import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { validateDevFnConfig } from "@devfn/config";
import { FilePortRegistry } from "@devfn/ports";
import { processBirthSignature } from "@devfn/processes";
import { OAUTH_RELAY_OWNER_ID, OAUTH_RELAY_ROUTE_ID, OAuthRelayClient } from "@devfn/proxy/oauth-relay";
import { DevFnOrchestrator } from "../src/index.js";

const RELAY_ORIGIN = "https://auth.dev.example.test";

// The process records the DevFn values a default OAuthRelayClient reads, then serves its health check.
const serverScript = "import { writeFileSync } from 'node:fs'; import { createServer } from 'node:http'; " +
  "const { DEVFN_STATE_DIR, DEVFN_INSTANCE_ID, XDG_STATE_HOME, HOME } = process.env; " +
  "writeFileSync(new URL('env.json', import.meta.url), JSON.stringify({ DEVFN_STATE_DIR, DEVFN_INSTANCE_ID, XDG_STATE_HOME, HOME })); " +
  "createServer((_request, response) => response.end('ready')).listen(Number(process.env.DEVFN_PORT_APP), '127.0.0.1');\n";

async function processFixture(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, ports: { app: {} },
    processes: { app: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"], health: { type: "http", port: "app", timeoutMs: 10_000 } } },
    profiles: { default: { processes: ["app"] } } });
  await writeFile(path.join(root, "server.mjs"), serverScript);
  return { root, config, orchestrator: new DevFnOrchestrator() };
}

/** A relay record for a running process (this one) in stateDir. */
async function recordRelay(stateDir: string): Promise<void> {
  await mkdir(path.join(stateDir, "oauth-relay"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, "oauth-relay", "service.json"), JSON.stringify({ version: 1, pid: process.pid, birthSignature: await processBirthSignature(process.pid),
    startedAt: new Date().toISOString(), port: 41001, origin: RELAY_ORIGIN, hostname: "auth.dev.example.test", domain: "dev.example.test", projectId: "fixture",
    repositoryIdentity: stateDir, invocationId: "relay" }));
}

it("gives launched processes the lifecycle's state directory, so a default OAuthRelayClient reads that machine state", async () => {
  const { root, config, orchestrator } = await processFixture("devfn-relay-state-dir-");
  const originalXdg = process.env.XDG_STATE_HOME;
  try {
    // --state-dir, then XDG_STATE_HOME (which DevFn does not pass to processes).
    for (const [label, stateDir] of [["custom", path.join(root, "custom-state")], ["xdg", undefined]] as const) {
      if (label === "xdg") process.env.XDG_STATE_HOME = path.join(root, "xdg");
      const expected = stateDir ?? path.join(root, "xdg", "devfn");
      await orchestrator.up({ config, root, ...(stateDir ? { stateDir } : {}) });
      try {
        const env = JSON.parse(await readFile(path.join(root, "env.json"), "utf8")) as NodeJS.ProcessEnv;
        expect(env.XDG_STATE_HOME).toBeUndefined();
        expect(env.DEVFN_STATE_DIR).toBe(await realpath(expected));
        await recordRelay(expected);
        await expect(new OAuthRelayClient({ env }).redirectUri("/oauth/callback")).resolves.toBe(`${RELAY_ORIGIN}/oauth/callback`);
      } finally {
        await orchestrator.down({ config, root, ...(stateDir ? { stateDir } : {}) });
      }
    }
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = originalXdg;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("tears down a route-less lifecycle and releases its leases without Caddy while a dead relay route remains", async () => {
  const { root, config, orchestrator } = await processFixture("devfn-relay-routeless-");
  const stateDir = path.join(root, "state");
  const toolsDir = path.join(root, "tools");
  const marker = path.join(toolsDir, "caddy-invoked");
  const originalPath = process.env.PATH;
  try {
    const started = await orchestrator.up({ config, root, stateDir });
    const child = execFile(process.execPath, ["-e", "setTimeout(() => undefined, 200)"]);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const birthSignature = await processBirthSignature(child.pid!);
    await exited;
    await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [{ id: OAUTH_RELAY_ROUTE_ID, instanceId: OAUTH_RELAY_OWNER_ID,
      hostname: "auth.localhost", targetHost: "127.0.0.1", targetPort: 41001, tls: "off", updatedAt: new Date().toISOString(),
      serviceProcess: { pid: child.pid!, birthSignature: birthSignature ?? "gone" } }] }));
    // A host where DevFn's Caddy is not running and cannot start.
    await mkdir(toolsDir);
    await writeFile(path.join(toolsDir, "caddy"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
    process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
    await expect(orchestrator.down({ config, root, stateDir })).resolves.toMatchObject({ state: "stopped" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const registry = await new FilePortRegistry(path.join(stateDir, "registry.json")).read();
    expect(registry.allocations.filter((item) => item.invocationId === started.invocationId).map((item) => item.state)).toEqual(["released"]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
