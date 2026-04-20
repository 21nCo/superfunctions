import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPlugFnRouter } from '../../src/router/http-router.js';
import { plugFn } from '../../src/core/plug-fn.js';
import { githubProvider } from '../../src/providers/github/index.js';
import { MemoryAdapter } from '../../src/storage/adapters/memory.js';

describe('PlugFn webhook verification e2e', () => {
  it('verifies a signed webhook through the router using raw request bytes', async () => {
    const plug = createPlug();
    const handler = vi.fn();
    plug.providers.register(githubProvider);
    plug.webhooks.on('github', 'issues.opened', handler);

    const router = createPlugFnRouter(plug, {
      webhookSecret: {
        github: 'whsec_github',
      },
    });
    const rawBody =
      '{"action":"opened","issue":{"id":1,"number":10,"title":"Bug","body":null,"html_url":"https://example.test/issues/10","user":{"login":"octo"}},"repository":{"name":"repo","owner":{"login":"octo"}}}';

    const response = await router.handle(
      new Request('http://localhost/v2/webhooks/github/issues.opened', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signRawBody(rawBody, 'whsec_github'),
        },
        body: rawBody,
      })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        event: {
          provider: string;
          event: string;
          verified: boolean;
        };
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.event.provider).toBe('github');
    expect(payload.data.event.event).toBe('issues.opened');
    expect(payload.data.event.verified).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]?.verified).toBe(true);
  });

  it('rejects a signature when the signed bytes and transmitted bytes differ', async () => {
    const plug = createPlug();
    plug.providers.register(githubProvider);

    const router = createPlugFnRouter(plug, {
      webhookSecret: {
        github: 'whsec_github',
      },
    });
    const signedBody =
      '{"action":"opened","issue":{"id":1,"number":10,"title":"Bug","body":null,"html_url":"https://example.test/issues/10","user":{"login":"octo"}},"repository":{"name":"repo","owner":{"login":"octo"}}}';
    const transmittedBody =
      '{"repository":{"owner":{"login":"octo"},"name":"repo"},"issue":{"user":{"login":"octo"},"html_url":"https://example.test/issues/10","body":null,"title":"Bug","number":10,"id":1},"action":"opened"}';

    const response = await router.handle(
      new Request('http://localhost/v2/webhooks/github/issues.opened', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signRawBody(signedBody, 'whsec_github'),
        },
        body: transmittedBody,
      })
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      ok: boolean;
      error: {
        code: string;
      };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });
});

function createPlug() {
  return plugFn({
    database: new MemoryAdapter(),
    auth: {
      async authenticate() {
        return {
          userId: 'user_e2e',
        };
      },
    },
    baseUrl: 'https://app.example.com',
    encryptionKey: 'phase-08-webhook-key',
    integrations: {
      github: {
        type: 'oauth2',
        clientId: 'github-client-id',
        clientSecret: 'github-client-secret',
        redirectUris: ['https://app.example.com/oauth/callback'],
        webhookSecret: 'whsec_github',
      },
    },
  });
}

function signRawBody(rawBody: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}
