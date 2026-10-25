import { execFile, spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import path from "node:path";
import tls from "node:tls";

import { createPlan, resolveEndpointTemplates } from "@devfn/core";
import { validateDevFnConfig } from "@devfn/config";
import { proxyListenerPorts, PUBLIC_ORIGIN_HEADER, PUBLIC_ORIGIN_PORT } from "@devfn/proxy";
import { CloudflareTunnelProvider, probePublicOrigin, readTunnelBindings } from "@devfn/proxy/tunnel";

import { OAUTH_CALLBACK_PATH, type QualificationApproval } from "./approval.js";
import type { LiveHost } from "./live.js";
import { ownerLabel } from "./matrix.js";
import type { ScenarioContext, ScenarioDriver } from "./runner.js";

type LiveDriver = (context: ScenarioContext, host: LiveHost) => Promise<void>;

/* Generic fixture manifests. Every one is schema-checked by the contract tests. */

const serverProcess = (name: string) => ({ adapter: "command" as const, command: [process.execPath, "server.mjs", name, `DEVFN_PORT_${name.toUpperCase()}`], ports: [name],
  health: { type: "http" as const, port: name, timeoutMs: 30_000 } });

/** Two native processes behind TLS .localhost routes: one at /, one at a stripped /api prefix on its own host. */
export function hostFixture(environment: Record<string, string> = {}): Record<string, unknown> {
  return { version: 1, project: { id: "qualification" }, ports: { web: {}, api: {} }, processes: { web: serverProcess("web"), api: serverProcess("api") },
    profiles: { default: { processes: ["web", "api"], proxy: true, ...(Object.keys(environment).length ? { environment } : {}) } },
    hostnames: { web: { target: "web", hostname: "app-{instance}.localhost", tls: "internal" }, api: { target: "api", hostname: "svc-{instance}.localhost", path: "/api", stripPrefix: true, tls: "internal" } } };
}

export const COMPOSE_FILE = `services:
  echo:
    image: node:22-alpine
    command: ["node", "-e", "require('http').createServer((q, s) => s.end('echo')).listen(8080)"]
  client:
    image: node:22-alpine
    environment:
      UPSTREAM: \${UPSTREAM}
    command: ["node", "-e", "require('http').createServer(async (q, s) => { try { s.end(JSON.stringify({ upstream: process.env.UPSTREAM, answer: await (await fetch(process.env.UPSTREAM)).text() })) } catch (e) { s.statusCode = 502; s.end(String(e)) } }).listen(8080)"]
`;

export function composeFixture(): Record<string, unknown> {
  const health = (port: string) => ({ type: "http" as const, port, timeoutMs: 180_000 });
  return { version: 1, project: { id: "qualification" }, ports: { echo: {}, client: {} },
    services: { echo: { adapter: "compose", file: "compose.yaml", service: "echo", ports: { echo: 8080 }, health: health("echo") },
      client: { adapter: "compose", file: "compose.yaml", service: "client", dependsOn: ["echo"], ports: { client: 8080 }, env: { UPSTREAM: "{{env.DEVFN_URL_ECHO}}" }, health: health("client") } },
    profiles: { default: { services: ["echo", "client"] } } };
}

/** web served on a registered domain; only the primary worktree also gets <host>.<domain>. */
export function domainFixture(domain: string): Record<string, unknown> {
  return { version: 1, project: { id: "qualification" }, ports: { web: {} }, processes: { web: serverProcess("web") },
    profiles: { default: { processes: ["web"], proxy: true } }, hostnames: { web: { target: "web", domain } } };
}

/** web published at /app through a tunnel binding; private is routed locally but never selected for public exposure. */
export function tunnelFixture(binding: string, ephemeral: boolean): Record<string, unknown> {
  return { version: 1, project: { id: "qualification" }, ports: { web: {}, private: {} }, processes: { web: serverProcess("web"), private: serverProcess("private") },
    profiles: { default: { processes: ["web", "private"], proxy: true, tunnel: { binding, routes: ["web"], ...(ephemeral ? { ephemeral: true } : {}) } } },
    hostnames: { web: { target: "web", path: "/app", stripPrefix: true }, private: { target: "private" } } };
}

export { OAUTH_CALLBACK_PATH };

/**
 * A worktree's own Google OAuth code-flow client. It owns state, nonce and the
 * S256 PKCE verifier, asks the DevFn relay for the registered redirect URI,
 * validates its callback and ID token nonce, and exchanges the code itself.
 * /evidence reports outcomes, session hosts and one fixture session ID for
 * the cross-host probe, never codes or tokens. A consumed callback URL stays
 * in memory until the harness takes it once from /replays to replay it.
 */
export function oauthApp(relayModule: string): string {
  return `import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { OAuthRelayClient } from ${JSON.stringify(relayModule)};
const [portKey, idEnv, secretEnv, callbackPath] = process.argv.slice(2);
const clientId = process.env[idEnv], clientSecret = process.env[secretEnv];
const relay = new OAuthRelayClient();
const token = (n = 32) => randomBytes(n).toString("base64url");
const flows = new Map(), sessions = new Map(), evidence = [];
let replays = [];
const cookie = (request, name) => (request.headers.cookie ?? "").split(/;\\s*/).find((item) => item.startsWith(name + "="))?.slice(name.length + 1);
createServer(async (request, response) => {
  const url = new URL(request.url, "https://" + request.headers.host);
  try {
    if (url.pathname === "/login") {
      const id = token(16), state = token(), nonce = token(), verifier = token(48);
      const { redirectUri } = await relay.authorize({ state, callbackUrl: "https://" + request.headers.host + callbackPath });
      flows.set(id, { state, nonce, verifier, redirectUri });
      const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email", state, nonce,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "select_account" })) target.searchParams.set(key, value);
      response.writeHead(302, { location: target.href, "set-cookie": "pre=" + id + "; Path=/; HttpOnly; Secure; SameSite=Lax" }).end(); return;
    }
    if (url.pathname === callbackPath) {
      const flow = flows.get(cookie(request, "pre") ?? "");
      const record = { host: request.headers.host, stateOk: !!flow && flow.state === url.searchParams.get("state") };
      if (!record.stateOk) { evidence.push(record); response.writeHead(400).end("state_mismatch"); return; }
      flows.delete(cookie(request, "pre"));
      replays.push(flow.redirectUri + url.search);
      const exchange = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code",
        code: url.searchParams.get("code") ?? "", redirect_uri: flow.redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: flow.verifier }) });
      const result = await exchange.json().catch(() => ({}));
      const claims = typeof result.id_token === "string" ? JSON.parse(Buffer.from(result.id_token.split(".")[1], "base64url").toString("utf8")) : {};
      Object.assign(record, { redirectUri: flow.redirectUri, tokenStatus: exchange.status, pkce: "S256", nonceOk: claims.nonce === flow.nonce,
        audienceOk: claims.aud === clientId, issuerOk: claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com" });
      const ok = exchange.ok && record.nonceOk && record.audienceOk && record.issuerOk;
      record.session = ok;
      evidence.push(record);
      if (!ok) { response.writeHead(400).end("login_failed"); return; }
      const sid = token();
      sessions.set(sid, request.headers.host);
      response.writeHead(302, { location: "/me", "set-cookie": "sid=" + sid + "; Path=/; HttpOnly; Secure; SameSite=Lax" }).end(); return;
    }
    if (url.pathname === "/me") { const host = sessions.get(cookie(request, "sid") ?? ""); response.writeHead(host === request.headers.host ? 200 : 401).end(host ? "signed-in" : "anonymous"); return; }
    if (url.pathname === "/evidence") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ evidence, sessions: sessions.size, sessionHosts: [...new Set(sessions.values())], probe: [...sessions.keys()][0] })); return; }
    if (url.pathname === "/replays") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(replays)); replays = []; return; }
    response.writeHead(404).end();
  } catch (error) { response.writeHead(500).end(error instanceof Error ? error.name : "error"); }
}).listen(Number(process.env[portKey]), "127.0.0.1");
`;
}

export function oauthFixture(domain: string, approval: NonNullable<QualificationApproval["oauth"]>): Record<string, unknown> {
  return { version: 1, project: { id: "qualification" }, ports: { app: {} },
    processes: { app: { adapter: "command", command: [process.execPath, "oauth.mjs", "DEVFN_PORT_APP", approval.clientIdEnv, approval.clientSecretEnv, OAUTH_CALLBACK_PATH], ports: ["app"],
      envAllowlist: [approval.clientIdEnv, approval.clientSecretEnv], secretEnv: [approval.clientSecretEnv], health: { type: "tcp", port: "app", timeoutMs: 30_000 } } },
    profiles: { default: { processes: ["app"], proxy: true } }, hostnames: { app: { target: "app", domain } } };
}

/* Probes. */

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));
const exec = async (command: string, args: readonly string[]): Promise<{ code: number; stdout: string }> => await new Promise((resolve) => {
  execFile(command, [...args], { timeout: 60_000 }, (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout) }));
});

