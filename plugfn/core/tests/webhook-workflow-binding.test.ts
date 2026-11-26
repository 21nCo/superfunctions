import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as publicPlugFn from '../src/index.js';
import { createPlugFnRouter, plugFn, TriggerType, WorkflowStatus } from '../src/index.js';
import { createPlugFnDatabaseAdapter } from '../src/storage/adapters/database.js';
import { MemoryAdapter } from '../src/storage/adapters/memory.js';
import { AdapterRuntimeStorage } from '../src/storage/runtime-storage.js';
import { mockProvider } from '../src/testing/index.js';
import { NoopLogger } from '../src/utils/logger.js';
import type { WebhookConfig } from '../src/types/trigger.js';
import type { PlugFnWebhookDelivery } from '../src/types/runtime.js';
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

  it('keeps webhook verification capabilities out of the public API and global symbol registry', () => {
    const { runtime } = startRuntime(database);
    for (const name of [
      'webhookSignatureProof', 'webhookRuntimeReplayContext', 'claimFirstSignedWebhookDelivery',
      'webhookReceiptTenantId', 'prepareWebhookIngress', 'registerWebhookPreparation',
    ]) {
      expect(publicPlugFn).not.toHaveProperty(name);
    }
    expect(Reflect.has(runtime.webhooks, Symbol.for('plugfn.prepareWebhookDelivery'))).toBe(false);
    expect(Object.getOwnPropertySymbols(runtime.webhooks)).toEqual([]);
  });

  it('routes webhooks through a shallow copy of the SDK facade', async () => {
    const { runtime } = startRuntime(database, { withResolver: false });
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    const router = createPlugFnRouter({ ...runtime, webhooks: { ...runtime.webhooks } }, {
      webhookSecret: { 'test-provider': signingCredential },
    });
    const response = await router.handle(new Request('https://app.example.test/webhooks/test-provider/test.event', {
      method: 'POST', body: JSON.stringify({ id: 'test-delivery' }),
    }));
    expect(response.status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each(['original', 'copy'] as const)('routes HTTP webhooks after wrapping handle on the %s SDK facade', async (facade) => {
    const { runtime } = startRuntime(database, { withResolver: false });
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    const plug = facade === 'copy' ? { ...runtime, webhooks: { ...runtime.webhooks } } : runtime;
    const tracedHandle = vi.fn(plug.webhooks.handle);
    plug.webhooks.handle = tracedHandle;
    const router = createPlugFnRouter(plug, { webhookSecret: { 'test-provider': signingCredential } });

    const response = await router.handle(new Request('https://app.example.test/webhooks/test-provider/test.event', {
      method: 'POST', body: JSON.stringify({ id: 'test-delivery' }),
    }));
    expect(response.status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
    expect(tracedHandle).not.toHaveBeenCalled();
  });

  it('keeps a scoped receipt bound when an application replaces its metadata', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action, resolveBinding } = startRuntime(database);
    expect((await send('test-installation-one')).status).toBe(200);
    const [receipt] = await database.findMany<publicPlugFn.PlugFnWebhookReceipt>({ model: receiptModel });
    const updates = await runtime.runtime.webhooks.updateReceipt(receipt.id, {
      metadata: { tenantId: secondBinding.tenantId },
      workflowTenantId: secondBinding.tenantId,
      workflowIdempotencyKey: 'test-other-receipt-key',
      connectionId: secondBinding.connectionId,
    });
    expect(updates).toMatchObject({
      metadata: { tenantId: secondBinding.tenantId },
      workflowTenantId: firstBinding.tenantId,
      workflowIdempotencyKey: receipt.workflowIdempotencyKey,
      connectionId: firstBinding.connectionId,
    });
    const duplicate = await send('test-installation-one');
    await expect(duplicate.json()).resolves.toMatchObject({ data: { duplicate: true } });
    resolveBinding.mockResolvedValue([secondBinding]);
    expect((await send('test-installation-one')).status).toBe(409);
    expect(action).toHaveBeenCalledOnce();
  });

  it('keeps scoped receipts out of the standalone receipt key space', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send } = startRuntime(database);
    expect((await send('test-installation-one')).status).toBe(200);
    const [scoped] = await database.findMany<publicPlugFn.PlugFnWebhookReceipt>({ model: receiptModel });
    const webhooks = runtime.runtime.webhooks;
    const key = 'test-standalone-delivery';
    const updated = await webhooks.updateReceipt(scoped.id, { idempotencyKey: key });
    expect(updated.idempotencyKey).toBeUndefined();

    // Verify that even a mixed row introduced by an adapter cannot be read as standalone.
    await database.updateWebhookReceipt(scoped.id, { idempotencyKey: key });
    await expect(webhooks.findReceiptByIdempotencyKey('test-provider', key)).resolves.toBeNull();
  });

  it('reports SDK receipt content conflicts as webhook errors', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send } = startRuntime(database, { authenticateDeliveryId: true });
    const headers = { 'x-test-signed-delivery': 'test-signed-delivery' };
    expect((await send('test-installation-one', 'test-delivery', headers)).status).toBe(200);
    const rawBody = Buffer.from(JSON.stringify({ id: 'test-other-body', installationId: 'test-installation-one' }));
    const handle = runtime.webhooks.handle('test-provider', 'test.event', undefined, headers, signingCredential, { rawBody });
    await expect(handle).rejects.toBeInstanceOf(publicPlugFn.WebhookHandlerError);
    await expect(handle).rejects.toMatchObject({ code: 'WEBHOOK_IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('reports SDK workflow readiness failures as retryable webhook errors', async () => {
    const { runtime } = startRuntime(database);
    vi.spyOn(runtime, 'ready', 'get').mockImplementation(() => Promise.reject(new Error('test storage unavailable')));
    const rawBody = Buffer.from(JSON.stringify({ id: 'test-delivery', installationId: 'test-installation-one' }));
    const handle = runtime.webhooks.handle('test-provider', 'test.event', undefined, {}, signingCredential, { rawBody });
    await expect(handle).rejects.toBeInstanceOf(publicPlugFn.WebhookHandlerError);
    await expect(handle).rejects.toMatchObject({ code: 'PLUGFN_NOT_READY', status: 503, retryable: true });
  });

  it.each([
    { reason: 'original raw body', withRawBody: false, verifySignatures: true },
    { reason: 'signature verification enabled', withRawBody: true, verifySignatures: false },
  ])('requires $reason before standalone SDK dispatch for a provider with bindings', async ({ reason, withRawBody, verifySignatures }) => {
    const verifySignature = vi.fn(() => true);
    const { runtime } = startRuntime(database, { verifySignature, verifySignatures });
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    const payload = { id: 'test-delivery' };
    const rawBody = withRawBody ? Buffer.from(JSON.stringify(payload)) : undefined;
    await expect(runtime.webhooks.handle('test-provider', 'test.event', payload, {}, signingCredential, { rawBody }))
      .rejects.toMatchObject({ code: 'WEBHOOK_WORKFLOW_BINDING_REQUIRED', status: 403, message: expect.stringContaining(reason) });
    expect(verifySignature).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
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

  it('ignores even a verified standalone completion and deduplicates subsequent scoped deliveries', async () => {
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
    const lookup = vi.spyOn(scoped.runtime.runtime.webhooks, 'findReceiptByIdempotencyKey');
    expect((await scoped.send('test-installation-one')).status).toBe(200);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(scoped.action).toHaveBeenCalledOnce();
    expect(lookup.mock.calls.every(([, , namespace]) => namespace === 'workflow')).toBe(true);

    const restarted = startRuntime(database, { routeAlias: route });
    restarted.runtime.webhooks.on('test-provider', 'test.event', listener);
    const duplicate = await restarted.send('test-installation-one');
    await expect(duplicate.json()).resolves.toMatchObject({ data: { duplicate: true } });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(restarted.action).not.toHaveBeenCalled();
  });

  it('deduplicates signed bound deliveries separately for each signing authority', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const { runtime, send, action, resolveAlternateBinding } = startRuntime(database);
    resolveAlternateBinding.mockReturnValue([firstBinding]);
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    const alternate = { 'x-test-authority': 'alternate' };

    expect((await send('test-installation-one')).status).toBe(200);
    expect((await send('test-installation-one', 'test-delivery', alternate)).status).toBe(200);
    const duplicate = await send('test-installation-one', 'test-delivery', alternate);
    await expect(duplicate.json()).resolves.toMatchObject({ data: { duplicate: true } });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('requires signature evidence on a scoped completion before deduplicating it', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const before = startRuntime(database);
    expect((await before.send('test-installation-one')).status).toBe(200);
    const [delivery] = await database.findMany<{ id: string }>({ model: deliveryModel });
    await database.updateWebhookDelivery(delivery.id, { signatureVerified: null });

    const after = startRuntime(database);
    const listener = vi.fn();
    after.runtime.webhooks.on('test-provider', 'test.event', listener);
    expect((await after.send('test-installation-one')).status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each([
    { source: 'a provider without a verifier', withVerifier: false, verifySignatures: undefined },
    { source: 'a provider with verification disabled', withVerifier: true, verifySignatures: false },
  ])('dispatches the first signed delivery after accepting unsigned deliveries from $source', async (options) => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const verifySignature = vi.fn((_payload, signature) => signature === 'test-signed-webhook');
    const before = startRuntime(database, { ...options, withResolver: false, verifySignature });
    const listener = vi.fn();
    before.runtime.webhooks.on('test-provider', 'test.event', listener);
    expect((await before.send('test-installation-one')).status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
    expect(verifySignature).not.toHaveBeenCalled();
    const receipt = await before.runtime.runtime.webhooks.findReceiptByIdempotencyKey('test-provider', 'test-delivery');
    expect(receipt?.verificationStatus).toBe(options.withVerifier ? 'not-required' : 'verified');
    const [originalDelivery] = await before.runtime.runtime.webhooks.listDeliveries(receipt!.id);
    expect(originalDelivery.signatureVerified).not.toBe(true);

    const after = startRuntime(database, { verifySignatures: true, verifySignature });
    after.runtime.webhooks.on('test-provider', 'test.event', listener);
    const signedHeaders = { 'x-signature': 'test-signed-webhook' };
    expect((await after.send('test-installation-one', 'test-delivery', signedHeaders)).status).toBe(200);
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(after.action).toHaveBeenCalledOnce();
    expect(await database.findMany({ model: deliveryModel })).toContainEqual(expect.objectContaining({
      status: 'success',
      signatureVerified: true,
    }));
    const duplicate = await after.send('test-installation-one', 'test-delivery', signedHeaders);
    await expect(duplicate.json()).resolves.toMatchObject({ data: { duplicate: true } });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores a historical completion that records a trigger but no signature evidence', async () => {
    await seedWorkflow(database, 'one', firstBinding.tenantId, firstBinding.connectionId);
    const before = startRuntime(database, { withResolver: false });
    before.runtime.webhooks.on('test-provider', 'test.event', vi.fn());
    expect((await before.send('test-installation-one')).status).toBe(200);
    const [delivery] = await database.findMany<{ id: string }>({ model: deliveryModel });
    await database.updateWebhookDelivery(delivery.id, { metadata: { triggerKey: 'test.event' } });

    const after = startRuntime(database);
    const listener = vi.fn();
    after.runtime.webhooks.on('test-provider', 'test.event', listener);
    expect((await after.send('test-installation-one')).status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();
    expect(after.action).toHaveBeenCalledOnce();
  });

  it('keeps unsigned standalone completion separate from signed standalone completion in the same runtime', async () => {
    const { runtime, send } = startRuntime(database, { withResolver: false, withVerifier: false });
    const listener = vi.fn();
    runtime.webhooks.on('test-provider', 'test.event', listener);
    expect((await send()).status).toBe(200);
    expect(listener).toHaveBeenCalledOnce();

    const provider = runtime.providers.get('test-provider')!;
    provider.triggers!['test.event'].webhookConfig!.verifySignature = (_payload, signature) =>
      signature === 'test-signed-webhook';
    const signedHeaders = { 'x-signature': 'test-signed-webhook' };
    expect((await send(undefined, 'test-delivery', signedHeaders)).status).toBe(200);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(await database.findMany({ model: deliveryModel })).toContainEqual(expect.objectContaining({
      signatureVerified: true, status: 'success', runtimeReplayContext: null,
    }));
    const duplicate = await send(undefined, 'test-delivery', signedHeaders);
    await expect(duplicate.json()).resolves.toMatchObject({ data: { duplicate: true } });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'dead-lettered'] as const)('uses and clears signed replay context on %s after an unsigned completion', async (status) => {
    const before = startRuntime(database, { withResolver: false, withVerifier: false });
    before.runtime.webhooks.on('test-provider', 'test.event', vi.fn());
    expect((await before.send(undefined, 'test-delivery', { 'x-test-topic': 'test-unsigned-topic' })).status).toBe(200);

    const { runtime, send } = startRuntime(database, { withResolver: false });
    runtime.webhooks.on('test-provider', 'test.event', vi.fn().mockRejectedValue(new Error('test listener failed')));
    expect((await send(undefined, 'test-delivery', {
      'x-test-topic': 'test-signed-topic', 'x-signature': 'test-signature',
    })).status).toBe(503);
    const [failed] = await database.findMany<PlugFnWebhookDelivery>({
      model: deliveryModel, where: [{ field: 'status', operator: 'eq', value: 'failed' }],
    });
    expect(failed.runtimeReplayContext).toMatchObject({
      event: 'test.event',
      headers: { 'x-test-topic': 'test-signed-topic', 'x-signature': '[redacted]' },
      rawBodyBase64: Buffer.from(JSON.stringify({ id: 'test-delivery' })).toString('base64'),
      rawBodyExpiresAt: expect.any(String),
    });
    expect(failed.metadata).not.toHaveProperty('rawBodyBase64');
    expect(failed.metadata).not.toHaveProperty('rawBodyExpiresAt');
    const applicationHeaders = { 'x-test-topic': 'test-application-topic' };
    const updated = await runtime.runtime.webhooks.updateDelivery(failed.id, {
      nextAttemptAt: new Date(0),
      signatureVerified: null,
      runtimeReplayContext: null,
      metadata: { event: 'test.other-event', replayHeaders: applicationHeaders },
    });
    expect(updated.runtimeReplayContext).toEqual(failed.runtimeReplayContext);
    const retryHandler = vi.fn(async () => {
      if (status === 'dead-lettered') throw new Error('test retry failed');
    });
    const result = await runtime.runtime.webhooks.processDueDeliveries(retryHandler, { maxAttempts: 1 });
    expect(result.processed).toBe(1);
    expect(retryHandler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      event: 'test.event',
      headers: expect.objectContaining({ 'x-test-topic': 'test-signed-topic', 'x-signature': '[redacted]' }),
      rawBody: Buffer.from(JSON.stringify({ id: 'test-delivery' })),
    }));
    expect(result.deliveries[0]).toMatchObject({ status, signatureVerified: true, metadata: { replayHeaders: applicationHeaders } });
    expect(result.deliveries[0]?.runtimeReplayContext).toBeNull();
  });

  it('expires a signed retry using its stored deadline after application metadata is replaced', async () => {
    const { runtime, send } = startRuntime(database, { withResolver: false });
    runtime.webhooks.on('test-provider', 'test.event', vi.fn().mockRejectedValue(new Error('test listener failed')));
    expect((await send()).status).toBe(503);
    const [failed] = await database.findMany<PlugFnWebhookDelivery>({ model: deliveryModel });
    await database.updateWebhookDelivery(failed.id, {
      runtimeReplayContext: { ...failed.runtimeReplayContext!, rawBodyExpiresAt: new Date(0).toISOString() },
    });
    const metadata = { rawBodyExpiresAt: '2099-01-01T00:00:00.000Z' };
    const webhooks = runtime.runtime.webhooks;
    await webhooks.updateDelivery(failed.id, { metadata, nextAttemptAt: new Date(0) });

    const handler = vi.fn();
    const result = await webhooks.processDueDeliveries(handler);
    expect(handler).not.toHaveBeenCalled();
    expect(result.deliveries).toMatchObject([{
      status: 'dead-lettered', error: 'webhook retry payload expired', runtimeReplayContext: null, metadata,
    }]);
  });

  it.each(['success', 'dead-lettered'] as const)('keeps application replayHeaders through an unsigned %s pre-binding attempt', async (status) => {
    const { runtime } = startRuntime(database, { withResolver: false, withVerifier: false });
    const webhooks = runtime.runtime.webhooks;
    const receipt = await webhooks.createReceipt({
      provider: 'test-provider', event: 'test.receipt-event', payloadHash: 'test-payload-hash',
      headersRedacted: { 'x-test-topic': 'test-receipt-topic' },
    });
    const metadata = {
      event: 'test.app-event', signatureVerified: true, replayHeaders: { 'x-test-topic': 'test-app-topic' },
    };
    await webhooks.createDelivery({ receiptId: receipt.id, status: 'pending', metadata });
    const handler = vi.fn(async () => {
      if (status === 'dead-lettered') throw new Error('test retry failed');
    });

    const result = await webhooks.processDueDeliveries(handler, { maxAttempts: 1 });
    expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      event: receipt.event, headers: receipt.headersRedacted,
    }));
    expect(result.deliveries[0]).toMatchObject({ status, metadata });
  });

  it('claims the first signed delivery once across runtimes that share an older receipt', async () => {
    const before = startRuntime(database, { withResolver: false, withVerifier: false });
    before.runtime.webhooks.on('test-provider', 'test.event', vi.fn());
    expect((await before.send()).status).toBe(200);

    const contenders = [startRuntime(database, { withResolver: false }), startRuntime(database, { withResolver: false })];
    const listener = vi.fn();
    let claims = 0;
    let releaseClaims!: () => void;
    const bothClaiming = new Promise<void>((resolve) => { releaseClaims = resolve; });
    for (const { runtime } of contenders) {
      runtime.webhooks.on('test-provider', 'test.event', listener);
      const webhooks = runtime.runtime.webhooks;
      const createReceipt = webhooks.createReceipt;
      vi.spyOn(webhooks, 'createReceipt').mockImplementation(async (input) => {
        const receipt = await createReceipt(input);
        if (++claims === contenders.length) releaseClaims();
        await bothClaiming;
        return receipt;
      });
    }

    const responses = await Promise.all(contenders.map(({ send }) => send()));
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map((response) => response.json()));
    expect(results.filter(({ data }) => data.duplicate)).toHaveLength(1);
    expect(listener).toHaveBeenCalledOnce();
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
    standaloneLookup.mockResolvedValueOnce(workflow);
    await expect(storage.findWebhookReceiptByIdempotencyKey(input.provider, input.idempotencyKey)).resolves.toBeNull();
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
  const resolveAlternateBinding = vi.fn((): typeof firstBinding[] => []);
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
