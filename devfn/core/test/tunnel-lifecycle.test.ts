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
import { FilePortRegistry, withFileLock } from "@devfn/ports";
import { processBirthSignature } from "@devfn/processes";
import { markOwnerBinding, publishTunnelRoutes, readOwnerBindings, readTunnelState, registerTunnelBinding, tunnelPaths, type TunnelServiceOptions } from "@devfn/proxy/tunnel";
import { DevFnOrchestrator, planPublicUrls, recoverOrphanedProxyRoutes, resolveInstanceIdentity, type TunnelOverrides } from "../src/index.js";
import { publicUrlsLive, publishLifecycleTunnel, withdrawLifecycleTunnel } from "../src/tunnel.js";
import { writeTunnelState } from "../../proxy/src/tunnel/state.js";
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

it.skipIf(process.platform === "win32")("withdraws, rather than relaunches, the routes of an owner with no lifecycle that may run once their connector exited", async () => {
  const tunnel = await registerPreview();
  await publishTunnelRoutes(tunnel, "other-worktree", [OTHER]);
  process.kill(-(await readTunnelState(stateDir, "preview")).connector!.pid, "SIGKILL");
  await stubLifecycleHost();
  const orchestrator = new DevFnOrchestrator(overrides);
  const started = await orchestrator.up({ config, root, stateDir, profile: "share", allowPublic: true });
  const state = await readTunnelState(stateDir, "preview");
  expect(state.hostnames.map((item) => item.hostname)).toEqual(started.tunnel!.hostnames);
  expect(state.connector!.hostnames).toEqual(started.tunnel!.hostnames);
  expect([...provider.records.keys()]).toEqual(started.tunnel!.hostnames);
  await orchestrator.down({ config, root, stateDir });
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
  const tunnel = await registerPreview();
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

  // Exposure cannot be shown ended: the DNS record is removed, but the connector another owner shares cannot be replaced and still routes the name.
  await publishTunnelRoutes(tunnel, "other-worktree", [OTHER]);
  provider.connector = "exit";
  const degraded = await orchestrator.down({ config, root, stateDir });
  expect(provider.records.has(hostname)).toBe(false);
  expect(degraded.state).toBe("degraded");
  expect(degraded.cleanup).toMatchObject({ stoppedProcesses: [], releasedPorts: false, removedProxy: false });
  expect(process.kill(replaced.processes[0].pid, 0)).toBe(true);
  provider.connector = "ready";
  expect((await orchestrator.down({ config, root, stateDir })).state).toBe("stopped");
  expect(provider.records.has(hostname)).toBe(false);
  expect(provider.records.has(OTHER)).toBe(true);
}, 90_000);

it("ends a receiptless owner's public exposure before a private start takes a lease, starting nothing while it cannot end", async () => {
  const tunnel = await registerPreview();
  await publishTunnelRoutes(tunnel, "other-worktree", [OTHER]);
  // The owner published, then its worktree receipts were removed (git clean -fdx).
  const identity = await resolveInstanceIdentity("fixture", root);
  const hostname = new URL((await planPublicUrls({ config, root, profile: "share", stateDir })).urls.web).hostname;
  await publishTunnelRoutes(tunnel, identity.instanceId, [hostname]);
  await stubLifecycleHost();
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  const leased = async () => (await registry.read()).invocations.some((item) => item.instanceId === identity.instanceId);
  const orchestrator = new DevFnOrchestrator(overrides);
  // The name's DNS record is removed, but the shared connector cannot be replaced and still routes it.
  provider.connector = "exit";
  await expect(orchestrator.up({ config, root, stateDir })).rejects.toThrow("could not be withdrawn before startup");
  expect(provider.records.has(hostname)).toBe(false);
  expect(await leased()).toBe(false);
  await expect(access(path.join(root, ".devfn"))).rejects.toThrow();
  expect((await readTunnelState(stateDir, "preview")).connector!.hostnames).toEqual([OTHER, hostname].sort());

  provider.connector = "ready";
  const leasedAtReplacement: boolean[] = [];
  provider.beforeLaunch = async () => { leasedAtReplacement.push(await leased()); };
  expect(await orchestrator.up({ config, root, stateDir })).toMatchObject({ state: "ready" });
  expect(leasedAtReplacement).toEqual([false]);
  expect([...provider.records.keys()]).toEqual([OTHER]);
  const state = await readTunnelState(stateDir, "preview");
  expect(state.hostnames).toEqual([expect.objectContaining({ hostname: OTHER, ownerId: "other-worktree" })]);
  expect(state.connector!.hostnames).toEqual([OTHER]);
  expect(await readOwnerBindings(stateDir, identity.instanceId)).toEqual([]);
  await orchestrator.down({ config, root, stateDir });
}, 60_000);

