import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { validateDevFnConfig } from "@devfn/config";
import { withFileLock } from "@devfn/ports";
import { proxyListenerPorts, proxyOwnerStatus, PUBLIC_ORIGIN_HEADER, PUBLIC_ORIGIN_PORT } from "@devfn/proxy";
import { caddyInternalRoot, probePublicOrigin, readTunnelState, registerTunnelBinding } from "@devfn/proxy/tunnel";
import { DevFnOrchestrator, resolveInstanceIdentity, type LifecycleReceipt } from "../src/index.js";
import { FakeTunnelProvider, fixtureBinding, writeConnectorScript } from "../../proxy/test/fixtures/tunnel.js";

// Local evidence only: the real DevFn Caddy, its public origin listener and
// the real origin probe, with the fake DNS provider and connector stand-in.
// A real cloudflared connector cannot become ready without the Cloudflare
// edge; real exposure and cleanup readback are networking acceptance.

const execFileAsync = promisify(execFile);
const SERVER = "import { readFileSync } from 'node:fs'; import { createServer } from 'node:http'; const body = readFileSync(new URL('body.txt', import.meta.url), 'utf8'); createServer((_request, response) => response.end(body)).listen(Number(process.env.DEVFN_PORT_WEB), '127.0.0.1');\n";
const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, ports: { web: {} },
  processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 20_000 } } },
  profiles: { default: { processes: ["web"], proxy: true, tunnel: { binding: "preview", routes: ["web"] } } },
  hostnames: { web: { target: "web" } } });

type Answer = { status: number; marker?: string; body: string } | { error: string };

/** One request to a real listener: over TLS with the given SNI, verified against ca when given, or plain HTTP. */
async function request(port: number, host: string, options: { servername?: string; ca?: string } = {}): Promise<Answer> {
  return await new Promise((resolve) => {
    const write = () => socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    const socket = options.servername === undefined
      ? net.connect(port, "127.0.0.1", write)
      : tls.connect({ host: "127.0.0.1", port, servername: options.servername, rejectUnauthorized: options.ca !== undefined, ...(options.ca ? { ca: options.ca } : {}), ALPNProtocols: ["http/1.1"] }, write);
    socket.setTimeout(5_000, () => socket.destroy(new Error("timed out")));
    let text = "";
    socket.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    socket.once("error", (error) => resolve({ error: error.message }));
    socket.once("end", () => {
      const [head, ...body] = text.split("\r\n\r\n");
      const marker = head.split("\r\n").find((line) => line.toLowerCase().startsWith(`${PUBLIC_ORIGIN_HEADER.toLowerCase()}:`));
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0), body: body.join(""), ...(marker ? { marker: marker.slice(marker.indexOf(":") + 1).trim() } : {}) });
    });
  });
}

/** A public name the origin no longer serves: no certificate for it, or the marked deny response. */
function expectUnserved(answer: Answer): void {
  if ("error" in answer) return;
  expect(answer).toMatchObject({ status: 403, marker: "deny" });
}

