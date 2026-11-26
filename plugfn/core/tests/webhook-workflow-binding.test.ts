import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createPlugFnRouter, plugFn, TriggerType, WorkflowStatus } from '../src/index.js';
import { createPlugFnDatabaseAdapter } from '../src/storage/adapters/database.js';
import { MemoryAdapter } from '../src/storage/adapters/memory.js';
import { AdapterRuntimeStorage } from '../src/storage/runtime-storage.js';
import { mockProvider } from '../src/testing/index.js';
import { NoopLogger } from '../src/utils/logger.js';
import type { WebhookConfig } from '../src/types/trigger.js';
import type { Workflow, WorkflowContext, WorkflowRuntimeRegistry } from '../src/types/workflow.js';

const firstBinding = {
  tenantId: 'test-tenant-one',
  connectionId: 'test-connection-one',
  revoked: new AbortController().signal,
};
const secondBinding = {
  tenantId: 'test-tenant-two',
  connectionId: 'test-connection-two',
  revoked: new AbortController().signal,
};
const workflowModel = 'plugfn_workflows';
const executionModel = 'plugfn_workflow_executions';
const receiptModel = 'plugfn_webhook_receipts';
const deliveryModel = 'plugfn_webhook_deliveries';
const signingCredential = 'test-webhook-secret';
const alternateCredential = 'test-alternate-webhook-secret';

class CustomWebhookPayload {
  constructor(readonly id: string, public installationId?: string) {}

  describe() {
    return this.id;
  }
}

