import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { allocateEphemeralPort, FilePortRegistry, withFileLock } from "@devfn/ports";
import { processBirthSignature, processIdentityStatus } from "@devfn/processes";
import { CaddyProxyController, proxyListenerPorts, registerDomain, type ProxyRoute } from "../src/index.js";
import {
  OAUTH_RELAY_OWNER_ID, OAUTH_RELAY_ROUTE_ID, OAuthRelayClient, oauthRelayStatus, readRelayService, recoverOAuthRelayRoute, startOAuthRelay, stopOAuthRelay, type OAuthRelayProxy,
} from "../src/oauth-relay/index.js";
import { createFakeProvider, createOAuthClientApp, FixtureBrowser } from "./fixtures/oauth.js";

const DOMAIN = "dev.example.test";
const loopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as never;
// The relay entry runs from source through tsx; the package build runs dist/oauth-relay/serve.js.
const RELAY_COMMAND = [process.execPath, "--import", createRequire(import.meta.url).resolve("tsx"), fileURLToPath(new URL("../src/oauth-relay/serve.ts", import.meta.url))];

/** Route state in memory, with the controller's per-owner replace semantics. */
function fakeProxy(initial: ProxyRoute[] = []): OAuthRelayProxy & { routes: ProxyRoute[]; removed: string[] } {
  const proxy = {
    routes: [...initial], removed: [] as string[],
    async upsert(routes: readonly Omit<ProxyRoute, "updatedAt">[], instanceId?: string) {
      const owner = instanceId ?? routes[0].instanceId;
      const next = routes.map((route) => ({ ...route, updatedAt: new Date().toISOString() }));
      proxy.routes = [...proxy.routes.filter((route) => route.instanceId !== owner), ...next];
      return next;
    },
    async removeInstance(instanceId: string) { proxy.removed.push(instanceId); proxy.routes = proxy.routes.filter((route) => route.instanceId !== instanceId); },
    async instanceRouteState(instanceId: string) { return { committed: proxy.routes.filter((route) => route.instanceId === instanceId) }; },
  };
  return proxy;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function registeredState(): Promise<string> {
  const stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-oauth-relay-service-")));
  cleanup.push(async () => {
    const service = await readRelayService(stateDir).catch(() => undefined);
    if (service) try { process.kill(-service.pid, "SIGKILL"); } catch { /* stopped */ }
    await rm(stateDir, { recursive: true, force: true });
  });
  await registerDomain(stateDir, { domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, tls: "internal" }, loopback);
  return stateDir;
}

const sibling: ProxyRoute = { id: "owner-a:app:0", instanceId: "owner-a", hostname: `app-a.${DOMAIN}`, targetHost: "127.0.0.1", targetPort: 41234, tls: "internal",
  updatedAt: "2026-01-01T00:00:00.000Z", registeredDomain: DOMAIN, projectId: "fixture", repositoryIdentity: "repo" };

it.skipIf(process.platform === "win32")("starts one relay, survives its crash without touching sibling routes, and stops it by verified identity", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy([sibling]);
  await expect(startOAuthRelay({ stateDir, domain: "other.example.test", projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND }))
    .rejects.toMatchObject({ code: "DEVFN_DOMAIN_UNREGISTERED" });
  await expect(startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "other", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND }))
    .rejects.toMatchObject({ code: "DEVFN_DOMAIN_UNREGISTERED" });
  const started = await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND });
  const { httpsPort } = proxyListenerPorts();
  expect(started).toMatchObject({ running: true, routeActive: true, hostname: `auth.${DOMAIN}`, origin: `https://auth.${DOMAIN}${httpsPort === 443 ? "" : `:${httpsPort}`}` });
  const first = (await readRelayService(stateDir))!;
  expect(proxy.routes.find((route) => route.instanceId === OAUTH_RELAY_OWNER_ID)).toMatchObject({ hostname: `auth.${DOMAIN}`, targetPort: first.port, tls: "internal", registeredDomain: DOMAIN });
  // Starting again reuses the running relay; another origin is refused.
  expect((await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND })).pid).toBe(first.pid);
  await expect(startOAuthRelay({ stateDir, domain: DOMAIN, host: "login", projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND }))
    .rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_UNAVAILABLE" });
  // The route is bound to the relay process, and the relay holds the listener claim as its own registry lifecycle.
  expect(proxy.routes.find((route) => route.instanceId === OAUTH_RELAY_OWNER_ID)?.serviceProcess).toEqual({ pid: first.pid, birthSignature: first.birthSignature });
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  const claims = async () => (await registry.read()).invocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => [item.state, item.proxyListenerPorts]);
  const listeners = [proxyListenerPorts().httpPort, httpsPort];
  expect(await claims()).toEqual([["ready", listeners]]);
  expect(await registry.instanceMayRun(OAUTH_RELAY_OWNER_ID)).toBe(true);
  // A live relay keeps its route through orphan recovery and status.
  expect(await recoverOAuthRelayRoute(stateDir, proxy)).toBe(false);
  expect(await oauthRelayStatus(stateDir, proxy)).toMatchObject({ running: true, routeActive: true });
  process.kill(-first.pid, "SIGKILL");
  for (let attempt = 0; attempt < 100 && await processIdentityStatus(first.pid, first.birthSignature) === "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  // Status after a crash removes the dead relay's route at once and ends its claim.
  expect(await oauthRelayStatus(stateDir, proxy)).toMatchObject({ running: false, routeActive: false });
  expect(proxy.routes).toEqual([sibling]);
  expect((await claims()).map(([state]) => state)).toEqual(["stopped"]);
  // A restart after the crash replaces only the relay's route.
  const restarted = await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND });
  expect(restarted.pid).not.toBe(first.pid);
  expect(proxy.routes).toContainEqual(sibling);
  const second = (await readRelayService(stateDir))!;
  expect((await claims()).map(([state]) => state)).toEqual(["stopped", "ready"]);
  expect(await stopOAuthRelay(stateDir, proxy)).toEqual({ stopped: true, routeRemoved: true });
  expect(await processIdentityStatus(second.pid, second.birthSignature)).not.toBe("running");
  expect(proxy.routes).toEqual([sibling]);
  expect(proxy.removed).toEqual([OAUTH_RELAY_OWNER_ID, OAUTH_RELAY_OWNER_ID]);
  expect((await claims()).map(([state]) => state)).toEqual(["stopped", "stopped"]);
  expect(await oauthRelayStatus(stateDir, proxy)).toMatchObject({ running: false, routeActive: false });
}, 60_000);

