import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FilePortRegistry, allocateEphemeralPort } from "@devfn/ports";
import { processBirthSignature } from "@devfn/processes";
import { proxyListenerPorts } from "../src/index.js";
import {
  consumeOAuthRelayCallback, createOAuthRelayHandler, OAUTH_RELAY_OWNER_ID, OAUTH_RELAY_ROUTE_ID, OAuthRelayClient, registerOAuthRelayState, stateDigest,
} from "../src/oauth-relay/index.js";
import { createFakeProvider, createOAuthClientApp, FixtureBrowser, type FakeProvider, type OAuthClientApp } from "./fixtures/oauth.js";

const DOMAIN = "dev.example.test";
const { httpsPort } = proxyListenerPorts();
const portSuffix = httpsPort === 443 ? "" : `:${httpsPort}`;
const RELAY_ORIGIN = `https://auth.${DOMAIN}${portSuffix}`;
const CALLBACK_PATH = "/oauth/callback";
const REDIRECT_URI = `${RELAY_ORIGIN}${CALLBACK_PATH}`;
const origin = (host: string) => `https://${host}.${DOMAIN}${portSuffix}`;
const state = (label: string) => `st_${label.padEnd(30, "x")}`;

interface Route { id: string; instanceId: string; hostname: string; targetPort: number; updatedAt: string; path?: string; match?: "exact" | "prefix" }

/**
 * One machine state directory with a recorded relay (served in-process by
 * this test process), two worktree owners and committed routes written as
 * the proxy controller writes them. `route` resolution stands in for DNS
 * plus Caddy and reads the same committed route state.
 */
