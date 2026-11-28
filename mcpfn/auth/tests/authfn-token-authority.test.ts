import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { authfn, type AuthFnRuntimeConfig } from "authfn";
import { issueSession } from "authfn/core/sessions";
import { createUser } from "authfn/core/users";
import {
  authFnOAuthProviderPlugin,
  revokeOAuthGrant,
  verifyOAuthAccessToken,
  type OAuthConsentInput,
} from "@authfn/oauth-provider";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { HandleRequestOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it, vi } from "vitest";

import {
  createAuthFnTokenAuthority,
  createMcpFnOAuthClientProvider,
  type AuthFnTokenAuthorityProvider,
  type McpFnWebStandardHandler,
} from "../src/index.js";

const AUTH_ORIGIN = "https://auth.example.com";
const MEMOTRON = "https://memotron.example.com/mcp";
const POINTRON = "https://pointron.example.com/mcp";
const MEMOTRON_SECRET = "test-memotron-introspection-secret";
const INTROSPECT = `${AUTH_ORIGIN}/auth/oauth/introspect`;
const REDIRECT = "http://127.0.0.1/callback";
const SCOPES = { memotron: ["read", "write"], pointron: ["read", "write"] } as const;
const TEST_CLIENT = { clientId: "test-cli", name: "Test CLI", redirectUris: [REDIRECT] };
// A readable, low-entropy PKCE verifier (43+ unreserved characters).
const VERIFIER = `test-code-verifier-${"v".repeat(32)}`;

type Mode = "in-process" | "introspection";

/** Echoes the verified `authInfo` the MCP handler received. */
function mcpHandler(calls: { count: number }): McpFnWebStandardHandler {
  return async (request: Request, options?: HandleRequestOptions) => {
    calls.count += 1;
    const server = new McpServer({ name: "memotron", version: "0.0.0" });
    server.registerTool("whoami", { description: "Who is calling" }, async (extra) => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          clientId: extra.authInfo?.clientId,
          scopes: extra.authInfo?.scopes,
          resource: extra.authInfo?.resource?.toString(),
          subject: extra.authInfo?.extra?.subject,
        }),
      }],
    }));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request, options);
  };
}