async function stopFixtureProxy(stateDir: string): Promise<void> {
  const raw = await readFile(path.join(stateDir, "proxy-owner.json"), "utf8").catch(() => undefined);
  if (!raw) return;
  const owner = JSON.parse(raw) as { pid: number; birthSignature?: string };
  if (await proxyOwnerStatus(owner) !== "active") return;
  try { process.kill(owner.pid, "SIGTERM"); } catch { /* stopped */ }
  for (let attempt = 0; attempt < 40 && await proxyOwnerStatus(owner) === "active"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
}

it.skipIf(process.env.DEVFN_REAL_PROXY !== "1")("shuts down and rolls back one runtime's public routes on the real public origin without disturbing another's", async () => await withFileLock(
  path.join(os.tmpdir(), "devfn-test-caddy-admin.lock"), async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-tunnel-real-origin-")));
    const stateDir = path.join(root, "state");
    // Two worktrees of one repository share the binding.
    const [rootA, rootB] = [path.join(root, "alpha"), path.join(root, "beta")];
    await mkdir(rootA);
    await execFileAsync("git", ["init", "-q"], { cwd: rootA });
    await execFileAsync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "--allow-empty", "-m", "fixture"], { cwd: rootA });
    await execFileAsync("git", ["worktree", "add", "-q", rootB], { cwd: rootA });
    for (const dir of [rootA, rootB]) {
      await writeFile(path.join(dir, "server.mjs"), SERVER);
      await writeFile(path.join(dir, "body.txt"), path.basename(dir));
    }
    await mkdir(stateDir);
    const credentialsFile = path.join(root, "credentials.json");
    await writeFile(credentialsFile, "{}", { mode: 0o600 });
    await registerTunnelBinding(stateDir, fixtureBinding((await resolveInstanceIdentity("fixture", rootA)).repositoryIdentity, credentialsFile));
    const provider = new FakeTunnelProvider(await writeConnectorScript(root));
    const orchestrator = new DevFnOrchestrator({ provider, readyTimeoutMs: 5_000 });
    const { httpPort } = proxyListenerPorts();
    const localHost = (receipt: LifecycleReceipt) => receipt.routes.find((route) => route.exposure !== "public")!.hostname;
    try {
      const b = await orchestrator.up({ config, root: rootB, stateDir, allowPublic: true });
      const a = await orchestrator.up({ config, root: rootA, stateDir, allowPublic: true });
      const [hostA, hostB] = [a.tunnel!.hostnames[0], b.tunnel!.hostnames[0]];
      const ca = await caddyInternalRoot();
      await probePublicOrigin(hostA, PUBLIC_ORIGIN_PORT, ca);
      expect(await request(PUBLIC_ORIGIN_PORT, hostA, { servername: hostA, ca })).toMatchObject({ status: 200, body: "alpha" });
      expect((await readTunnelState(stateDir, "preview")).connector!.hostnames).toEqual([hostA, hostB].sort());

      const serving = async () => {
        // B's public name answers with verified TLS, keeps its connector entry and DNS, and its local route serves.
        await probePublicOrigin(hostB, PUBLIC_ORIGIN_PORT, ca);
        expect(await request(PUBLIC_ORIGIN_PORT, hostB, { servername: hostB, ca })).toMatchObject({ status: 200, body: "beta" });
        expect(await request(httpPort, localHost(b))).toMatchObject({ status: 200, body: "beta" });
        const state = await readTunnelState(stateDir, "preview");
        expect(state.hostnames.map((item) => item.hostname)).toEqual([hostB]);
        expect(state.connector!.hostnames).toEqual([hostB]);
        expect([...provider.records.keys()]).toEqual([hostB]);
        // A's public name is no longer served by the origin, and its local route is gone.
        expectUnserved(await request(PUBLIC_ORIGIN_PORT, hostA, { servername: hostA }));
        expect(await request(httpPort, localHost(a))).not.toMatchObject({ body: "alpha" });
      };

      // Shutdown of A.
      expect(await orchestrator.down({ config, root: rootA, stateDir })).toMatchObject({ state: "stopped", cleanup: { withdrawnPublicHostnames: [hostA], errors: [] } });
      await serving();

      // Rollback: A's next start fails once its public origin route is active, at the DNS provider and then at connector readiness.
      provider.failEnsure.add(hostA);
      await expect(orchestrator.up({ config, root: rootA, stateDir, allowPublic: true })).rejects.toMatchObject({ code: "DEVFN_START_FAILED", message: expect.stringContaining(`provider failure for ${hostA}`) });
      await serving();
      provider.failEnsure.clear();
      provider.calls.length = 0;
      provider.connector = "exit";
      await expect(orchestrator.up({ config, root: rootA, stateDir, allowPublic: true })).rejects.toMatchObject({ code: "DEVFN_START_FAILED", message: expect.stringContaining("connector did not become ready") });
      expect(provider.calls).toContain("launch");
      provider.connector = "ready";
      await serving();

      expect(await orchestrator.down({ config, root: rootB, stateDir })).toMatchObject({ state: "stopped", cleanup: { withdrawnPublicHostnames: [hostB], errors: [] } });
      expect(provider.records.size).toBe(0);
      expectUnserved(await request(PUBLIC_ORIGIN_PORT, hostB, { servername: hostB }));
    } finally {
      for (const dir of [rootA, rootB]) await orchestrator.down({ config, root: dir, stateDir }).catch(() => undefined);
      const state = await readTunnelState(stateDir, "preview").catch(() => undefined);
      for (const record of [state?.connector, ...(state?.retired ?? [])]) if (record) { try { process.kill(-record.pid, "SIGKILL"); } catch { /* gone */ } }
      await stopFixtureProxy(stateDir);
      await rm(root, { recursive: true, force: true });
    }
  }, { timeoutMs: 120_000 }), 240_000);