/** The certificate names a verified TLS handshake for servername presents. */
async function certificateNames(servername: string, ca: string, address = "127.0.0.1", port = proxyListenerPorts().httpsPort): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: address, port, servername, ca, rejectUnauthorized: true }, () => { resolve(socket.getPeerCertificate().subjectaltname ?? ""); socket.destroy(); });
    socket.setTimeout(10_000, () => socket.destroy(new Error("TLS handshake timed out")));
    socket.once("error", reject);
  });
}

/** Whether a fresh Node.js that trusts the operating system's CA store accepts url; unknown before Node.js 22.15 (--use-system-ca). */
async function systemTrustAccepts(url: string): Promise<boolean | undefined> {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major === 22 && minor < 15) return undefined;
  const script = `const u = new URL(${JSON.stringify(url)}); require("https").get({ host: "127.0.0.1", port: u.port, servername: u.hostname, headers: { host: u.host } }, () => process.exit(0)).on("error", () => process.exit(9));`;
  return (await exec(process.execPath, ["--use-system-ca", "-e", script])).code === 0;
}

const marker = (cwd: string) => path.basename(cwd);
const pathOf = (url: string) => new URL(url).pathname.replace(/\/$/, "");
const originOf = (url: string) => new URL(url).origin;
const hostOf = (url: string) => new URL(url).hostname;
/** The plain-HTTP form of a local TLS route URL, on the proxy's HTTP listener. */
const plainOf = (url: string) => url.replace(/^https:/, "http:").replace(`:${proxyListenerPorts().httpsPort}`, `:${proxyListenerPorts().httpPort}`);

async function urls(host: LiveHost, cwd: string): Promise<Record<string, string>> { return (await host.must(cwd, ["url"])).urls as Record<string, string>; }

async function start(context: ScenarioContext, host: LiveHost, cwd: string, args: readonly string[] = []): Promise<Record<string, any>> {
  const result = await host.up(context.scenario.id, cwd, args);
  if (result.code !== 0 || result.json.state !== "ready") throw new Error(`devfn up in ${marker(cwd)} failed: ${JSON.stringify(result.json.error ?? result.json.state)}`);
  return result.json;
}