it.skipIf(process.platform === "win32")("recovers a crashed relay's route only, and refuses to guess when its record is unreadable", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy([sibling]);
  const started = await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND });
  const record = path.join(stateDir, "oauth-relay", "service.json");
  const valid = await readFile(record, "utf8");
  await writeFile(record, "{");
  expect(await recoverOAuthRelayRoute(stateDir, proxy)).toBe(false);
  await expect(startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND }))
    .rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_STATE_INVALID" });
  await writeFile(record, valid);
  const service = JSON.parse(valid) as { pid: number; birthSignature: string };
  process.kill(-started.pid!, "SIGKILL");
  for (let attempt = 0; attempt < 100 && await processIdentityStatus(service.pid, service.birthSignature) === "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await recoverOAuthRelayRoute(stateDir, proxy)).toBe(true);
  expect(proxy.routes).toEqual([sibling]);
  expect(await readRelayService(stateDir)).toBeUndefined();
}, 60_000);

it("follows the listener claim contract: a sibling lease refuses the start, and the relay's claim covers stopping worktrees", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy([sibling]);
  const { httpPort, httpsPort } = proxyListenerPorts();
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"), undefined, async () => true);
  // A v0.1 profile leases the HTTPS listener port as an exact service port.
  await registry.reserve({ projectId: "fixture", instanceId: "v01", invocationId: "v01-1", profile: "default", requests: [{ name: "web", spec: { preferred: httpsPort, exact: true } }] });
  await expect(startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND }))
    .rejects.toMatchObject({ code: "DEVFN_PORT_CONFLICT", details: { port: httpsPort, instanceId: "v01", service: "web" } });
  expect(await readRelayService(stateDir)).toBeUndefined();
  expect(proxy.routes).toEqual([sibling]);
  expect((await registry.read()).invocations.map((item) => item.instanceId)).toEqual(["v01"]);
  await registry.release({ invocationId: "v01-1" });
  await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND });
  // While the relay claims the listeners, a sibling cannot lease them, and a
  // routed worktree that stops is covered by the relay rather than retained.
  await expect(registry.reserve({ projectId: "fixture", instanceId: "v01", invocationId: "v01-2", profile: "default", requests: [{ name: "web", spec: { preferred: httpPort, exact: true } }] }))
    .rejects.toMatchObject({ code: "DEVFN_PORT_CONFLICT", details: { instanceId: OAUTH_RELAY_OWNER_ID } });
  await registry.reserve({ projectId: "fixture", instanceId: "owner-a", invocationId: "a-1", profile: "default", requests: [], proxyListenerPorts: [httpPort, httpsPort] });
  await registry.markActive("a-1");
  await registry.release({ invocationId: "a-1" });
  expect((await registry.read()).invocations.find((item) => item.id === "a-1")).toMatchObject({ state: "stopped" });
  expect((await registry.read()).invocations.find((item) => item.id === "a-1")?.proxyClaimRetained).toBeUndefined();
  // The relay's loopback backend is a lease of its claim, owned by the relay
  // process, so no sibling lease, planned or bound, can take that port.
  const service = (await readRelayService(stateDir))!;
  const backend = async () => (await registry.read()).allocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => [item.port, item.state, item.process?.pid]);
  expect(await backend()).toEqual([[service.port, "active", service.pid]]);
  await expect(registry.reserve({ projectId: "fixture", instanceId: "v01", invocationId: "v01-3", profile: "default", requests: [{ name: "web", spec: { preferred: service.port, exact: true } }] }))
    .rejects.toMatchObject({ code: "DEVFN_PORT_CONFLICT", details: { port: service.port } });
  // A running relay whose claim ended is replaced, not reused unclaimed.
  await registry.release({ invocationId: service.invocationId });
  const replaced = await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND });
  expect(replaced.pid).not.toBe(service.pid);
  expect(await processIdentityStatus(service.pid, service.birthSignature)).not.toBe("running");
  const next = (await readRelayService(stateDir))!;
  expect((await backend()).filter(([, state]) => state === "active")).toEqual([[next.port, "active", next.pid]]);
  await stopOAuthRelay(stateDir, proxy);
  expect((await backend()).every(([, state]) => state === "released")).toBe(true);
}, 60_000);