/** A real AuthFn OAuth provider on an in-memory database, and a protected Memotron `/mcp`. */
async function setup(mode: Mode) {
  let clock = Date.now();
  const database = memoryAdapter({ debug: false });
  const consents: OAuthConsentInput[] = [];
  const authServer = authfn({ scopes: SCOPES, plugins: [authFnOAuthProviderPlugin()] }).createServer({
    database,
    pluginRuntime: {
      oauthProvider: {
        clients: [TEST_CLIENT],
        resources: [
          { resource: MEMOTRON, scopes: ["memotron:read", "memotron:write"], introspectionSecret: MEMOTRON_SECRET },
          { resource: POINTRON, scopes: ["pointron:read", "pointron:write"] },
        ],
        registration: { dynamic: true },
        now: () => new Date(clock),
        loginRequired: () => new Response("sign in", { status: 401 }),
        consent: (input) => {
          consents.push(input);
          return new Response("consent page", { status: 200 });
        },
      },
    },
  });
  const coreConfig: AuthFnRuntimeConfig = { database, namespace: "authfn", plugins: [], scopes: SCOPES };
  const user = await createUser(coreConfig, { primaryEmail: "user@example.com" });
  const session = await issueSession(coreConfig, {}, { userId: user.id, methods: ["password"] });
  const names = await authServer.cookieNamesForRequest(new Request(`${AUTH_ORIGIN}/auth/session`));
  const cookie = `${names.sessionCookieName}=${session.sessionToken}; ${names.csrfCookieName}=${session.csrfToken}`;
  const store = { database, namespace: "authfn" };

  const requests: Request[] = [];
  let protectedEndpoint: (request: Request) => Promise<Response> = async () => new Response(null, { status: 404 });
  /** Routes the issuer origin to AuthFn (RFC 8414 metadata path included) and Memotron to `/mcp`. */
  const route = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const url = new URL(request.url);
    if (url.origin === AUTH_ORIGIN) {
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return authServer.router.handle(new Request(`${AUTH_ORIGIN}/auth${url.pathname}`, request));
      }
      return authServer.router.handle(request);
    }
    if (url.origin === new URL(MEMOTRON).origin) return protectedEndpoint(request);
    return new Response(null, { status: 404 });
  };

  const provider: AuthFnTokenAuthorityProvider = mode === "in-process"
    ? {
        issuer: AUTH_ORIGIN,
        verifyAccessToken: (token, { resource }) =>
          verifyOAuthAccessToken(store, token, { resource, now: () => new Date(clock) }),
      }
    : { issuer: AUTH_ORIGIN, introspection: { endpoint: INTROSPECT, secret: MEMOTRON_SECRET, fetch: route } };
  const authority = createAuthFnTokenAuthority(provider);
  const calls = { count: 0 };
  protectedEndpoint = authority.protect(mcpHandler(calls), {
    resource: MEMOTRON,
    scopesSupported: ["memotron:read", "memotron:write"],
    resourceName: "Memotron",
    clock: () => clock,
  });

  /** The browser half: the signed-in user approves the consent page; returns the callback URL. */
  const approve = async (authorizationUrl: URL): Promise<URL> => {
    const page = await route(authorizationUrl, { headers: { cookie } });
    expect(page.status).toBe(200);
    const consent = consents[consents.length - 1]!;
    const decided = await route(consent.decisionUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-authfn-csrf": session.csrfToken },
      body: JSON.stringify({ ...consent.params, decision: "approve" }),
    });
    const body = await decided.json() as { data: { redirectTo: string } };
    return new URL(body.data.redirectTo);
  };

  /** A token for `resource` through the pre-configured public client, without the MCP SDK. */
  const issueToken = async (resource: string, scope?: string) => {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: TEST_CLIENT.clientId,
      redirect_uri: REDIRECT,
      state: "test-state",
      code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      code_challenge_method: "S256",
      resource,
      ...(scope ? { scope } : {}),
    });
    const callback = await approve(new URL(`${AUTH_ORIGIN}/auth/oauth/authorize?${query}`));
    const response = await route(`${AUTH_ORIGIN}/auth/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        redirect_uri: REDIRECT,
        client_id: TEST_CLIENT.clientId,
        code_verifier: VERIFIER,
      }),
    });
    expect(response.status).toBe(200);
    return await response.json() as { access_token: string; refresh_token: string };
  };

  /** A raw MCP `tools/call` of `whoami` at Memotron's `/mcp`. */
  const callWhoami = (accessToken?: string) =>
    route(MEMOTRON, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
    });

  return {
    route,
    approve,
    issueToken,
    callWhoami,
    requests,
    calls,
    store,
    user,
    advance: (seconds: number) => {
      clock += seconds * 1_000;
    },
  };
}

function whoamiOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

async function whoamiResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as { result: unknown };
  return whoamiOf(body.result);
}

describe.each<Mode>(["in-process", "introspection"])("AuthFn token authority (%s)", (mode) => {
  it("runs discovery, registration, the PKCE code flow, a tool call and refresh end to end", async () => {
    const env = await setup(mode);
    let authorizationUrl: URL | undefined;
    const oauth = createMcpFnOAuthClientProvider({
      redirectUrl: REDIRECT,
      clientMetadata: {
        client_name: "Test MCP Host",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      openAuthorization: (url) => {
        authorizationUrl = url;
      },
    });
    const connect = async () => {
      const client = new Client({ name: "test-mcp-host", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(MEMOTRON), { authProvider: oauth, fetch: env.route });
      return { client, transport };
    };

    // Discovery and registration: the 401 names the metadata, which names AuthFn.
    const first = await connect();
    await expect(first.client.connect(first.transport)).rejects.toThrow(UnauthorizedError);
    const metadata = await env.route("https://memotron.example.com/.well-known/oauth-protected-resource/mcp");
    await expect(metadata.json()).resolves.toMatchObject({
      resource: MEMOTRON,
      authorization_servers: [AUTH_ORIGIN],
      scopes_supported: ["memotron:read", "memotron:write"],
    });
    const paths = env.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
    expect(paths).toEqual(expect.arrayContaining([
      "GET /.well-known/oauth-protected-resource/mcp",
      "GET /.well-known/oauth-authorization-server",
      "POST /auth/oauth/register",
    ]));
    const registered = (await oauth.clientInformation())!;
    expect(registered.client_id).toEqual(expect.any(String));
    expect(env.calls.count).toBe(0);

    // PKCE code flow: S256 challenge, RFC 8707 resource, consent, code exchange.
    expect(authorizationUrl!.origin).toBe(AUTH_ORIGIN);
    expect(authorizationUrl!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl!.searchParams.get("resource")).toBe(MEMOTRON);
    expect(authorizationUrl!.searchParams.get("client_id")).toBe(registered.client_id);
    const callback = await env.approve(authorizationUrl!);
    await oauth.validateAuthorizationState(callback.searchParams.get("state") ?? undefined);
    await first.transport.finishAuth(callback.searchParams.get("code")!);
    const issued = (await oauth.tokens())!;

    // A tool call with the token carries its client, scopes, audience and subject.
    const second = await connect();
    await second.client.connect(second.transport);
    const result = await second.client.callTool({ name: "whoami", arguments: {} });
    expect(whoamiOf(result)).toEqual({
      clientId: registered.client_id,
      scopes: ["memotron:read", "memotron:write"],
      resource: MEMOTRON,
      subject: env.user.id,
    });

    // Refresh: once the access token expires the endpoint answers 401 and the
    // client rotates its refresh token, then the call succeeds.
    env.advance(3_601);
    const stale = await env.callWhoami(issued.access_token);
    expect(stale.status).toBe(401);
    const refreshed = await second.client.callTool({ name: "whoami", arguments: {} });
    expect(whoamiOf(refreshed)).toMatchObject({ clientId: registered.client_id, subject: env.user.id });
    const rotated = (await oauth.tokens())!;
    expect(rotated.access_token).not.toBe(issued.access_token);
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    const tokenRequests = env.requests.filter((request) => new URL(request.url).pathname === "/auth/oauth/token");
    const grants = await Promise.all(tokenRequests.map(async (request) =>
      new URLSearchParams(await request.text()).get("grant_type")));
    expect(grants).toEqual(["authorization_code", "refresh_token"]);
    await second.client.close();
  });

  it("passes the granted scopes, not the resource's full set", async () => {
    const env = await setup(mode);
    const { access_token } = await env.issueToken(MEMOTRON, "memotron:read");
    const response = await env.callWhoami(access_token);
    expect(response.status).toBe(200);
    await expect(whoamiResponse(response)).resolves.toMatchObject({ scopes: ["memotron:read"] });
  });

  it("refuses a token issued for another audience", async () => {
    const env = await setup(mode);
    const { access_token } = await env.issueToken(POINTRON);
    const response = await env.callWhoami(access_token);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(env.calls.count).toBe(0);
  });

  it("refuses an expired token", async () => {
    const env = await setup(mode);
    const { access_token } = await env.issueToken(MEMOTRON);
    expect((await env.callWhoami(access_token)).status).toBe(200);
    env.advance(3_601);
    const response = await env.callWhoami(access_token);
    expect(response.status).toBe(401);
    expect(env.calls.count).toBe(1);
  });

  it("refuses a token of a revoked grant on the next request", async () => {
    const env = await setup(mode);
    const { access_token } = await env.issueToken(MEMOTRON);
    expect((await env.callWhoami(access_token)).status).toBe(200);
    const info = (await verifyOAuthAccessToken(env.store, access_token, { resource: MEMOTRON }))!;
    await revokeOAuthGrant(env.store, info.grantId, { userId: env.user.id });
    const response = await env.callWhoami(access_token);
    expect(response.status).toBe(401);
    expect(env.calls.count).toBe(1);
  });
});

describe("AuthFn token authority boundaries", () => {
  const handler = (calls: { count: number }): McpFnWebStandardHandler => async () => {
    calls.count += 1;
    return new Response("mcp");
  };
  const bearer = (token = "test-access-token") =>
    new Request(MEMOTRON, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const later = () => new Date(Date.now() + 60_000);

  it("re-checks the audience and expiry the provider reports", async () => {
    const calls = { count: 0 };
    const verifyAccessToken = vi.fn();
    const endpoint = createAuthFnTokenAuthority({ issuer: AUTH_ORIGIN, verifyAccessToken })
      .protect(handler(calls), { resource: MEMOTRON });
    verifyAccessToken.mockResolvedValueOnce({
      clientId: "test-client", userId: "test-user", resource: POINTRON, scopes: ["*"], expiresAt: later(),
    });
    expect((await endpoint(bearer())).status).toBe(401);
    verifyAccessToken.mockResolvedValueOnce({
      clientId: "test-client", userId: "test-user", resource: MEMOTRON, scopes: ["*"], expiresAt: new Date(Date.now() - 1_000),
    });
    expect((await endpoint(bearer())).status).toBe(401);
    verifyAccessToken.mockResolvedValueOnce({
      clientId: "test-client", userId: "test-user", resource: MEMOTRON, scopes: ["*"], expiresAt: later(),
    });
    expect((await endpoint(bearer())).status).toBe(200);
    expect(verifyAccessToken).toHaveBeenCalledWith("test-access-token", { resource: MEMOTRON });
    expect(calls.count).toBe(1);
  });

  it("answers 503, not invalid_token, when the provider cannot be asked", async () => {
    const calls = { count: 0 };
    const local = createAuthFnTokenAuthority({
      issuer: AUTH_ORIGIN,
      verifyAccessToken: async () => {
        throw new Error("database offline");
      },
    }).protect(handler(calls), { resource: MEMOTRON });
    const response = await local(bearer());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "temporarily_unavailable" });

    for (const fetch of [
      async () => new Response("down", { status: 500 }),
      async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } }),
      async () => new Response("not json", { status: 200 }),
      async () => {
        throw new TypeError("network down");
      },
    ]) {
      const remote = createAuthFnTokenAuthority({
        issuer: AUTH_ORIGIN,
        introspection: { endpoint: INTROSPECT, secret: MEMOTRON_SECRET, fetch },
      }).protect(handler(calls), { resource: MEMOTRON });
      expect((await remote(bearer())).status).toBe(503);
    }
    expect(calls.count).toBe(0);
  });

  it("refuses introspection answers that are not active for exactly this resource", async () => {
    const calls = { count: 0 };
    const exp = Math.floor(Date.now() / 1_000) + 60;
    const active = { active: true, aud: MEMOTRON, client_id: "test-client", sub: "test-user", scope: "memotron:read", exp, token_type: "Bearer" };
    let answer: Record<string, unknown> = active;
    const fetch = vi.fn(async () => Response.json(answer));
    const endpoint = createAuthFnTokenAuthority({
      issuer: AUTH_ORIGIN,
      introspection: { endpoint: INTROSPECT, secret: MEMOTRON_SECRET, fetch },
    }).protect(handler(calls), { resource: MEMOTRON });
    for (const refused of [
      { active: false },
      { ...active, active: "true" },
      { ...active, aud: POINTRON },
      { ...active, aud: [MEMOTRON] },
      { ...active, exp: undefined },
      { ...active, exp: exp - 120 },
      { ...active, client_id: undefined },
      { ...active, token_type: "DPoP" },
    ]) {
      answer = refused;
      expect((await endpoint(bearer())).status).toBe(401);
    }
    answer = active;
    expect((await endpoint(bearer())).status).toBe(200);
    expect(calls.count).toBe(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(INTROSPECT);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${MEMOTRON_SECRET}`);
    expect(new URLSearchParams(init.body as string).get("token")).toBe("test-access-token");
    expect(init.redirect).toBe("manual");
  });

  it("leaves scope checks to tools, so a wildcard grant reaches them", async () => {
    const calls = { count: 0 };
    const endpoint = createAuthFnTokenAuthority({
      issuer: `${AUTH_ORIGIN}/`,
      verifyAccessToken: async () => ({
        clientId: "test-client", userId: "test-user", resource: MEMOTRON, scopes: ["*"], expiresAt: later(),
      }),
    }).protect(handler(calls), { resource: MEMOTRON, requiredScopes: ["memotron:read"] } as never);
    expect((await endpoint(bearer())).status).toBe(200);
    expect(calls.count).toBe(1);
  });

  it("refuses unusable configuration when it is created", () => {
    const verifyAccessToken = async () => null;
    expect(() => createAuthFnTokenAuthority({ issuer: AUTH_ORIGIN } as never)).toThrow(/exactly one/);
    expect(() => createAuthFnTokenAuthority({
      issuer: AUTH_ORIGIN,
      verifyAccessToken,
      introspection: { endpoint: INTROSPECT, secret: MEMOTRON_SECRET },
    } as never)).toThrow(/exactly one/);
    const authority = createAuthFnTokenAuthority({ issuer: AUTH_ORIGIN, verifyAccessToken });
    expect(createAuthFnTokenAuthority({ issuer: `${AUTH_ORIGIN}/`, verifyAccessToken }).issuer).toBe(AUTH_ORIGIN);
    // RFC 8414 issuers carry no credentials, query or fragment; the root-slash
    // rewrite must not silently drop them.
    for (const issuer of [
      "https://test-user@auth.example.com/",
      "https://auth.example.com/?tenant=test",
      "https://auth.example.com/#frag",
      "https://auth.example.com/?",
      "https://auth.example.com/auth#",
    ]) {
      expect(() => createAuthFnTokenAuthority({ issuer, verifyAccessToken }), issuer).toThrow(/credentials, a query or a fragment/);
    }
    // MCP clients send the normalized spelling; AuthFn binds tokens to it exactly.
    expect(() => authority.protect(handler({ count: 0 }), { resource: "https://memotron.example.com" }))
      .toThrow(/normalized form/);
    expect(() => authority.protect(handler({ count: 0 }), { resource: `${MEMOTRON}#frag` })).toThrow(/normalized form/);
    expect(() => createAuthFnTokenAuthority({ issuer: "http://auth.example.com", verifyAccessToken })
      .protect(handler({ count: 0 }), { resource: MEMOTRON })).toThrow(/HTTPS/);
    for (const introspection of [
      { endpoint: "http://auth.example.com/auth/oauth/introspect", secret: MEMOTRON_SECRET },
      { endpoint: INTROSPECT, secret: "has spaces" },
      { endpoint: INTROSPECT, secret: MEMOTRON_SECRET, timeoutMs: 0 },
      { endpoint: INTROSPECT, secret: MEMOTRON_SECRET, timeoutMs: 1.5 },
      // Node would clamp this timer to 1 ms and fail every check.
      { endpoint: INTROSPECT, secret: MEMOTRON_SECRET, timeoutMs: 2 ** 31 },
    ]) {
      expect(() => createAuthFnTokenAuthority({ issuer: AUTH_ORIGIN, introspection })).toThrow(TypeError);
    }
  });
});

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILT_ENTRY = join(PACKAGE_ROOT, "dist", "index.js");

