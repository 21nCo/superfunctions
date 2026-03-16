import { describe, it, expect, vi } from 'vitest';
import { createPlugFnRouter } from '../src/router/http-router.js';

describe('HTTP router auth boundaries', () => {
  it('uses session identity and ignores spoofed query identity', async () => {
    const listConnections = vi.fn(async () => []);
    const plug = createMockPlugFn({ listConnections });
    const router = createPlugFnRouter(plug);

    const response = await router.handle(
      new Request('http://localhost/v2/connections?userId=spoofed&provider=gmail', {
        method: 'GET',
        headers: {
          authorization: 'Bearer valid-session-for-user-u1',
        },
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.userId).toBe('u1');
    expect(body.meta.requestId).toMatch(/^req_[a-f0-9]+$/);
    expect(new Date(body.meta.timestamp).toString()).not.toBe('Invalid Date');
    expect(listConnections).toHaveBeenCalledTimes(1);
    expect(listConnections).toHaveBeenCalledWith({
      userId: 'u1',
      provider: 'gmail',
    });
  });

  it('rejects unauthenticated access with TENANT_ACCESS_DENIED', async () => {
    const listConnections = vi.fn(async () => []);
    const plug = createMockPlugFn({ listConnections });
    const router = createPlugFnRouter(plug);

    const response = await router.handle(
      new Request('http://localhost/v2/connections', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('TENANT_ACCESS_DENIED');
    expect(body.error.status).toBe(401);
    expect(body.error.retryable).toBe(false);
    expect(body.error.details).toEqual({});
    expect(body.meta.requestId).toMatch(/^req_[a-f0-9]+$/);
    expect(listConnections).not.toHaveBeenCalled();
  });

  it('rejects identity spoofing in body payloads', async () => {
    const disconnect = vi.fn(async () => {});
    const plug = createMockPlugFn({ disconnect });
    const router = createPlugFnRouter(plug);

    const response = await router.handle(
      new Request('http://localhost/v2/connections/disconnect', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-session-for-user-u1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'spoofed-user',
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
} = {}) {
  const listConnections = overrides.listConnections ?? vi.fn(async () => []);
  const disconnect = overrides.disconnect ?? vi.fn(async () => {});
  const handleWebhook = overrides.handleWebhook ?? vi.fn(async () => ({}));

  return {
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
