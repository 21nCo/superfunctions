import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";

import type { OAuthRelayClient } from "../../src/oauth-relay/client.js";

/**
 * Application-neutral OAuth fixtures. The provider is fake: success through
 * it is fixture evidence of the relay contract, not a real provider journey.
 */

const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}
const close = async (server: http.Server) => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };

async function body(request: http.IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}

export interface FakeProvider {
  origin: string;
  clientId: string; clientSecret: string;
  /** Every token request's redirect_uri and outcome, in order. */
  tokenRequests: Array<{ redirectUri: string; ok: boolean; error?: string }>;
  /** Every code the provider issued, so tests can search other outputs for them. */
  issuedCodes: string[];
  issuedTokens: string[];
  close(): Promise<void>;
}

/**
 * A code-flow provider with exact registered redirect URIs, single-use codes,
 * mandatory S256 PKCE, a nonce echoed in an (unsigned fixture) ID token and a
 * token exchange that must repeat the authorization request's redirect URI.
 * The signed-in user is chosen with login_hint.
 */
export async function createFakeProvider(registeredRedirectUris: () => readonly string[]): Promise<FakeProvider> {
  const clientId = "fixture-client";
  const clientSecret = `secret-${token(16)}`;
  const codes = new Map<string, { redirectUri: string; challenge: string; nonce: string; user: string; used: boolean }>();
  const provider: Omit<FakeProvider, "close" | "origin"> = { clientId, clientSecret, tokenRequests: [], issuedCodes: [], issuedTokens: [] };
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (url.searchParams.get("client_id") !== clientId || !registeredRedirectUris().includes(redirectUri) ||
          url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("code_challenge") || !url.searchParams.get("state")) {
          response.writeHead(400).end("invalid_request"); return;
        }
        const code = token();
        provider.issuedCodes.push(code);
        codes.set(code, { redirectUri, challenge: url.searchParams.get("code_challenge")!, nonce: url.searchParams.get("nonce") ?? "", user: url.searchParams.get("login_hint") ?? "anonymous", used: false });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        response.writeHead(302, { location: callback.href }).end(); return;
      }
      if (request.method === "POST" && url.pathname === "/token") {
        const form = new URLSearchParams(await body(request));
        const grant = codes.get(form.get("code") ?? "");
        const redirectUri = form.get("redirect_uri") ?? "";
        let error: string | undefined;
        if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) error = "invalid_client";
        else if (!grant || grant.used) error = "invalid_grant";
        else if (grant.redirectUri !== redirectUri) error = "redirect_uri_mismatch";
        else if (s256(form.get("code_verifier") ?? "") !== grant.challenge) error = "pkce_failed";
        if (grant) grant.used = true;
        provider.tokenRequests.push({ redirectUri, ok: !error, ...(error ? { error } : {}) });
        if (error || !grant) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error })); return; }
        const accessToken = token();
        provider.issuedTokens.push(accessToken);
        const idToken = `fixture.${Buffer.from(JSON.stringify({ iss: "fixture-provider", aud: clientId, sub: grant.user, nonce: grant.nonce })).toString("base64url")}.unsigned`;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: accessToken, id_token: idToken, token_type: "Bearer" })); return;
      }
      response.writeHead(404).end();
    })().catch(() => response.writeHead(500).end());
  });
  const port = await listen(server);
  return { ...provider, origin: `http://127.0.0.1:${port}`, close: async () => await close(server) } as FakeProvider;
}

export interface OAuthClientApp {
  port: number;
  /** Server-side sessions by session ID; values are signed-in users. */
  sessions: Map<string, string>;
  /** Callback outcomes in order, for assertions. */
  callbacks: Array<{ ok: boolean; reason?: string }>;
  verifiers: string[];
  close(): Promise<void>;
}

/**
 * A worktree's own OAuth client. It owns state, nonce and PKCE, binds them
 * to a host-only pre-session cookie, validates them at its callback, performs
 * the token exchange with the relay's registered redirect URI and issues its
 * own host-only session cookie. It knows nothing about other worktrees.
 */
