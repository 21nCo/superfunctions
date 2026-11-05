import type { AuthProvider } from "../../../packages/auth/src/types.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpFnAuthProviderAdapter, McpFnPrincipalConfigurationError, createAuthProviderMcpHandler, type McpFnAuthSessionLike } from "../src/provider-adapter.js";

const resource = "https://mcp.example.com/mcp";
const request = () => new Request(resource, { headers: { authorization: "Bearer token" } });
const session = (extra: Partial<McpFnAuthSessionLike> = {}): McpFnAuthSessionLike => ({
  id: "client", type: "oauth", subject: { actorId: "user", actorType: "user" },
  resourceIds: [resource], ...extra,
});

describe("provider resource and expiry boundary", () => {
  it.each([undefined, [], ["https://other.example/mcp"], ["not-a-url"]].map(resourceIds => ({ resourceIds })))("rejects unbound resource IDs $resourceIds", async ({ resourceIds }) => {
    const downstream = vi.fn(async () => Response.json({ ok: true }));
    const handler = createAuthProviderMcpHandler(downstream, { resource, provider: { authenticateBearer: async () => session({ resourceIds }) } });
    expect((await handler(request())).status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it.each([new Date(0), new Date(NaN)])("rejects expired or invalid session expiry %s even with a mapper and authorization", async (expiresAt) => {
    const downstream = vi.fn(async () => Response.json({ ok: true }));
    const handler = createAuthProviderMcpHandler(downstream, {
      resource, provider: { authenticateBearer: async () => session({ expiresAt }), authorize: async () => true },
      map: () => ({ subject: "user", clientId: "client", scopes: [], resourceIds: [resource], expiresAt: Date.now() / 1000 + 600 }),
    });
    expect((await handler(request())).status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it.each([0, NaN, Infinity])("rejects invalid mapped expiry %s", async (expiresAt) => {
    const handler = createAuthProviderMcpHandler(async () => Response.json({ ok: true }), {
      resource, provider: { authenticateBearer: async () => session() },
      map: () => ({ subject: "user", clientId: "client", scopes: [], resourceIds: [resource], expiresAt }),
    });
    expect((await handler(request())).status).toBe(401);
  });

  it("normalizes resource URLs and preserves the earliest expiry after mapping", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const handler = createAuthProviderMcpHandler(async (_request, options) => Response.json(options?.authInfo), {
      resource, provider: { authenticateBearer: async () => session({ expiresAt: new Date(expiresAt * 1000) }) },
      map: () => ({ subject: "user", clientId: "client", scopes: [], resourceIds: ["https://MCP.example.com:443/mcp#fragment"], expiresAt: expiresAt + 600 }),
    });
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource, expiresAt });
  });

  it.each(["provider", "adapter"])("permits explicit unbound policy with the %s hook", async (hook) => {
    const handler = createAuthProviderMcpHandler(async () => Response.json({ ok: true }), {
      resource, unboundSessions: "allow",
      provider: { authenticateBearer: async () => session({ resourceIds: [] }), ...(hook === "provider" ? { authorize: async () => true } : {}) },
      ...(hook === "adapter" ? { authorize: async () => true } : {}),
    });
    expect((await handler(request())).status).toBe(200);
  });

  it("rejects conflicting resource claims even when both hooks approve", async () => {
    const handler = createAuthProviderMcpHandler(async () => Response.json({ ok: true }), {
      resource, provider: { authenticateBearer: async () => session({ resourceIds: ["https://other.example/mcp"] }), authorize: async () => true },
      authorize: async () => true,
    });
    expect((await handler(request())).status).toBe(401);
  });

  it("never lets a matching resource override either authorization denial", async () => {
    for (const providerAllows of [true, false]) {
      const handler = createAuthProviderMcpHandler(async () => Response.json({ ok: true }), {
        resource, provider: { authenticateBearer: async () => session(), authorize: async () => providerAllows },
        authorize: async () => !providerAllows,
      });
      expect((await handler(request())).status).toBe(401);
    }
  });
});

it.each([null, '2030-01-01', 123, {}])("returns401 for malformed session expiry %j", async expiresAt => {
  const handler = createAuthProviderMcpHandler(async () => Response.json({ ok: true }), { resource,
    provider: { authenticateBearer: async () => session({ expiresAt: expiresAt as unknown as Date }) },
  });
  expect((await handler(request())).status).toBe(401);
});

it("does not interpret a business-rule authorization hook as resource binding", async () => {
  const handler = createAuthProviderMcpHandler(async () => Response.json({ ok: true }), { resource,
    provider: { authenticateBearer: async () => session({ resourceIds: [] }) }, authorize: () => true,
  });
  expect((await handler(request())).status).toBe(401);
});

it("rejects raw resource conflicts before trusted mapping and authorization", async () => {
  const authorize = vi.fn(() => true);
  const handler = createAuthProviderMcpHandler(async () => Response.json({ ok: true }), { resource,
    provider: { authenticateBearer: async () => session({ resourceIds: ['https://other.example/mcp'] }) },
    map: () => ({ subject: 'user', clientId: 'client', scopes: [], resourceIds: [resource] }), authorize,
  });
  expect((await handler(request())).status).toBe(401);
  expect(authorize).not.toHaveBeenCalled();
});

it("does not share the mutable AuthInfo resource URL between requests", async () => {
  const handler = createAuthProviderMcpHandler(async (_request, options) => {
    options!.authInfo!.resource!.hostname = 'mutated.example'; return Response.json({ ok: true });
  }, { resource, provider: { authenticateBearer: async () => session() } });
  expect((await handler(request())).status).toBe(200);
  expect((await handler(request())).status).toBe(200);
});

it("passes explicit unbound status and an isolated resource to authorization", async () => {
  const authorize = vi.fn(({ resource: authorizedResource, resourceBound }: { resource: URL; resourceBound: boolean }) => {
    expect(authorizedResource.toString()).toBe(resource); expect(resourceBound).toBe(false);
    authorizedResource.hostname = 'mutated.example'; return true;
  });
  const handler = createAuthProviderMcpHandler(async (_request, options) => Response.json(options?.authInfo), {
    resource, unboundSessions: 'allow', provider: { authenticateBearer: async () => session({ resourceIds: [] }) }, authorize,
  });
  const response = await handler(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ resource, extra: { resourceBinding: 'unbound' } });
});

it("rechecks expiry after asynchronous authorization policy evaluation", async () => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const handler = createAuthProviderMcpHandler(async () => Response.json({ ok: true }), { resource,
      provider: { authenticateBearer: async () => session({ expiresAt: new Date(now + 1000) }) },
      authorize: async () => { now += 2000; return true; },
    });
    expect((await handler(request())).status).toBe(401);
  } finally { clock.mockRestore(); }
});

