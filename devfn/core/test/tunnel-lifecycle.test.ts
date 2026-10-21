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

import { validateDevFnConfig } from "@devfn/config";
import { withFileLock } from "@devfn/ports";
import { processBirthSignature } from "@devfn/processes";
import { publishTunnelRoutes, readTunnelState, registerTunnelBinding, tunnelPaths, type TunnelServiceOptions } from "@devfn/proxy/tunnel";
import { DevFnOrchestrator, planPublicUrls, recoverOrphanedProxyRoutes, resolveInstanceIdentity, type TunnelOverrides } from "../src/index.js";
import { publishLifecycleTunnel, withdrawLifecycleTunnel } from "../src/tunnel.js";
import { FakeTunnelProvider, fixtureBinding, writeConnectorScript } from "../../proxy/test/fixtures/tunnel.js";

const CADDY_STUB = "#!/bin/sh\ncase \"$1\" in version|validate|reload) exit 0;; esac\nexit 1\n";
const SERVER = "import { createServer } from 'node:http'; createServer((_request, response) => response.end('ready')).listen(Number(process.env.DEVFN_PORT_WEB), '127.0.0.1');\n";
const OTHER = "web-other-0123456789abcdef0123.tunnel.example.test";

let root: string;
let stateDir: string;
let provider: FakeTunnelProvider;
let overrides: TunnelOverrides;
let originalPath: string | undefined;
const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, ports: { web: {} },
  processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 20_000 } } },
  profiles: { default: { processes: ["web"], proxy: true }, share: { processes: ["web"], proxy: true, tunnel: { binding: "preview", routes: ["web"] } } },
  hostnames: { web: { target: "web" } } });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "devfn-tunnel-lifecycle-")));
  stateDir = path.join(root, "state");
  provider = new FakeTunnelProvider(await writeConnectorScript(root));
  overrides = { provider, readyTimeoutMs: 5_000, originCa: async () => "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n", probeOrigin: async () => undefined };
  originalPath = process.env.PATH;
});

