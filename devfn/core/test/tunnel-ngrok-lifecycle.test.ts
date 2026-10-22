import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@devfn/proxy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devfn/proxy")>();
  return {
    ...actual,
    // The command stub stands in for a Caddy that holds its listeners and serves what it is given.
    CaddyProxyController: class extends actual.CaddyProxyController {
      constructor(stateDir: string) { super(stateDir, undefined, undefined, async () => true, async () => true); }
      // Physical owner and listener preflight is covered by the proxy suites.
      override async assertActivationReady(): Promise<void> {}
    },
  };
});

import { validateDevFnConfig, type DevFnConfig } from "@devfn/config";
import { processBirthSignature } from "@devfn/processes";
import { readTunnelState, registerTunnelBinding, tunnelPaths, type TunnelBinding } from "@devfn/proxy/tunnel";
import { DevFnOrchestrator, planPublicUrls, resolveInstanceIdentity, type TunnelOverrides } from "../src/index.js";
import { FakeTunnelProvider, ngrokFixtureBinding, writeConnectorScript } from "../../proxy/test/fixtures/tunnel.js";

const CADDY_STUB = "#!/bin/sh\ncase \"$1\" in version|validate|reload) exit 0;; esac\nexit 1\n";
// The fixture server records the environment it started with.
const SERVER = "import { writeFileSync } from 'node:fs'; import { createServer } from 'node:http'; writeFileSync('started-env.json', JSON.stringify(process.env)); createServer((_request, response) => response.end('ready')).listen(Number(process.env.DEVFN_PORT_WEB), '127.0.0.1');\n";

/** A fake provider that, like ngrok ephemeral endpoints, assigns each hostname a URL once its connector is ready. */
class AssigningProvider extends FakeTunnelProvider {
  public assigned = 0;
  public assignedUrls(_binding: TunnelBinding, _port: number, hostnames: readonly string[]): Promise<Record<string, string>> {
    this.assigned += 1;
    return Promise.resolve(Object.fromEntries(hostnames.map((hostname, index) => [hostname, `https://assigned-${this.assigned}-${index}.ngrok-free.app`])));
  }
}

let root: string;
let stateDir: string;
let provider: AssigningProvider;
let overrides: TunnelOverrides;
let originalPath: string | undefined;

const manifest = (tunnel: Record<string, unknown>, env: Record<string, string> = {}): DevFnConfig => validateDevFnConfig({ version: 1, project: { id: "fixture" }, ports: { web: {} },
  processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], env, health: { type: "http", port: "web", timeoutMs: 20_000 } } },
  profiles: { default: { processes: ["web"], proxy: true }, share: { processes: ["web"], proxy: true, tunnel } },
  hostnames: { web: { target: "web", path: "/app" } } });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "devfn-ngrok-lifecycle-")));
  stateDir = path.join(root, "state");
  provider = new AssigningProvider(await writeConnectorScript(root));
  overrides = { provider, readyTimeoutMs: 5_000, originCa: async () => "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n", probeOrigin: async () => undefined };
  originalPath = process.env.PATH;
  await mkdir(stateDir, { recursive: true });
  const identity = await resolveInstanceIdentity("fixture", root);
  await registerTunnelBinding(stateDir, ngrokFixtureBinding(identity.repositoryIdentity, "reserved", "share"));
  await registerTunnelBinding(stateDir, ngrokFixtureBinding(identity.repositoryIdentity, "ephemeral", "eph"));
});

