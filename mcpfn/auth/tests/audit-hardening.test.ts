import { describe, expect, it, vi } from "vitest";

import {
  MemoryMcpFnOAuthSessionStore,
  createAuthProviderMcpHandler,
  createMcpFnOAuthClientProvider,
  createOAuthResourceServerHandler,
} from "../src/index.js";

// Regression tests for the McpFn security audit (MCP-21): MCP-SEC-05 (provider
// adapter audience and expiry), MCP-SEC-11 (tokens without expiry) and the
// stored-credential part of MCP-SEC-02.

const resource = "https://mcp.example.com/mcp";
const echoAuthInfo = vi.fn(async (_request: Request, options?: { authInfo?: unknown }) =>
  Response.json(options?.authInfo ?? null));

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-secret-id",
    type: "oauth",
    subject: { actorId: "user-1", actorType: "user" },
    scopes: ["mcp:read"],
    resourceIds: [resource],
    ...overrides,
  };
}

function call(handler: (request: Request) => Promise<Response>) {
  return handler(new Request(resource, { headers: { authorization: "Bearer test-access-token" } }));
}

describe("AuthFn provider adapter (MCP-SEC-05)", () => {
  it("rejects a credential issued for another resource", async () => {
    const handler = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      provider: { authenticateBearer: async () => session({ resourceIds: ["https://billing.example.com/api"] }) },
    });
    expect((await call(handler)).status).toBe(401);
  });

  it("rejects a credential with no resource binding", async () => {
    const handler = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      provider: { authenticateBearer: async () => session({ resourceIds: undefined }) },
    });
    expect((await call(handler)).status).toBe(401);
  });

  it("lets the provider's authorize hook decide the audience", async () => {
    const authorize = vi.fn(async (_session: unknown, resourceId: string) => resourceId === resource);
    const handler = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      provider: { authenticateBearer: async () => session({ resourceIds: [] }), authorize },
    });
    const response = await call(handler);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ resource });
    expect(authorize).toHaveBeenCalledWith(expect.anything(), resource);
  });

  it("accepts unbound credentials only when allowed, without claiming the resource", async () => {
    const handler = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      allowUnboundCredentials: true,
      provider: { authenticateBearer: async () => session({ resourceIds: [] }) },
    });
    const response = await call(handler);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("resource");
  });

  it("refuses a credential bound elsewhere even with allowUnboundCredentials", async () => {
    const handler = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      allowUnboundCredentials: true,
      provider: { authenticateBearer: async () => session({ resourceIds: ["https://billing.example.com/api"] }) },
    });
    expect((await call(handler)).status).toBe(401);
  });

  it("gives each request its own resource URL", async () => {
    const seen: string[] = [];
    const handler = createAuthProviderMcpHandler(async (_request, options) => {
      const url = (options as { authInfo: { resource: URL } }).authInfo.resource;
      seen.push(url.toString());
      url.pathname = "/other";
      return Response.json({});
    }, { resource, provider: { authenticateBearer: async () => session() } });
    await call(handler);
    await call(handler);
    expect(seen).toHaveLength(2);
    expect(seen).toEqual([resource, resource]);
  });

  it("uses the session's exact expiry for the default mapping", async () => {
    const now = Date.UTC(2026, 10, 25, 12, 0, 0, 100);
    const handler = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      clock: () => now,
      provider: { authenticateBearer: async () => session({ expiresAt: new Date(now + 800) }) },
    });
    expect((await call(handler)).status).toBe(200);
  });

  it("rechecks expiry after asynchronous mapping", async () => {
    let now = Date.UTC(2026, 10, 25);
    const handler = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      clock: () => now,
      provider: { authenticateBearer: async () => session({ expiresAt: new Date(now + 1_000) }) },
      map: async (current) => {
        now += 5_000;
        return { subject: current.subject.actorId, clientId: "client-1", scopes: [], resourceIds: [resource] };
      },
    });
    expect((await call(handler)).status).toBe(401);
  });

  it("rejects expired sessions and mapped principals", async () => {
    const now = Date.UTC(2026, 10, 25);
    const expired = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      clock: () => now,
      provider: { authenticateBearer: async () => session({ expiresAt: new Date(now - 1_000) }) },
    });
    expect((await call(expired)).status).toBe(401);
    const mapped = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      clock: () => now,
      provider: { authenticateBearer: async () => session() },
      map: () => ({ subject: "user-1", clientId: "client-1", scopes: [], resourceIds: [resource], expiresAt: now / 1_000 }),
    });
    expect((await call(mapped)).status).toBe(401);
    const valid = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      clock: () => now,
      provider: { authenticateBearer: async () => session({ expiresAt: new Date(now + 60_000) }) },
    });
    expect((await call(valid)).status).toBe(200);
  });

  it("does not expose the session ID as the client ID", async () => {
    const handler = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      provider: { authenticateBearer: async () => session() },
    });
    const body = JSON.stringify(await (await call(handler)).json());
    expect(body).not.toContain("session-secret-id");
    expect(JSON.parse(body)).toMatchObject({ clientId: "user:user-1" });
    const withClient = createAuthProviderMcpHandler(echoAuthInfo, {
      resource,
      provider: { authenticateBearer: async () => session({ metadata: { clientId: "registered-client" } }) },
    });
    await expect((await call(withClient)).json()).resolves.toMatchObject({ clientId: "registered-client" });
  });
});