it("does not promote free-form extras into absent trusted tenant or region claims", async () => {
  const handler = createAuthProviderMcpHandler(async (_request, options) => Response.json(options?.authInfo), { resource,
    provider: { authenticateBearer: async () => session() },
    map: () => ({ subject: 'user', clientId: 'client', scopes: [], resourceIds: [resource], extra: { tenantId: 'untrusted-tenant', regionId: 'untrusted-region' } }),
  });
  const response = await handler(request());
  expect(response.status).toBe(200);
  const info = await response.json();
  expect(info.extra).not.toHaveProperty('tenantId'); expect(info.extra).not.toHaveProperty('regionId');
});

it("maps only an explicitly configured provider project ID", async () => {
  const authorize = vi.fn(async (_session, id: string) => id === "proj_123");
  const provider: AuthProvider = { authenticate: async () => ({ id: "client", type: "api-key", subject: { actorId: "user", actorType: "user" }, resourceIds: ["proj_123"] }), authorize };
  const downstream = async (_request: Request, options: any) => Response.json(options.authInfo);
  expect((await createAuthProviderMcpHandler(downstream, { resource, provider })(request())).status).toBe(401);
  const response = await createAuthProviderMcpHandler(downstream, { resource, provider, providerResourceId: "proj_123" })(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ resource, extra: { resourceBinding: "bound", resourceIds: ["proj_123"] } });
  expect(authorize).toHaveBeenCalledWith(expect.anything(), "proj_123");
  for (const resourceIds of [["proj_other"], ["00000000-0000-0000-0000-000000000000"]]) {
    const handler = createAuthProviderMcpHandler(downstream, { resource, providerResourceId: "proj_123", unboundSessions: "allow",
      provider: { authenticate: async () => session({ resourceIds }), authorize: async () => true }, authorize: () => true });
    expect((await handler(request())).status).toBe(401);
  }
});

it.each([null, resource, {}, [123], [resource, null]])("rejects malformed raw and mapped resourceIds %j with401", async resourceIds => {
  for (const mapped of [false, true]) {
    const handler = createAuthProviderMcpHandler(async () => Response.json({ ok: true }), { resource,
      provider: { authenticate: async () => session(mapped ? {} : { resourceIds: resourceIds as any }) },
      ...(mapped ? { map: () => ({ subject: "user", clientId: "client", scopes: [], resourceIds: resourceIds as any }) } : {}),
    });
    expect((await handler(request())).status).toBe(401);
  }
});

it("isolates accepted claims from authorization and scope policy mutations", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const principal = { subject: "user", clientId: "client", scopes: ["read"], resourceIds: [resource], expiresAt,
    tenantId: "tenant", extra: { authMethods: ["forged"], nested: { trusted: true } } };
  const handler = createAuthProviderMcpHandler(async (_request, options) => Response.json(options?.authInfo), { resource,
    provider: { authenticate: async () => session(), authorize: async () => { principal.scopes.push("provider-injected"); return true; } },
    map: () => principal,
    authorize: ({ principal: copy }) => { copy.subject = "attacker"; copy.clientId = "other"; copy.tenantId = "other";
      copy.scopes.push("admin"); copy.resourceIds.length = 0; copy.expiresAt = Infinity; (copy.extra!.nested as any).trusted = false; return true; },
    requiredScopes: ({ principal: copy }) => { copy.scopes.push("scope-injected"); return ["read"]; },
  });
  const response = await handler(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ token: "token", resource, clientId: "client", scopes: ["read"], expiresAt,
    extra: { subject: "user", tenantId: "tenant", resourceIds: [resource], resourceBinding: "bound", boundResourceId: resource, nested: { trusted: true } } });
});