/** Whether url answers with cwd's marker through the local DevFn proxy. */
async function serves(host: LiveHost, url: string, cwd: string, ca: string): Promise<boolean> {
  const answer = await host.request(url, { ca }).catch(() => undefined);
  return answer?.status === 200 && answer.json?.marker === marker(cwd);
}

/** A running sentinel lifecycle whose process and URL must never change during the scenario. */
async function sentinel(context: ScenarioContext, host: LiveHost): Promise<{ cwd: string; web: string; check: () => Promise<void> }> {
  const cwd = await host.repository(context.scenario.id, "sentinel", hostFixture());
  await start(context, host, cwd);
  const ca = await host.ca();
  const { web } = await urls(host, cwd);
  const { pid } = await host.seen(cwd, "web");
  return { cwd, web, check: async () => {
    const now = await host.seen(cwd, "web");
    context.expect("sentinel-preserved", now.pid === pid && await serves(host, web, cwd, ca), `sentinel pid ${pid} -> ${now.pid} at ${web}`);
  } };
}

/** One fixture repository and a linked worktree, both started. */
async function twoWorktrees(context: ScenarioContext, host: LiveHost, config = hostFixture()): Promise<Array<{ cwd: string; receipt: Record<string, any>; urls: Record<string, string> }>> {
  const primary = await host.repository(context.scenario.id, "pair", config);
  const linked = await host.worktree(context.scenario.id, primary, "b");
  const result = [];
  for (const cwd of [primary, linked]) result.push({ cwd, receipt: await start(context, host, cwd), urls: await urls(host, cwd) });
  return result;
}

/* Drivers. */

const native: LiveDriver = async (context, host) => {
  const cwd = await host.repository(context.scenario.id, "native", hostFixture());
  const receipt = await start(context, host, cwd);
  const seen = await host.seen(cwd, "web");
  const port = Number(seen.env.DEVFN_PORT_WEB);
  context.expect("env-before-start", seen.env.DEVFN_URL_WEB === `http://127.0.0.1:${port}` && seen.env.DEVFN_INSTANCE_ID === receipt.instanceId,
    `recorded before listen: DEVFN_URL_WEB=${seen.env.DEVFN_URL_WEB}, owner matches receipt: ${seen.env.DEVFN_INSTANCE_ID === receipt.instanceId}`);
  const { web } = await urls(host, cwd);
  const leased = (receipt.allocations as Array<{ port: number; instanceId: string }>).some((item) => item.port === port && item.instanceId === receipt.instanceId);
  const direct = await host.request(seen.env.DEVFN_URL_WEB);
  context.expect("receipt-matches", leased && direct.json?.marker === marker(cwd) && await serves(host, web, cwd, await host.ca()), `leased ${port}: ${leased}; direct and ${web} serve the worktree`);
};

const compose: LiveDriver = async (context, host) => {
  const cwd = await host.repository(context.scenario.id, "compose", composeFixture(), { "compose.yaml": COMPOSE_FILE });
  const receipt = await start(context, host, cwd);
  const allocation = (name: string) => (receipt.allocations as Array<{ service: string; port: number; host: string }>).find((item) => item.service === name);
  const client = allocation("client");
  const answer = client ? await host.request(`http://127.0.0.1:${client.port}/`) : undefined;
  context.expect("sibling-url", answer?.json?.upstream === "http://echo:8080" && answer.json.answer === "echo", `client saw ${String(answer?.json?.upstream)} and reached it: ${answer?.json?.answer === "echo"}`);
  const published = await Promise.all(["echo", "client"].map(async (name) => (await exec("docker", ["ps", "--filter", `publish=${allocation(name)?.port ?? 0}`, "--format", "{{.Ports}}"])).stdout.trim()));
  context.expect("loopback-mapping", published.every((ports, index) => ports.length > 0 && ports.split(",").every((item) => item.trim().startsWith("127.0.0.1:")) && allocation(["echo", "client"][index])?.host === "127.0.0.1"),
    `published: ${published.join(" | ")}`);
};

const twoWorktreeDriver: LiveDriver = async (context, host) => {
  const [a, b] = await twoWorktrees(context, host);
  const ports = (receipt: Record<string, any>) => (receipt.allocations as Array<{ port: number }>).map((item) => item.port);
  context.expect("distinct-owners", a.receipt.instanceId !== b.receipt.instanceId && !ports(a.receipt).some((port) => ports(b.receipt).includes(port)) && hostOf(a.urls.web) !== hostOf(b.urls.web),
    `owners ${a.receipt.instanceId}/${b.receipt.instanceId}, hosts ${hostOf(a.urls.web)}/${hostOf(b.urls.web)}`);
  const ca = await host.ca();
  context.expect("own-marker", await serves(host, a.urls.web, a.cwd, ca) && await serves(host, b.urls.web, b.cwd, ca), "each hostname answered with its own worktree marker");
};