it("writes nothing but its readiness line, whatever callbacks it serves", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "devfn-oauth-relay-silent-"));
  cleanup.push(async () => await rm(stateDir, { recursive: true, force: true }));
  const child = spawn(RELAY_COMMAND[0], RELAY_COMMAND.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const leased = await allocateEphemeralPort();
  child.stdin.write(`${JSON.stringify({ stateDir, origin: "https://auth.dev.example.test", nonce: "n", port: leased })}\n`);
  for (let attempt = 0; attempt < 200 && !stdout.includes("\n"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  const { port } = JSON.parse(stdout) as { port: number };
  expect(port).toBe(leased);
  child.stdin.end("commit\n");
  const secret = "st_secretsecretsecretsecretsecret";
  for (const query of [`code=CODE-${secret}&state=${secret}`, `state=${secret}`, "x", `code=a&state=${secret}%0a`]) {
    await new Promise<void>((resolve, reject) => http.get({ hostname: "127.0.0.1", port, path: `/cb?${query}`, headers: { host: "auth.dev.example.test" } }, (response) => {
      response.resume(); response.once("end", resolve);
    }).once("error", reject));
  }
  await writeFile(path.join(stateDir, "oauth-relay", "tickets.json"), "{");
  await new Promise<void>((resolve) => http.get({ hostname: "127.0.0.1", port, path: `/cb?code=CODE-${secret}&state=${secret}`, headers: { host: "auth.dev.example.test" } }, (response) => {
    response.resume(); response.once("end", resolve);
  }));
  child.kill("SIGTERM");
  await exited;
  expect(stdout).toBe(`${JSON.stringify({ nonce: "n", port })}\n`);
  expect(stderr).toBe("");
}, 30_000);

// Opt-in local observation through the real DevFn-owned Caddy, internal TLS,
// the relay process and two worktree apps. The provider is still a fixture.
it.skipIf(process.env.DEVFN_REAL_PROXY !== "1")("completes two worktree sign-ins through real Caddy and one relay hostname", async () => await withFileLock(
  path.join(os.tmpdir(), "devfn-test-caddy-admin.lock"), async () => {
    const stateDir = await registeredState();
    const original = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.XDG_DATA_HOME = path.join(stateDir, "data");
    process.env.XDG_CONFIG_HOME = path.join(stateDir, "config");
    const proxy = new CaddyProxyController(stateDir, loopback);
    cleanup.push(async () => {
      try { process.kill(-(JSON.parse(await readFile(path.join(stateDir, "proxy-owner.json"), "utf8")) as { pid: number }).pid, "SIGTERM"); } catch { /* stopped */ }
      for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
    const relay = await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND });
    const provider = await createFakeProvider(() => [`${relay.origin}/oauth/callback`]);
    const apps = await Promise.all(["owner-a", "owner-b"].map(async (owner) => await createOAuthClientApp({ scheme: "https", callbackPath: "/oauth/callback", provider,
      relay: new OAuthRelayClient({ stateDir, ownerId: owner }) })));
    cleanup.push(async () => { await provider.close(); await Promise.all(apps.map((app) => app.close())); });
    // Both owners are ready lifecycles in the machine registry, which the
    // relay process consults: this test process is the verified owner of the
    // lease on each app's port.
    const registry = new FilePortRegistry(path.join(stateDir, "registry.json"), undefined, async () => true);
    for (const [index, owner] of ["owner-a", "owner-b"].entries()) {
      await registry.reserve({ projectId: "fixture", instanceId: owner, invocationId: owner, profile: "default", requests: [{ name: "app", spec: { preferred: apps[index].port, exact: true } }] });
      await registry.markActive(owner, { app: { process: { pid: process.pid, birthSignature: (await processBirthSignature(process.pid))! } } });
    }
    for (const [index, owner] of ["owner-a", "owner-b"].entries()) {
      await proxy.upsert([{ id: `${owner}:app:0`, instanceId: owner, hostname: `app-${index}.${DOMAIN}`, targetHost: "127.0.0.1", targetPort: apps[index].port, tls: "internal",
        registeredDomain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir }], owner);
    }
    const { httpsPort } = proxyListenerPorts();
    let ca: string | undefined;
    for (let attempt = 0; attempt < 50 && !ca; attempt += 1) {
      ca = await readFile(path.join(stateDir, "data", "caddy", "pki", "authorities", "local", "root.crt"), "utf8").catch(() => undefined);
      if (!ca) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const browser = new FixtureBrowser((url) => url.hostname === "127.0.0.1" ? { port: Number(url.port), tls: false } : { port: httpsPort, tls: true, ca });
    const suffix = httpsPort === 443 ? "" : `:${httpsPort}`;
    // Caddy issues internal certificates asynchronously after a reload.
    for (const host of ["auth", "app-0", "app-1"]) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await browser.request(`https://${host}.${DOMAIN}${suffix}/me`).then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const [a, b] = await Promise.all([browser.navigate(`https://app-0.${DOMAIN}${suffix}/login?user=alice`), browser.navigate(`https://app-1.${DOMAIN}${suffix}/login?user=bob`)]);
    expect([a.at(-1)?.body, b.at(-1)?.body], JSON.stringify([a, b], null, 1)).toEqual(["alice", "bob"]);
    expect(a[2]).toMatchObject({ url: expect.stringContaining(`https://auth.${DOMAIN}${suffix}/oauth/callback?`), status: 303, setCookie: [] });
    expect(provider.tokenRequests.map((request) => request.redirectUri)).toEqual([`${relay.origin}/oauth/callback`, `${relay.origin}/oauth/callback`]);
    expect((await browser.request(a[2].url)).status).toBe(403);
    // A crashed relay's route goes at the next transition that changes routes;
    // one for an owner without routes leaves Caddy untouched. Caddy then no
    // longer serves the callback host at all (no certificate is selected for
    // it); sibling routes stay served.
    process.kill(-relay.pid!, "SIGKILL");
    for (let attempt = 0; attempt < 100 && (await readRelayService(stateDir).then((service) => processIdentityStatus(service!.pid, service!.birthSignature))) === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await proxy.removeInstance("unrelated");
    expect((await browser.request(a[2].url)).status).toBe(502);
    await proxy.removeInstance("owner-a");
    await expect(browser.request(a[2].url)).rejects.toThrow(/EPROTO|alert/);
    expect((await browser.request(`https://app-1.${DOMAIN}${suffix}/me`)).body).toBe("bob");
    expect(await stopOAuthRelay(stateDir, proxy)).toMatchObject({ stopped: false, routeRemoved: false });
  }, { timeoutMs: 120_000 }), 240_000);

it("keeps a relay running only once its starter commits it", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "devfn-oauth-relay-gate-"));
  cleanup.push(async () => await rm(stateDir, { recursive: true, force: true }));
  const child = spawn(RELAY_COMMAND[0], RELAY_COMMAND.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
  cleanup.push(async () => { try { child.kill("SIGKILL"); } catch { /* exited */ } });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const leased = await allocateEphemeralPort();
  child.stdin.write(`${JSON.stringify({ stateDir, origin: "https://auth.dev.example.test", nonce: "n", port: leased })}\n`);
  for (let attempt = 0; attempt < 200 && !stdout.includes("\n"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  const { port } = JSON.parse(stdout) as { port: number };
  expect(port).toBe(leased);
  // The starter's end of stdin closes without a commit, as when it is killed.
  child.stdin.end();
  expect(await exited).toBe(0);
  await expect(new Promise((resolve, reject) => http.get({ hostname: "127.0.0.1", port, path: "/" }, resolve).once("error", reject))).rejects.toThrow(/ECONNREFUSED/);
}, 30_000);

it("stops by every recorded identity when the service record is unreadable, and leaves the record for inspection", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy([sibling]);
  const started = await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND });
  const service = (await readRelayService(stateDir))!;
  cleanup.push(async () => { try { process.kill(-service.pid, "SIGKILL"); } catch { /* stopped */ } });
  const record = path.join(stateDir, "oauth-relay", "service.json");
  await writeFile(record, "{");
  expect(await oauthRelayStatus(stateDir, proxy)).toMatchObject({ running: false, unverified: true });
  await expect(stopOAuthRelay(stateDir, proxy)).rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_STATE_INVALID" });
  expect(started.pid).toBe(service.pid);
  expect(await processIdentityStatus(service.pid, service.birthSignature)).not.toBe("running");
  expect(proxy.routes).toEqual([sibling]);
  expect(await readFile(record, "utf8")).toBe("{");
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  expect((await registry.read()).invocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => item.state)).toEqual(["stopped"]);
}, 60_000);