it("checks mapped project bindings and rejects invalid local mapping configuration", async () => {
  for (const providerResourceId of ["", " ", " proj_123", null, 123]) {
    expect(() => createAuthProviderMcpHandler(async () => new Response(), { resource, providerResourceId: providerResourceId as any,
      provider: { authenticate: async () => session() } })).toThrow("providerResourceId must be a nonempty string");
  }
  for (const mappedId of ["proj_123", "proj_other"]) {
    const handler = createAuthProviderMcpHandler(async () => new Response(), { resource, providerResourceId: "proj_123",
      provider: { authenticate: async () => session({ resourceIds: ["proj_123"] }), authorize: async () => true },
      map: () => ({ subject: "user", clientId: "client", scopes: [], resourceIds: [mappedId] }),
    });
    expect((await handler(request())).status).toBe(mappedId === "proj_123" ? 200 : 401);
  }
});

it("honors project authorizer denial and rejects conflicting mapped claims even with unbound allow", async () => {
  for (const deny of [true, false]) {
    const handler = createAuthProviderMcpHandler(async () => new Response(), { resource, providerResourceId: "proj_123", unboundSessions: "allow",
      provider: { authenticate: async () => session({ resourceIds: ["proj_123"] }), authorize: async () => !deny },
      map: () => ({ subject: "user", clientId: "client", scopes: [], resourceIds: [deny ? "proj_123" : "proj_other"] }),
    });
    expect((await handler(request())).status).toBe(401);
  }
});

it("classifies noncloneable mapped extras as configuration errors", async () => {
  const handler = createAuthProviderMcpHandler(async () => new Response(), { resource,
    provider: { authenticate: async () => session() },
    map: () => ({ subject: "user", clientId: "client", scopes: [], resourceIds: [resource], extra: { can: () => true } }),
  });
  const response = await handler(request());
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: "invalid_provider_configuration" });
});

it("reads expiry once before validation and does not promote all project entitlements to the endpoint binding", async () => {
  let reads = 0;
  const handler = createAuthProviderMcpHandler(async (_request, options) => Response.json(options?.authInfo), { resource, providerResourceId: "proj_123",
    provider: { authenticate: async () => session({ resourceIds: ["proj_456", "proj_123"] }), authorize: async () => true },
    map: () => ({ subject: "user", clientId: "client", scopes: [], resourceIds: ["proj_456", "proj_123"],
      get expiresAt() { reads++; return reads === 1 ? Math.floor(Date.now() / 1000) + 600 : Infinity; } }),
  });
  const response = await handler(request());
  expect(response.status).toBe(200);
  expect(reads).toBe(1);
  expect(await response.json()).toMatchObject({ extra: { boundResourceId: "proj_123", resourceIds: ["proj_456", "proj_123"] } });
});

it.each([{ scopes: "read" }, { authMethods: "password" }, { subject: 3 }, { clientId: null }, { tenantId: {} }, { regionId: [] }])("rejects malformed mapped identity claims %j", async invalid => {
  const handler = createAuthProviderMcpHandler(async () => new Response(), { resource,
    provider: { authenticate: async () => session() },
    map: () => ({ subject: "user", clientId: "client", scopes: [], resourceIds: [resource], ...invalid } as any),
  });
  expect((await handler(request())).status).toBe(401);
});


it("requires an authorizer for explicit provider resource mapping", () => {
  expect(() => createMcpFnAuthProviderAdapter({ resource, providerResourceId: "proj_123",
    provider: { authenticate: async () => session({ resourceIds: ["proj_123"] }) },
  })).toThrow("providerResourceId requires provider.authorize");
});

it("exposes a stable configuration error to direct adapter callers", async () => {
  const adapter = createMcpFnAuthProviderAdapter({ resource, provider: { authenticate: async () => session() },
    map: () => ({ subject: "user", clientId: "client", scopes: [], resourceIds: [resource], extra: { can: () => true } }),
  });
  await expect(adapter.authenticate(request())).rejects.toBeInstanceOf(McpFnPrincipalConfigurationError);
  await expect(adapter.authenticate(request())).rejects.toMatchObject({ name: "McpFnPrincipalConfigurationError",
    code: "MCPFN_INVALID_PROVIDER_CONFIGURATION", message: "Mapped extra claims must be structured-cloneable data" });
});


it("fails closed if the configured project authorizer is removed after construction", async () => {
  const provider: AuthProvider = { authenticate: async () => ({ id: "client", type: "api-key", subject: { actorId: "user", actorType: "user" }, resourceIds: ["proj_123"] }), authorize: async () => true };
  const adapter = createMcpFnAuthProviderAdapter({ resource, providerResourceId: "proj_123", provider });
  expect(await adapter.authenticate(request())).not.toBeNull();
  delete provider.authorize;
  expect(await adapter.authenticate(request())).toBeNull();
});