const routeIsolation: LiveDriver = async (context, host) => {
  const [a, b] = await twoWorktrees(context, host);
  const ca = await host.ca();
  const api = a.urls.api;
  const stripped = await host.request(`${api}/item?x=1`, { ca });
  const boundary = await host.request(`${originOf(api)}${pathOf(api)}x`, { ca });
  context.expect("path-prefix", stripped.json?.name === "api" && stripped.json.path === "/item?x=1" && boundary.status === 404, `${pathOf(api)}/item -> ${String(stripped.json?.path)}; ${pathOf(api)}x -> ${boundary.status}`);
  const unselected = await host.request(`${originOf(api)}/other`, { ca });
  const unknown = await host.request(`http://${host.prefix}-unknown.localhost/`);
  context.expect("unselected-denied", unselected.status === 404 && unknown.status === 404 && !unselected.json && !unknown.json, `unselected path ${unselected.status}, unknown host ${unknown.status}`);
  const crossed = [];
  for (const [own, other] of [[a, b], [b, a]]) for (const url of [own.urls.web, `${own.urls.api}/x`]) crossed.push((await host.request(url, { ca })).json?.marker === marker(other.cwd));
  const disjoint = !(a.receipt.routes as Array<{ hostname: string }>).some((route) => (b.receipt.routes as Array<{ hostname: string }>).some((other) => other.hostname === route.hostname));
  context.expect("no-cross-worktree", !crossed.includes(true) && disjoint, `route hostnames disjoint: ${disjoint}; cross answers: ${crossed.filter(Boolean).length}`);
};

const internalTls: LiveDriver = async (context, host) => {
  const anchors = await host.trustAnchors();
  const [a, b] = await twoWorktrees(context, host);
  const ca = await host.ca();
  const names = await Promise.all([a, b].map(async (item) => await certificateNames(hostOf(item.urls.web), ca)));
  context.expect("verified-sni", names.every((name, index) => name.includes(`DNS:${hostOf([a, b][index].urls.web)}`)), `verified certificates: ${names.join(" | ")}`);
  const plain = await host.request(plainOf(a.urls.web));
  context.expect("http-redirect", plain.status >= 300 && plain.status < 400 && String(plain.headers.location ?? "").startsWith("https://"), `HTTP answered ${plain.status} -> ${String(plain.headers.location)}`);
  const unchanged = JSON.stringify(await host.trustAnchors()) === JSON.stringify(anchors);
  // A root the operator trusted before the run is reported, not attributed to DevFn.
  context.expect("no-trust-install", unchanged, `OS trust store ${unchanged ? "unchanged" : "changed"} across startup and TLS use (${anchors.length} anchors); the internal root was ${{ true: "already trusted by the operator", false: "not trusted by the OS", undefined: "not checked against the OS store (Node.js before 22.15)" }[String(await systemTrustAccepts(a.urls.web))]}`);
};

const registeredDomain = (approval: QualificationApproval | undefined): LiveDriver => async (context, host) => {
  const domain = approval!.domain!;
  const primary = await host.repository(context.scenario.id, "domain", domainFixture(domain));
  context.inventory.record("registered-domain", domain, context.scenario.id, { cwd: primary });
  const registered = await host.devfn(primary, ["domains", "register", domain, "--tls", "internal"]);
  const loopback = async (name: string) => (await lookup(name, { all: true })).every((item) => item.address.startsWith("127.") || item.address === "::1");
  context.expect("loopback-only", registered.code === 0 && await loopback(domain), `registration ${registered.code === 0 ? "accepted" : JSON.stringify(registered.json.error)}; ${domain} resolves only to loopback`);
  const linked = await host.worktree(context.scenario.id, primary, "b");
  const served = [];
  const routes: string[][] = [];
  let ca = "";
  for (const cwd of [primary, linked]) {
    const receipt = await start(context, host, cwd);
    // The internal root is read from the Caddy admin API, which exists only once a lifecycle started Caddy.
    ca ||= await host.ca();
    routes.push((receipt.routes as Array<{ hostname: string }>).map((route) => route.hostname));
    const { web } = await urls(host, cwd);
    served.push(await loopback(hostOf(web)) && await serves(host, web, cwd, ca));
  }
  context.expect("worktree-alias", served.every(Boolean) && routes.every((names) => names.some((name) => name.endsWith(`.${domain}`) && name.startsWith("web-"))), `aliases ${routes.flat().join(", ")}`);
  const canonical = `web.${domain}`;
  context.expect("primary-alias", routes[0].includes(canonical) && !routes[1].includes(canonical) && await serves(host, `https://${canonical}:${proxyListenerPorts().httpsPort}/`, primary, ca),
    `${canonical} routed to the primary worktree only`);
};

