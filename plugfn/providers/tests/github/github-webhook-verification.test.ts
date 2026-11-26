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
  it('rejects a standalone fallback that would introduce a workflow subject', async () => {
    const database = new MemoryAdapter();
    const secret = 'test-github-webhook-secret';
    const binding = {
      tenantId: 'test-tenant',
      connectionId: 'test-connection',
      revoked: new AbortController().signal,
    };
    const resolve = vi.fn(() => [binding]);
    const runtime = plugFn({
      database, auth: { authenticate: () => null },
      baseUrl: 'https://app.example.test', encryptionKey: Buffer.alloc(32, 1).toString('hex'),
      integrations: {}, logger: new NoopLogger(),
      webhooks: { workflowBindings: { github: [{
        id: 'test-github-app', credentialFingerprints: [createHash('sha256').update(secret).digest('hex')], resolve,
      }] } },
    });
    const standalone = githubProvider.triggers!.pull_request;
    const specialized = githubProvider.triggers!['pull_request.closed'];
    const handler = vi.fn(standalone.handler);
    runtime.providers.register({
      ...githubProvider,
      triggers: {
        pull_request: {
          ...standalone,
          handler,
          webhookConfig: { ...standalone.webhookConfig!, getWorkflowEvent: () => 'pull_request' },
        },
        'pull_request.closed': {
          ...specialized,
          webhookConfig: { ...specialized.webhookConfig!, getWorkflowSubject: () => undefined },
        },
      },
    });
    const listener = vi.fn();
    runtime.webhooks.on('github', 'pull_request', listener);
    const body = JSON.stringify({
      action: 'closed',
      installation: { id: 42 },
      pull_request: {
        id: 1, number: 1, title: 'Test pull request', state: 'closed',
        html_url: 'https://example.test/pull/1', head: { ref: 'test-topic' }, base: { ref: 'dev' },
      },
      repository: { name: 'test', full_name: 'example/test', owner: { login: 'example' } },
    });
    const headers = { 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body, secret) };
    const router = createPlugFnRouter(runtime, { webhookSecret: { github: secret } });
    const response = await router.handle(new Request('https://app.example.test/webhooks/github/pull-request', {
      method: 'POST', headers, body,
    }));
    expect(response.status).toBe(403);
    await expect(runtime.webhooks.handle('github', 'pull-request', undefined, headers, secret, {
      rawBody: encoder.encode(body),
    })).rejects.toMatchObject({ code: 'WEBHOOK_WORKFLOW_BINDING_REQUIRED' });
    expect(resolve).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(await database.findMany({ model: 'plugfn_webhook_receipts' })).toEqual([]);
  });

  it('verifies a subjectless issue against the original standalone trigger before validating an action trigger', async () => {
    const secret = 'test-github-webhook-secret';
    const resolve = vi.fn(() => []);
    const runtime = plugFn({
      database: new MemoryAdapter(), auth: { authenticate: () => null },
      baseUrl: 'https://app.example.test', encryptionKey: Buffer.alloc(32, 1).toString('hex'),
      integrations: {}, logger: new NoopLogger(),
      webhooks: { workflowBindings: { github: [{
        id: 'test-github-app', credentialFingerprints: [createHash('sha256').update(secret).digest('hex')], resolve,
      }] } },
    });
    runtime.providers.register(githubProvider);
    const listener = vi.fn();
    runtime.webhooks.on('github', 'issues', listener);
    const body = JSON.stringify({
      action: 'opened',
      issue: { id: 1, number: 1, title: 'Test issue', body: null, state: 'open', html_url: 'https://example.test/issue/1' },
      repository: { name: 'test', full_name: 'example/test', owner: { login: 'example' } },
    });
    const headers = { 'x-hub-signature-256': sign(body, secret) };
    await expect(runtime.webhooks.handle('github', 'issues', undefined, headers, secret, {
      rawBody: encoder.encode(body),
    })).resolves.toMatchObject({ event: 'issues', verified: true });
    expect(listener).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    { scoped: true, hasInstallation: true, event: 'pull_request.closed', ingress: 'HTTP', legacyPayload: true },
    { scoped: true, hasInstallation: true, event: 'pull_request.closed', ingress: 'SDK', legacyPayload: true },
    { scoped: true, hasInstallation: true, event: 'pull_request.closed', ingress: 'HTTP', legacyPayload: false },
    { scoped: true, hasInstallation: false, event: 'pull_request', ingress: 'HTTP', legacyPayload: true },
    { scoped: false, hasInstallation: true, event: 'pull_request', ingress: 'HTTP', legacyPayload: true },
  ])('dispatches the pull-request alias via $ingress (binding $scoped, installation $hasInstallation, legacy payload $legacyPayload)', async ({
    scoped, hasInstallation, event, ingress, legacyPayload,
  }) => {
    const binding = {
      tenantId: 'test-tenant',
      connectionId: 'test-connection',
      revoked: new AbortController().signal,
    };
    const secret = 'test-github-webhook-secret';
    const resolveBinding = vi.fn(() => [binding]);
    const database = new MemoryAdapter();
    const action = vi.fn(async () => ({}));
    if (scoped && hasInstallation) {
      await database.create({
        model: 'plugfn_workflows',
        data: {
          id: 'test-github-workflow', name: 'Test GitHub workflow', userId: 'test-user',
          tenantId: binding.tenantId, status: 'enabled',
          definition: {
            trigger: { provider: 'github', event: 'pull_request.closed', connectionId: binding.connectionId },
            steps: [{ id: 'test-step', type: 'action', action: 'test-action' }],
          },
          createdAt: new Date(), updatedAt: new Date(),
        },
      });
    }
    const runtime = plugFn({
      database,
      auth: { authenticate: () => null },
      baseUrl: 'https://app.example.test',
      encryptionKey: Buffer.alloc(32, 1).toString('hex'),
      integrations: {},
      logger: new NoopLogger(),
      workflows: { runtime: { actions: { 'test-action': action } } },
      webhooks: scoped ? {
        workflowBindings: {
          github: [{
            id: 'test-github-app',
            credentialFingerprints: [createHash('sha256').update(secret).digest('hex')],
            resolve: resolveBinding,
          }],
        },
      } : undefined,
    });
    runtime.providers.register(githubProvider);
    const listener = vi.fn();
    const otherListener = vi.fn();
    runtime.webhooks.on('github', 'pull_request', listener);
    runtime.webhooks.on('github', 'pull_request.closed', otherListener);

    const payload = {
      action: 'closed',
      ...(hasInstallation ? { installation: { id: 42 } } : {}),
      pull_request: {
        id: 9,
        number: 42,
        title: 'PR title',
        html_url: 'https://github.com/21nCo/super-functions/pull/42',
        merged: true,
        state: 'closed',
        ...(legacyPayload ? { head: { ref: 'test-topic' }, base: { ref: 'dev' } } : {}),
      },
      repository: {
        name: 'super-functions',
        full_name: '21nCo/super-functions',
        owner: {
          login: '21nCo',
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    if (ingress === 'SDK') {
      await expect(runtime.webhooks.handle(
        'github', 'pull_request', undefined, { 'x-hub-signature-256': sign(rawBody, secret) }, secret,
        { rawBody: encoder.encode(rawBody) },
      )).resolves.toMatchObject({ event, verified: true });
    } else {
      const router = createPlugFnRouter(runtime, { webhookSecret: { github: secret } });
      const accepted = await router.handle(new Request('https://app.example.test/webhooks/github/pull-request', {
        method: 'POST',
        headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(rawBody, secret) },
        body: rawBody,
      }));
      expect(accepted.status).toBe(200);
      const result = await accepted.json();
      expect(result).toMatchObject({ data: { event: { event, verified: true } } });
      if (scoped && !hasInstallation) {
        const receipt = await runtime.runtime.webhooks.getReceipt(result.data.receiptId);
        expect(receipt).toMatchObject({ event: 'pull-request' });
        await expect(runtime.runtime.webhooks.listDeliveries(result.data.receiptId)).resolves.toEqual([
          expect.objectContaining({ handlerName: 'github.pull-request' }),
        ]);
      }
    }
    if (scoped && hasInstallation) expect(resolveBinding).toHaveBeenCalledWith('42');
    else expect(resolveBinding).not.toHaveBeenCalled();
    if (legacyPayload) {
      expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: 'pull_request' }));
    } else {
      expect(listener).not.toHaveBeenCalled();
    }
    expect(otherListener).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(scoped && hasInstallation ? 1 : 0);
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
    expect(listener).toHaveBeenCalledTimes(legacyPayload ? 1 : 0);
  });

  it('does not classify review, review thread, or unknown-action bodies as pull requests', () => {
    const classify = githubProvider.triggers?.pull_request.webhookConfig?.getWorkflowEvent;
    expect(classify).toBeTypeOf('function');
    for (const payload of [
      { action: 'edited', pull_request: {}, review: {} },
      { action: 'edited', pull_request: {}, comment: {} },
      { action: 'resolved', pull_request: {}, thread: {} },
      { action: 'test-unknown-action', pull_request: {} },
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