// A legal 251-character registered domain: auth.<domain> exceeds the 253-character hostname a service record holds.
const LONG_DOMAIN = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(54), "test"].join(".");

it.skipIf(process.platform === "win32")("refuses a relay its service record cannot hold, or an unnormalized domain, before any claim, process or route", async () => {
  const stateDir = await registeredState();
  const longProject = "p".repeat(2048);
  await registerDomain(stateDir, { domain: LONG_DOMAIN, projectId: longProject, repositoryIdentity: stateDir, tls: "internal" }, loopback);
  const proxy = fakeProxy([sibling]);
  const start = (domain: string, host?: string, projectId = longProject, repositoryIdentity = stateDir) => startOAuthRelay({ stateDir, domain, host, projectId, repositoryIdentity, proxy, command: RELAY_COMMAND });
  const rejected = { code: "DEVFN_OAUTH_RELAY_REJECTED", reason: "malformed" };
  for (const host of [undefined, "h".repeat(40)]) await expect(start(LONG_DOMAIN, host)).rejects.toMatchObject(rejected);
  for (const [index, [projectId, repository]] of [[`${longProject}p`, stateDir], ["fix\nture", stateDir], ["fixture", `${stateDir}/re\npo`]].entries()) {
    await mkdir(repository, { recursive: true });
    await registerDomain(stateDir, { domain: `bad-${index}.example.test`, projectId, repositoryIdentity: repository, tls: "internal" }, loopback);
    await expect(start(`bad-${index}.example.test`, undefined, projectId, repository)).rejects.toMatchObject(rejected);
  }
  await expect(start("Dev.Example.Test")).rejects.toMatchObject({ code: "DEVFN_DOMAIN_INVALID" });
  expect(await readRelayService(stateDir)).toBeUndefined();
  expect((await new FilePortRegistry(path.join(stateDir, "registry.json")).read()).invocations).toEqual([]);
  expect(proxy.routes).toEqual([sibling]);
  // A hostname of exactly 253 characters and a 2048-character project ID are served and stopped.
  expect(await start(LONG_DOMAIN, "x")).toMatchObject({ running: true, routeActive: true, hostname: `x.${LONG_DOMAIN}` });
  expect(await stopOAuthRelay(stateDir, proxy)).toEqual({ stopped: true, routeRemoved: true });
}, 60_000);

it.skipIf(process.platform === "win32")("fails a start whose relay exits before the proxy activates its route, leaving no record, claim or route", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy([sibling]);
  const dying: OAuthRelayProxy = { ...proxy, async upsert() {
    const service = (await readRelayService(stateDir))!;
    process.kill(-service.pid, "SIGKILL");
    while (await processIdentityStatus(service.pid, service.birthSignature) === "running") await new Promise((resolve) => setTimeout(resolve, 20));
    return []; } };
  await expect(startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy: dying, command: RELAY_COMMAND }))
    .rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_UNAVAILABLE", message: expect.stringMatching(/exited before its route was activated/) });
  expect(await readRelayService(stateDir)).toBeUndefined();
  expect((await new FilePortRegistry(path.join(stateDir, "registry.json")).read()).invocations.map((item) => item.state)).toEqual(["failed"]);
  expect(proxy.routes).toEqual([sibling]);
}, 60_000);

it("reports a pending relay route that stop withdraws as removed", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy();
  let pending: ProxyRoute[] | undefined = [{ ...sibling, id: OAUTH_RELAY_ROUTE_ID, instanceId: OAUTH_RELAY_OWNER_ID, hostname: `auth.${DOMAIN}` }];
  const journaled: OAuthRelayProxy = { upsert: proxy.upsert, async removeInstance(instanceId) { pending = undefined; await proxy.removeInstance(instanceId); },
    async instanceRouteState(instanceId) { return { ...await proxy.instanceRouteState(instanceId), ...(pending ? { pending } : {}) }; } };
  expect(await stopOAuthRelay(stateDir, journaled)).toEqual({ stopped: false, routeRemoved: true });
  expect(pending).toBeUndefined();
});

it("stops nothing when Caddy cannot remove the relay route, so no callback can reach a freed port", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy([sibling]);
  await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND });
  const service = (await readRelayService(stateDir))!;
  const record = await readFile(path.join(stateDir, "oauth-relay", "service.json"), "utf8");
  const routes = [...proxy.routes];
  const unavailable = { ...proxy, removeInstance: async () => { throw Object.assign(new Error("Caddy is unavailable."), { code: "DEVFN_PROXY_UNAVAILABLE" }); } };
  await expect(stopOAuthRelay(stateDir, unavailable)).rejects.toMatchObject({ code: "DEVFN_PROXY_UNAVAILABLE" });
  expect(await processIdentityStatus(service.pid, service.birthSignature)).toBe("running");
  expect(proxy.routes).toEqual(routes);
  expect(await readFile(path.join(stateDir, "oauth-relay", "service.json"), "utf8")).toBe(record);
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  expect((await registry.read()).invocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => item.state)).toEqual(["ready"]);
  // Once Caddy applies the removal, the same command stops the relay.
  await expect(stopOAuthRelay(stateDir, proxy)).resolves.toEqual({ stopped: true, routeRemoved: true });
  expect(await processIdentityStatus(service.pid, service.birthSignature)).not.toBe("running");
  expect(proxy.routes).toEqual([sibling]);
}, 60_000);