const googleOAuth = (approval: QualificationApproval | undefined): LiveDriver => async (context, host) => {
  const domain = approval!.domain!;
  const oauth = approval!.oauth!;
  const primary = await host.repository(context.scenario.id, "oauth", oauthFixture(domain, oauth), { "oauth.mjs": oauthApp(import.meta.resolve("@devfn/proxy/oauth-relay")) });
  context.inventory.record("registered-domain", domain, context.scenario.id, { cwd: primary });
  await host.must(primary, ["domains", "register", domain, "--tls", "internal"]);
  context.inventory.record("oauth-relay", domain, context.scenario.id, { cwd: primary });
  const { relay } = await host.must(primary, ["oauth-relay", "start", domain, "--host", oauth.relayHost]);
  const linked = await host.worktree(context.scenario.id, primary, "b");
  const apps: Array<{ cwd: string; url: string }> = [];
  for (const cwd of [primary, linked]) { await start(context, host, cwd); apps.push({ cwd, url: (await urls(host, cwd)).app }); }
  const ca = await host.ca();
  type Evidence = { evidence: Array<Record<string, any>>; sessions: number; sessionHosts: string[]; probe?: string };
  const read = async (app: { url: string }) => (await host.request(`${originOf(app.url)}/evidence`, { ca })).json as Evidence;
  // A person or browser agent signs in at each URL; the run only waits for the apps to report the outcome.
  process.stderr.write(`Complete a Google sign-in at each URL within 10 minutes:\n${apps.map((app) => `  ${originOf(app.url)}/login`).join("\n")}\n`);
  const deadline = Date.now() + 600_000;
  let evidence: Evidence[] = [];
  while (Date.now() < deadline) {
    evidence = await Promise.all(apps.map(read));
    if (evidence.every((item) => item.evidence.some((record) => record.session === true))) break;
    await sleep(3_000);
  }
  const logins = evidence.map((item) => item.evidence.find((record) => record.session === true));
  const approved = `${relay.origin}${OAUTH_CALLBACK_PATH}` === oauth.redirectUri;
  context.expect("one-redirect-uri", approved && logins.every((record) => record?.redirectUri === oauth.redirectUri), `relay redirect ${relay.origin}${OAUTH_CALLBACK_PATH}; both flows used it: ${logins.every((record) => record?.redirectUri === oauth.redirectUri)}`);
  // Each session is honored on its own host and refused on the other worktree's host.
  const me = async (app: { url: string }, probe: string | undefined) => probe ? (await host.request(`${originOf(app.url)}/me`, { ca, cookie: `sid=${probe}` }).catch(() => undefined))?.status : undefined;
  const own = await Promise.all(apps.map(async (app, index) => await me(app, evidence[index].probe)));
  const crossed = await Promise.all(apps.map(async (app, index) => await me(app, evidence[1 - index].probe)));
  context.expect("login-both", logins.every((record, index) => record?.host === new URL(apps[index].url).host && evidence[index].sessionHosts.every((item) => item === record.host)) && own.every((status) => status === 200) && crossed.every((status) => status === 401),
    `sessions on ${logins.map((record) => record?.host ?? "none").join(", ")}; /me with its own session ${own.join(", ")}, with the other worktree's ${crossed.join(", ")}`);
  context.expect("state-nonce-pkce", logins.every((record) => record?.stateOk === true && record.nonceOk === true && record.pkce === "S256" && record.audienceOk === true && record.issuerOk === true),
    "state, ID token nonce/audience/issuer and S256 PKCE validated by both clients");
  const replays = (await Promise.all(apps.map(async (app) => (await host.request(`${originOf(app.url)}/replays`, { ca })).json as unknown as string[]))).flat();
  const statuses: number[] = [];
  for (const url of replays) statuses.push((await host.request(url, { ca }).catch(() => ({ status: 0 }))).status);
  const after = await Promise.all(apps.map(read));
  context.expect("replay-rejected", replays.length >= 2 && statuses.every((status) => status >= 400) && after.every((item, index) => item.sessions === evidence[index].sessions),
    `replayed ${replays.length} consumed callbacks: ${statuses.join(", ")}; no new session`);
  context.expect("token-exchange", logins.every((record) => record?.tokenStatus === 200), "Google's token endpoint answered 200 to each worktree's own exchange; the receipt holds no code or token, and consumed callbacks were replayed from memory");
};

/** Read-back helpers shared by tunnel journeys. */
async function publicAnswer(host: LiveHost, url: string, attempts = 24): Promise<{ status: number; marker?: string; name?: string; path?: string } | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const answer = await host.request(url, { publicDns: true }).catch(() => undefined);
    if (answer?.json?.marker) return { status: answer.status, marker: String(answer.json.marker), name: String(answer.json.name), path: String(answer.json.path) };
    if (attempt === attempts - 1) return answer ? { status: answer.status } : undefined;
    await sleep(5_000);
  }
  return undefined;
}

function registerArgs(approval: QualificationApproval, kind: "cloudflare" | "ngrok-reserved" | "ngrok-ephemeral"): string[] {
  if (kind === "cloudflare") {
    const cf = approval.cloudflare!;
    return ["--provider", "cloudflare", "--domain", cf.domain, "--account-id", cf.accountId, "--zone-id", cf.zoneId, "--tunnel-id", cf.tunnelId, "--credentials-file", cf.credentialsFile, "--api-token-env", cf.apiTokenEnv];
  }
  if (kind === "ngrok-reserved") return ["--provider", "ngrok", "--domain", approval.ngrokReserved!.domain, "--authtoken-env", approval.ngrokReserved!.authtokenEnv, "--api-key-env", approval.ngrokReserved!.apiKeyEnv];
  const ephemeral = approval.ngrokEphemeral!;
  return ["--provider", "ngrok", "--ephemeral", "--authtoken-env", ephemeral.authtokenEnv, "--api-key-env", ephemeral.apiKeyEnv];
}

/** Register a run-named binding for a fresh fixture repository. */
async function binding(context: ScenarioContext, host: LiveHost, approval: QualificationApproval, kind: "cloudflare" | "ngrok-reserved" | "ngrok-ephemeral", repository: string): Promise<string> {
  const name = `${host.prefix}-${kind === "cloudflare" ? "cf" : kind === "ngrok-reserved" ? "ngr" : "nge"}`;
  const cwd = await host.repository(context.scenario.id, repository, tunnelFixture(name, kind === "ngrok-ephemeral"));
  context.inventory.record("tunnel-binding", name, context.scenario.id, { cwd });
  await host.must(cwd, ["tunnel", "register", name, ...registerArgs(approval, kind), "--nonproduction"]);
  const registered = (await readTunnelBindings(host.stateDir)).find((item) => item.name === name);
  if (!registered) throw new Error(`binding ${name} is not readable after registration`);
  host.noteBinding(registered);
  return cwd;
}