interface BearerOutcome {
  status: number;
  wwwAuthenticate?: string;
  body?: unknown;
  auth?: AuthInfo;
}

/** Runs the MCP SDK's own Express bearer middleware with a minimal req/res. */
async function sdkBearerAuth(verifier: OAuthTokenVerifier, token = "test-access-token"): Promise<BearerOutcome> {
  const outcome: BearerOutcome = { status: 0 };
  const req: { headers: Record<string, string>; auth?: AuthInfo } = {
    headers: { authorization: `Bearer ${token}` },
  };
  const res = {
    set(name: string, value: string) {
      if (name.toLowerCase() === "www-authenticate") outcome.wwwAuthenticate = value;
      return res;
    },
    status(code: number) {
      outcome.status = code;
      return res;
    },
    json(body: unknown) {
      outcome.body = body;
      return res;
    },
  };
  await requireBearerAuth({ verifier })(req as never, res as never, () => {
    outcome.status = 200;
    outcome.auth = req.auth;
  });
  return outcome;
}

describe("AuthFn verifier with the MCP SDK bearer middleware", () => {
  const options = { invalidTokenError: InvalidTokenError };
  const later = () => new Date(Date.now() + 60_000);
  const local = (verifyAccessToken: AuthFnTokenAuthorityProvider["verifyAccessToken"]) =>
    createAuthFnTokenAuthority({ issuer: AUTH_ORIGIN, verifyAccessToken } as AuthFnTokenAuthorityProvider);
  const remote = (fetch: typeof globalThis.fetch) =>
    createAuthFnTokenAuthority({ issuer: AUTH_ORIGIN, introspection: { endpoint: INTROSPECT, secret: MEMOTRON_SECRET, fetch } });
  const claims = (overrides: Record<string, unknown> = {}) => ({
    clientId: "test-client", userId: "test-user", resource: MEMOTRON, scopes: ["memotron:read"], expiresAt: later(), ...overrides,
  });
  const introspected = (overrides: Record<string, unknown> = {}) => async () => Response.json({
    active: true, aud: MEMOTRON, client_id: "test-client", sub: "test-user", scope: "memotron:read",
    exp: Math.floor(Date.now() / 1_000) + 60, ...overrides,
  });

  it("answers 401 invalid_token for inactive, other-audience and expired tokens, in both modes", async () => {
    for (const authority of [
      local(async () => null),
      local(async () => claims({ resource: POINTRON })),
      local(async () => claims({ expiresAt: new Date(Date.now() - 1_000) })),
      remote(introspected({ active: false })),
      remote(introspected({ aud: POINTRON })),
      remote(introspected({ exp: Math.floor(Date.now() / 1_000) - 1 })),
    ]) {
      const outcome = await sdkBearerAuth(authority.verifier(MEMOTRON, options));
      expect(outcome.status).toBe(401);
      expect(outcome.wwwAuthenticate).toMatch(/^Bearer error="invalid_token"/);
      expect(outcome.body).toMatchObject({ error: "invalid_token" });
    }
  });

  it("passes an active token's authInfo through and keeps a provider outage apart from invalid_token", async () => {
    for (const authority of [local(async () => claims()), remote(introspected())]) {
      const outcome = await sdkBearerAuth(authority.verifier(MEMOTRON, options));
      expect(outcome.status).toBe(200);
      expect(outcome.auth).toMatchObject({ clientId: "test-client", scopes: ["memotron:read"], extra: { subject: "test-user" } });
    }
    for (const authority of [
      local(async () => {
        throw new Error("database offline");
      }),
      remote(async () => new Response("down", { status: 503 })),
    ]) {
      const outcome = await sdkBearerAuth(authority.verifier(MEMOTRON, options));
      expect(outcome.status).toBe(500);
      expect(outcome.wwwAuthenticate).toBeUndefined();
    }
  });

  it("rejects a token whose expiry is at or before now when verification completes", async () => {
    const start = 1_900_000_000_000;
    let now = start;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      // The deadline equals the clock: not active.
      await expect(local(async () => claims({ expiresAt: new Date(start) })).verifier(MEMOTRON, options)
        .verifyAccessToken("test-access-token")).rejects.toBeInstanceOf(InvalidTokenError);
      await expect(remote(introspected({ exp: start / 1_000 })).verifier(MEMOTRON, options)
        .verifyAccessToken("test-access-token")).rejects.toBeInstanceOf(InvalidTokenError);
      // Active when asked, lapsed by the time the answer arrives.
      const lapsing = local(async () => {
        now = start + 2_000;
        return claims({ expiresAt: new Date(start + 1_000) });
      });
      await expect(lapsing.verifier(MEMOTRON, options).verifyAccessToken("test-access-token"))
        .rejects.toBeInstanceOf(InvalidTokenError);
      now = start;
      const lapsingRemote = remote(async () => {
        now = start + 2_000;
        return Response.json({ active: true, aud: MEMOTRON, client_id: "test-client", sub: "test-user", exp: start / 1_000 + 1 });
      });
      await expect(lapsingRemote.verifier(MEMOTRON, options).verifyAccessToken("test-access-token"))
        .rejects.toBeInstanceOf(InvalidTokenError);
      now = start;
      await expect(local(async () => claims({ expiresAt: new Date(start + 1_000) })).verifier(MEMOTRON, options)
        .verifyAccessToken("test-access-token")).resolves.toMatchObject({ expiresAt: start / 1_000 + 1 });
    } finally {
      clock.mockRestore();
    }
  });

  it("needs the host SDK's InvalidTokenError class", () => {
    const authority = local(async () => null);
    expect(() => authority.verifier(MEMOTRON, undefined as never)).toThrow(/invalidTokenError/);
    expect(() => authority.verifier(MEMOTRON, {} as never)).toThrow(/invalidTokenError/);
  });

  // The published bundle inlines its own SDK copy; the host's class must still
  // be the one thrown, or requireBearerAuth answers 500 for an inactive token.
  it.runIf(existsSync(BUILT_ENTRY) || Boolean(process.env.CI))(
    "answers 401 invalid_token through the built entry's inlined SDK",
    async () => {
      const built = (await import(pathToFileURL(BUILT_ENTRY).href)) as typeof import("../src/index.js");
      const inactive = built.createAuthFnTokenAuthority({ issuer: AUTH_ORIGIN, verifyAccessToken: async () => null });
      const outcome = await sdkBearerAuth(inactive.verifier(MEMOTRON, options));
      expect(outcome.status).toBe(401);
      expect(outcome.wwwAuthenticate).toMatch(/^Bearer error="invalid_token"/);
      const active = built.createAuthFnTokenAuthority({ issuer: AUTH_ORIGIN, verifyAccessToken: async () => claims() });
      expect((await sdkBearerAuth(active.verifier(MEMOTRON, options))).status).toBe(200);
    },
    60_000,
  );
});
