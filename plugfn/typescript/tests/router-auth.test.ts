import { describe, it, expect, vi } from 'vitest';
import { createPlugFnRouter } from '../src/router/http-router.js';

describe('HTTP router auth boundaries', () => {
  it('exposes the canonical route inventory', () => {
    const plug = createMockPlugFn();
    const router = createPlugFnRouter(plug);

    const canonicalRoutes = router
      .getRoutes()
      .filter((route) => !route.path.startsWith('/v2/'))
      .map((route) => `${route.method} ${route.path}`);

    expect(canonicalRoutes).toEqual([
      'GET /callback',
      'POST /webhooks/:provider/:event',
      'GET /providers',
      'GET /connections',
      'POST /connections/auth',
      'POST /connections/disconnect',
      'GET /workflows',
      'GET /metrics',
    ]);
  });

  it('defaults to plugFn.config.auth.authenticate and rejects mismatched query identity', async () => {
    const listConnections = vi.fn(async () => []);
    const authenticate = vi.fn(async () => ({ userId: 'u1', tenantId: 'tenant_1' }));
    const plug = createMockPlugFn({ listConnections, authenticate });
    const router = createPlugFnRouter(plug);

    const response = await router.handle(
      new Request('http://localhost/v2/connections?userId=spoofed&provider=gmail', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('TENANT_ACCESS_DENIED');
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(listConnections).not.toHaveBeenCalled();
  });

  it('prefers an explicit auth override when supplied', async () => {
    const listConnections = vi.fn(async () => []);
    const configuredAuthenticate = vi.fn(async () => ({ userId: 'config-user' }));
    const overrideAuthenticate = vi.fn(async () => ({ userId: 'override-user' }));
    const plug = createMockPlugFn({
      listConnections,
      authenticate: configuredAuthenticate,
    });
    const router = createPlugFnRouter(plug, {
      authenticate: overrideAuthenticate,
    });

    const response = await router.handle(
      new Request('http://localhost/v2/connections?provider=gmail', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.userId).toBe('override-user');
    expect(configuredAuthenticate).not.toHaveBeenCalled();
    expect(overrideAuthenticate).toHaveBeenCalledTimes(1);
    expect(listConnections).toHaveBeenCalledWith({
      userId: 'override-user',
      provider: 'gmail',
    });
  });

  it('rejects unauthenticated access with PLUGFN_AUTH_REQUIRED', async () => {
    const listConnections = vi.fn(async () => []);
    const plug = createMockPlugFn({
      listConnections,
      authenticate: vi.fn(async () => null),
    });
    const router = createPlugFnRouter(plug);

    const response = await router.handle(
      new Request('http://localhost/v2/connections', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('PLUGFN_AUTH_REQUIRED');
    expect(body.error.status).toBe(401);
    expect(body.error.retryable).toBe(false);
    expect(body.error.details).toEqual({});
    expect(body.meta.requestId).toMatch(/^req_[a-f0-9]+$/);
    expect(listConnections).not.toHaveBeenCalled();
  });

  it('rejects identity spoofing in body payloads', async () => {
    const disconnect = vi.fn(async () => {});
    const plug = createMockPlugFn({
      disconnect,
      authenticate: vi.fn(async () => ({ userId: 'u1', tenantId: 'tenant-1' })),
    });
    const router = createPlugFnRouter(plug);

    const response = await router.handle(
      new Request('http://localhost/v2/connections/disconnect', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'spoofed-user',
          tenantId: 'tenant-2',
          provider: 'gmail',
        }),
      })
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('TENANT_ACCESS_DENIED');
    expect(body.error.status).toBe(403);
    expect(body.error.retryable).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('rejects oversized webhook payloads with deterministic error details', async () => {
    const handleWebhook = vi.fn(async () => ({}));
    const plug = createMockPlugFn({ handleWebhook });
    const router = createPlugFnRouter(plug, { maxWebhookPayloadBytes: 32 });

    const response = await router.handle(
      new Request('http://localhost/v2/webhooks/gmail/mail.update', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ payload: 'x'.repeat(64) }),
      })
    );

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.status).toBe(413);
    expect(body.error.retryable).toBe(false);
    expect(body.error.details).toEqual({ maxBytes: 32 });
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});

function createMockPlugFn(overrides: {
  listConnections?: ReturnType<typeof vi.fn>;
  disconnect?: ReturnType<typeof vi.fn>;
  handleWebhook?: ReturnType<typeof vi.fn>;
  authenticate?: ReturnType<typeof vi.fn>;
} = {}) {
  const listConnections = overrides.listConnections ?? vi.fn(async () => []);
  const disconnect = overrides.disconnect ?? vi.fn(async () => {});
  const handleWebhook = overrides.handleWebhook ?? vi.fn(async () => ({}));
  const authenticate = overrides.authenticate ?? vi.fn(async () => ({ userId: 'u1' }));

  return {
    config: {
      auth: {
        authenticate,
      },
      baseUrl: 'https://app.example.com',
      integrations: {},
    },
    connections: {
      getAuthUrl: vi.fn(async () => 'https://example.com/auth'),
      handleCallback: vi.fn(async () => ({ id: 'conn_1', provider: 'gmail', status: 'active' })),
      list: listConnections,
      get: vi.fn(async () => ({ id: 'conn_1' })),
      disconnect,
      refresh: vi.fn(async () => ({ id: 'conn_1' })),
    },
    workflows: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      enable: vi.fn(async () => {}),
      disable: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      getStats: vi.fn(async () => ({})),
    },
    webhooks: {
      on: vi.fn(),
      off: vi.fn(),
      handle: handleWebhook,
    },
    providers: {
      list: vi.fn(() => []),
      get: vi.fn(() => undefined),
      register: vi.fn(),
    },
    batch: vi.fn(async () => []),
    getMetrics: vi.fn(async () => ({})),
    on: vi.fn(),
    off: vi.fn(),
  } as any;
}