afterEach(async () => {
  for (const name of ["preview", "staging"]) {
    const state = await readTunnelState(stateDir, name).catch(() => undefined);
    for (const record of [state?.connector, ...(state?.retired ?? [])]) if (record) { try { process.kill(-record.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  await rm(root, { recursive: true, force: true });
});

async function registerPreview(): Promise<TunnelServiceOptions> {
  await mkdir(stateDir, { recursive: true });
  const credentialsFile = path.join(root, "credentials.json");
  await writeFile(credentialsFile, "{}", { mode: 0o600 });
  const identity = await resolveInstanceIdentity("fixture", root);
  const binding = await registerTunnelBinding(stateDir, fixtureBinding(identity.repositoryIdentity, credentialsFile));
  return { ...overrides, stateDir, binding };
}

/** A Caddy that accepts what it is given, owned by this process, and the fixture server. */
async function stubLifecycleHost(): Promise<void> {
  const toolsDir = path.join(root, "tools");
  await mkdir(toolsDir);
  await writeFile(path.join(root, "server.mjs"), SERVER);
  await writeFile(path.join(toolsDir, "caddy"), CADDY_STUB, { mode: 0o700 });
  process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
  await writeFile(path.join(stateDir, "proxy-owner.json"), JSON.stringify({ pid: process.pid, birthSignature: await processBirthSignature(process.pid) }));
}

it("requires --allow-public before tunnel state or the provider is touched; selecting a binding grants nothing", async () => {
  await expect(new DevFnOrchestrator(overrides).up({ config, root, stateDir, profile: "share" }))
    .rejects.toMatchObject({ code: "DEVFN_PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED", details: { tunnel: { binding: "preview", routes: ["web"] } } });
  expect(provider.calls).toEqual([]);
  await expect(access(stateDir)).rejects.toThrow();
});

it("publishes the pre-start public URL after readiness and withdraws only its own routes on down", async () => {
  const tunnel = await registerPreview();
  await publishTunnelRoutes(tunnel, "other-worktree", [OTHER]);
  const planned = await planPublicUrls({ config, root, profile: "share", stateDir });
  expect(planned).toEqual(await planPublicUrls({ config, root, profile: "share", stateDir }));
  expect(planned.urls.web).toMatch(/^https:\/\/web-devfn-tunnel-lifecycle-[a-z0-9-]+-[a-f0-9]{20}\.tunnel\.example\.test$/);
  expect(await planPublicUrls({ config, root, stateDir })).toEqual({ urls: {} });

  await stubLifecycleHost();
  const orchestrator = new DevFnOrchestrator(overrides);
  const started = await orchestrator.up({ config, root, stateDir, profile: "share", allowPublic: true });
  const hostname = new URL(planned.urls.web).hostname;
  expect(started).toMatchObject({ state: "ready", publicUrls: planned.urls, tunnel: { binding: "preview", hostnames: [hostname] } });
  // The public origin route never becomes the local URL, though its ID sorts first.
  expect(new URL(started.urls.web).hostname).toMatch(/\.localhost$/);
  const { routes } = JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8")) as { routes: Array<Record<string, unknown>> };
  expect(routes.filter((route) => route.exposure === "public")).toEqual([expect.objectContaining({ hostname, publicDomain: "tunnel.example.test", tls: "internal" })]);
  expect([...provider.records.keys()].sort()).toEqual([OTHER, hostname].sort());

  const stopped = await orchestrator.down({ config, root, stateDir });
  expect(stopped.cleanup).toMatchObject({ withdrawnPublicHostnames: [hostname], errors: [] });
  expect([...provider.records.keys()]).toEqual([OTHER]);
  const state = await readTunnelState(stateDir, "preview");
  expect(state.hostnames).toEqual([expect.objectContaining({ hostname: OTHER, ownerId: "other-worktree" })]);
  expect(state.connector).toBeDefined();
}, 60_000);

it("withdraws an orphaned owner's public routes during recovery and leaves an owner whose command runs", async () => {
  const tunnel = await registerPreview();
  const live = "web-live-0123456789abcdef0123.tunnel.example.test";
  await publishTunnelRoutes(tunnel, "orphan-owner", [OTHER]);
  await publishTunnelRoutes(tunnel, "live-owner", [live]);
  const recovered = await withFileLock(path.join(await realpath(stateDir), "lifecycle-live-owner.lock"), async () => await recoverOrphanedProxyRoutes(stateDir, overrides));
  expect(recovered).toEqual(["orphan-owner"]);
  expect([...provider.records.keys()]).toEqual([live]);
  expect((await readTunnelState(stateDir, "preview")).hostnames.map((item) => item.ownerId)).toEqual(["live-owner"]);
});

it("withdraws public routes before stopping processes, also for a replacement, and stops nothing while withdrawal fails", async () => {
  await registerPreview();
  await stubLifecycleHost();
  const orchestrator = new DevFnOrchestrator(overrides);
  const started = await orchestrator.up({ config, root, stateDir, profile: "share", allowPublic: true });
  const hostname = started.tunnel!.hostnames[0];
  provider.calls.length = 0;
  const replaced = await orchestrator.up({ config, root, stateDir, profile: "share", allowPublic: true, replace: true });
  // The prior lifecycle's exposure ended before its process stopped; the replacement republished once ready.
  expect(provider.calls.indexOf(`remove ${hostname}`)).toBeGreaterThanOrEqual(0);
  expect(provider.calls.indexOf(`remove ${hostname}`)).toBeLessThan(provider.calls.lastIndexOf(`ensure ${hostname}`));
  expect(replaced).toMatchObject({ state: "ready", tunnel: { hostnames: [hostname] } });

  provider.failRemove.add(hostname);
  const degraded = await orchestrator.down({ config, root, stateDir });
  expect(degraded.state).toBe("degraded");
  expect(degraded.cleanup).toMatchObject({ stoppedProcesses: [], releasedPorts: false, removedProxy: false });
  expect(process.kill(replaced.processes[0].pid, 0)).toBe(true);
  provider.failRemove.clear();
  expect((await orchestrator.down({ config, root, stateDir })).state).toBe("stopped");
  expect(provider.records.has(hostname)).toBe(false);
}, 90_000);

/** A second binding of the same repository on its own tunnel and domain. */
async function registerStaging(preview: TunnelServiceOptions): Promise<TunnelServiceOptions> {
  const credentialsFile = path.join(root, "staging.json");
  await writeFile(credentialsFile, "{}", { mode: 0o600 });
  const base = fixtureBinding(preview.binding.repositoryIdentity, credentialsFile, "staging");
  return { ...preview, binding: await registerTunnelBinding(stateDir, { ...base, domain: "staging.example.test", cloudflare: { ...base.cloudflare, tunnelId: "00000000-0000-4000-8000-000000000002" } }) };
}
const STAGED = "web-other-0123456789abcdef0123.staging.example.test";

it("moves an owner's routes off a binding it no longer selects", async () => {
  const preview = await registerPreview();
  const staging = (await registerStaging(preview)).binding;
  await publishTunnelRoutes(preview, "owner", [OTHER]);
  const moved = STAGED;
  await publishLifecycleTunnel(stateDir, { instanceId: "owner" }, { binding: staging, routes: [{ id: "owner:public:web", instanceId: "owner", hostname: moved, targetHost: "127.0.0.1", targetPort: 1, tls: "internal" }], urls: {} }, overrides);
  expect((await readTunnelState(stateDir, "preview")).hostnames).toEqual([]);
  expect((await readTunnelState(stateDir, "staging")).hostnames.map((item) => item.hostname)).toEqual([moved]);
});

it("keeps lifecycles that never published independent of malformed tunnel state", async () => {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "tunnels.json"), "{ not json");
  expect(await withdrawLifecycleTunnel(stateDir, { instanceId: "never-published", projectId: "fixture" }, overrides)).toEqual([]);
  // A binding's unreadable state fails only owners of the project it is registered to.
  const tunnel = await (async () => { await rm(path.join(stateDir, "tunnels.json")); return await registerPreview(); })();
  await mkdir(tunnelPaths(stateDir, "preview").dir, { recursive: true });
  await writeFile(tunnelPaths(stateDir, "preview").state, "{ not json");
  expect(await withdrawLifecycleTunnel(stateDir, { instanceId: "other", projectId: "another-project" }, overrides)).toEqual([]);
  await expect(withdrawLifecycleTunnel(stateDir, { instanceId: "mine", projectId: "fixture" }, overrides)).rejects.toThrow("unreadable");
  expect(tunnel.binding.name).toBe("preview");
});

it("recovers every other orphan when one orphan's withdrawal fails", async () => {
  const tunnel = await registerPreview();
  const staging = await registerStaging(tunnel);
  await publishTunnelRoutes(staging, "orphan-a", [STAGED]);
  await publishTunnelRoutes(tunnel, "orphan-b", [OTHER]);
  provider.failRemove.add(STAGED);
  await expect(recoverOrphanedProxyRoutes(stateDir, overrides)).rejects.toMatchObject({ details: { recovered: ["orphan-b"] } });
  expect([...provider.records.keys()]).toEqual([STAGED]);
  provider.failRemove.clear();
  expect(await recoverOrphanedProxyRoutes(stateDir, overrides)).toEqual(["orphan-a"]);
  expect(provider.records.size).toBe(0);
});