it("withdraws a route that a failed start activated or journaled before it stops the new relay and releases its claim", async () => {
  const relayClaims = async (stateDir: string) => (await new FilePortRegistry(path.join(stateDir, "registry.json")).read()).invocations
    .filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => item.state);
  for (const reached of ["committed", "pending", "none"] as const) {
    const stateDir = await registeredState();
    const proxy = fakeProxy([sibling]);
    let pending: ProxyRoute[] | undefined;
    const steps: string[] = [];
    const failing: OAuthRelayProxy = {
      async upsert(routes, instanceId) {
        // The route reached Caddy or the journal, then the commit failed.
        if (reached === "committed") await proxy.upsert(routes, instanceId);
        if (reached === "pending") pending = routes.map((route) => ({ ...route, updatedAt: new Date().toISOString() }));
        throw Object.assign(new Error("The route state could not be committed."), { code: "DEVFN_PROXY_RELOAD_FAILED" });
      },
      async removeInstance(instanceId) {
        const service = (await readRelayService(stateDir))!;
        steps.push(`remove:${await processIdentityStatus(service.pid, service.birthSignature)}:${(await relayClaims(stateDir)).join()}`);
        pending = undefined;
        await proxy.removeInstance(instanceId);
      },
      async instanceRouteState(instanceId) { return { ...await proxy.instanceRouteState(instanceId), ...(pending ? { pending } : {}) }; },
    };
    await expect(startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy: failing, command: RELAY_COMMAND }))
      .rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED" });
    // A route that reached the proxy is removed while the relay still runs and holds its claim.
    expect(steps).toEqual(reached === "none" ? [] : ["remove:running:ready"]);
    expect(proxy.routes).toEqual([sibling]);
    expect(pending).toBeUndefined();
    expect(await readRelayService(stateDir)).toBeUndefined();
    expect(await relayClaims(stateDir)).toEqual(["failed"]);
  }
}, 90_000);

it("keeps a failed start's relay running, recorded and claimed when its activated route cannot be removed", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy([sibling]);
  const failing: OAuthRelayProxy = {
    ...proxy,
    async upsert(routes, instanceId) {
      await proxy.upsert(routes, instanceId);
      throw Object.assign(new Error("The route state could not be committed."), { code: "DEVFN_PROXY_RELOAD_FAILED" });
    },
    async removeInstance() { throw Object.assign(new Error("Caddy is unavailable."), { code: "DEVFN_PROXY_UNAVAILABLE" }); },
  };
  const error = await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy: failing, command: RELAY_COMMAND }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "DEVFN_OAUTH_RELAY_UNAVAILABLE", message: expect.stringMatching(/could not be committed.*Caddy is unavailable.*keeps running/) });
  const service = (await readRelayService(stateDir))!;
  expect(await processIdentityStatus(service.pid, service.birthSignature)).toBe("running");
  expect(proxy.routes.map((route) => route.id)).toEqual([sibling.id, "devfn-oauth-relay:callback"]);
  expect(proxy.routes.find((route) => route.instanceId === OAUTH_RELAY_OWNER_ID)?.targetPort).toBe(service.port);
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  expect((await registry.read()).invocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => item.state)).toEqual(["ready"]);
  expect((await registry.read()).allocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => [item.port, item.state])).toEqual([[service.port, "active"]]);
  // A removal the proxy reports applied but does not reflect is not confirmed either.
  await expect(stopOAuthRelay(stateDir, { ...proxy, removeInstance: async () => undefined })).rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_UNAVAILABLE" });
  expect(await processIdentityStatus(service.pid, service.birthSignature)).toBe("running");
  // Once the proxy is available, stop withdraws the route and the relay.
  await expect(stopOAuthRelay(stateDir, proxy)).resolves.toEqual({ stopped: true, routeRemoved: true });
  expect(await processIdentityStatus(service.pid, service.birthSignature)).not.toBe("running");
  expect(proxy.routes).toEqual([sibling]);
}, 60_000);

it.skipIf(process.platform === "win32")("names a failed start's relay that does not stop, and keeps its record and claim with no route", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy([sibling]);
  const wrapper = path.join(stateDir, "relay-group.cjs");
  // The recorded relay leads a group with the relay entry; once the leader dies, the group cannot be verified as the relay's.
  await writeFile(wrapper, `const { spawn } = require("node:child_process");
spawn(process.argv[2], process.argv.slice(3), { stdio: "inherit" });
`);
  const failing: OAuthRelayProxy = {
    ...proxy,
    async upsert() {
      const service = (await readRelayService(stateDir))!;
      cleanup.push(async () => { try { process.kill(-service.pid, "SIGKILL"); } catch { /* stopped */ } });
      process.kill(service.pid, "SIGKILL");
      for (let attempt = 0; attempt < 100 && await processIdentityStatus(service.pid, service.birthSignature) === "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      throw Object.assign(new Error("The route state could not be committed."), { code: "DEVFN_PROXY_RELOAD_FAILED" });
    },
  };
  const error = await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy: failing,
    command: [process.execPath, wrapper, ...RELAY_COMMAND] }).catch((caught: unknown) => caught);
  const service = (await readRelayService(stateDir))!;
  expect(error).toMatchObject({ code: "DEVFN_OAUTH_RELAY_UNAVAILABLE",
    message: expect.stringMatching(new RegExp(`could not be committed.*did not stop.*PID ${service.pid}\\b.*record and listener claim.*devfn oauth-relay stop`)) });
  expect(proxy.routes).toEqual([sibling]);
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  expect((await registry.read()).invocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => item.state)).toEqual(["ready"]);
  expect((await registry.read()).allocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => [item.port, item.state])).toEqual([[service.port, "active"]]);
}, 60_000);

