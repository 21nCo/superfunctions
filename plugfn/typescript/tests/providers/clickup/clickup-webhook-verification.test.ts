import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../../../src/core/provider-registry.js';
import { clickupProvider } from '../../../src/providers/clickup/index.js';
import { NoopLogger } from '../../../src/utils/logger.js';
import { WebhookHandler } from '../../../src/webhooks/webhook-handler.js';

function sign(payload: unknown, secret: string): string {
  const digest = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  return `sha256=${digest}`;
}

describe('clickup webhook verification', () => {
  it('emits task.updated only for verified payloads', async () => {
    const logger = new NoopLogger();
    const registry = new ProviderRegistry(logger);
    registry.register(clickupProvider);
    const handler = new WebhookHandler(registry, logger);

    const listener = vi.fn();
    handler.on('clickup', 'task.updated', listener);

    const payload = {
      event: 'taskUpdated',
      task_id: 'task_1',
    };
    const secret = 'clickup-secret';

    const accepted = await handler.handleWebhook(
      'clickup',
      'task.updated',
      payload,
      { 'x-signature': sign(payload, secret) },
      secret
    );
    expect(accepted.verified).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    await expect(
      handler.handleWebhook('clickup', 'task.updated', payload, { 'x-signature': 'sha256=bad' }, secret)
    ).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('emits task.statusChanged only for verified payloads', async () => {
    const logger = new NoopLogger();
    const registry = new ProviderRegistry(logger);
    registry.register(clickupProvider);
    const handler = new WebhookHandler(registry, logger);

    const listener = vi.fn();
    handler.on('clickup', 'task.statusChanged', listener);

    const payload = {
      event: 'taskStatusUpdated',
      task_id: 'task_1',
      status: 'done',
    };
    const secret = 'clickup-secret';

    const accepted = await handler.handleWebhook(
      'clickup',
      'task.statusChanged',
      payload,
      { 'x-signature': sign(payload, secret) },
      secret
    );
    expect(accepted.verified).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    await expect(
      handler.handleWebhook(
        'clickup',
        'task.statusChanged',
        payload,
        { 'x-signature': 'sha256=invalid' },
        secret
      )
    ).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