it.skipIf(process.platform === "win32")("republishes, rather than reports already running, a ready public lifecycle whose connector exited", async () => {
  await registerPreview();
  await stubLifecycleHost();
  const orchestrator = new DevFnOrchestrator(overrides);
  const started = await orchestrator.up({ config, root, stateDir, profile: "share", allowPublic: true });
  await expect(orchestrator.up({ config, root, stateDir, profile: "share", allowPublic: true })).rejects.toMatchObject({ code: "DEVFN_ALREADY_RUNNING" });
  const crashed = (await readTunnelState(stateDir, "preview")).connector!;
  process.kill(-crashed.pid, "SIGKILL");
  expect(await orchestrator.up({ config, root, stateDir, profile: "share", allowPublic: true })).toMatchObject({ state: "ready", tunnel: started.tunnel });
  const state = await readTunnelState(stateDir, "preview");
  expect(state.connector!.pid).not.toBe(crashed.pid);
  expect(state.connector!.hostnames).toEqual(started.tunnel!.hostnames);
  await orchestrator.down({ config, root, stateDir });
}, 90_000);

it("completes local teardown once the connector no longer routes the names, reporting a DNS removal that keeps failing", async () => {
  await registerPreview();
  await stubLifecycleHost();
  const orchestrator = new DevFnOrchestrator(overrides);
  const started = await orchestrator.up({ config, root, stateDir, profile: "share", allowPublic: true });
  const hostname = started.tunnel!.hostnames[0];
  provider.failRemove.add(hostname);
  const degraded = await orchestrator.down({ config, root, stateDir });
  expect(degraded).toMatchObject({ state: "degraded", cleanup: { stoppedProcesses: ["web"], releasedPorts: true, removedProxy: true, errors: [],
    publicOutstanding: [`preview: ${hostname}: public DNS removal is not confirmed`, `preview: provider failure removing ${hostname}`] } });
  expect(await readOwnerBindings(stateDir, started.instanceId)).toEqual(["preview"]);
  provider.failRemove.clear();
  expect(await orchestrator.down({ config, root, stateDir })).toMatchObject({ state: "stopped", cleanup: { errors: [] } });
  expect(provider.records.size).toBe(0);
  expect(await readOwnerBindings(stateDir, started.instanceId)).toEqual([]);
}, 90_000);

/** A second binding of the same repository on its own tunnel and domain. */
async function registerStaging(preview: TunnelServiceOptions): Promise<TunnelServiceOptions> {
  const credentialsFile = path.join(root, "staging.json");
  await writeFile(credentialsFile, "{}", { mode: 0o600 });
  const base = fixtureBinding(preview.binding.repositoryIdentity, credentialsFile, "staging");
  return { ...preview, binding: await registerTunnelBinding(stateDir, { ...base, domain: "staging.example.test", cloudflare: { ...base.cloudflare, tunnelId: "00000000-0000-4000-8000-000000000002" } }) };
}
const STAGED = "web-other-0123456789abcdef0123.staging.example.test";

it("moves an owner's routes off a binding it no longer selects, reporting what the old binding still journals", async () => {
  const preview = await registerPreview();
  const staging = (await registerStaging(preview)).binding;
  await publishTunnelRoutes(preview, "owner", [OTHER]);
  const moved = STAGED;
  provider.failRemove.add(OTHER);
  expect(await publishLifecycleTunnel(stateDir, "owner", { binding: staging, timing: "pre-start", routes: [{ id: "owner:public:web", instanceId: "owner", hostname: moved, targetHost: "127.0.0.1", targetPort: 1, tls: "internal" }],
    hostnames: { web: moved }, urls: { web: `https://${moved}` }, postStart: [] }, config, overrides))
    .toEqual({ hostnames: [moved], urls: { web: `https://${moved}` }, outstanding: [`preview: ${OTHER}: public DNS removal is not confirmed`, `preview: provider failure removing ${OTHER}`] });
  expect(await readOwnerBindings(stateDir, "owner")).toEqual(["preview", "staging"]);
  expect((await readTunnelState(stateDir, "preview")).hostnames).toEqual([]);
  expect((await readTunnelState(stateDir, "staging")).hostnames.map((item) => item.hostname)).toEqual([moved]);
});