describe('webhook workflow admission', () => {
  let database: MemoryAdapter;

  beforeEach(() => {
    database = new MemoryAdapter();
  });

  it('looks up and runs only the workflow for each verified connection and tenant', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    await seedWorkflow(database, 'two', secondBinding.tenantId, secondBinding.connectionId);
    await seedWorkflow(database, 'other-connection', firstBinding.tenantId, secondBinding.connectionId);
    await seedWorkflow(database, 'other-tenant', secondBinding.tenantId, firstBinding.connectionId);
    await seedWorkflow(database, 'legacy', firstBinding.tenantId);
    const { runtime, send, action } = startRuntime(database);
    await runtime.ready;
    const lookup = vi.spyOn(database, 'findOne');
    const create = vi.spyOn(database, 'create');

    expect((await send('test-installation-one')).status).toBe(200);
    expect(action.mock.calls.map(([context]) => [context.workflowId, context.userId])).toEqual([
      ['test-workflow-one', 'test-user-one'],
    ]);
    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: firstBinding.tenantId,
      trigger: expect.objectContaining({ connectionId: firstBinding.connectionId }),
    }));
    expect(new Set(lookup.mock.calls.filter(([request]) => request.model === workflowModel)
      .map(([request]) => request.where?.[0]?.value))).toEqual(new Set(['test-workflow-one']));
    expect(create.mock.calls.filter(([request]) => request.model === executionModel)).toHaveLength(1);

    // A provider delivery ID can recur on a different connection.
    expect((await send('test-installation-two')).status).toBe(200);
    expect(action.mock.calls.map(([context]) => [context.workflowId, context.userId])).toEqual([
      ['test-workflow-one', 'test-user-one'],
      ['test-workflow-two', 'test-user-two'],
    ]);
    const executions = await database.findMany({ model: executionModel });
    expect(executions.map((row) => row.workflowId).sort()).toEqual([
      'test-workflow-one',
      'test-workflow-two',
    ]);
    expect(executions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workflowId: 'test-workflow-one',
        input: expect.objectContaining({
          payload: { id: 'test-delivery', installationId: 'test-installation-one' },
        }),
      }),
    ]));
    expect(await database.findMany({ model: receiptModel })).toEqual([
      expect.objectContaining({ connectionId: firstBinding.connectionId }),
      expect.objectContaining({ connectionId: secondBinding.connectionId }),
    ]);
  });

  it.each([undefined, 'test-installation-unknown', 'test-installation-ambiguous'])(
    'stops unresolved subject %s before lookup or persistence',
    async (installationId) => {
      await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
      const { runtime, send, action, triggerHandler } = startRuntime(database);
      await runtime.ready;
      const lookup = vi.spyOn(database, 'findOne');
      const create = vi.spyOn(database, 'create');

      const response = await send(installationId);
      expect(response.status).toBe(403);
      expect(lookup).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(triggerHandler).not.toHaveBeenCalled();
      expect(action).not.toHaveBeenCalled();
    }
  );

  it('never resolves a workflow scope when the provider has no verifier or verification is disabled', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    for (const options of [{ withVerifier: false }, { verifySignatures: false }]) {
      const { send, resolveBinding, action } = startRuntime(database, options);
      expect((await send('test-installation-one')).status).toBe(403);
      expect(resolveBinding).not.toHaveBeenCalled();
      expect(action).not.toHaveBeenCalled();
    }
    for (const model of [receiptModel, deliveryModel, executionModel]) {
      expect(await database.findMany({ model })).toEqual([]);
    }
  });

  it('does not dispatch a bound workflow on a provider without a configured resolver', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { send, action, triggerHandler } = startRuntime(database, { withResolver: false });
    expect((await send('test-installation-one')).status).toBe(200);
    expect(triggerHandler).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    expect(await database.findMany({ model: executionModel })).toEqual([]);
  });

  it('keeps verified standalone listeners available for deliveries without a workflow subject', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action } = startRuntime(database);
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);

    expect((await send()).status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    expect(await database.findMany({ model: executionModel })).toEqual([]);
    expect(await database.findMany({ model: receiptModel })).toEqual([
      expect.objectContaining({ idempotencyKey: 'test-delivery' }),
    ]);
  });

  it('retains the original tenant binding for redelivery after the registry changes', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    await seedWorkflow(database, 'two', secondBinding.tenantId, secondBinding.connectionId);
    const { send, action, resolveBinding } = startRuntime(database);
    expect((await send('test-installation-one')).status).toBe(200);

    resolveBinding.mockResolvedValue([secondBinding]);
    const retry = await send('test-installation-one');
    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toMatchObject({
      error: { code: 'WEBHOOK_IDEMPOTENCY_CONFLICT', details: {} },
    });
    expect(action).toHaveBeenCalledOnce();
    expect(await database.findMany({ model: executionModel })).toEqual([
      expect.objectContaining({ workflowId: 'test-workflow-one' }),
    ]);
  });

  it('enforces the original receipt binding on programmatic deliveries too', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    await seedWorkflow(database, 'two', secondBinding.tenantId, secondBinding.connectionId);
    const { runtime, send, action, resolveBinding } = startRuntime(database);
    expect((await send('test-installation-one')).status).toBe(200);

    resolveBinding.mockResolvedValue([secondBinding]);
    await expect(runtime.webhooks.handle(
      'test-provider',
      'test.event',
      undefined,
      {},
      signingCredential,
      { rawBody: new TextEncoder().encode(JSON.stringify({
        id: 'test-delivery',
        installationId: 'test-installation-one',
      })) }
    )).rejects.toMatchObject({ code: 'WEBHOOK_IDEMPOTENCY_CONFLICT' });
    expect(action).toHaveBeenCalledOnce();
  });

  it('verification exposes inspection data and creates no delivery', async () => {
    const { runtime, action } = startRuntime(database);
    const verified = await runtime.webhooks.verify(
      'test-provider', 'test.event', undefined, {}, signingCredential, {
        rawBody: new TextEncoder().encode(JSON.stringify({
          id: 'test-delivery',
          installationId: 'test-installation-one',
        })),
      }
    );
    expect(verified.verified).toBe(true);
    expect(verified).not.toHaveProperty('admit');
    expect(action).not.toHaveBeenCalled();
    expect(await database.findMany({ model: receiptModel })).toEqual([]);
  });

  it('allows HTTP to retry a failed programmatic delivery and deduplicates the completed attempt', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const first = startRuntime(database);
    first.runtime.webhooks.on('test-provider', 'test.event', async () => {
      throw new Error('test listener failed');
    });
    await expect(first.runtime.webhooks.handle(
      'test-provider', 'test.event', undefined, {}, signingCredential, {
        rawBody: new TextEncoder().encode(JSON.stringify({
          id: 'test-delivery',
          installationId: 'test-installation-one',
        })),
      }
    )).rejects.toMatchObject({ code: 'WEBHOOK_HANDLER_FAILED' });
    expect(await database.findMany({ model: deliveryModel })).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);

    const retry = startRuntime(database);
    const listener = vi.fn();
    retry.runtime.webhooks.on('test-provider', 'test.event', listener);
    expect((await retry.send('test-installation-one')).status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
    const duplicate = await retry.send('test-installation-one');
    await expect(duplicate.json()).resolves.toMatchObject({ data: { duplicate: true } });
    await expect(retry.runtime.webhooks.handle(
      'test-provider', 'test.event', undefined, {}, signingCredential, {
        rawBody: new TextEncoder().encode(JSON.stringify({
          id: 'test-delivery',
          installationId: 'test-installation-one',
        })),
      }
    )).resolves.toMatchObject({
      id: expect.any(String),
      idempotencyKey: expect.any(String),
      payload: { id: 'test-delivery', installationId: 'test-installation-one' },
      receivedAt: expect.any(Date),
      webhookDelivery: true,
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(await database.findMany({ model: executionModel })).toHaveLength(1);
  });

  it('keeps scoped retries on verified ingress and leaves worker capacity for standalone deliveries', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action } = startRuntime(database);
    action.mockRejectedValueOnce(new Error('test temporary failure'));
    expect((await send('test-installation-one')).status).toBe(503);
    const [scoped] = await database.findMany<{ id: string }>({ model: deliveryModel });
    const webhooks = runtime.runtime.webhooks;
    expect(scoped).toMatchObject({ status: 'failed', attempts: 1, workflowScoped: true });
    expect(scoped).not.toHaveProperty('metadata.rawBodyBase64');
    expect(await webhooks.processDueDeliveries(vi.fn())).toMatchObject({ processed: 0 });

    // A crashed scoped request can leave a stale running row. It must not
    // take the only slot from a standalone attempt in the same queue.
    await database.updateWebhookDelivery(scoped.id, { status: 'running', updatedAt: new Date(0) });
    const receipt = await webhooks.createReceipt({
      provider: 'test-provider', event: 'test.event', payloadHash: 'test-payload-hash',
    });
    const standalone = await webhooks.createDelivery({ receiptId: receipt.id, status: 'running' });
    await database.updateWebhookDelivery(standalone.id, { updatedAt: new Date(1) });
    const worker = vi.fn();
    expect(await webhooks.processDueDeliveries(worker, { limit: 1 })).toMatchObject({ succeeded: 1 });
    expect(worker).toHaveBeenCalledWith(expect.objectContaining({ delivery: expect.objectContaining({ id: standalone.id }) }));
    expect(await webhooks.listDeliveries(receipt.id)).toEqual([expect.objectContaining({ status: 'success' })]);
    expect((await send('test-installation-one')).status).toBe(200);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('records the canonical listener only when the receipt actually dispatched it', async () => {
    const { runtime, send } = startRuntime(database, { withResolver: false, authenticateEventHeader: true });
    const first = vi.fn();
    const second = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', first);
    runtime.webhooks.on('test-provider', 'test.other-event', second);
    const rawBody = Buffer.from(JSON.stringify({ id: 'test-delivery', installationId: 'test-installation-one' }));
    await runtime.webhooks.handle('test-provider', 'test.event', undefined, {
      'x-plugfn-delivery': 'test-delivery',
    }, signingCredential, { rawBody });
    expect(first).toHaveBeenCalledOnce();

    expect((await send('test-installation-one', 'test-delivery', {}, 'test.other-event')).status).toBe(200);
    expect(second).not.toHaveBeenCalled();
    const [delivery] = await database.findMany({ model: deliveryModel });
    expect(delivery).toMatchObject({ status: 'success' });
    expect(delivery).not.toHaveProperty('metadata.triggerKey');
  });

  it('keeps a reassigned attempt out of standalone retries while its receipt is scoped', async () => {
    const { runtime } = startRuntime(database);
    const webhooks = runtime.runtime.webhooks;
    const input = { provider: 'test-provider', event: 'test.event', payloadHash: 'test-payload-hash' };
    const standalone = await webhooks.createReceipt(input);
    const scoped = await webhooks.createReceipt({
      ...input, idempotencyKey: 'test-scope-key', idempotencyNamespace: 'workflow',
    });
    const attempt = await webhooks.createDelivery({ receiptId: standalone.id });
    await expect(webhooks.updateDelivery(attempt.id, { receiptId: scoped.id, status: 'success' })).rejects.toMatchObject({
      code: 'WEBHOOK_DELIVERY_REASSIGNMENT_CONFLICT', status: 409,
    });
    await expect(webhooks.updateDelivery(attempt.id, { receiptId: scoped.id })).resolves.toMatchObject({
      workflowScoped: true,
    });
    const worker = vi.fn();
    expect(await webhooks.processDueDeliveries(worker)).toMatchObject({ processed: 0 });
    expect(worker).not.toHaveBeenCalled();
    await expect(webhooks.updateDelivery(attempt.id, { receiptId: standalone.id })).resolves.toMatchObject({
      workflowScoped: null,
    });
    expect(await webhooks.processDueDeliveries(worker)).toMatchObject({ succeeded: 1 });
  });

  it('rejects reassignment after a retry worker owns the attempt', async () => {
    const { runtime } = startRuntime(database);
    const webhooks = runtime.runtime.webhooks;
    const input = { provider: 'test-provider', event: 'test.event', payloadHash: 'test-payload-hash' };
    const standalone = await webhooks.createReceipt(input);
    const scoped = await webhooks.createReceipt({
      ...input, idempotencyKey: 'test-scope-key', idempotencyNamespace: 'workflow',
    });
    const attempt = await webhooks.createDelivery({ receiptId: standalone.id });
    const worker = vi.fn(async () => {
      await expect(webhooks.updateDelivery(attempt.id, { receiptId: scoped.id })).rejects.toMatchObject({
        code: 'WEBHOOK_DELIVERY_REASSIGNMENT_CONFLICT', status: 409,
      });
    });

    expect(await webhooks.processDueDeliveries(worker)).toMatchObject({ succeeded: 1 });
    expect(worker).toHaveBeenCalledOnce();
    await expect(webhooks.updateDelivery(attempt.id, { receiptId: scoped.id })).rejects.toMatchObject({
      code: 'WEBHOOK_DELIVERY_REASSIGNMENT_CONFLICT', status: 409,
    });
    expect(await webhooks.listDeliveries(scoped.id)).toEqual([]);
    expect(await webhooks.listDeliveries(standalone.id)).toEqual([
      expect.objectContaining({ id: attempt.id, status: 'success' }),
    ]);
  });

  it('preserves the original Buffer for a standalone SDK verifier', async () => {
    const rawBody = Buffer.from(JSON.stringify({ id: 'test-delivery' }));
    const verify: NonNullable<WebhookConfig['verifySignature']> = (_payload, _signature, _secret, context) =>
      context?.rawBody === rawBody && Buffer.isBuffer(context.rawBody);
    const { runtime } = startRuntime(database, { withResolver: false, verifySignature: verify });
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    await expect(runtime.webhooks.handle('test-provider', 'test.event', undefined, {}, signingCredential, { rawBody }))
      .resolves.toMatchObject({ verified: true });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('resolves installations only within the verified signing authority', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { send, action, resolveBinding, resolveAlternateBinding } = startRuntime(database);
    expect((await send('test-installation-one', 'test-delivery', {
      'x-test-authority': 'alternate',
    })).status).toBe(403);
    expect(resolveAlternateBinding).toHaveBeenCalledWith('test-installation-one');
    expect(resolveBinding).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(await database.findMany({ model: receiptModel })).toEqual([]);
  });

  it('requires the requested workflow trigger to match the authenticated event', async () => {
    const { send, resolveBinding, triggerHandler } = startRuntime(database, {
      authenticatedEvent: 'test.other-event',
    });
    expect((await send('test-installation-one')).status).toBe(400);
    expect(resolveBinding).not.toHaveBeenCalled();
    expect(triggerHandler).not.toHaveBeenCalled();
    expect(await database.findMany({ model: receiptModel })).toEqual([]);
  });

  it('accepts the event from a custom provider that authenticates its event header', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { send, action } = startRuntime(database, { authenticateEventHeader: true });
    expect((await send('test-installation-one', 'test-delivery', {
      'x-test-signed-event': 'test.event',
    })).status).toBe(200);
    expect(action).toHaveBeenCalledOnce();
  });

  it('keeps identical bodies for different authenticated event families distinct', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    await seedWorkflow(
      database, 'other-event', firstBinding.tenantId, firstBinding.connectionId, 'test.other-event'
    );
    const { send, action } = startRuntime(database, { authenticateEventHeader: true });

    expect((await send('test-installation-one', 'test-delivery', {
      'x-test-signed-event': 'test.event',
    })).status).toBe(200);
    expect((await send('test-installation-one', 'test-delivery', {
      'x-test-signed-event': 'test.other-event',
    }, 'test.other-event')).status).toBe(200);
    expect(action.mock.calls.map(([context]) => context.workflowId)).toEqual([
      'test-workflow-one',
      'test-workflow-other-event',
    ]);
  });

  it('keeps workflow mutations out of the verified event passed to standalone listeners', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action } = startRuntime(database);
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    action.mockImplementationOnce(async ({ trigger }) => {
      trigger.payload.payload.id = 'test-mutated-id';
      trigger.payload.headers['x-plugfn-delivery'] = 'test-mutated-header';
      return {};
    });

    expect((await send('test-installation-one')).status).toBe(200);
    expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      payload: { id: 'test-delivery', installationId: 'test-installation-one' },
      headers: expect.objectContaining({ 'x-plugfn-delivery': 'test-delivery' }),
    }));
    expect(await database.findMany({ model: executionModel })).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          payload: { id: 'test-delivery', installationId: 'test-installation-one' },
        }),
      }),
    ]);
  });

  it('preserves binary attachments in an isolated workflow event', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    await seedWorkflow(database, 'two', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action } = startRuntime(database, { withBinaryAttachment: true });
    const listener = vi.fn();
    const backingStores = new Set<ArrayBufferLike>();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    action.mockImplementation(async ({ trigger }) => {
      const attachment = trigger.payload.payload.attachment;
      expect(Buffer.isBuffer(attachment)).toBe(true);
      expect(attachment.toString('utf8')).toBe('test-attachment');
      backingStores.add(attachment.buffer);
      attachment.fill(0);
      return {};
    });

    expect((await send('test-installation-one')).status).toBe(200);
    expect(action).toHaveBeenCalledTimes(2);
    expect(backingStores.size).toBe(2);
    expect(listener.mock.calls[0]?.[0].payload.attachment.toString('utf8')).toBe('test-attachment');
  });

  it('isolates custom typed events using the provider copy', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    await seedWorkflow(database, 'two', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action } = startRuntime(database, { withCustomPayload: true });
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    const copies = new Set<CustomWebhookPayload>();
    action.mockImplementation(async ({ trigger }) => {
      const payload: CustomWebhookPayload = trigger.payload.payload;
      expect(payload.describe()).toBe('test-delivery');
      expect(payload.installationId).toBe('test-installation-one');
      copies.add(payload);
      payload.installationId = 'test-mutated-installation';
      return {};
    });

    expect((await send('test-installation-one')).status).toBe(200);
    expect(copies.size).toBe(2);
    expect(listener.mock.calls[0]?.[0].payload.installationId).toBe('test-installation-one');
  });

  it('distinguishes authenticated delivery IDs when verified bodies match', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { send, action } = startRuntime(database, { authenticateDeliveryId: true });
    expect((await send('test-installation-one', 'test-delivery', {
      'x-test-signed-delivery': 'test-first-delivery',
    })).status).toBe(200);
    expect((await send('test-installation-one', 'test-delivery', {
      'x-test-signed-delivery': 'test-second-delivery',
    })).status).toBe(200);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('preserves completed listener deduplication independently of workflows', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const route = 'test-alias';
    const legacy = startRuntime(database, { withResolver: false, routeAlias: route });
    const listener = vi.fn();
    legacy.runtime.webhooks.on('test-provider', 'test.event', listener);
    const response = await legacy.send('test-installation-one', 'test-delivery', {}, route);
    expect(response.status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();

    const scoped = startRuntime(database, { routeAlias: route });
    scoped.runtime.webhooks.on('test-provider', 'test.event', listener);
    expect((await scoped.send('test-installation-one')).status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
    expect(scoped.action).toHaveBeenCalledOnce();
  });

  it('uses only unowned legacy receipts to suppress a standalone listener during scoped dispatch', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action } = startRuntime(database);
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    const receipt = await runtime.runtime.webhooks.createReceipt({
      provider: 'test-provider',
      event: 'test.event',
      idempotencyKey: 'test-delivery',
      payloadHash: fingerprint(JSON.stringify({ id: 'test-delivery', installationId: 'test-installation-one' })),
      owner: { kind: 'user', userId: 'test-owner', tenantId: firstBinding.tenantId },
      verificationStatus: 'verified',
    });
    await runtime.runtime.webhooks.createDelivery({
      receiptId: receipt.id, status: 'success', metadata: { triggerKey: 'test.event' },
    });

    expect((await send('test-installation-one')).status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });

  it('retries a standalone receipt that carries application tenant metadata', async () => {
    const { runtime, send } = startRuntime(database, { withResolver: false });
    const listener = vi.fn().mockRejectedValueOnce(new Error('test listener failed'));
    runtime.webhooks.on('test-provider', 'test.event', listener);
    expect((await send()).status).toBe(503);
    const webhooks = runtime.runtime.webhooks;
    const receipt = await webhooks.findReceiptByIdempotencyKey('test-provider', 'test-delivery');
    await webhooks.updateReceipt(receipt!.id, { metadata: { tenantId: 'test-application-tenant' } });

    expect((await send()).status).toBe(200);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each([
    { route: 'test-alias', historical: false },
    { route: 'test-alias', historical: true },
    { route: 'test.other-event', historical: true },
  ])('delivers the new event after reassignment of $route (historical: $historical)', async ({ route, historical }) => {
    await seedWorkflow(
      database, 'other-event', firstBinding.tenantId, firstBinding.connectionId, 'test.other-event'
    );
    const legacy = startRuntime(database, { withResolver: false, routeAlias: route });
    expect((await legacy.send('test-installation-one', 'test-delivery', {}, route)).status).toBe(200);
    if (historical) {
      const [delivery] = await database.findMany<{ id: string }>({ model: deliveryModel });
      await database.updateWebhookDelivery(delivery.id, { metadata: { event: route } });
    }

    const scoped = startRuntime(database, { authenticateEventHeader: true, otherRouteAlias: route });
    const listener = vi.fn();
    scoped.runtime.webhooks.on('test-provider', 'test.other-event', listener);
    expect((await scoped.send('test-installation-one', 'test-delivery', {
      'x-test-signed-event': 'test.other-event',
    }, route)).status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
    expect(scoped.action).toHaveBeenCalledOnce();
  });

  it('stores and retrieves identical opaque keys independently in each receipt namespace', async () => {
    const { runtime } = startRuntime(database);
    const webhooks = runtime.runtime.webhooks;
    const input = {
      provider: 'test-provider',
      event: 'test.event',
      idempotencyKey: 'test-delivery-key',
      payloadHash: 'test-payload-hash',
    };
    const workflowInput = { ...input, idempotencyNamespace: 'workflow' as const };
    const workflow = await webhooks.createReceipt(workflowInput);
    expect(workflow.workflowIdempotencyKey).toEqual(expect.any(String));
    const standaloneKey = workflow.workflowIdempotencyKey!;
    const standalone = await webhooks.createReceipt({ ...input, idempotencyKey: standaloneKey });

    expect(workflow.id).not.toBe(standalone.id);
    expect(workflow.idempotencyKey).toBeUndefined();
    expect(await webhooks.findReceiptByIdempotencyKey(input.provider, standaloneKey)).toEqual(standalone);
    expect(await webhooks.findReceiptByIdempotencyKey(
      input.provider, input.idempotencyKey, 'workflow',
    )).toEqual(workflow);
    expect(await webhooks.createReceipt(workflowInput)).toEqual(workflow);

    const otherProvider = await webhooks.createReceipt({ ...workflowInput, provider: 'test-other-provider' });
    expect(otherProvider.workflowIdempotencyKey).not.toBe(workflow.workflowIdempotencyKey);
    expect(await webhooks.findReceiptByIdempotencyKey(
      otherProvider.provider, input.idempotencyKey, 'workflow',
    )).toEqual(otherProvider);
  });

  it('uses the workflow index with a two-argument standalone receipt adapter', async () => {
    const adapter = createPlugFnDatabaseAdapter({ database });
    const findStandalone = adapter.findWebhookReceiptByIdempotencyKey.bind(adapter);
    const standaloneLookup = vi.spyOn(adapter, 'findWebhookReceiptByIdempotencyKey')
      .mockImplementation((provider, key) => findStandalone(provider, key));
    const storage = new AdapterRuntimeStorage(adapter);
    const input = {
      provider: 'test-provider',
      event: 'test.event',
      idempotencyKey: 'test-delivery-key',
      payloadHash: 'test-payload-hash',
    };
    const standalone = await storage.createWebhookReceipt(input);
    standaloneLookup.mockClear();

    const workflowInput = { ...input, idempotencyNamespace: 'workflow' as const };
    const workflow = await storage.createWebhookReceipt(workflowInput);
    expect(workflow.id).not.toBe(standalone.id);
    expect(await storage.createWebhookReceipt(workflowInput)).toEqual(workflow);
    expect(standaloneLookup).not.toHaveBeenCalled();
  });

  it('ignores a completed legacy receipt for a different authenticated event', async () => {
    await seedWorkflow(
      database, 'other-event', firstBinding.tenantId, firstBinding.connectionId, 'test.other-event'
    );
    const legacy = startRuntime(database, { withResolver: false, authenticateEventHeader: true });
    expect((await legacy.send('test-installation-one', 'test-delivery', {
      'x-test-signed-event': 'test.event',
    })).status).toBe(200);

    const scoped = startRuntime(database, { authenticateEventHeader: true });
    const listener = vi.fn();
    scoped.runtime.webhooks.on('test-provider', 'test.other-event', listener);
    expect((await scoped.send('test-installation-one', 'test-delivery', {
      'x-test-signed-event': 'test.other-event',
    }, 'test.other-event')).status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
    expect(scoped.action).toHaveBeenCalledOnce();
  });

  it('revalidates the registry after a receipt claim and before dispatch', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action, resolveBinding, triggerHandler } = startRuntime(database);
    const webhooks = runtime.runtime.webhooks;
    const createReceipt = webhooks.createReceipt;
    vi.spyOn(webhooks, 'createReceipt').mockImplementation(async (input) => {
      const receipt = await createReceipt(input);
      resolveBinding.mockResolvedValue([]);
      return receipt;
    });

    expect((await send('test-installation-one')).status).toBe(503);
    expect(triggerHandler).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(await database.findMany({ model: executionModel })).toEqual([]);
  });

  it('checks the persisted binding again after looking up a registered workflow', async () => {
    const workflow = await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action } = startRuntime(database);
    await runtime.ready;
    await database.update({
      model: workflowModel,
      where: [{ field: 'id', operator: 'eq', value: workflow.id }],
      data: { tenantId: secondBinding.tenantId },
    });
    expect((await send('test-installation-one')).status).toBe(200);
    expect(action).not.toHaveBeenCalled();
    expect(await database.findMany({ model: executionModel })).toEqual([]);
  });

  it('checks the registry again when workflow execution is admitted', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { send, action, resolveBinding, triggerHandler } = startRuntime(database);
    triggerHandler.mockImplementationOnce(async (payload) => {
      resolveBinding.mockResolvedValue([]);
      return { event: 'test.event', data: payload };
    });

    expect((await send('test-installation-one')).status).toBe(503);
    expect(action).not.toHaveBeenCalled();
    expect(await database.findMany({ model: executionModel })).toEqual([]);
  });

  it('rejects a workflow rebound while the execution registry check is pending', async () => {
    const workflow = await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { send, action, resolveBinding, triggerHandler } = startRuntime(database);
    triggerHandler.mockImplementationOnce(async (payload) => {
      resolveBinding.mockImplementationOnce(async () => {
        await database.update({
          model: workflowModel,
          where: [{ field: 'id', operator: 'eq', value: workflow.id }],
          data: { tenantId: secondBinding.tenantId },
        });
        return [firstBinding];
      });
      return { event: 'test.event', data: payload };
    });

    expect((await send('test-installation-one')).status).toBe(200);
    expect(action).not.toHaveBeenCalled();
    expect(await database.findMany({ model: executionModel })).toEqual([]);
  });

  it('retries a workflow revised within the same scope instead of acknowledging it without execution', async () => {
    const workflow = await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { send, action, resolveBinding, triggerHandler } = startRuntime(database);
    triggerHandler.mockImplementationOnce(async (payload) => {
      resolveBinding.mockImplementationOnce(async () => {
        await database.update({
          model: workflowModel,
          where: [{ field: 'id', operator: 'eq', value: workflow.id }],
          data: { updatedAt: new Date(workflow.updatedAt.getTime() + 1000) },
        });
        return [firstBinding];
      });
      return { event: 'test.event', data: payload };
    });

    expect((await send('test-installation-one')).status).toBe(503);
    expect(action).not.toHaveBeenCalled();
    expect((await send('test-installation-one')).status).toBe(200);
    expect(action).toHaveBeenCalledOnce();
  });

  it('cancels the execution claim if the binding is revoked while the insert is pending', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { send, action, resolveBinding } = startRuntime(database);
    const controller = new AbortController();
    resolveBinding.mockResolvedValue([{ ...firstBinding, revoked: controller.signal }]);
    const create = database.create.bind(database);
    vi.spyOn(database, 'create').mockImplementation(async (input) => {
      const result = await create(input);
      if (input.model === executionModel) {
        controller.abort();
      }
      return result;
    });

    expect((await send('test-installation-one')).status).toBe(503);
    expect(action).not.toHaveBeenCalled();
    expect(await database.findMany({ model: executionModel })).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
    resolveBinding.mockResolvedValue([firstBinding]);
    expect((await send('test-installation-one')).status).toBe(200);
    expect(action).toHaveBeenCalledOnce();
  });

  it('keeps the payload out of an execution claim if the stored workflow is rebound during the insert', async () => {
    const workflow = await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { send, action } = startRuntime(database);
    const create = database.create.bind(database);
    vi.spyOn(database, 'create').mockImplementation(async (input) => {
      const result = await create(input);
      if (input.model === executionModel) {
        await database.update({
          model: workflowModel,
          where: [{ field: 'id', operator: 'eq', value: workflow.id }],
          data: { tenantId: secondBinding.tenantId },
        });
      }
      return result;
    });

    expect((await send('test-installation-one')).status).toBe(503);
    expect(action).not.toHaveBeenCalled();
    const [claim] = await database.findMany({ model: executionModel });
    expect(claim.status).toBe('cancelled');
    expect(claim.input).not.toHaveProperty('payload');
  });

  it('preserves checkpoints if a workflow is disabled while a resume claim is pending', async () => {
    const workflow = await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const workflowWhere = [{ field: 'id', operator: 'eq' as const, value: workflow.id }];
    await database.update({
      model: workflowModel,
      where: workflowWhere,
      data: {
        definition: {
          ...workflow.definition,
          steps: [
            ...workflow.definition.steps,
            { id: 'test-resume-step', type: 'action', action: 'test-action' },
          ],
        },
      },
    });
    const { send, action } = startRuntime(database);
    action.mockResolvedValueOnce({ saved: 'test-checkpoint' });
    action.mockRejectedValueOnce(new Error('test interruption'));
    expect((await send('test-installation-one')).status).toBe(503);
    const [failed] = await database.findMany({ model: executionModel });

    const update = database.update.bind(database);
    vi.spyOn(database, 'update').mockImplementationOnce(async (input) => {
      const result = await update(input);
      if (input.model === executionModel && input.data.status === 'running') {
        await update({ model: workflowModel, where: workflowWhere, data: { status: WorkflowStatus.Disabled } });
      }
      return result;
    });
    expect((await send('test-installation-one')).status).toBe(503);
    expect(action).toHaveBeenCalledTimes(2);
    expect(await database.findMany({ model: executionModel })).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        input: failed.input,
        output: {
          data: { saved: 'test-checkpoint' },
          __workflow: expect.objectContaining({ completedStepIds: ['test-step'] }),
        },
      }),
    ]);

    await update({ model: workflowModel, where: workflowWhere, data: { status: WorkflowStatus.Enabled } });
    expect((await send('test-installation-one')).status).toBe(200);
    expect(action).toHaveBeenCalledTimes(3);
    expect(action.mock.calls[2]?.[0].data).toEqual({ saved: 'test-checkpoint' });
  });

  it('stops execution when its binding generation is revoked during the final workflow read', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action, resolveBinding } = startRuntime(database);
    const controller = new AbortController();
    resolveBinding.mockResolvedValue([{ ...firstBinding, revoked: controller.signal }]);
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    await runtime.ready;
    const findOne = database.findOne.bind(database);
    let workflowReads = 0;
    vi.spyOn(database, 'findOne').mockImplementation(async (input) => {
      const result = await findOne(input);
      if (input.model === workflowModel && ++workflowReads === 2) {
        controller.abort();
      }
      return result;
    });

    const revoked = await send('test-installation-one');
    expect(revoked.status).toBe(503);
    await expect(revoked.json()).resolves.toMatchObject({
      error: { code: 'WEBHOOK_WORKFLOW_BINDING_REVOKED', retryable: true },
    });
    expect(action).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(await database.findMany({ model: executionModel })).toEqual([]);
    resolveBinding.mockResolvedValue([firstBinding]);
    expect((await send('test-installation-one')).status).toBe(200);
    expect(action).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('stops remaining error handlers when the binding is revoked between them', async () => {
    const workflow = await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    await database.update({
      model: workflowModel,
      where: [{ field: 'id', operator: 'eq', value: workflow.id }],
      data: {
        definition: {
          ...workflow.definition,
          errorHandlers: [{ handler: 'test-first-handler' }, { handler: 'test-second-handler' }],
        },
      },
    });
    const controller = new AbortController();
    const firstHandler = vi.fn(async () => controller.abort());
    const secondHandler = vi.fn(async () => {});
    const { send, action, resolveBinding } = startRuntime(database, {
      errorHandlers: {
        'test-first-handler': firstHandler,
        'test-second-handler': secondHandler,
      },
    });
    resolveBinding.mockResolvedValue([{ ...firstBinding, revoked: controller.signal }]);
    action.mockRejectedValueOnce(new Error('test action failed'));

    expect((await send('test-installation-one')).status).toBe(503);
    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).not.toHaveBeenCalled();
    expect(await database.findMany({ model: executionModel })).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
  });

  it('skips persisted legacy definitions until an administrator explicitly backfills the binding', async () => {
    const legacy = await seedWorkflow(database, 'legacy', firstBinding.tenantId);
    const before = startRuntime(database);
    expect((await before.send('test-installation-one')).status).toBe(200);
    expect(before.action).not.toHaveBeenCalled();
    expect(await database.findMany({ model: executionModel })).toEqual([]);
    expect(await before.runtime.workflows.get(legacy.id)).toMatchObject({
      definition: legacy.definition,
      status: WorkflowStatus.Enabled,
    });

    await database.update({
      model: workflowModel,
      where: [{ field: 'id', operator: 'eq', value: legacy.id }],
      data: {
        definition: {
          ...legacy.definition,
          trigger: { ...legacy.definition.trigger, connectionId: firstBinding.connectionId },
        },
      },
    });
    const after = startRuntime(database);
    expect((await after.send('test-installation-one', 'test-new-delivery')).status).toBe(200);
    expect(after.action).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      workflowId: legacy.id,
      userId: legacy.userId,
    }));
  });
});