async function machine() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-oauth-relay-"));
  const live = new Set(["owner-a", "owner-b"]);
  const ownerLive = async (owner: string) => live.has(owner);
  const relayServer = http.createServer(createOAuthRelayHandler({ stateDir, origin: RELAY_ORIGIN, ownerLive }));
  await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
  const relayPort = (relayServer.address() as { port: number }).port;
  const birthSignature = await processBirthSignature(process.pid);
  await mkdir(path.join(stateDir, "oauth-relay"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, "oauth-relay", "service.json"), JSON.stringify({ version: 1, pid: process.pid, birthSignature, startedAt: new Date().toISOString(),
    port: relayPort, origin: RELAY_ORIGIN, hostname: `auth.${DOMAIN}`, domain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir }));
  const routes: Route[] = [{ id: OAUTH_RELAY_ROUTE_ID, instanceId: OAUTH_RELAY_OWNER_ID, hostname: `auth.${DOMAIN}`, targetPort: relayPort, updatedAt: "2026-01-01T00:00:00.000Z" }];
  const writeRoutes = async (file = "proxy-routes.json", list = routes) => await writeFile(path.join(stateDir, file), JSON.stringify({ version: 1, routes: list.map((route) => ({
    ...route, targetHost: "127.0.0.1", tls: "internal", registeredDomain: DOMAIN, projectId: "fixture", repositoryIdentity: stateDir })) }));
  const provider = await createFakeProvider(() => [REDIRECT_URI]);
  const apps: Record<string, OAuthClientApp> = {};
  for (const [owner, host] of [["owner-a", "app-a"], ["owner-b", "app-b"]] as const) {
    apps[owner] = await createOAuthClientApp({ scheme: "https", callbackPath: CALLBACK_PATH, provider,
      relay: new OAuthRelayClient({ stateDir, ownerId: owner, ownerLive }) });
    routes.push({ id: `${owner}:app:0`, instanceId: owner, hostname: `${host}.${DOMAIN}`, targetPort: apps[owner].port, updatedAt: "2026-01-01T00:00:00.000Z" });
  }
  await writeRoutes();
  const connect = (url: URL) => {
    if (url.hostname === "127.0.0.1") return { port: Number(url.port), tls: false };
    const route = routes.find((item) => item.hostname === url.hostname);
    if (!route || url.protocol !== "https:" || url.port !== String(httpsPort === 443 ? "" : httpsPort)) throw new Error(`No route serves ${url.origin}`);
    return { port: route.targetPort, tls: false };
  };
  return {
    stateDir, live, ownerLive, routes, writeRoutes, provider, apps, connect, relayPort,
    browser: () => new FixtureBrowser(connect),
    close: async () => {
      relayServer.closeAllConnections();
      await new Promise<void>((resolve) => relayServer.close(() => resolve()));
      await Promise.all([provider.close(), ...Object.values(apps).map((app) => app.close())]);
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

type Machine = Awaited<ReturnType<typeof machine>>;
let current: Machine | undefined;
afterEach(async () => { await current?.close(); current = undefined; });
const setup = async () => (current = await machine());

/** Every file under a directory, recursively, as text. */
async function allText(dir: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += await readFile(path.join(entry.parentPath, entry.name), "utf8");
  }
  return text;
}

/** A raw request to the relay listener; fetch cannot set Host. */
async function relayRequest(m: Machine, query: string, options: { method?: string; host?: string } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return await new Promise((resolve, reject) => {
    const call = http.request({ hostname: "127.0.0.1", port: m.relayPort, path: `${CALLBACK_PATH}?${query}`, method: options.method ?? "GET",
      headers: { host: options.host ?? new URL(RELAY_ORIGIN).host } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += String(chunk); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    });
    call.on("error", reject);
    call.end();
  });
}

/** Register a ticket for owner-a's route through the public API. */
const registerA = async (m: Machine, value: string, extra: Partial<Parameters<typeof registerOAuthRelayState>[1]> = {}) =>
  await registerOAuthRelayState(m.stateDir, { ownerId: "owner-a", state: value, redirectUri: REDIRECT_URI, callbackUrl: `${origin("app-a")}${CALLBACK_PATH}`, ...extra }, { ownerLive: m.ownerLive });
const callback = (m: Machine, value: string, extra = "") => ({ origin: RELAY_ORIGIN, requestOrigin: RELAY_ORIGIN, requestPath: CALLBACK_PATH, rawQuery: `code=c0de&state=${value}${extra}` });
const consume = async (m: Machine, input: ReturnType<typeof callback>, now?: () => Date) =>
  await consumeOAuthRelayCallback(m.stateDir, input, { ownerLive: m.ownerLive, ...(now ? { now } : {}) });

describe("OAuth relay fixture journey", () => {
  it("completes two simultaneous worktree sign-ins through one registered redirect URI without mixing sessions", async () => {
    const m = await setup();
    const browser = m.browser();
    const [alice, bob] = await Promise.all([
      browser.navigate(`${origin("app-a")}/login?user=alice`),
      browser.navigate(`${origin("app-b")}/login?user=bob`),
    ]);
    for (const [hops, host, user, app] of [[alice, "app-a", "alice", m.apps["owner-a"]], [bob, "app-b", "bob", m.apps["owner-b"]]] as const) {
      // login -> provider -> relay -> worktree callback -> /me
      expect(hops.map((hop) => new URL(hop.url).hostname)).toEqual([`${host}.${DOMAIN}`, "127.0.0.1", `auth.${DOMAIN}`, `${host}.${DOMAIN}`, `${host}.${DOMAIN}`]);
      expect(hops.at(-1)).toMatchObject({ status: 200, body: user });
      const relayHop = hops[2];
      expect(relayHop.status).toBe(303);
      expect(relayHop.setCookie).toEqual([]);
      // The provider's query reaches the worktree byte-exact.
      expect(new URL(relayHop.location!).search).toBe(new URL(relayHop.url).search);
      expect(relayHop.location!.startsWith(`${origin(host)}${CALLBACK_PATH}?`)).toBe(true);
      expect(new URL(hops[1].url).searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(app.callbacks).toEqual([{ ok: true }]);
    }
    // The token exchange repeated the one registered redirect URI.
    expect(m.provider.tokenRequests).toEqual([{ redirectUri: REDIRECT_URI, ok: true }, { redirectUri: REDIRECT_URI, ok: true }]);
    // Host-only sessions: each worktree host holds only its own session, the relay none.
    expect(browser.jar.get(`auth.${DOMAIN}`)).toBeUndefined();
    expect((await browser.request(`${origin("app-a")}/me`)).body).toBe("alice");
    expect((await browser.request(`${origin("app-b")}/me`)).body).toBe("bob");
    const sidA = browser.jar.get(`app-a.${DOMAIN}`)!.get("sid")!;
    expect(m.apps["owner-b"].sessions.has(sidA)).toBe(false);
    // A replayed provider callback is refused by the relay.
    const replay = await browser.request(alice[2].url);
    expect(replay).toMatchObject({ status: 403, body: "DEVFN_OAUTH_RELAY_REJECTED: replayed\n" });
    // Delivering one worktree's callback to the other fails that client's own state check.
    const crossed = await browser.request(`${origin("app-b")}${CALLBACK_PATH}${new URL(alice[2].location!).search}`);
    expect(crossed).toMatchObject({ status: 400, body: "state_mismatch" });
    // No state, code, verifier, token or client secret is in relay state.
    const persisted = await allText(m.stateDir);
    for (const secret of [...m.provider.issuedCodes, ...m.provider.issuedTokens, m.provider.clientSecret, ...Object.values(m.apps).flatMap((app) => app.verifiers),
      new URL(alice[1].url).searchParams.get("state")!, new URL(bob[1].url).searchParams.get("state")!]) {
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).toContain(stateDigest(new URL(alice[1].url).searchParams.get("state")!));
  });

  it("keeps PKCE and the registered redirect URI effective at the token exchange", async () => {
    const m = await setup();
    // An intercepted code is useless without the worktree's verifier, and a
    // code redeemed with any other redirect URI is refused.
    for (const [redirectUri, verifier, error] of [[REDIRECT_URI, "wrong-verifier-wrong-verifier-wrong-verifier", "pkce_failed"], [`${origin("app-a")}${CALLBACK_PATH}`, "x", "redirect_uri_mismatch"]]) {
      const hops = await m.browser().navigate(`${origin("app-a")}/login?user=alice`, 2);
      const code = new URL(hops[1].location!).searchParams.get("code")!;
      const response = await fetch(new URL("/token", m.provider.origin), { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code,
        redirect_uri: redirectUri, client_id: m.provider.clientId, client_secret: m.provider.clientSecret, code_verifier: verifier }) });
      expect(await response.json()).toEqual({ error });
    }
  });
});