it.skipIf(process.platform === "win32")("releases a failed start's relay only after a reload of the committed routes confirms Caddy no longer routes to it", async () => {
  const stateDir = await registeredState();
  const toolsDir = await mkdtemp(path.join(os.tmpdir(), "devfn-oauth-relay-caddy-"));
  const originalPath = process.env.PATH;
  const originalFailures = process.env.DEVFN_TEST_RELOAD_FAILURES;
  cleanup.push(async () => {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalFailures === undefined) delete process.env.DEVFN_TEST_RELOAD_FAILURES; else process.env.DEVFN_TEST_RELOAD_FAILURES = originalFailures;
    await rm(toolsDir, { recursive: true, force: true });
  });
  const live = path.join(toolsDir, "live.Caddyfile");
  const reloads = path.join(toolsDir, "reloads");
  // Every reload loads its configuration; the command then fails, as on a timeout, until DEVFN_TEST_RELOAD_FAILURES reloads have failed.
  await writeFile(path.join(toolsDir, "caddy"), `#!/bin/sh\nif [ "$1" = reload ]; then\n  cp "$3" '${live}'\n  n=$(( $(cat '${reloads}' 2>/dev/null || echo 0) + 1 )); echo "$n" > '${reloads}'\n  [ "$n" -gt "$DEVFN_TEST_RELOAD_FAILURES" ] || exit 1\nfi\nexit 0\n`, { mode: 0o700 });
  process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
  await writeFile(path.join(stateDir, "proxy-owner.json"), JSON.stringify({ pid: process.pid, birthSignature: await processBirthSignature(process.pid) }));
  const statePath = path.join(stateDir, "proxy-routes.json");
  const committed = `${JSON.stringify({ version: 1, routes: [{ id: "s", instanceId: "sibling", hostname: "sibling.localhost", targetHost: "127.0.0.1", targetPort: 41234, tls: "off", updatedAt: "before" }] })}\n`;
  await writeFile(statePath, committed);
  const proxy = new CaddyProxyController(stateDir, loopback);
  const relayHost = `auth.${DOMAIN}`;
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  const claims = async () => (await registry.read()).invocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => item.state);
  // Caddy loaded the relay route, and neither that reload nor a reload of the committed routes is confirmed.
  process.env.DEVFN_TEST_RELOAD_FAILURES = "99";
  const error = await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "DEVFN_OAUTH_RELAY_UNAVAILABLE", message: expect.stringMatching(/possibly live.*keeps running/) });
  const service = (await readRelayService(stateDir))!;
  expect(await processIdentityStatus(service.pid, service.birthSignature)).toBe("running");
  expect(await claims()).toEqual(["ready"]);
  expect((await registry.read()).allocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => [item.port, item.state])).toEqual([[service.port, "active"]]);
  expect(await proxy.instanceRouteState(OAUTH_RELAY_OWNER_ID)).toMatchObject({ committed: [], pending: [expect.objectContaining({ hostname: relayHost, targetPort: service.port })] });
  expect(await readFile(statePath, "utf8")).toBe(committed);
  // Once Caddy reloads the committed routes, stop withdraws the route, then the relay.
  process.env.DEVFN_TEST_RELOAD_FAILURES = "0";
  await expect(stopOAuthRelay(stateDir, proxy)).resolves.toMatchObject({ stopped: true });
  expect(await readFile(live, "utf8")).not.toContain(relayHost);
  expect(await processIdentityStatus(service.pid, service.birthSignature)).not.toBe("running");
  expect(await readFile(statePath, "utf8")).toBe(committed);
  // A reload that fails after loading the relay route is released only once the committed reload confirms the route gone.
  await rm(reloads);
  process.env.DEVFN_TEST_RELOAD_FAILURES = "1";
  await expect(startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND }))
    .rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED" });
  expect(await readFile(live, "utf8")).toContain("sibling.localhost");
  expect(await readFile(live, "utf8")).not.toContain(relayHost);
  expect(await readRelayService(stateDir)).toBeUndefined();
  expect(await claims()).toEqual(["stopped", "failed"]);
  expect(await readFile(statePath, "utf8")).toBe(committed);
}, 90_000);

it("does not declare the relay stopped while a route or claim records a live relay the service record does not name", async () => {
  const stateDir = await registeredState();
  const live = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, stdio: "ignore" });
  cleanup.push(async () => { try { process.kill(-live.pid!, "SIGKILL"); } catch { /* stopped */ } });
  const identity = { pid: live.pid!, birthSignature: (await processBirthSignature(live.pid!))! };
  const relayRoute: ProxyRoute = { ...sibling, id: "devfn-oauth-relay:callback", instanceId: OAUTH_RELAY_OWNER_ID, hostname: `auth.${DOMAIN}`, targetPort: 41999, serviceProcess: identity };
  // No service record: the route still names a live relay process.
  const proxy = fakeProxy([sibling, relayRoute]);
  expect(await recoverOAuthRelayRoute(stateDir, proxy)).toBe(false);
  expect(await oauthRelayStatus(stateDir, proxy)).toMatchObject({ running: false, unverified: true });
  expect(proxy.routes).toEqual([sibling, relayRoute]);
  await expect(startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND }))
    .rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_STATE_INVALID" });
  // Without the route, a relay claim recording the live process keeps it unverified too.
  const bare = fakeProxy([sibling]);
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  await registry.reserve({ projectId: "fixture", instanceId: OAUTH_RELAY_OWNER_ID, invocationId: "relay-1", profile: "oauth-relay", requests: [] });
  await registry.recordOwners("relay-1", "oauth-relay", [{ process: identity }]);
  await registry.markActive("relay-1");
  expect(await recoverOAuthRelayRoute(stateDir, bare)).toBe(false);
  expect((await registry.read()).invocations.find((item) => item.id === "relay-1")).toMatchObject({ state: "ready" });
  // stop ends it by that identity.
  expect(await stopOAuthRelay(stateDir, proxy)).toEqual({ stopped: true, routeRemoved: true });
  expect(await processIdentityStatus(identity.pid, identity.birthSignature)).not.toBe("running");
  expect(await oauthRelayStatus(stateDir, proxy)).toMatchObject({ running: false, routeActive: false });
  expect((await oauthRelayStatus(stateDir, proxy)).unverified).toBeUndefined();
}, 60_000);

