import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import path from "node:path";
import tls from "node:tls";

import { createPlan, domainAliases, resolveEndpointTemplates, resolveInstanceIdentity } from "@devfn/core";
import { validateDevFnConfig } from "@devfn/config";
import { proxyListenerPorts, PUBLIC_ORIGIN_HEADER, PUBLIC_ORIGIN_PORT } from "@devfn/proxy";
import { CloudflareTunnelProvider, probePublicOrigin, readTunnelBindings, readTunnelState, type TunnelBinding } from "@devfn/proxy/tunnel";

import { OAUTH_CALLBACK_PATH, type QualificationApproval } from "./approval.js";
import { failedWith, QUALIFICATION_PROJECT_ID, SHIPPED_ERRORS, type Answer, type LiveHost, type OwnedStatus, type ProviderReadBack } from "./live.js";
import { ownerLabel } from "./matrix.js";
import type { ScenarioContext, ScenarioDriver } from "./runner.js";

type LiveDriver = (context: ScenarioContext, host: LiveHost) => Promise<void>;

/* Generic fixture manifests. Every one is schema-checked by the contract tests. */

const PROJECT_ID = QUALIFICATION_PROJECT_ID;

const serverProcess = (name: string) => ({ adapter: "command" as const, command: [process.execPath, "server.mjs", name, `DEVFN_PORT_${name.toUpperCase()}`], ports: [name],
  health: { type: "http" as const, port: name, timeoutMs: 30_000 } });