describe("OAuth relay ticket contract", () => {
  it("binds registration to the owner's own live route and refuses forged or arbitrary targets", async () => {
    const m = await setup();
    await expect(registerA(m, state("own"))).resolves.toMatchObject({ expiresAt: expect.any(String) });
    for (const [callbackUrl, reason] of [
      [`${origin("app-b")}${CALLBACK_PATH}`, "target-invalid"], // another owner's route
      [`https://evil.example${CALLBACK_PATH}`, "target-invalid"], // not a DevFn route
      [`http://app-a.${DOMAIN}${CALLBACK_PATH}`, "target-invalid"], // wrong scheme for the route
      [`${RELAY_ORIGIN}${CALLBACK_PATH}`, "target-invalid"], // the relay itself
      [`${origin("app-a")}/a/../oauth/callback`, "malformed"],
      [`${origin("app-a")}${CALLBACK_PATH}?next=https://evil.example`, "malformed"],
      [`https://user:pw@app-a.${DOMAIN}${portSuffix}${CALLBACK_PATH}`, "malformed"],
      [`${origin("app-a")}/%2e%2e/x`, "malformed"],
    ]) {
      await expect(registerA(m, state(callbackUrl.length.toString() + reason), { callbackUrl }), callbackUrl)
        .rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_REJECTED", reason });
    }
    await expect(registerA(m, state("origin"), { redirectUri: `${origin("app-a")}${CALLBACK_PATH}` })).rejects.toMatchObject({ reason: "wrong-origin" });
    await expect(registerA(m, "short")).rejects.toMatchObject({ reason: "malformed" });
    await expect(registerA(m, state("reserved"), { ownerId: OAUTH_RELAY_OWNER_ID })).rejects.toMatchObject({ reason: "malformed" });
    await expect(registerA(m, state("ttl"), { expiresInSeconds: 3600 })).rejects.toMatchObject({ reason: "malformed" });
    m.live.delete("owner-a");
    await expect(registerA(m, state("stale"))).rejects.toMatchObject({ reason: "stale-owner" });
  });

  it("refuses rebinding a state, even to the same target", async () => {
    const m = await setup();
    await registerA(m, state("bound"));
    await expect(registerA(m, state("bound"))).rejects.toMatchObject({ reason: "target-mutated" });
    m.live.add("owner-b");
    await expect(registerOAuthRelayState(m.stateDir, { ownerId: "owner-b", state: state("bound"), redirectUri: REDIRECT_URI, callbackUrl: `${origin("app-b")}${CALLBACK_PATH}` }, { ownerLive: m.ownerLive }))
      .rejects.toMatchObject({ reason: "target-mutated" });
  });

  it("forwards only to the bound route and rejects stale owners, stopped or changed routes, expiry and wrong origins", async () => {
    const m = await setup();
    for (const label of ["ok", "stopped", "restarted", "moved", "dead", "origin", "path", "pending"]) await registerA(m, state(label));
    await registerA(m, state("expired"), { expiresInSeconds: 1 });
    // Host or path not on the registered redirect URI.
    await expect(consume(m, { ...callback(m, state("origin")), requestOrigin: origin("app-a") })).rejects.toMatchObject({ reason: "wrong-origin" });
    await expect(consume(m, { ...callback(m, state("path")), requestPath: "/other" })).rejects.toMatchObject({ reason: "wrong-origin" });
    // The wrong-host attempt did not consume; the wrong-path attempt did.
    await expect(consume(m, callback(m, state("origin")))).resolves.toMatchObject({ location: `${origin("app-a")}${CALLBACK_PATH}?code=c0de&state=${state("origin")}` });
    await expect(consume(m, callback(m, state("path")))).rejects.toMatchObject({ reason: "replayed" });
    await expect(consume(m, callback(m, state("ok"), "&redirect_uri=https://evil.example&target=x"))).resolves.toEqual({
      location: `${origin("app-a")}${CALLBACK_PATH}?code=c0de&state=${state("ok")}&redirect_uri=https://evil.example&target=x` });
    await expect(consume(m, callback(m, state("never")))).rejects.toMatchObject({ reason: "unknown-state" });
    // Two seconds after now is past the one-second ticket, however slowly it was registered.
    await expect(consume(m, callback(m, state("expired")), () => new Date(Date.now() + 2_000))).rejects.toMatchObject({ reason: "expired" });
    await expect(consume(m, callback(m, state("expired")))).rejects.toMatchObject({ reason: "unknown-state" });
    m.live.delete("owner-a");
    await expect(consume(m, callback(m, state("dead")))).rejects.toMatchObject({ reason: "stale-owner" });
    m.live.add("owner-a");
    const own = m.routes.find((route) => route.instanceId === "owner-a")!;
    await m.writeRoutes("proxy-routes.pending.json", m.routes.filter((route) => route !== own));
    await expect(consume(m, callback(m, state("pending")))).rejects.toMatchObject({ reason: "route-stopped" });
    await rm(path.join(m.stateDir, "proxy-routes.pending.json"));
    own.targetPort = await allocateEphemeralPort();
    await m.writeRoutes();
    await expect(consume(m, callback(m, state("moved")))).rejects.toMatchObject({ reason: "target-mutated" });
    own.updatedAt = "2026-02-01T00:00:00.000Z";
    await m.writeRoutes();
    await expect(consume(m, callback(m, state("restarted")))).rejects.toMatchObject({ reason: "stale-owner" });
    await m.writeRoutes("proxy-routes.json", m.routes.filter((route) => route !== own));
    await expect(consume(m, callback(m, state("stopped")))).rejects.toMatchObject({ reason: "route-stopped" });
  });

  it("rejects malformed and parameter-polluted callbacks before touching a ticket", async () => {
    const m = await setup();
    await registerA(m, state("poll"));
    for (const rawQuery of [`state=${state("poll")}`, `code=a&code=b&state=${state("poll")}`, `code=a&state=${state("poll")}&state=${state("other")}`,
      `code=a&error=x&state=${state("poll")}`, `code=a%0d%0aSet-Cookie:x&state=${state("poll")} `]) {
      await expect(consume(m, { ...callback(m, ""), rawQuery })).rejects.toMatchObject({ reason: "malformed" });
    }
    await expect(consume(m, { ...callback(m, ""), rawQuery: `error=access_denied&state=${state("poll")}` })).resolves.toMatchObject({ location: expect.stringContaining("error=access_denied") });
  });

  it("lets exactly one of many concurrent replays through", async () => {
    const m = await setup();
    await registerA(m, state("race"));
    const statuses = (await Promise.all(Array.from({ length: 16 }, async () => await relayRequest(m, `code=c0de&state=${state("race")}`)))).map((result) => result.status);
    expect(statuses.filter((status) => status === 303)).toHaveLength(1);
    expect(statuses.filter((status) => status === 403)).toHaveLength(15);
  });

  it("answers only GET on the relay origin and never sets cookies", async () => {
    const m = await setup();
    await registerA(m, state("http"));
    const query = `code=c0de&state=${state("http")}`;
    expect((await relayRequest(m, query, { method: "POST" })).status).toBe(405);
    expect(await relayRequest(m, query, { host: `app-a.${DOMAIN}${portSuffix}` })).toMatchObject({ status: 421, body: "DEVFN_OAUTH_RELAY_REJECTED: wrong-origin\n" });
    const ok = await relayRequest(m, query);
    expect(ok.status).toBe(303);
    expect(ok.headers["set-cookie"]).toBeUndefined();
    expect(ok.headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
  });

  it("fails closed without rewriting state it cannot verify", async () => {
    const m = await setup();
    await registerA(m, state("intact"));
    const tickets = path.join(m.stateDir, "oauth-relay", "tickets.json");
    const corrupt = (await readFile(tickets, "utf8")).replace(/"ownerId": "owner-a"/, '"ownerId": 7');
    await writeFile(tickets, corrupt);
    await expect(consume(m, callback(m, state("intact")))).rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_STATE_INVALID" });
    await expect(registerA(m, state("new"))).rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_STATE_INVALID" });
    expect(await relayRequest(m, `code=c0de&state=${state("intact")}`)).toMatchObject({ status: 503, body: "DEVFN_OAUTH_RELAY_STATE_INVALID\n" });
    expect(await readFile(tickets, "utf8")).toBe(corrupt);
    // Unreadable route state cannot establish ownership either.
    await writeFile(tickets, JSON.stringify({ version: 1, tickets: [] }));
    await registerA(m, state("routes"));
    await writeFile(path.join(m.stateDir, "proxy-routes.json"), "{");
    await expect(consume(m, callback(m, state("routes")))).rejects.toMatchObject({ code: "DEVFN_OAUTH_RELAY_STATE_INVALID" });
  });

  it("uses the machine registry's lifecycle journal as owner liveness by default", async () => {
    const m = await setup();
    const registry = new FilePortRegistry(path.join(m.stateDir, "registry.json"));
    const port = await allocateEphemeralPort();
    await registry.reserve({ projectId: "fixture", instanceId: "owner-a", invocationId: "a-1", profile: "default", requests: [{ name: "app", spec: { preferred: port } }] });
    await registry.markActive("owner-a", { app: { process: { pid: process.pid, birthSignature: (await processBirthSignature(process.pid))! } } });
    const input = { ownerId: "owner-a", redirectUri: REDIRECT_URI, callbackUrl: `${origin("app-a")}${CALLBACK_PATH}` };
    await expect(registerOAuthRelayState(m.stateDir, { ...input, state: state("journal") })).resolves.toBeDefined();
    await expect(registerOAuthRelayState(m.stateDir, { ...input, ownerId: "owner-b", state: state("nojournal"), callbackUrl: `${origin("app-b")}${CALLBACK_PATH}` }))
      .rejects.toMatchObject({ reason: "stale-owner" });
    await expect(consumeOAuthRelayCallback(m.stateDir, callback(m, state("journal")))).resolves.toBeDefined();
  });
});