it("leaves no unrecorded relay running when its starter is killed after the relay is ready", async () => {
  const stateDir = await registeredState();
  const readyFile = path.join(stateDir, "relay-ready");
  const wrapper = path.join(stateDir, "relay-wrapper.mjs");
  const starter = path.join(stateDir, "starter.mts");
  // The wrapper marks the moment the relay has written its readiness line.
  await writeFile(wrapper, `import { writeFileSync } from "node:fs";
const end = process.stdout.end.bind(process.stdout);
process.stdout.end = (...args) => { const result = end(...args); writeFileSync(${JSON.stringify(readyFile)}, String(process.pid)); return result; };
await import(${JSON.stringify(new URL("../src/oauth-relay/serve.ts", import.meta.url).href)});
`);
  await writeFile(starter, `import { startOAuthRelay } from ${JSON.stringify(new URL("../src/oauth-relay/index.ts", import.meta.url).href)};
const proxy = { upsert: async (routes) => routes, removeInstance: async () => undefined, instanceRouteState: async () => ({ committed: [] }) };
await startOAuthRelay({ stateDir: ${JSON.stringify(stateDir)}, domain: ${JSON.stringify(DOMAIN)}, projectId: "fixture", repositoryIdentity: ${JSON.stringify(stateDir)}, proxy,
  command: ${JSON.stringify([...RELAY_COMMAND.slice(0, -1), wrapper])} });
setInterval(() => undefined, 1000);
`);
  const child = spawn(RELAY_COMMAND[0], [...RELAY_COMMAND.slice(1, -1), starter], { stdio: "ignore" });
  cleanup.push(async () => { try { child.kill("SIGKILL"); } catch { /* exited */ } });
  let relayPid: number | undefined;
  for (let attempt = 0; attempt < 600 && !relayPid; attempt += 1) {
    relayPid = Number(await readFile(readyFile, "utf8").catch(() => "")) || undefined;
    if (!relayPid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill("SIGKILL");
  expect(relayPid).toBeDefined();
  cleanup.push(async () => { try { process.kill(-relayPid!, "SIGKILL"); } catch { /* stopped */ } });
  const alive = () => { try { process.kill(relayPid!, 0); return true; } catch { return false; } };
  for (let attempt = 0; attempt < 100 && alive(); attempt += 1) {
    if ((await readRelayService(stateDir).catch(() => undefined))?.pid === relayPid) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Either the relay was committed with a durable record, or it exited with its starter.
  const recorded = (await readRelayService(stateDir).catch(() => undefined))?.pid === relayPid;
  expect(recorded || !alive()).toBe(true);
}, 60_000);

it.skipIf(process.platform === "win32")("counts the relay stopped only when its whole process group is gone", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy([sibling]);
  const wrapper = path.join(stateDir, "relay-group.cjs");
  // The recorded relay leads a group with the relay entry and a member that ignores SIGTERM.
  await writeFile(wrapper, `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [pidFile, ...relay] = process.argv.slice(2);
spawn(process.execPath, ["-e", \`process.on("SIGTERM", () => undefined); require("node:fs").writeFileSync(\${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => undefined, 1000);\`], { stdio: "ignore" });
const wait = () => fs.existsSync(pidFile) ? spawn(relay[0], relay.slice(1), { stdio: "inherit" }) : setTimeout(wait, 10);
wait();
`);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  const claims = async () => (await registry.read()).invocations.filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => item.state);
  const start = async (pidFile: string) => await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy,
    command: [process.execPath, wrapper, path.join(stateDir, pidFile), ...RELAY_COMMAND] });

  // stop forces the member that ignored SIGTERM before it releases anything.
  const first = await start("member-1");
  const member = Number(await readFile(path.join(stateDir, "member-1"), "utf8"));
  cleanup.push(async () => { try { process.kill(member, "SIGKILL"); } catch { /* stopped */ } });
  expect(await stopOAuthRelay(stateDir, proxy)).toEqual({ stopped: true, routeRemoved: true });
  expect(alive(member)).toBe(false);
  expect(alive(first.pid!)).toBe(false);
  expect(await claims()).toEqual(["stopped"]);
  expect(await readRelayService(stateDir)).toBeUndefined();

  // A group that outlives its leader cannot be verified as the relay's: it keeps
  // its route, record and claim, refuses a new start, and stop signals none of it.
  const second = await start("member-2");
  const service = (await readRelayService(stateDir))!;
  const survivor = Number(await readFile(path.join(stateDir, "member-2"), "utf8"));
  cleanup.push(async () => { try { process.kill(-second.pid!, "SIGKILL"); } catch { /* stopped */ } });
  const record = await readFile(path.join(stateDir, "oauth-relay", "service.json"), "utf8");
  process.kill(second.pid!, "SIGKILL");
  for (let attempt = 0; attempt < 100 && await processIdentityStatus(service.pid, service.birthSignature) === "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const routes = [...proxy.routes];
  expect(await recoverOAuthRelayRoute(stateDir, proxy)).toBe(false);
  expect(await oauthRelayStatus(stateDir, proxy)).toMatchObject({ running: false, unverified: true });
  expect(proxy.routes).toEqual(routes);
  await expect(start("member-3")).rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_STATE_INVALID" });
  await expect(stopOAuthRelay(stateDir, proxy)).rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_UNAVAILABLE" });
  expect(alive(survivor)).toBe(true);
  expect(await readFile(path.join(stateDir, "oauth-relay", "service.json"), "utf8")).toBe(record);
  expect(await claims()).toEqual(["stopped", "ready"]);
}, 90_000);