it("reports public URLs live only while the running connector routes every one of them", async () => {
  const tunnel = await registerPreview();
  const added = "api-other-0123456789abcdef0123.tunnel.example.test";
  await publishTunnelRoutes(tunnel, "owner", [OTHER]);
  expect(await publicUrlsLive(stateDir, "owner", { binding: "preview", hostnames: [OTHER] })).toBe(true);
  // A name committed for the owner that the running connector does not route is not live.
  const state = await readTunnelState(stateDir, "preview");
  state.hostnames.push({ hostname: added, ownerId: "owner", publishedAt: "now" });
  await writeTunnelState(stateDir, state);
  expect(await publicUrlsLive(stateDir, "owner", { binding: "preview", hostnames: [OTHER, added] })).toBe(false);
});

it("reads no tunnel state for a lifecycle that never published and fails closed for one that may have", async () => {
  const tunnel = await registerPreview();
  await mkdir(tunnelPaths(stateDir, "preview").dir, { recursive: true });
  await writeFile(tunnelPaths(stateDir, "preview").state, "{ not json");
  await writeFile(path.join(stateDir, "tunnels.json"), "{ not json");
  // A never-published lifecycle of the binding's own project starts and stops as in DevFn v0.1.
  await stubLifecycleHost();
  const orchestrator = new DevFnOrchestrator(overrides);
  expect(await orchestrator.up({ config, root, stateDir, allowPublic: true })).toMatchObject({ state: "ready" });
  expect(await orchestrator.down({ config, root, stateDir })).toMatchObject({ state: "stopped", cleanup: { errors: [] } });
  // An owner with a publish-intent marker is not skipped: its withdrawal and recovery fail and are reported.
  await writeFile(path.join(stateDir, "tunnels.json"), JSON.stringify({ version: 1, bindings: [tunnel.binding] }));
  await markOwnerBinding(stateDir, "marked-owner", "preview", true);
  await expect(withdrawLifecycleTunnel(stateDir, "marked-owner", overrides)).rejects.toThrow("is invalid");
  await expect(recoverOrphanedProxyRoutes(stateDir, overrides)).rejects.toMatchObject({ details: { recovered: [], failures: [expect.stringContaining("marked-owner: Public tunnel routes could not be fully withdrawn")] } });
}, 60_000);

it("recovers every other orphan when one orphan's withdrawal fails", async () => {
  const tunnel = await registerPreview();
  const staging = await registerStaging(tunnel);
  const live = "web-live-0123456789abcdef0123.staging.example.test";
  await publishTunnelRoutes(staging, "live-owner", [live]);
  await publishTunnelRoutes(staging, "orphan-a", [STAGED]);
  await publishTunnelRoutes(tunnel, "orphan-b", [OTHER]);
  // orphan-a's exposure cannot be shown ended: its DNS removal fails and the connector it shares with a live owner cannot be replaced.
  provider.failRemove.add(STAGED);
  provider.connector = "exit";
  const recover = async () => await withFileLock(path.join(await realpath(stateDir), "lifecycle-live-owner.lock"), async () => await recoverOrphanedProxyRoutes(stateDir, overrides));
  await expect(recover()).rejects.toMatchObject({ details: { recovered: ["orphan-b"], failures: [expect.stringContaining("orphan-a: Public tunnel routes could not be fully withdrawn")] } });
  expect([...provider.records.keys()].sort()).toEqual([live, STAGED].sort());
  provider.failRemove.clear();
  provider.connector = "ready";
  expect(await recover()).toEqual(["orphan-a"]);
  expect([...provider.records.keys()]).toEqual([live]);
});