/** Record and start one public worktree; its public hostname is recorded before it can exist. */
async function publicStart(context: ScenarioContext, host: LiveHost, cwd: string, name: string): Promise<{ hostname: string; url: string; receipt: Record<string, any> }> {
  const planned = (await host.must(cwd, ["tunnel", "urls"])) as { urls: Record<string, string> };
  const record = (hostname: string, url: string) => { context.inventory.record("public-hostname", hostname, context.scenario.id, { cwd, binding: name, url }); };
  if (planned.urls.web) record(hostOf(planned.urls.web), planned.urls.web);
  const receipt = await start(context, host, cwd, ["--allow-public"]);
  const hostname = (receipt.tunnel?.hostnames as string[] | undefined)?.[0] ?? "";
  const url = (receipt.publicUrls as Record<string, string> | undefined)?.web ?? "";
  if (!planned.urls.web && hostname) record(hostname, url);
  return { hostname, url, receipt };
}

const tunnelJourney = (approval: QualificationApproval | undefined, kind: "cloudflare" | "ngrok-reserved" | "ngrok-ephemeral"): LiveDriver => async (context, host) => {
  const cwd = await binding(context, host, approval!, kind, "public");
  const name = `${host.prefix}-${kind === "cloudflare" ? "cf" : kind === "ngrok-reserved" ? "ngr" : "nge"}`;
  const planned = (await host.must(cwd, ["tunnel", "urls"])) as { timing?: string; urls: Record<string, string>; assignedAfterStart?: string[] };
  const { hostname, url, receipt } = await publicStart(context, host, cwd, name);
  const timing = kind === "ngrok-ephemeral"
    ? planned.timing === "post-start" && !planned.urls.web && (planned.assignedAfterStart ?? []).includes("web") && url.startsWith("https://")
    : planned.timing === "pre-start" && planned.urls.web === url;
  context.expect("url-timing", timing, `planned ${planned.timing}: ${planned.urls.web ?? "assigned after start"}; started ${url}`);
  const served = await publicAnswer(host, `${url}/item`);
  context.expect("public-route-served", served?.marker === marker(cwd) && served.name === "web" && served.path === "/item", `${url}/item -> ${JSON.stringify(served)}`);
  // Denial needs positive evidence; an unreachable or failed probe proves nothing.
  const bound = (await readTunnelBindings(host.stateDir)).find((item) => item.name === name)!;
  const privateName = hostname.replace(/^web-/, "private-");
  const ca = await host.ca();
  const originDenied = await host.request(`https://${hostname}/`, { ca, port: PUBLIC_ORIGIN_PORT, host: privateName }).catch(() => undefined);
  const outside = await host.request(`${originOf(url)}/other`, { publicDns: true }).catch(() => undefined);
  const edge = kind === "cloudflare" ? (await host.readBack(bound, privateName, undefined) ? "a provider record" : "no provider record")
    : kind === "ngrok-reserved" ? await host.request(`https://${privateName}/`, { publicDns: true }).then((answer) => answer.json?.marker === undefined && answer.status >= 400 ? `edge ${answer.status}` : `served ${answer.status}`, () => "unanswered")
      : "no name assigned";
  context.expect("private-route-denied", !(receipt.tunnel?.hostnames as string[]).some((item) => item.startsWith("private-")) && originDenied?.status === 403 && originDenied.headers[PUBLIC_ORIGIN_HEADER.toLowerCase()] === "deny"
    && outside?.status === 404 && outside.headers[PUBLIC_ORIGIN_HEADER.toLowerCase()] === "fallback" && /^(no |edge )/.test(edge),
    `origin for ${privateName}: ${String(originDenied?.status ?? "unanswered")} ${String(originDenied?.headers[PUBLIC_ORIGIN_HEADER.toLowerCase()] ?? "")}; ${originOf(url)}/other: ${String(outside?.status ?? "unanswered")} ${String(outside?.headers[PUBLIC_ORIGIN_HEADER.toLowerCase()] ?? "")}; public ${privateName}: ${edge}`);
  if (bound.provider === "cloudflare") await new CloudflareTunnelProvider({ env: host.options.env }).verifyDns(bound, hostname);
  const resolved = await lookup(hostOf(url), { all: true }).then((items) => items.map((item) => item.address), () => []);
  const misrouted = await host.request(url, { publicDns: true, host: `${host.prefix}-unrouted.${hostOf(url).split(".").slice(1).join(".")}` }).catch(() => undefined);
  context.expect("dns-host-sni", resolved.length > 0 && misrouted !== undefined && misrouted.json?.marker === undefined,
    `${hostOf(url)} resolves to ${resolved.join(", ")}; edge certificate verified for the name; mismatched Host answered ${misrouted?.status ?? "nothing"} without a fixture marker`);
  await probePublicOrigin(hostname, PUBLIC_ORIGIN_PORT, ca);
  context.observe("origin-tls", true, `origin certificate for ${hostname} verified against the internal root on ${PUBLIC_ORIGIN_PORT}`);
  await host.must(cwd, ["down"]);
  const entry = context.inventory.list(context.scenario.id).find((item) => item.kind === "public-hostname")!;
  context.expect("withdrawn-absent", !await host.handlers().present(entry), `${entry.id} no longer routed, journaled, recorded at the provider or served`);
};

const tunnelReload = (approval: QualificationApproval | undefined): LiveDriver => async (context, host) => {
  const primary = await binding(context, host, approval!, "cloudflare", "reload");
  const name = `${host.prefix}-cf`;
  const linked = await host.worktree(context.scenario.id, primary, "b");
  const [a, b] = [await publicStart(context, host, primary, name), await publicStart(context, host, linked, name)];
  const present = async (hostname: string) => await host.handlers().present(context.inventory.list(context.scenario.id).find((item) => item.kind === "public-hostname" && item.id === hostname)!);
  await host.must(primary, ["down"]);
  context.expect("withdraw-one", !await present(a.hostname) && (await publicAnswer(host, `${b.url}/x`))?.marker === marker(linked), `${a.hostname} withdrawn; ${b.hostname} still serves`);
  await host.must(linked, ["tunnel", "recover", name, "--allow-public"]);
  context.expect("recover-preserves", (await publicAnswer(host, `${b.url}/x`))?.marker === marker(linked), `${b.hostname} serves after tunnel recover`);
  await host.must(linked, ["down"]);
  context.expect("withdrawn-absent", !await present(a.hostname) && !await present(b.hostname), "neither hostname is routed, journaled, recorded at the provider or served");
};

