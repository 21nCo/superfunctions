import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPlugFnRouter, MemoryAdapter, NoopLogger, plugFn, ProviderRegistry, WebhookHandler } from 'plugfn';
import { githubProvider } from '../../src/github/index.js';

const encoder = new TextEncoder();

function sign(rawBody: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

describe('github webhook verification', () => {
  it('resolves the authenticated installation before dispatching pull_request.closed', async () => {
    const binding = {
      tenantId: 'test-tenant',
      connectionId: 'test-connection',
      revoked: new AbortController().signal,
    };
    const secret = 'test-github-webhook-secret';
    const resolveBinding = vi.fn(() => [binding]);
    const runtime = plugFn({
      database: new MemoryAdapter(),
      auth: { authenticate: () => null },
      baseUrl: 'https://app.example.test',
      encryptionKey: Buffer.alloc(32, 1).toString('hex'),
      integrations: {},
      logger: new NoopLogger(),
      webhooks: {
        workflowBindings: {
          github: [{
            id: 'test-github-app',
            credentialFingerprints: [createHash('sha256').update(secret).digest('hex')],
            resolve: resolveBinding,
          }],
        },
      },
    });
    runtime.providers.register(githubProvider);
    const listener = vi.fn();
    runtime.webhooks.on('github', 'pull_request.closed', listener);

    const payload = {
      action: 'closed',
      installation: { id: 42 },
      pull_request: {
        id: 9,
        number: 42,
        title: 'PR title',
        html_url: 'https://github.com/21nCo/super-functions/pull/42',
        merged: true,
      },
      repository: {
        name: 'super-functions',
        owner: {
          login: '21nCo',
        },
      },
    };
    const rawBody = JSON.stringify(payload);

    const router = createPlugFnRouter(runtime, { webhookSecret: { github: secret } });
    const accepted = await router.handle(new Request('https://app.example.test/webhooks/github/pull-request', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(rawBody, secret) },
      body: rawBody,
    }));
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      data: { event: { event: 'pull_request.closed', verified: true } },
    });
    expect(resolveBinding).toHaveBeenCalledWith('42');
    expect(listener).toHaveBeenCalledTimes(1);
    const resolutionsAfterDispatch = resolveBinding.mock.calls.length;

    await expect(
      runtime.webhooks.handle(
        'github',
        'pull_request.closed',
        undefined,
        { 'x-hub-signature-256': 'sha256=bad' },
        secret,
        { rawBody: encoder.encode(rawBody) }
      )
    ).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
    expect(resolveBinding).toHaveBeenCalledTimes(resolutionsAfterDispatch);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not classify review, review comment, or review thread bodies as pull requests', () => {
    const classify = githubProvider.triggers?.pull_request.webhookConfig?.getWorkflowEvent;
    expect(classify).toBeTypeOf('function');
    for (const payload of [
      { action: 'edited', pull_request: {}, review: {} },
      { action: 'edited', pull_request: {}, comment: {} },
      { action: 'resolved', pull_request: {}, thread: {} },
    ]) {
      expect(classify?.(payload, { headers: {} })).toBeUndefined();
    }
  });

  it('emits issue_comment.created only for verified payloads', async () => {
    const logger = new NoopLogger();
    const registry = new ProviderRegistry(logger);
    registry.register(githubProvider);

    const handler = new WebhookHandler(registry, logger);
    const listener = vi.fn();
    handler.on('github', 'issue_comment.created', listener);

    const payload = {
      action: 'created',
      issue: {
        id: 5,
        number: 42,
        title: 'Issue title',
        html_url: 'https://github.com/21nCo/super-functions/issues/42',
      },
      comment: {
        id: 10,
        body: '/conduct spec',
      },
      repository: {
        name: 'super-functions',
        owner: {
          login: '21nCo',
        },
      },
    };
    const secret = 'github-secret';
    const rawBody = JSON.stringify(payload);

    const accepted = await handler.handleWebhook(
      'github',
      'issue_comment.created',
      undefined,
      { 'x-hub-signature-256': sign(rawBody, secret) },
      secret,
      { rawBody: encoder.encode(rawBody) }
    );
    expect(accepted.verified).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    await expect(
      handler.handleWebhook(
        'github',
        'issue_comment.created',
        undefined,
        { 'x-hub-signature-256': 'sha256=invalid' },
        secret,
        { rawBody: encoder.encode(rawBody) }
      )
    ).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