afterEach(async () => {
  for (const name of ["share", "eph"]) {
    const state = await readTunnelState(stateDir, name).catch(() => undefined);
    for (const record of [state?.connector, ...(state?.retired ?? [])]) if (record) { try { process.kill(-record.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  await rm(root, { recursive: true, force: true });
});

/** A Caddy that accepts what it is given, owned by this process, and the fixture server. */
async function stubLifecycleHost(): Promise<void> {
  const toolsDir = path.join(root, "tools");
  await mkdir(toolsDir);
  await writeFile(path.join(root, "server.mjs"), SERVER);
  await writeFile(path.join(toolsDir, "caddy"), CADDY_STUB, { mode: 0o700 });
  process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
  await writeFile(path.join(stateDir, "proxy-owner.json"), JSON.stringify({ pid: process.pid, birthSignature: await processBirthSignature(process.pid) }));
}

it("gives consumers a reserved ngrok endpoint's deterministic public URL before start, and records the same URL", async () => {
  const config = manifest({ binding: "share", routes: ["web"] }, { CALLBACK_URL: "{{env.DEVFN_PUBLIC_URL_WEB}}/callback" });
  const planned = await planPublicUrls({ config, root, profile: "share", stateDir });
  expect(planned).toMatchObject({ binding: "share", timing: "pre-start" });
  expect(planned.urls.web).toMatch(/^https:\/\/web-devfn-ngrok-lifecycle-[a-z0-9-]+-[a-f0-9]{20}\.ngrok\.example\.test\/app$/);
  expect(planned).not.toHaveProperty("assignedAfterStart");

  await stubLifecycleHost();
  const orchestrator = new DevFnOrchestrator(overrides);
  const started = await orchestrator.up({ config, root, profile: "share", stateDir, allowPublic: true });
  const env = JSON.parse(await readFile(path.join(root, "started-env.json"), "utf8")) as Record<string, string>;
  expect(env.DEVFN_PUBLIC_URL_WEB).toBe(planned.urls.web);
  expect(env.CALLBACK_URL).toBe(`${planned.urls.web}/callback`);
  expect(started).toMatchObject({ state: "ready", publicUrls: planned.urls, tunnel: { binding: "share", urlTiming: "pre-start", hostnames: [new URL(planned.urls.web).hostname] } });
  await orchestrator.down({ config, root, stateDir });
}, 60_000);

it("starts nothing when an ephemeral endpoint is not selected explicitly or its URL is needed before start", async () => {
  // Without --allow-public nothing is read, whatever the binding.
  const unselected = manifest({ binding: "eph", routes: ["web"] });
  await expect(new DevFnOrchestrator(overrides).up({ config: unselected, root, profile: "share", stateDir }))
    .rejects.toMatchObject({ code: "DEVFN_PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED" });
  await expect(new DevFnOrchestrator(overrides).up({ config: unselected, root, profile: "share", stateDir, allowPublic: true }))
    .rejects.toThrow("assigns public URLs only after its connector starts (ephemeral endpoints); select it explicitly with profiles.share.tunnel.ephemeral: true");
  await expect(new DevFnOrchestrator(overrides).up({ config: manifest({ binding: "share", routes: ["web"], ephemeral: true }), root, profile: "share", stateDir, allowPublic: true }))
    .rejects.toThrow("binding share has deterministic URLs");
  const consumer = manifest({ binding: "eph", routes: ["web"], ephemeral: true }, { CALLBACK_URL: "{{env.DEVFN_PUBLIC_URL_WEB}}/callback" });
  await expect(new DevFnOrchestrator(overrides).up({ config: consumer, root, profile: "share", stateDir, allowPublic: true }))
    .rejects.toThrow("processes.web.env: DEVFN_PUBLIC_URL_WEB is the public URL of ephemeral tunnel route web, which the provider assigns only after startup");
  const argv = manifest({ binding: "eph", routes: ["web"], ephemeral: true });
  argv.processes!.web.command = [process.execPath, "server.mjs", "--public={{env.DEVFN_PUBLIC_URL_WEB}}"];
  await expect(new DevFnOrchestrator(overrides).up({ config: argv, root, profile: "share", stateDir, allowPublic: true })).rejects.toThrow("processes.web.command: DEVFN_PUBLIC_URL_WEB");
  // No lease, process, connector or provider call happened.
  expect(provider.calls).toEqual([]);
  await expect(access(path.join(stateDir, "registry.json"))).rejects.toThrow();
  await expect(access(path.join(stateDir, "tunnel-owners"))).rejects.toThrow();
  await expect(access(path.join(root, "started-env.json"))).rejects.toThrow();
});

it("publishes an ephemeral endpoint's URL only to runtime outputs once its connector reports it", async () => {
  const config = manifest({ binding: "eph", routes: ["web"], ephemeral: true });
  expect(await planPublicUrls({ config, root, profile: "share", stateDir })).toEqual({ binding: "eph", timing: "post-start", urls: {}, assignedAfterStart: ["web"] });
  await stubLifecycleHost();
  const orchestrator = new DevFnOrchestrator(overrides);
  const started = await orchestrator.up({ config, root, profile: "share", stateDir, allowPublic: true });
  const hostname = started.tunnel!.hostnames[0];
  expect(hostname).toMatch(/\.eph\.ngrok\.devfn\.internal$/);
  expect(started).toMatchObject({ state: "ready", publicUrls: { web: "https://assigned-1-0.ngrok-free.app/app" }, tunnel: { binding: "eph", urlTiming: "post-start" } });
  const env = JSON.parse(await readFile(path.join(root, "started-env.json"), "utf8")) as Record<string, string>;
  expect(Object.keys(env).filter((key) => key.startsWith("DEVFN_PUBLIC_URL_"))).toEqual([]);
  expect((await readTunnelState(stateDir, "eph")).connector!.urls).toEqual({ [hostname]: "https://assigned-1-0.ngrok-free.app" });
  expect(await orchestrator.status({ config, root })).toMatchObject({ state: "ready" });
  // A connector restart for another worktree assigns new URLs: the receipt's snapshot is then no longer ready, and up records the current one.
  const journal = tunnelPaths(stateDir, "eph").state;
  const state = JSON.parse(await readFile(journal, "utf8")) as { connector: { urls: Record<string, string> } };
  state.connector.urls[hostname] = "https://reassigned.ngrok-free.app";
  await writeFile(journal, JSON.stringify(state), { mode: 0o600 });
  expect(await orchestrator.status({ config, root })).toMatchObject({ state: "degraded" });
  const restarted = await orchestrator.up({ config, root, profile: "share", stateDir, allowPublic: true });
  expect(restarted.publicUrls).toEqual({ web: `${(await readTunnelState(stateDir, "eph")).connector!.urls[restarted.tunnel!.hostnames[0]]}/app` });
  expect(await orchestrator.status({ config, root })).toMatchObject({ state: "ready" });
  await orchestrator.down({ config, root, stateDir });
}, 60_000);

it("keeps a reserved endpoint's pre-start URL for consumers across replacement and crash recovery", async () => {
  const config = manifest({ binding: "share", routes: ["web"] }, { CALLBACK_URL: "{{env.DEVFN_PUBLIC_URL_WEB}}/callback" });
  const planned = (await planPublicUrls({ config, root, profile: "share", stateDir })).urls.web;
  await stubLifecycleHost();
  const orchestrator = new DevFnOrchestrator(overrides);
  const startedEnv = async () => JSON.parse(await readFile(path.join(root, "started-env.json"), "utf8")) as Record<string, string>;
  await orchestrator.up({ config, root, profile: "share", stateDir, allowPublic: true });
  await rm(path.join(root, "started-env.json"));
  // Replacement validates the new lifecycle with the same public template inputs before stopping the old one.
  const replaced = await orchestrator.up({ config, root, profile: "share", stateDir, allowPublic: true, replace: true });
  expect((await startedEnv()).CALLBACK_URL).toBe(`${planned}/callback`);
  expect(replaced.publicUrls).toEqual({ web: planned });
  // A crashed consumer is recovered by a plain up through the same replacement validation.
  process.kill(-replaced.processes[0].pid, "SIGKILL");
  await vi.waitFor(() => expect(() => process.kill(-replaced.processes[0].pid, 0)).toThrow(), { timeout: 5_000 });
  await rm(path.join(root, "started-env.json"));
  const recovered = await orchestrator.up({ config, root, profile: "share", stateDir, allowPublic: true });
  expect(recovered.invocationId).not.toBe(replaced.invocationId);
  expect((await startedEnv()).CALLBACK_URL).toBe(`${planned}/callback`);
  expect(recovered).toMatchObject({ state: "ready", publicUrls: { web: planned } });
  await orchestrator.down({ config, root, stateDir });
}, 90_000);

it("rejects an ephemeral URL reference on replacement while the running lifecycle keeps serving", async () => {
  const config = manifest({ binding: "eph", routes: ["web"], ephemeral: true });
  await stubLifecycleHost();
  const orchestrator = new DevFnOrchestrator(overrides);
  const started = await orchestrator.up({ config, root, profile: "share", stateDir, allowPublic: true });
  const consumer = manifest({ binding: "eph", routes: ["web"], ephemeral: true }, { CALLBACK_URL: "{{env.DEVFN_PUBLIC_URL_WEB}}/callback" });
  await expect(orchestrator.up({ config: consumer, root, profile: "share", stateDir, allowPublic: true, replace: true }))
    .rejects.toThrow("processes.web.env: DEVFN_PUBLIC_URL_WEB is the public URL of ephemeral tunnel route web");
  expect(process.kill(started.processes[0].pid, 0)).toBe(true);
  const connector = (await readTunnelState(stateDir, "eph")).connector!;
  expect(process.kill(connector.pid, 0)).toBe(true);
  expect(connector.urls).toEqual({ [started.tunnel!.hostnames[0]]: "https://assigned-1-0.ngrok-free.app" });
  await orchestrator.down({ config, root, stateDir });
}, 60_000);

it("rejects a Compose interpolation of an ephemeral URL from the real Compose source before any state", async () => {
  const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, ports: { web: {} },
    processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 20_000 } } },
    services: { consumer: { adapter: "compose", service: "consumer", dependsOn: ["web"] } },
    defaultProfile: "share", profiles: { share: { processes: ["web"], services: ["consumer"], proxy: true, tunnel: { binding: "eph", routes: ["web"], ephemeral: true } } },
    hostnames: { web: { target: "web", path: "/app" } } });
  await writeFile(path.join(root, "compose.yaml"), "services:\n  consumer:\n    image: busybox\n    environment:\n      CALLBACK: ${DEVFN_PUBLIC_URL_WEB}/callback\n");
  await expect(new DevFnOrchestrator(overrides).up({ config, root, profile: "share", stateDir, allowPublic: true }))
    .rejects.toThrow("services.consumer.compose: DEVFN_PUBLIC_URL_WEB is the public URL of ephemeral tunnel route web");
  expect(provider.calls).toEqual([]);
  await expect(access(path.join(stateDir, "registry.json"))).rejects.toThrow();
  await expect(access(path.join(stateDir, "tunnel-owners"))).rejects.toThrow();
});