const startupFailure: LiveDriver = async (context, host) => {
  const { check } = await sentinel(context, host);
  const cwd = await host.repository(context.scenario.id, "failing", hostFixture());
  await writeFile(path.join(cwd, "fail-api"), "", "utf8");
  const failed = await host.up(context.scenario.id, cwd);
  const status = (await host.devfn(cwd, ["status"])).json;
  const leases = ((await host.must(cwd, ["ports"])).allocations as Array<{ instanceId: string }>).filter((item) => item.instanceId === status.instanceId);
  // The processes the failed start launched recorded their pids; none may survive, and no route of the owner may stay.
  const survivors = await host.survivingFixtures(cwd);
  const routes = await host.routesOf(String(status.instanceId));
  await rm(path.join(cwd, "fail-api"));
  const retried = await host.up(context.scenario.id, cwd);
  context.expect("failure-cleaned", failed.code !== 0 && typeof failed.json.error?.code === "string" && status.state !== "ready" && leases.length === 0 && survivors.length === 0 && routes.length === 0 && retried.json.state === "ready",
    `failure ${String(failed.json.error?.code)}; state ${String(status.state)}; leases left ${leases.length}; processes left ${survivors.join(", ") || "none"}; routes left ${routes.join(", ") || "none"}; retry ${String(retried.json.state)}`);
  await check();
};

const concurrentChange: LiveDriver = async (context, host) => {
  const { check } = await sentinel(context, host);
  const cwd = await host.repository(context.scenario.id, "concurrent", hostFixture());
  const results = await Promise.all([host.up(context.scenario.id, cwd), host.up(context.scenario.id, cwd)]);
  const winners = results.filter((item) => item.code === 0 && item.json.state === "ready");
  const status = await host.must(cwd, ["status"]);
  context.expect("single-owner", winners.length === 1 && status.state === "ready" && (status.processes as unknown[]).length === 2,
    `${winners.length} of 2 concurrent starts succeeded; the other: ${JSON.stringify(results.find((item) => item !== winners[0])?.json.error?.code)}`);
  const before = await host.seen(cwd, "web");
  await writeFile(path.join(cwd, "devfn.config.json"), `${JSON.stringify(hostFixture({ QUAL_REVISION: "2" }), null, 2)}\n`);
  const degraded = await host.devfn(cwd, ["status", "--trust"]);
  const restarted = await host.must(cwd, ["restart"]);
  const seen = await host.seen(cwd, "web");
  context.expect("change-detected", before.env.QUAL_REVISION === undefined && degraded.json.state === "degraded" && restarted.state === "ready" && seen.pid !== before.pid && seen.env.QUAL_REVISION === "2" && seen.env.DEVFN_INSTANCE_ID === restarted.instanceId,
    `status after change: ${String(degraded.json.state)}; restart: ${String(restarted.state)}; process ${before.pid} -> ${seen.pid} saw QUAL_REVISION=${String(seen.env.QUAL_REVISION)}`);
  await check();
};