/** Two native processes behind TLS .localhost routes: one at /, one at a stripped /api prefix on its own host. */
export function hostFixture(environment: Record<string, string> = {}): Record<string, unknown> {
  return { version: 1, project: { id: PROJECT_ID }, ports: { web: {}, api: {} }, processes: { web: serverProcess("web"), api: serverProcess("api") },
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
  return { version: 1, project: { id: PROJECT_ID }, ports: { echo: {}, client: {} },
    services: { echo: { adapter: "compose", file: "compose.yaml", service: "echo", ports: { echo: 8080 }, health: health("echo") },
      client: { adapter: "compose", file: "compose.yaml", service: "client", dependsOn: ["echo"], ports: { client: 8080 }, env: { UPSTREAM: "{{env.DEVFN_URL_ECHO}}" }, health: health("client") } },
    profiles: { default: { services: ["echo", "client"] } } };
}

/** web served on a registered domain; only the primary worktree also gets <host>.<domain>. */
export function domainFixture(domain: string): Record<string, unknown> {
  return { version: 1, project: { id: PROJECT_ID }, ports: { web: {} }, processes: { web: serverProcess("web") },
    profiles: { default: { processes: ["web"], proxy: true } }, hostnames: { web: { target: "web", domain } } };
}

/** web published at /app through a tunnel binding; private is routed locally over internal TLS, so Caddy holds its certificate, but never selected for public exposure. */
export function tunnelFixture(binding: string, ephemeral: boolean): Record<string, unknown> {
  return { version: 1, project: { id: PROJECT_ID }, ports: { web: {}, private: {} }, processes: { web: serverProcess("web"), private: serverProcess("private") },
    profiles: { default: { processes: ["web", "private"], proxy: true, tunnel: { binding, routes: ["web"], ...(ephemeral ? { ephemeral: true } : {}) } } },
    hostnames: { web: { target: "web", path: "/app", stripPrefix: true }, private: { target: "private", tls: "internal" } } };
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
  return { version: 1, project: { id: PROJECT_ID }, ports: { app: {} },
    processes: { app: { adapter: "command", command: [process.execPath, "oauth.mjs", "DEVFN_PORT_APP", approval.clientIdEnv, approval.clientSecretEnv, OAUTH_CALLBACK_PATH], ports: ["app"],
      // Both are redacted: DevFn requires a credential-shaped variable name in secretEnv, and the receipt redacts the client ID too.
      envAllowlist: [approval.clientIdEnv, approval.clientSecretEnv], secretEnv: [approval.clientIdEnv, approval.clientSecretEnv], health: { type: "tcp", port: "app", timeoutMs: 30_000 } } },
    profiles: { default: { processes: ["app"], proxy: true } }, hostnames: { app: { target: "app", domain } } };
}

/* Probes. */

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

const originHeader = (answer: Answer) => answer.headers[PUBLIC_ORIGIN_HEADER.toLowerCase()];

/**
 * Answer predicates. Each holds only for the positive answer the shipped
 * component gives for its claim; a failed request (undefined), another
 * status, a fixture answer or a missing marker header never satisfies one.
 */
export const ANSWERS = {
  /** The public origin's marked deny for a name Caddy holds a certificate for but does not publish (SNI == Host). */
  originDenied: (answer?: Answer) => answer?.status === 403 && originHeader(answer) === "deny" && answer.json === undefined,
  /** Caddy's empty 421 on the public origin for a Host header that differs from the TLS server name. */
  forgedHostRefused: (answer?: Answer) => answer?.status === 421 && answer.body === "",
  /** A published host's marked fallback for a path the profile did not select. */
  originFallback: (answer?: Answer) => answer?.status === 404 && originHeader(answer) === "fallback" && answer.json === undefined,
  /** The local proxy's own 404 for an unknown name or unrouted path: no fixture process answered. */
  proxyNotFound: (answer?: Answer) => answer?.status === 404 && answer.json === undefined && answer.headers.location === undefined,
  /** Caddy's permanent redirect of a TLS route's plain-HTTP name to HTTPS on the same name. */
  httpsRedirect: (answer: Answer | undefined, hostname: string) => {
    try { return answer?.status === 308 && new URL(String(answer.headers.location)).protocol === "https:" && new URL(String(answer.headers.location)).hostname === hostname; } catch { return false; }
  },
  /** The relay's rejection of a callback whose state it already consumed. */
  relayReplayRejected: (answer?: Answer) => answer?.status === 403 && /^DEVFN_OAUTH_RELAY_REJECTED: replayed\b/.test(answer.body),
  /**
   * The provider edge's own refusal of a Host the run never published: a
   * Cloudflare 1xxx edge error (plain text for a non-browser client, 4xx or
   * Cloudflare's own 530, never 1033, which means a tunnel did match) or an
   * ngrok ERR_NGROK error with a 4xx status. A 5xx from an origin path, a
   * fixture answer and anything shaped like the DevFn origin (its marker
   * header or its empty 421) mean the edge forwarded the request.
   */
  edgeUnrouted: (answer: Answer | undefined, provider: TunnelBinding["provider"]) => {
    if (!answer || answer.json?.marker !== undefined || originHeader(answer) !== undefined) return false;
    const client = answer.status >= 400 && answer.status < 500;
    if (provider === "cloudflare") {
      return answer.headers.server === "cloudflare" && typeof answer.headers["cf-ray"] === "string" && (client || answer.status === 530) && /^error code: 1(?!033)\d{3}\s*$/.test(answer.body);
    }
    return client && /^ERR_NGROK_\d+$/.test(String(answer.headers["ngrok-error-code"] ?? ""));
  },
  /** The provider read-back holds no name for the private route, and every name it holds for the binding is the selected public host. */
  providerWithheld: (held: readonly string[], publicHost: string, privateName: string) => !held.includes(privateName) && held.every((name) => name === publicHost),
};

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

/**
 * Handle a promise the driver does not await at once, from the moment it is
 * created, and rethrow its rejection only when joined: an interrupt that
 * rejects it while the driver awaits something else never ends the process
 * before the run's cleanup and read-back.
 */
export function detach<T>(promise: Promise<T>): () => Promise<T> {
  const settled = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  return async () => { const outcome = await settled; if ("error" in outcome) throw outcome.error; return outcome.value; };
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
  const direct = async (name: string) => { const leased = allocation(name); return leased ? await host.request(`http://127.0.0.1:${leased.port}/`).catch(() => undefined) : undefined; };
  const answer = await direct("client");
  context.expect("sibling-url", answer?.json?.upstream === "http://echo:8080" && answer.json.answer === "echo", `client saw ${String(answer?.json?.upstream)} and reached it: ${answer?.json?.answer === "echo"}`);
  const echo = await direct("echo");
  const published = await Promise.all(["echo", "client"].map(async (name) => (await host.docker(["ps", "--filter", `publish=${allocation(name)?.port ?? 0}`, "--format", "{{.Ports}}"])).stdout.trim()));
  // Each leased port is published on loopback only and answers at its own direct URL with its own service.
  context.expect("loopback-mapping", published.every((ports, index) => ports.length > 0 && ports.split(",").every((item) => item.trim().startsWith("127.0.0.1:")) && allocation(["echo", "client"][index])?.host === "127.0.0.1")
    && echo?.status === 200 && echo.body === "echo" && answer?.status === 200,
    `published: ${published.join(" | ")}; direct echo -> ${echo ? `${echo.status} ${echo.body.slice(0, 20)}` : "unanswered"}, client -> ${answer?.status ?? "unanswered"}`);
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
  context.expect("path-prefix", stripped.json?.name === "api" && stripped.json.path === "/item?x=1" && ANSWERS.proxyNotFound(boundary), `${pathOf(api)}/item -> ${String(stripped.json?.path)}; ${pathOf(api)}x -> ${boundary.status}`);
  const unselected = await host.request(`${originOf(api)}/other`, { ca });
  const unknown = await host.request(`http://${host.prefix}-unknown.localhost/`);
  context.expect("unselected-denied", ANSWERS.proxyNotFound(unselected) && ANSWERS.proxyNotFound(unknown), `unselected path ${unselected.status}, unknown host ${unknown.status}`);
  // Each of a worktree's names must answer with that worktree's own marker: an unanswered request proves nothing about isolation.
  const answered: string[] = [];
  for (const own of [a, b]) for (const url of [own.urls.web, `${own.urls.api}/x`]) { const found = (await host.request(url, { ca })).json?.marker; if (found !== marker(own.cwd)) answered.push(`${url} -> ${String(found ?? "no marker")}`); }
  const disjoint = !(a.receipt.routes as Array<{ hostname: string }>).some((route) => (b.receipt.routes as Array<{ hostname: string }>).some((other) => other.hostname === route.hostname));
  context.expect("no-cross-worktree", answered.length === 0 && disjoint, `route hostnames disjoint: ${disjoint}; names not answered by their own worktree: ${answered.join(", ") || "none"}`);
};

const internalTls: LiveDriver = async (context, host) => {
  const anchors = await host.trustAnchors();
  const [a, b] = await twoWorktrees(context, host);
  const ca = await host.ca();
  const names = await Promise.all([a, b].map(async (item) => await certificateNames(hostOf(item.urls.web), ca)));
  context.expect("verified-sni", names.every((name, index) => name.includes(`DNS:${hostOf([a, b][index].urls.web)}`)), `verified certificates: ${names.join(" | ")}`);
  const plain = await host.request(plainOf(a.urls.web));
  context.expect("http-redirect", ANSWERS.httpsRedirect(plain, hostOf(a.urls.web)), `HTTP answered ${plain.status} -> ${String(plain.headers.location)}`);
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
  const served: boolean[] = [];
  const routes: string[][] = [];
  let ca = "";
  for (const cwd of [primary, linked]) {
    const receipt = await start(context, host, cwd);
    // The internal root is read from the Caddy admin API, which exists only once a lifecycle started Caddy.
    ca ||= await host.ca();
    routes.push((receipt.routes as Array<{ hostname: string }>).map((route) => route.hostname));
    // The worktree's own alias itself resolves to loopback and serves the worktree over the registration's internal TLS.
    const alias = routes.at(-1)!.find((name) => name.endsWith(`.${domain}`) && name.startsWith("web-"));
    served.push(alias !== undefined && await loopback(alias) && await serves(host, `https://${alias}:${proxyListenerPorts().httpsPort}/`, cwd, ca));
  }
  context.expect("worktree-alias", served.length === 2 && served.every(Boolean), `aliases ${routes.flat().join(", ")}; each served its own worktree: ${served.join(", ")}`);
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
  // Each consumed callback is replayed as soon as its app reports it, well inside the relay ticket lifetime, so only "replayed" is a rejection.
  const replays: Array<Answer | undefined> = [];
  const replay = async () => {
    for (const app of apps) for (const url of (await host.request(`${originOf(app.url)}/replays`, { ca })).json as unknown as string[]) replays.push(await host.request(url, { ca }).catch(() => undefined));
  };
  const deadline = Date.now() + 600_000;
  let evidence: Evidence[] = [];
  while (Date.now() < deadline) {
    evidence = await Promise.all(apps.map(read));
    await replay();
    if (evidence.every((item) => item.evidence.some((record) => record.session === true))) break;
    await host.wait(3_000);
  }
  await replay();
  const logins = evidence.map((item) => item.evidence.find((record) => record.session === true));
  const approved = `${relay.origin}${OAUTH_CALLBACK_PATH}` === oauth.redirectUri;
  context.expect("one-redirect-uri", approved && logins.every((record) => record?.redirectUri === oauth.redirectUri), `relay redirect ${relay.origin}${OAUTH_CALLBACK_PATH}; both flows used it: ${logins.every((record) => record?.redirectUri === oauth.redirectUri)}`);
  // The relay delivered each callback to its own worktree's host, which honors the session it established there.
  const own = await Promise.all(apps.map(async (app, index) => evidence[index].probe ? (await host.request(`${originOf(app.url)}/me`, { ca, cookie: `sid=${evidence[index].probe}` }).catch(() => undefined))?.status : undefined));
  context.expect("login-both", logins.every((record, index) => record?.host === new URL(apps[index].url).host && evidence[index].sessionHosts.every((item) => item === record.host)) && own.every((status) => status === 200),
    `callbacks and sessions on ${logins.map((record) => record?.host ?? "none").join(", ")}; /me with each own session: ${own.join(", ")}`);
  context.expect("state-nonce-pkce", logins.every((record) => record?.stateOk === true && record.nonceOk === true && record.pkce === "S256" && record.audienceOk === true && record.issuerOk === true),
    "state, ID token nonce/audience/issuer and S256 PKCE validated by both clients");
  const after = await Promise.all(apps.map(read));
  context.expect("replay-rejected", replays.length >= 2 && replays.every(ANSWERS.relayReplayRejected) && after.every((item) => item.sessions === item.evidence.filter((record) => record.session === true).length),
    `replayed ${replays.length} consumed callbacks: ${replays.map((answer) => answer ? `${answer.status} ${answer.body.trim()}` : "unanswered").join(", ")}; sessions ${after.map((item) => item.sessions).join(", ")}, one per login`);
  context.expect("token-exchange", logins.every((record) => record?.tokenStatus === 200), "Google's token endpoint answered 200 to each worktree's own exchange; the receipt holds no code or token, and consumed callbacks were replayed from memory");
};

/** Read-back helpers shared by tunnel journeys. */
async function publicAnswer(host: LiveHost, url: string, attempts = 24): Promise<{ status: number; marker?: string; name?: string; path?: string } | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const answer = await host.request(url, { publicDns: true }).catch(() => undefined);
    if (answer?.json?.marker) return { status: answer.status, marker: String(answer.json.marker), name: String(answer.json.name), path: String(answer.json.path) };
    if (attempt === attempts - 1) return answer ? { status: answer.status } : undefined;
    await host.wait(5_000);
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

/**
 * Record and start one public worktree. Its public name is recorded before up
 * can publish it: the planned URL's host, or, for a URL the provider assigns
 * only after start, the origin name DevFn derives for the route, which the
 * provider read-back finds by the binding's marker whatever URL it got. The
 * assigned URL is attached once the start reports it.
 */
async function publicStart(context: ScenarioContext, host: LiveHost, cwd: string, name: string): Promise<{ hostname: string; url: string; receipt: Record<string, any> }> {
  const planned = (await host.must(cwd, ["tunnel", "urls"])) as { urls: Record<string, string> };
  const bound = (await readTunnelBindings(host.stateDir)).find((item) => item.name === name);
  if (!bound) throw new Error(`binding ${name} is not readable before start`);
  const origin = planned.urls.web ? hostOf(planned.urls.web) : domainAliases("web", bound.domain, await resolveInstanceIdentity(PROJECT_ID, cwd))[0];
  const entry = context.inventory.record("public-hostname", origin, context.scenario.id, { cwd, binding: name, ...(planned.urls.web ? { url: planned.urls.web } : {}) });
  const receipt = await host.soleTunnelUser(bound, async () => await start(context, host, cwd, ["--allow-public"]));
  const hostname = (receipt.tunnel?.hostnames as string[] | undefined)?.[0] ?? "";
  const url = (receipt.publicUrls as Record<string, string> | undefined)?.web ?? "";
  if (hostname !== origin) throw new Error(`DevFn published ${hostname || "no name"} for web, not the recorded ${origin}`);
  if (!planned.urls.web && url) context.inventory.attach(entry, { url });
  return { hostname, url, receipt };
}

/** Every name the provider holds for the private route's name or carrying the binding's marker; providerWithheld allows only the selected public host among them. */
export async function providerHeld(readBack: ProviderReadBack, binding: TunnelBinding, privateName: string): Promise<string[]> {
  return [...new Set([...await readBack(binding, privateName, undefined), ...await readBack(binding, undefined, undefined)])].sort();
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
  // Denial needs the shipped component's own answer; an unreachable or failed probe proves nothing.
  const bound = (await readTunnelBindings(host.stateDir)).find((item) => item.name === name)!;
  const ca = await host.ca();
  const local = hostOf((await urls(host, cwd)).private);
  const privateName = hostname.replace(/^web-/, "private-");
  // The origin denies the private route's own name (SNI == Host) and refuses it as a forged Host behind the public name.
  const denied = await host.request(`https://${local}/`, { ca, port: PUBLIC_ORIGIN_PORT }).catch(() => undefined);
  const forged = await host.request(`https://${hostname}/`, { ca, port: PUBLIC_ORIGIN_PORT, host: local }).catch(() => undefined);
  const outside = await host.request(`${originOf(url)}/other`, { publicDns: true }).catch(() => undefined);
  const held = await providerHeld(host.readBack, bound, privateName);
  const shown = (answer?: Answer) => answer ? `${answer.status} ${String(originHeader(answer) ?? "")}`.trim() : "unanswered";
  context.expect("private-route-denied", !(receipt.tunnel?.hostnames as string[]).some((item) => item.startsWith("private-")) && ANSWERS.originDenied(denied) && ANSWERS.forgedHostRefused(forged)
    && ANSWERS.originFallback(outside) && ANSWERS.providerWithheld(held, hostOf(url), privateName),
    `origin for ${local}: ${shown(denied)}; Host ${local} behind ${hostname}: ${shown(forged)}; ${originOf(url)}/other: ${shown(outside)}; ${bound.provider} holds ${held.join(", ") || "nothing"} for the binding or ${privateName}`);
  if (bound.provider === "cloudflare") await new CloudflareTunnelProvider({ env: host.options.env }).verifyDns(bound, hostname);
  const resolved = await lookup(hostOf(url), { all: true }).then((items) => items.map((item) => item.address), () => []);
  const misrouted = await host.request(url, { publicDns: true, host: `${host.prefix}-unrouted.${hostOf(url).split(".").slice(1).join(".")}` }).catch(() => undefined);
  const edgeError = misrouted ? String(misrouted.headers["ngrok-error-code"] ?? misrouted.body.trim().slice(0, 40)) : "";
  // A reserved endpoint's name lies under the account's reserved wildcard domain.
  const underDomain = kind !== "ngrok-reserved" || hostOf(url).endsWith(`.${approval!.ngrokReserved!.domain}`);
  context.expect("dns-host-sni", resolved.length > 0 && underDomain && ANSWERS.edgeUnrouted(misrouted, bound.provider),
    `${hostOf(url)} resolves to ${resolved.join(", ")}; edge certificate verified for the name; mismatched Host answered ${misrouted ? `${misrouted.status} ${edgeError}`.trim() : "nothing"}`);
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
  const bound = (await readTunnelBindings(host.stateDir)).find((item) => item.name === name)!;
  // Withdrawing a name can swap the connector for a successor; the run identifies that successor as its own.
  await host.soleTunnelUser(bound, async () => await host.must(primary, ["down"]));
  context.expect("withdraw-one", !await present(a.hostname) && (await publicAnswer(host, `${b.url}/x`))?.marker === marker(linked), `${a.hostname} withdrawn; ${b.hostname} still serves`);
  const recovery = await restartConnector(host, bound, linked, `${b.url}/x`);
  context.expect("recover-preserves", RECOVERED.connectorRestarted(recovery),
    `connector ${recovery.killed} ${recovery.signalled ? "killed" : "not signalled: its recorded identity was not verified"}: ${recovery.downAfterKill ? "down" : "still up"}, served meanwhile: ${recovery.servedWhileDown}; after tunnel recover connector ${String(recovery.after ?? "none")} ${recovery.running ? "runs" : "is not running"}; ${b.hostname} serves: ${recovery.served}`);
  await host.must(linked, ["down"]);
  context.expect("withdrawn-absent", !await present(a.hostname) && !await present(b.hostname), "neither hostname is routed, journaled, recorded at the provider or served");
};

/** What a connector restart showed: the connector the run killed went down, and tunnel recover started a new one that serves the remaining route. */
export interface ConnectorRecovery { killed: number; signalled: boolean; downAfterKill: boolean; servedWhileDown: boolean; after?: number; running: boolean; served: boolean }

export const RECOVERED = {
  /** The run signalled the recorded connector, its process was gone and DevFn reported it stopped, nothing served the route meanwhile, and recover left a different connector running that serves it. */
  connectorRestarted: (recovery: ConnectorRecovery) => recovery.signalled && recovery.downAfterKill && !recovery.servedWhileDown && recovery.after !== undefined && recovery.after !== recovery.killed && recovery.running && recovery.served,
};

/**
 * Kill the binding's recorded connector (its process group, SIGKILL), observe
 * that it is down and the remaining route is not served, then run devfn
 * tunnel recover from cwd and read the connector and route back. A recover
 * on a healthy connector would be a no-op, so it never stands for a restart.
 * The connector is signalled only while its process matches the birth
 * identity DevFn recorded for it; otherwise nothing is signalled or recovered.
 */
export async function restartConnector(host: LiveHost, bound: TunnelBinding, cwd: string, url: string): Promise<ConnectorRecovery> {
  const connector = (await readTunnelState(host.stateDir, bound.name)).connector;
  if (!connector) throw new Error(`binding ${bound.name} records no connector to restart`);
  if (!await host.killRecorded(connector, true)) return { killed: connector.pid, signalled: false, downAfterKill: false, servedWhileDown: false, running: false, served: false };
  for (let wait = 0; wait < 50 && alive(connector.pid); wait += 1) await host.wait(200);
  const stopped = (await host.must(cwd, ["tunnel", "status", bound.name])).tunnel as { connector?: string };
  // DevFn reports stopped only on death evidence; unverified or a missing answer is not down.
  const downAfterKill = !alive(connector.pid) && stopped.connector === "stopped";
  const meanwhile = await host.request(url, { publicDns: true }).catch(() => undefined);
  await host.soleTunnelUser(bound, async () => await host.must(cwd, ["tunnel", "recover", bound.name, "--allow-public"]));
  const recovered = (await host.must(cwd, ["tunnel", "status", bound.name])).tunnel as { connector?: string; pid?: number };
  const after = typeof recovered.pid === "number" ? recovered.pid : undefined;
  return { killed: connector.pid, signalled: true, downAfterKill, servedWhileDown: meanwhile?.json?.marker === marker(cwd), ...(after !== undefined ? { after } : {}),
    running: recovered.connector === "running" && after !== undefined && alive(after), served: (await publicAnswer(host, url))?.marker === marker(cwd) };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/** The node a startup failure is injected into: the last in plan order, so DevFn started the node before it, which is listening when it fails. */
export function failureInjection(config: Record<string, unknown>): { failing: string; sibling: string } {
  const nodes = createPlan(validateDevFnConfig(config)).nodes;
  if (nodes.length < 2) throw new Error("a startup failure needs a node started before the failing one");
  return { failing: nodes.at(-1)!.name, sibling: nodes.at(-2)!.name };
}

/** The failing node asked its sibling before it exited and got the worktree's own answer, and the sibling's process is gone now. */
export function rolledBackReadySibling(failing: { sibling?: Record<string, unknown> | null } | undefined, sibling: { pid: number } | undefined, name: string, cwd: string, running = alive): boolean {
  return failing?.sibling?.name === name && failing.sibling.marker === marker(cwd) && sibling !== undefined && !running(sibling.pid);
}

const startupFailure: LiveDriver = async (context, host) => {
  const { check } = await sentinel(context, host);
  const config = hostFixture();
  const cwd = await host.repository(context.scenario.id, "failing", config);
  const { failing, sibling } = failureInjection(config);
  await writeFile(path.join(cwd, `fail-${failing}`), `DEVFN_URL_${sibling.toUpperCase()}`, "utf8");
  const failed = await host.up(context.scenario.id, cwd);
  const [failedSeen, siblingSeen] = await Promise.all([failing, sibling].map(async (name) => await host.seen(cwd, name).catch(() => undefined)));
  const rolledBack = rolledBackReadySibling(failedSeen, siblingSeen, sibling, cwd);
  // Leases and routes are those of the checkout's own owner, never of whatever an unreadable status named.
  const owner = await host.owner(cwd);
  const status = await host.status(cwd);
  const leases = ((await host.must(cwd, ["ports"])).allocations as Array<{ instanceId: string }>).filter((item) => item.instanceId === owner);
  // The processes the failed start launched recorded their pids; none may survive, and no route of the owner may stay.
  const survivors = await host.survivingFixtures(cwd);
  const routes = await host.routesOf(owner);
  await rm(path.join(cwd, `fail-${failing}`));
  const retried = await host.up(context.scenario.id, cwd);
  context.expect("failure-cleaned", failedWith(failed, SHIPPED_ERRORS.startupFailure) && rolledBack && status !== undefined && status.state !== "ready" && leases.length === 0 && survivors.length === 0 && routes.length === 0
    && retried.code === 0 && retried.json.state === "ready",
    `${failing} failed while ${sibling} answered: ${failedSeen?.sibling ? "yes" : "no"}; ${sibling} process ${String(siblingSeen?.pid)} ${rolledBack ? "stopped" : "not shown stopped"}; failure ${String(failed.json.error?.code)} (exit ${failed.code}); state ${status ? status.state : "unreadable"}; leases left ${leases.length}; processes left ${survivors.join(", ") || "none"}; routes left ${routes.join(", ") || "none"}; retry ${String(retried.json.state)}`);
  await check();
};

const concurrentChange: LiveDriver = async (context, host) => {
  const { check } = await sentinel(context, host);
  const cwd = await host.repository(context.scenario.id, "concurrent", hostFixture());
  const results = await Promise.all([host.up(context.scenario.id, cwd), host.up(context.scenario.id, cwd)]);
  const winners = results.filter((item) => item.code === 0 && item.json.state === "ready");
  const status = await host.status(cwd);
  const loser = results.find((item) => item !== winners[0]);
  context.expect("single-owner", winners.length === 1 && status?.state === "ready" && Array.isArray(status.processes) && status.processes.length === 2 && failedWith(loser, SHIPPED_ERRORS.concurrentStart),
    `${winners.length} of 2 concurrent starts succeeded; the other: ${JSON.stringify(loser?.json.error?.code)} (exit ${String(loser?.code)}); status ${status ? status.state : "unreadable"}`);
  const before = await host.seen(cwd, "web");
  await writeFile(path.join(cwd, "devfn.config.json"), `${JSON.stringify(hostFixture({ QUAL_REVISION: "2" }), null, 2)}\n`);
  const degraded = await host.status(cwd, ["--trust"]);
  const restarted = await host.must(cwd, ["restart"]);
  const seen = await host.seen(cwd, "web");
  context.expect("change-detected", before.env.QUAL_REVISION === undefined && degraded?.state === "degraded" && restarted.state === "ready" && seen.pid !== before.pid && seen.env.QUAL_REVISION === "2" && seen.env.DEVFN_INSTANCE_ID === restarted.instanceId,
    `status after change: ${degraded ? degraded.state : "unreadable"}; restart: ${String(restarted.state)}; process ${before.pid} -> ${seen.pid} saw QUAL_REVISION=${String(seen.env.QUAL_REVISION)}`);
  await check();
};

export interface InterruptedStart { killed: boolean; orphan?: number; result: { code: number; json: Record<string, any> }; status?: OwnedStatus }

/**
 * Start cwd's lifecycle with its last node held before listening (hold-<name>),
 * kill the start with SIGKILL once that node recorded itself, then lift the
 * hold so the orphan listens as a process killed mid-start would. killed is
 * whether the start was still running when it was killed.
 */
export async function interruptStart(context: ScenarioContext, host: LiveHost, cwd: string): Promise<InterruptedStart> {
  const { failing: held } = failureInjection(hostFixture());
  await writeFile(path.join(cwd, `hold-${held}`), "", "utf8");
  const kill = new AbortController();
  let ended = false;
  // It runs like every DevFn command of the run, in the run's environment.
  const join = detach(host.up(context.scenario.id, cwd, [], kill.signal).finally(() => { ended = true; }));
  let orphan: number | undefined;
  let killed = false;
  try {
    for (let wait = 0; wait < 300 && orphan === undefined && !ended; wait += 1) { orphan = (await host.seen(cwd, held).catch(() => undefined))?.pid; if (orphan === undefined) await host.wait(100); }
    killed = !ended && orphan !== undefined;
  } finally {
    // An interrupted wait still kills the start and waits for it to end before the driver returns to cleanup.
    kill.abort();
    await join().catch(() => undefined);
    await rm(path.join(cwd, `hold-${held}`), { force: true });
  }
  const result = await join();
  // A failed or degraded lifecycle still reports its state for its owner; a failed read reports none.
  const status = await host.status(cwd);
  return { killed, ...(orphan !== undefined ? { orphan } : {}), result, ...(status ? { status } : {}) };
}

export const INTERRUPTED = {
  /** The start was killed while its held node had recorded itself and before it ended, it reported no ready lifecycle, and its owner's status then read a lifecycle that is not ready. */
  killedBeforeReady: (start: InterruptedStart) => start.killed && start.orphan !== undefined && start.result.code !== 0 && start.result.json.state !== "ready"
    && start.status !== undefined && start.status.state !== "ready",
  /** No process of the killed start still runs, whatever a later lifecycle lists: a live orphan fails, and an unknown orphan proves nothing. */
  orphanGone: (start: InterruptedStart, running: (pid: number) => boolean = alive) => start.orphan !== undefined && !running(start.orphan),
};

const crash: LiveDriver = async (context, host) => {
  const { check } = await sentinel(context, host);
  const cwd = await host.repository(context.scenario.id, "crash", hostFixture());
  await start(context, host, cwd);
  // The web process is recorded while DevFn reports its lifecycle ready, and signalled only while it still matches that record.
  const target = await host.recordProcess((await host.seen(cwd, "web")).pid);
  if (!await host.killRecorded(target, false)) context.expect("crash-detected", false, `web process ${String(target?.pid ?? "unrecorded")} not signalled: its identity was not verified`);
  await host.wait(500);
  // DevFn's detected crash: the ready lifecycle's process died, so its owner's status reads degraded (or failed).
  const status = await host.status(cwd);
  const interrupted = await host.repository(context.scenario.id, "interrupted", hostFixture());
  const killed = await interruptStart(context, host, interrupted);
  const orphan = killed.orphan;
  const collected = await host.devfn(interrupted, ["ports", "gc"]);
  context.expect("crash-detected", (status?.state === "degraded" || status?.state === "failed") && INTERRUPTED.killedBeforeReady(killed) && collected.code === 0,
    `status after kill: ${status ? status.state : "unreadable"}; interrupted up ${killed.killed ? "killed" : "not killed"} before it ended: code ${killed.result.code}, state ${String(killed.result.json.state ?? killed.result.json.error?.code)}; its status then ${killed.status ? killed.status.state : "unreadable"}; ports gc after it: ${collected.code === 0 ? "ok" : JSON.stringify(collected.json.error)}`);
  const restarted = await host.must(cwd, ["restart"]);
  // The killed start's lifecycle lock is recoverable only once stale (five minutes); a retry before then fails closed.
  let retried = await host.up(context.scenario.id, interrupted);
  for (const deadline = Date.now() + 420_000; !(retried.code === 0 && retried.json.state === "ready") && Date.now() < deadline; retried = await host.up(context.scenario.id, interrupted)) {
    await host.wait(15_000);
    await host.devfn(interrupted, ["ports", "gc"]);
  }
  const gone = INTERRUPTED.orphanGone(killed);
  const ca = await host.ca();
  context.expect("restart-recovers", restarted.state === "ready" && await serves(host, (await urls(host, cwd)).web, cwd, ca) && retried.code === 0 && retried.json.state === "ready" && gone && await serves(host, (await urls(host, interrupted)).web, interrupted, ca),
    `crashed worktree ${String(restarted.state)}; interrupted worktree ${String(retried.json.state ?? JSON.stringify(retried.json.error))}; process ${String(orphan)} from the killed start ${gone ? "is gone" : "still runs"}`);
  await check();
};

const oneWorktreeStop: LiveDriver = async (context, host) => {
  const [a, b] = await twoWorktrees(context, host);
  const ca = await host.ca();
  const before = await host.seen(b.cwd, "web");
  await host.must(a.cwd, ["down"]);
  const status = await host.status(a.cwd);
  const leases = ((await host.must(a.cwd, ["ports"])).allocations as Array<{ instanceId: string }>).filter((item) => item.instanceId === a.receipt.instanceId);
  const survivors = await host.survivingFixtures(a.cwd);
  const routes = await host.routesOf(String(a.receipt.instanceId));
  // Withdrawal is observed as the proxy's own 404 for the name on plain HTTP, never as a failed request.
  const answer = await host.request(plainOf(a.urls.web)).catch(() => undefined);
  context.expect("stopped-withdrawn", status?.state === "stopped" && leases.length === 0 && survivors.length === 0 && routes.length === 0 && ANSWERS.proxyNotFound(answer),
    `state ${status ? status.state : "unreadable"}; leases ${leases.length}; processes left ${survivors.join(", ") || "none"}; routes left ${routes.join(", ") || "none"}; ${plainOf(a.urls.web)} -> ${String(answer?.status ?? "unanswered")}`);
  const after = await host.seen(b.cwd, "web");
  context.expect("sentinel-preserved", after.pid === before.pid && await serves(host, b.urls.web, b.cwd, ca), `other worktree pid ${before.pid} -> ${after.pid}`);
};

const proxyReload: LiveDriver = async (context, host) => {
  const { check, cwd: sentinelCwd, web } = await sentinel(context, host);
  const ca = await host.ca();
  const cwd = await host.repository(context.scenario.id, "reload", hostFixture());
  let probing = true;
  const answers: boolean[] = [];
  const probe = detach((async () => { while (probing) { answers.push(await serves(host, web, sentinelCwd, ca)); await host.wait(50); } })());
  try { await start(context, host, cwd); await host.must(cwd, ["down"]); await start(context, host, cwd); await host.must(cwd, ["down"]); }
  finally { probing = false; await probe(); }
  context.expect("reload-preserves", answers.length > 0 && answers.every(Boolean), `${answers.filter(Boolean).length}/${answers.length} sentinel probes answered across four route changes`);
  await check();
};

/**
 * DEVFN_ values a process sees that DevFn sets at launch outside the endpoint
 * resolver; a new one must be named here, never ignored by default.
 * DEVFN_STATE_DIR is the lifecycle's state directory (core orchestrator), so
 * the OAuth relay client reaches the right DevFn state; the driver checks its
 * value against the run's state directory instead.
 */
export const RUNTIME_ONLY_KEYS: ReadonlySet<string> = new Set(["DEVFN_STATE_DIR"]);

/** Every DEVFN_ key, in either direction, whose resolver value differs from what the process saw: a key only one side has differs too. */
export function resolverDifferences(resolved: Record<string, string>, seen: Record<string, string>, runtimeOnly: ReadonlySet<string> = RUNTIME_ONLY_KEYS): string[] {
  const keys = new Set([...Object.keys(resolved), ...Object.keys(seen)].filter((key) => key.startsWith("DEVFN_") && !runtimeOnly.has(key)));
  return [...keys].sort().flatMap((key) => resolved[key] === seen[key] ? [] : [key in resolved ? (key in seen ? key : `${key} (not seen by the process)`) : `${key} (not produced by the resolver)`]);
}

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
  const differing = (["web", "api"] as const).flatMap((name) => [...resolverDifferences(resolved.nodes[name].environment, (name === "web" ? seen : api).env),
    ...((name === "web" ? seen : api).env.DEVFN_STATE_DIR === host.stateDir ? [] : [`DEVFN_STATE_DIR (${String((name === "web" ? seen : api).env.DEVFN_STATE_DIR)}, not the run state directory)`])].map((item) => `${name}.${item}`));
  context.expect("resolver-matches", differing.length === 0, differing.length ? `differs: ${differing.join(", ")}` : "the published resolver reproduced every DEVFN_ value each process saw, and nothing more; DEVFN_STATE_DIR is the run state directory");
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