async function seedWorkflow(
  database: MemoryAdapter,
  name: string,
  tenantId: string,
  connectionId?: string,
  event = 'test.event'
) {
  const workflow = {
    id: `test-workflow-${name}`,
    tenantId,
    userId: `test-user-${name}`,
    name,
    status: WorkflowStatus.Enabled,
    definition: {
      trigger: { provider: 'test-provider', event, ...(connectionId && { connectionId }) },
      steps: [{ id: 'test-step', type: 'action', action: 'test-action' }],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies Workflow;
  await database.create({ model: workflowModel, data: workflow });
  return workflow;
}

function startRuntime(
  database: MemoryAdapter,
  options: {
    withVerifier?: boolean;
    verifySignature?: WebhookConfig['verifySignature'];
    verifySignatures?: boolean;
    withResolver?: boolean;
    authenticateDeliveryId?: boolean;
    authenticatedEvent?: string;
    authenticateEventHeader?: boolean;
    errorHandlers?: WorkflowRuntimeRegistry['errorHandlers'];
    withBinaryAttachment?: boolean;
    withCustomPayload?: boolean;
    routeAlias?: string;
    otherRouteAlias?: string;
  } = {}
) {
  const action = vi.fn(async (_context: WorkflowContext) => ({}));
  const resolveBinding = vi.fn(async (subject: string) => {
    switch (subject) {
      case 'test-installation-one': return [firstBinding];
      case 'test-installation-two': return [secondBinding];
      case 'test-installation-ambiguous': return [firstBinding, secondBinding];
      default: return [];
    }
  });
  const resolveAlternateBinding = vi.fn(() => []);
  const runtime = plugFn({
    database,
    auth: { authenticate: () => null },
    baseUrl: 'https://app.example.test',
    encryptionKey: Buffer.alloc(32, 1).toString('hex'),
    integrations: {},
    logger: new NoopLogger(),
    webhooks: {
      verifySignatures: options.verifySignatures,
      workflowBindings: options.withResolver === false ? undefined : {
        'test-provider': [
          {
            id: 'test-signing-app',
            credentialFingerprints: [fingerprint(signingCredential)],
            resolve: resolveBinding,
          },
          {
            id: 'test-alternate-signing-app',
            credentialFingerprints: [fingerprint(alternateCredential)],
            resolve: resolveAlternateBinding,
          },
        ],
      },
    },
    workflows: { runtime: { actions: { 'test-action': action }, errorHandlers: options.errorHandlers } },
  });
  const provider = mockProvider('test-provider', {});
  const triggerHandler = vi.fn(async (payload: unknown) => ({ event: 'test.event', data: payload }));
  provider.triggers = {
    'test.event': {
      name: 'test.event',
      displayName: 'Test event',
      description: 'Test event',
      type: TriggerType.Webhook,
      schema: options.withCustomPayload
        ? z.instanceof(CustomWebhookPayload)
        : z.object({ id: z.string(), installationId: z.string().optional() }),
      handler: triggerHandler,
      webhookConfig: {
        path: `/webhooks/test-provider/${options.routeAlias ?? 'test.event'}`,
        method: 'POST',
        verifySignature: options.withVerifier === false ? undefined : options.verifySignature ?? (() => true),
        getWorkflowSubject: (payload: unknown) =>
          z.object({ installationId: z.string() }).safeParse(payload).data?.installationId,
        getWorkflowEvent: (_payload, { headers }) => options.authenticateEventHeader
          ? headers['x-test-signed-event']
          : options.authenticatedEvent ?? 'test.event',
        getAuthenticatedDeliveryId: options.authenticateDeliveryId
          ? (_payload, { headers }) => headers['x-test-signed-delivery']
          : undefined,
        transformPayload: options.withBinaryAttachment
          ? (payload) => ({ ...payload, attachment: Buffer.from('test-attachment') })
          : options.withCustomPayload
          ? ({ id, installationId }) => new CustomWebhookPayload(id, installationId)
          : undefined,
        cloneWorkflowEvent: options.withCustomPayload
          ? (event: Parameters<NonNullable<WebhookConfig['cloneWorkflowEvent']>>[0]) => {
            const { id, installationId } = event.payload;
            const payload = new CustomWebhookPayload(id, installationId);
            return { ...structuredClone(event), payload, data: payload };
          }
          : undefined,
      },
    },
  };
  if (options.authenticateEventHeader) {
    const primary = provider.triggers['test.event'];
    provider.triggers['test.other-event'] = {
      ...primary,
      name: 'test.other-event',
      webhookConfig: {
        ...primary.webhookConfig!, path: `/webhooks/test-provider/${options.otherRouteAlias ?? 'test.other-event'}`,
      },
    };
  }
  runtime.providers.register(provider);
  const router = createPlugFnRouter(runtime, {
    webhookSecret: (_provider, _request, headers) =>
      headers['x-test-authority'] === 'alternate' ? alternateCredential : signingCredential,
  });
  const send = (
    installationId?: string,
    id = 'test-delivery',
    headers?: Record<string, string>,
    event = 'test.event'
  ) => router.handle(
    new Request(`https://app.example.test/webhooks/test-provider/${event}`, {
      method: 'POST',
      headers: { 'x-plugfn-delivery': id, ...headers },
      body: JSON.stringify({ id, installationId }),
    })
  );
  return { runtime, send, action, resolveBinding, resolveAlternateBinding, triggerHandler };
}

function fingerprint(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}