describe("OAuth resource server token expiry (MCP-SEC-11)", () => {
  const verifier = (expiresAt?: number) => ({
    verifyAccessToken: async () => ({
      token: "test-access-token",
      clientId: "client-1",
      scopes: [],
      resource: new URL(resource),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }),
  });

  it("rejects a verified token without expiresAt by default", async () => {
    const handler = createOAuthResourceServerHandler(echoAuthInfo, {
      resource,
      authorizationServers: ["https://login.example.com"],
      verifier: verifier(),
    });
    const response = await call(handler);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("accepts tokens without expiry only when allowed", async () => {
    const handler = createOAuthResourceServerHandler(echoAuthInfo, {
      resource,
      authorizationServers: ["https://login.example.com"],
      verifier: verifier(),
      allowTokensWithoutExpiry: true,
    });
    expect((await call(handler)).status).toBe(200);
  });

  it("still accepts unexpired tokens", async () => {
    const handler = createOAuthResourceServerHandler(echoAuthInfo, {
      resource,
      authorizationServers: ["https://login.example.com"],
      verifier: verifier(Math.floor(Date.now() / 1_000) + 3_600),
    });
    expect((await call(handler)).status).toBe(200);
  });
});

describe("stored OAuth tokens without an issuer (MCP-SEC-02)", () => {
  function provider(store: MemoryMcpFnOAuthSessionStore) {
    return createMcpFnOAuthClientProvider({
      redirectUrl: "http://127.0.0.1:8123/callback",
      clientMetadata: { redirect_uris: ["http://127.0.0.1:8123/callback"], client_name: "test-client" },
      store,
      openAuthorization: () => undefined,
    });
  }

  it("withholds the refresh token of tokens saved without an issuer", async () => {
    const store = new MemoryMcpFnOAuthSessionStore();
    await store.setTokens({ access_token: "test-access-token", token_type: "Bearer", refresh_token: "test-refresh-token" });
    const tokens = await provider(store).tokens();
    expect(tokens).toEqual({ access_token: "test-access-token", token_type: "Bearer" });
  });

  it("does not return confidential client information saved without an issuer", async () => {
    const store = new MemoryMcpFnOAuthSessionStore();
    await store.setClientInformation({ client_id: "client-1", client_secret: "test-client-secret" });
    await expect(provider(store).clientInformation()).resolves.toBeUndefined();
    await store.setClientInformation({ client_id: "client-1", client_secret: "test-client-secret", issuer: "https://login.example.com" } as never);
    await expect(provider(store).clientInformation()).resolves.toMatchObject({ client_id: "client-1" });
    await store.setClientInformation({ client_id: "public-client" });
    await expect(provider(store).clientInformation()).resolves.toEqual({ client_id: "public-client" });
    await store.setClientInformation({ client_id: "public-client", client_secret: "", token_endpoint_auth_method: "none" } as never);
    await expect(provider(store).clientInformation()).resolves.toEqual({ client_id: "public-client", token_endpoint_auth_method: "none" });
  });

  it("keeps the refresh token of tokens bound to an issuer", async () => {
    const store = new MemoryMcpFnOAuthSessionStore();
    const saved = { access_token: "test-access-token", token_type: "Bearer", refresh_token: "test-refresh-token", issuer: "https://login.example.com" };
    await provider(store).saveTokens(saved);
    await expect(provider(store).tokens()).resolves.toEqual(saved);
  });
});