export async function createOAuthClientApp(options: { scheme: "http" | "https"; callbackPath: string; provider: FakeProvider; relay: OAuthRelayClient }): Promise<OAuthClientApp> {
  const pending = new Map<string, { state: string; nonce: string; verifier: string; redirectUri: string }>();
  const app: Omit<OAuthClientApp, "port" | "close"> = { sessions: new Map(), callbacks: [], verifiers: [] };
  const cookie = (request: http.IncomingMessage, name: string) => (request.headers.cookie ?? "").split(/;\s*/).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
  const fail = (response: http.ServerResponse, reason: string) => { app.callbacks.push({ ok: false, reason }); response.writeHead(400).end(reason); };
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/login") {
        const id = token(16);
        const state = `st_${token()}`;
        const nonce = `nonce_${token()}`;
        const verifier = token(64);
        app.verifiers.push(verifier);
        const { redirectUri } = await options.relay.authorize({ state, callbackUrl: `${options.scheme}://${request.headers.host}${options.callbackPath}` });
        pending.set(id, { state, nonce, verifier, redirectUri });
        const authorize = new URL("/authorize", options.provider.origin);
        for (const [key, value] of Object.entries({ response_type: "code", client_id: options.provider.clientId, redirect_uri: redirectUri, state, nonce,
          code_challenge: s256(verifier), code_challenge_method: "S256", login_hint: url.searchParams.get("user") ?? "anonymous" })) authorize.searchParams.set(key, value);
        response.writeHead(302, { location: authorize.href, "set-cookie": `pre=${id}; Path=/; HttpOnly; SameSite=Lax` }).end(); return;
      }
      if (url.pathname === options.callbackPath) {
        const flow = pending.get(cookie(request, "pre") ?? "");
        const state = url.searchParams.get("state") ?? "";
        if (!flow || !same(flow.state, state)) { fail(response, "state_mismatch"); return; }
        pending.delete(cookie(request, "pre")!);
        const exchange = await fetch(new URL("/token", options.provider.origin), { method: "POST", body: new URLSearchParams({
          grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", redirect_uri: flow.redirectUri, client_id: options.provider.clientId,
          client_secret: options.provider.clientSecret, code_verifier: flow.verifier }) });
        if (!exchange.ok) { fail(response, `token_${((await exchange.json()) as { error: string }).error}`); return; }
        const claims = JSON.parse(Buffer.from(((await exchange.json()) as { id_token: string }).id_token.split(".")[1], "base64url").toString("utf8")) as { aud: string; sub: string; nonce: string };
        if (claims.aud !== options.provider.clientId || !same(claims.nonce, flow.nonce)) { fail(response, "nonce_mismatch"); return; }
        const sid = token();
        app.sessions.set(sid, claims.sub);
        app.callbacks.push({ ok: true });
        response.writeHead(302, { location: "/me", "set-cookie": [`sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax`, "pre=; Path=/; Max-Age=0"] }).end(); return;
      }
      if (url.pathname === "/me") {
        const user = app.sessions.get(cookie(request, "sid") ?? "");
        response.writeHead(user ? 200 : 401).end(user ?? "anonymous"); return;
      }
      response.writeHead(404).end();
    })().catch((error: unknown) => { if (!response.headersSent) fail(response, error instanceof Error && "reason" in error ? String(error.reason) : "error"); });
  });
  const port = await listen(server);
  return { ...app, port, close: async () => await close(server) } as OAuthClientApp;
}

export interface Hop { url: string; status: number; location?: string; setCookie: string[]; body: string }

/**
 * A browser with a host-only cookie jar. It reaches DevFn hostnames through
 * `connect`, which stands in for DNS plus Caddy (or is real Caddy), and
 * follows redirects while recording every hop.
 */
export class FixtureBrowser {
  public readonly jar = new Map<string, Map<string, string>>();

  public constructor(private readonly connect: (url: URL) => { port: number; ca?: string; tls: boolean }) {}

  public async request(target: string): Promise<Hop> {
    const url = new URL(target);
    const route = this.connect(url);
    // Like a browser, host-only cookies are keyed by hostname, not port.
    const cookies = [...(this.jar.get(url.hostname) ?? new Map()).entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    const hop = await new Promise<Hop>((resolve, reject) => {
      const client = route.tls ? https : http;
      const call = client.request({ hostname: "127.0.0.1", port: route.port, path: `${url.pathname}${url.search}`, method: "GET",
        headers: { host: url.host, ...(cookies ? { cookie: cookies } : {}) }, ...(route.tls ? { servername: url.hostname, ca: route.ca } : {}) }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += String(chunk); });
        response.on("end", () => resolve({ url: target, status: response.statusCode ?? 0, body: text,
          ...(response.headers.location ? { location: new URL(response.headers.location, target).href } : {}),
          setCookie: response.headers["set-cookie"] ?? [] }));
      });
      call.on("error", reject);
      call.end();
    });
    for (const header of hop.setCookie) {
      const [pair, ...attributes] = header.split(/;\s*/);
      if (attributes.some((item) => /^domain=/i.test(item))) throw new Error("Fixture cookies must be host-only.");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      const jar = this.jar.get(url.hostname) ?? new Map<string, string>();
      if (attributes.some((item) => /^max-age=0$/i.test(item))) jar.delete(name); else jar.set(name, value);
      this.jar.set(url.hostname, jar);
    }
    return hop;
  }

  public async navigate(start: string, limit = 10): Promise<Hop[]> {
    const hops: Hop[] = [];
    for (let next: string | undefined = start; next && hops.length < limit;) {
      const hop = await this.request(next);
      hops.push(hop);
      next = hop.status >= 300 && hop.status < 400 ? hop.location : undefined;
    }
    return hops;
  }
}