const crash: LiveDriver = async (context, host) => {
  const { check } = await sentinel(context, host);
  const cwd = await host.repository(context.scenario.id, "crash", hostFixture());
  await start(context, host, cwd);
  process.kill((await host.seen(cwd, "web")).pid, "SIGKILL");
  await sleep(500);
  const status = await host.devfn(cwd, ["status"]);
  // An interrupted start: the CLI is killed once its first process has recorded its startup.
  const interrupted = await host.repository(context.scenario.id, "interrupted", hostFixture());
  host.options.inventory.record("runtime", interrupted, context.scenario.id);
  const child = spawn(process.execPath, [host.options.devfnCli, "up", "--json", "--state-dir", host.stateDir], { cwd: interrupted, env: host.options.env, stdio: "ignore" });
  let orphan: number | undefined;
  for (let wait = 0; wait < 300 && orphan === undefined; wait += 1) { orphan = (await host.seen(interrupted, "web").catch(() => undefined))?.pid; if (orphan === undefined) await sleep(100); }
  child.kill("SIGKILL");
  const collected = await host.devfn(interrupted, ["ports", "gc"]);
  context.expect("crash-detected", status.json.state !== "ready" && collected.code === 0 && orphan !== undefined,
    `status after kill: ${String(status.json.state)}; ports gc after interrupted up: ${collected.code === 0 ? "ok" : JSON.stringify(collected.json.error)}`);
  const restarted = await host.must(cwd, ["restart"]);
  // The killed start's lifecycle lock is recoverable only once stale (five minutes); a retry before then fails closed.
  let retried = await host.up(context.scenario.id, interrupted);
  for (const deadline = Date.now() + 420_000; retried.json.state !== "ready" && Date.now() < deadline; retried = await host.up(context.scenario.id, interrupted)) {
    await sleep(15_000);
    await host.devfn(interrupted, ["ports", "gc"]);
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const orphaned = orphan !== undefined && alive(orphan) && !((retried.json.processes ?? []) as Array<{ pid: number }>).some((item) => item.pid === orphan);
  const ca = await host.ca();
  context.expect("restart-recovers", restarted.state === "ready" && await serves(host, (await urls(host, cwd)).web, cwd, ca) && retried.json.state === "ready" && !orphaned && await serves(host, (await urls(host, interrupted)).web, interrupted, ca),
    `crashed worktree ${String(restarted.state)}; interrupted worktree ${String(retried.json.state ?? JSON.stringify(retried.json.error))}; process ${String(orphan)} from the killed start ${orphaned ? "still runs" : "is gone"}`);
  await check();
};

const oneWorktreeStop: LiveDriver = async (context, host) => {
  const [a, b] = await twoWorktrees(context, host);
  const ca = await host.ca();
  const before = await host.seen(b.cwd, "web");
  await host.must(a.cwd, ["down"]);
  const status = await host.must(a.cwd, ["status"]);
  const leases = ((await host.must(a.cwd, ["ports"])).allocations as Array<{ instanceId: string }>).filter((item) => item.instanceId === a.receipt.instanceId);
  const survivors = await host.survivingFixtures(a.cwd);
  const routes = await host.routesOf(String(a.receipt.instanceId));
  // Withdrawal is observed as the proxy's own 404 for the name on plain HTTP, never as a failed request.
  const answer = await host.request(plainOf(a.urls.web)).catch(() => undefined);
  context.expect("stopped-withdrawn", status.state === "stopped" && leases.length === 0 && survivors.length === 0 && routes.length === 0 && answer?.status === 404 && answer.json === undefined,
    `state ${String(status.state)}; leases ${leases.length}; processes left ${survivors.join(", ") || "none"}; routes left ${routes.join(", ") || "none"}; ${plainOf(a.urls.web)} -> ${String(answer?.status ?? "unanswered")}`);
  const after = await host.seen(b.cwd, "web");
  context.expect("sentinel-preserved", after.pid === before.pid && await serves(host, b.urls.web, b.cwd, ca), `other worktree pid ${before.pid} -> ${after.pid}`);
};

const proxyReload: LiveDriver = async (context, host) => {
  const { check, cwd: sentinelCwd, web } = await sentinel(context, host);
  const ca = await host.ca();
  const cwd = await host.repository(context.scenario.id, "reload", hostFixture());
  let probing = true;
  const answers: boolean[] = [];
  const probe = (async () => { while (probing) { answers.push(await serves(host, web, sentinelCwd, ca)); await sleep(50); } })();
  try { await start(context, host, cwd); await host.must(cwd, ["down"]); await start(context, host, cwd); await host.must(cwd, ["down"]); }
  finally { probing = false; await probe; }
  context.expect("reload-preserves", answers.length > 0 && answers.every(Boolean), `${answers.filter(Boolean).length}/${answers.length} sentinel probes answered across four route changes`);
  await check();
};

const ownerEndpoint: LiveDriver = async (context, host) => {
  const config = hostFixture();
  const cwd = await host.repository(context.scenario.id, "owner", config);
  const receipt = await start(context, host, cwd);
  const seen = await host.seen(cwd, "web");
  const digest = ownerLabel(receipt.instanceId as string);
  const hostnames = (receipt.routes as Array<{ hostname: string }>).map((route) => route.hostname);
  context.expect("owner-opaque", seen.env.DEVFN_INSTANCE_ID === receipt.instanceId && hostnames.every((name) => name.includes(digest) && !name.includes(receipt.instanceId as string) && !name.includes(marker(cwd))),
    `owner ${String(receipt.instanceId)} appears in routes only as ${digest}`);
  const validated = validateDevFnConfig(config);
  const api = await host.seen(cwd, "api");
  const resolved = resolveEndpointTemplates({ config: validated, plan: createPlan(validated), ownerId: receipt.instanceId as string, ports: { web: Number(seen.env.DEVFN_PORT_WEB), api: Number(api.env.DEVFN_PORT_API) } });
  const differing = (["web", "api"] as const).flatMap((name) => Object.entries(resolved.nodes[name].environment)
    .filter(([key, value]) => key.startsWith("DEVFN_") && value !== (name === "web" ? seen : api).env[key]).map(([key]) => `${name}.${key}`));
  context.expect("resolver-matches", differing.length === 0, differing.length ? `differs: ${differing.join(", ")}` : "the published resolver reproduced every generated value the process saw");
};

/** Live drivers for every matrix scenario against one live host. */
export function liveDrivers(host: LiveHost, approval: QualificationApproval | undefined): Record<string, ScenarioDriver> {
  const drivers: Record<string, LiveDriver> = {
    "host.native-prestart": native, "host.compose-prestart": compose, "host.two-worktrees": twoWorktreeDriver, "host.route-isolation": routeIsolation,
    "host.internal-tls": internalTls, "host.registered-domain": registeredDomain(approval), "oauth.google-two-worktrees": googleOAuth(approval),
    "tunnel.cloudflare": tunnelJourney(approval, "cloudflare"), "tunnel.ngrok-reserved": tunnelJourney(approval, "ngrok-reserved"), "tunnel.ngrok-ephemeral": tunnelJourney(approval, "ngrok-ephemeral"),
    "recovery.startup-failure": startupFailure, "recovery.concurrent-change": concurrentChange, "recovery.crash": crash, "recovery.one-worktree-stop": oneWorktreeStop,
    "recovery.proxy-reload": proxyReload, "recovery.tunnel-reload": tunnelReload(approval), "interface.owner-endpoint": ownerEndpoint,
  };
  return Object.fromEntries(Object.entries(drivers).map(([id, driver]) => [id, async (context: ScenarioContext) => await driver(context, host)]));
}