it("retires an unclaimed relay route-first: a failed replacement leaves no relay route, and a failed withdrawal leaves the old relay running", async () => {
  const relayClaims = async (stateDir: string) => (await new FilePortRegistry(path.join(stateDir, "registry.json")).read()).invocations
    .filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => item.state);
  for (const failure of ["claim", "launch", "withdrawal"] as const) {
    const stateDir = await registeredState();
    const proxy = fakeProxy([sibling]);
    await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy, command: RELAY_COMMAND });
    const old = (await readRelayService(stateDir))!;
    cleanup.push(async () => { try { process.kill(-old.pid, "SIGKILL"); } catch { /* stopped */ } });
    const registry = new FilePortRegistry(path.join(stateDir, "registry.json"), undefined, async () => true);
    await registry.release({ invocationId: old.invocationId });
    if (failure === "claim") await registry.reserve({ projectId: "fixture", instanceId: "v01", invocationId: "v01-1", profile: "default", requests: [{ name: "web", spec: { preferred: proxyListenerPorts().httpsPort, exact: true } }] });
    const record = await readFile(path.join(stateDir, "oauth-relay", "service.json"), "utf8");
    const routes = JSON.stringify(proxy.routes);
    const steps: string[] = [];
    const observed: OAuthRelayProxy = {
      ...proxy,
      async removeInstance(instanceId) {
        steps.push(`remove:${await processIdentityStatus(old.pid, old.birthSignature)}`);
        if (failure === "withdrawal") throw Object.assign(new Error("Caddy is unavailable."), { code: "DEVFN_PROXY_UNAVAILABLE" });
        await proxy.removeInstance(instanceId);
      },
    };
    await expect(startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy: observed,
      command: failure === "launch" ? [process.execPath, "-e", "process.exit(1)"] : RELAY_COMMAND }))
      .rejects.toMatchObject({ code: { claim: "DEVFN_PORT_CONFLICT", launch: "DEVFN_OAUTH_RELAY_UNAVAILABLE", withdrawal: "DEVFN_PROXY_UNAVAILABLE" }[failure] });
    // The old relay's route went while the relay still ran, before it was signalled.
    expect(steps).toEqual(["remove:running"]);
    if (failure === "withdrawal") {
      expect(await processIdentityStatus(old.pid, old.birthSignature)).toBe("running");
      expect(JSON.stringify(proxy.routes)).toBe(routes);
      expect(await readFile(path.join(stateDir, "oauth-relay", "service.json"), "utf8")).toBe(record);
      continue;
    }
    expect(await processIdentityStatus(old.pid, old.birthSignature)).not.toBe("running");
    expect(proxy.routes).toEqual([sibling]);
    expect(await readRelayService(stateDir)).toBeUndefined();
    expect(await relayClaims(stateDir)).not.toContain("ready");
  }
}, 90_000);

it("removes a committed or pending relay route that does not reach the live recorded relay, through recovery and status, and keeps the relay", async () => {
  const stateDir = await registeredState();
  const proxy = fakeProxy([sibling]);
  let pending: ProxyRoute[] | undefined;
  const journaled: OAuthRelayProxy = {
    ...proxy,
    async removeInstance(instanceId) { pending = undefined; await proxy.removeInstance(instanceId); },
    async instanceRouteState(instanceId) { return { ...await proxy.instanceRouteState(instanceId), ...(pending ? { pending } : {}) }; },
  };
  const start = async () => await startOAuthRelay({ stateDir, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir, proxy: journaled, command: RELAY_COMMAND });
  await start();
  const service = (await readRelayService(stateDir))!;
  const record = await readFile(path.join(stateDir, "oauth-relay", "service.json"), "utf8");
  const route = proxy.routes.find((item) => item.instanceId === OAUTH_RELAY_OWNER_ID)!;
  const siblingJson = JSON.stringify(sibling);
  const claims = async () => (await new FilePortRegistry(path.join(stateDir, "registry.json")).read()).invocations
    .filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID).map((item) => item.state);
  // As a starter killed between committing a replacement relay and routing it
  // would leave behind: the previous, dead relay's route to its former port.
  const previous = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
  const dead = { pid: previous.pid!, birthSignature: (await processBirthSignature(previous.pid!))! };
  previous.kill("SIGKILL");
  await new Promise((resolve) => previous.once("exit", resolve));
  const formerPort = await allocateEphemeralPort();
  proxy.routes = [sibling, { ...route, targetPort: formerPort, serviceProcess: dead }];
  expect(await recoverOAuthRelayRoute(stateDir, journaled)).toBe(true);
  expect(proxy.routes.map((item) => JSON.stringify(item))).toEqual([siblingJson]);
  expect(await processIdentityStatus(service.pid, service.birthSignature)).toBe("running");
  expect(await readFile(path.join(stateDir, "oauth-relay", "service.json"), "utf8")).toBe(record);
  expect(await claims()).toEqual(["ready"]);
  // The next start reuses the live relay and routes it again.
  expect((await start()).pid).toBe(service.pid);
  expect(proxy.routes.find((item) => item.instanceId === OAUTH_RELAY_OWNER_ID)).toMatchObject({ targetPort: service.port, serviceProcess: { pid: service.pid } });
  // A pending relay route to another host is withdrawn by status, with the committed one.
  pending = [{ ...route, hostname: `login.${DOMAIN}` }];
  expect(await oauthRelayStatus(stateDir, journaled)).toMatchObject({ running: true, routeActive: false, pid: service.pid });
  expect(pending).toBeUndefined();
  expect(proxy.routes.map((item) => JSON.stringify(item))).toEqual([siblingJson]);
  expect(await processIdentityStatus(service.pid, service.birthSignature)).toBe("running");
  expect(await claims()).toEqual(["ready"]);
  // A route that reaches the live relay is kept.
  await start();
  const routed = JSON.stringify(proxy.routes);
  expect(await oauthRelayStatus(stateDir, journaled)).toMatchObject({ running: true, routeActive: true });
  expect(JSON.stringify(proxy.routes)).toBe(routed);
}, 60_000);
