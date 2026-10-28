import { describe, expect, it, vi } from "vitest";
import { createAuthProviderMcpHandler, type McpFnAuthSessionLike } from "../src/provider-adapter.js";

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
