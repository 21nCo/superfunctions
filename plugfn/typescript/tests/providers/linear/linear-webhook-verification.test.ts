import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../../../src/core/provider-registry.js';
import { linearProvider } from '../../../src/providers/linear/index.js';
import { WebhookHandler } from '../../../src/webhooks/webhook-handler.js';
import { NoopLogger } from '../../../src/utils/logger.js';

function sign(payload: unknown, secret: string): string {
  const digest = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  return `sha256=${digest}`;
}

describe('linear webhook verification', () => {
  it('emits issue.updated only for signed payloads', async () => {
    const logger = new NoopLogger();
    const registry = new ProviderRegistry(logger);
    registry.register(linearProvider);

    const webhookHandler = new WebhookHandler(registry, logger);
    const handler = vi.fn();
    webhookHandler.on('linear', 'issue.updated', handler);

    const payload = {
      action: 'update',
      data: {
        id: 'issue_1',
        identifier: 'ENG-1234',
        title: 'Updated title',
      },
    };
    const secret = 'linear-secret';

    const accepted = await webhookHandler.handleWebhook(
      'linear',
      'issue.updated',
      payload,
      { 'x-signature': sign(payload, secret) },
      secret
    );

    expect(accepted.verified).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(
      webhookHandler.handleWebhook('linear', 'issue.updated', payload, { 'x-signature': 'bad' }, secret)
    ).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emits issue_comment.created only for signed payloads', async () => {
    const logger = new NoopLogger();
    const registry = new ProviderRegistry(logger);
    registry.register(linearProvider);

    const webhookHandler = new WebhookHandler(registry, logger);
    const handler = vi.fn();
    webhookHandler.on('linear', 'issue_comment.created', handler);

    const payload = {
      action: 'create',
      data: {
        id: 'comment_1',
        body: '/conduct spec',
        issue: {
          id: 'issue_1',
          identifier: 'ENG-1234',
        },
      },
    };
    const secret = 'linear-secret';

    const accepted = await webhookHandler.handleWebhook(
      'linear',
      'issue_comment.created',
      payload,
      { 'x-signature': sign(payload, secret) },
      secret
    );

    expect(accepted.verified).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(
      webhookHandler.handleWebhook(
        'linear',
        'issue_comment.created',
        payload,
        { 'x-signature': 'sha256=invalid' },
        secret
      )
    ).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
