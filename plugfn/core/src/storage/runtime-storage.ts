import { createHash } from 'node:crypto';
import { NotFoundError, type Adapter as DbAdapter, type WhereClause } from '@superfunctions/db';
import type {
  PlugFnConnectionGrant,
  PlugFnConnectionOwner,
  PlugFnProviderEvent,
  PlugFnProviderInstallation,
  PlugFnSecretRef,
  PlugFnSyncCheckpoint,
  PlugFnSyncJob,
  PlugFnWebhookDelivery,
  PlugFnWebhookReceipt,
  PlugFnWebhookReceiptNamespace,
} from '../types/runtime.js';
import {
  ensurePlugFnDatabaseAdapter,
  type PlugFnDatabaseStorageAdapter,
} from './adapters/database.js';
import {
  assertWebhookReceiptProvider,
  assertWebhookUpdateFields,
  hasWebhookSignatureProof,
  isBindingId,
  normalizeWebhookStorageRow,
  webhookBindingRequired,
  webhookDeliveryReassignmentConflict,
  WebhookHandlerError,
  webhookRetryUpdates,
} from '../webhooks/webhook-handler.js';

export const webhookSignatureProof = Symbol('plugfn.webhookSignatureProof');
export const webhookReceiptTenantId = Symbol('plugfn.webhookReceiptTenantId');

export interface CreateProviderInstallationInput {
  provider: string;
  owner: PlugFnConnectionOwner;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateConnectionGrantInput {
  connectionId: string;
  granteeUserId: string;
  grant: string;
  expiresAt?: Date;
}

export interface CreateWebhookReceiptInput {
  [webhookSignatureProof]?: boolean;
  [webhookReceiptTenantId]?: string;
  provider: string;
  event: string;
  payloadHash: string;
  idempotencyKey?: string;
  idempotencyNamespace?: PlugFnWebhookReceiptNamespace;
  connectionId?: string;
  owner?: PlugFnConnectionOwner;
  headersRedacted?: Record<string, string>;
  verificationStatus?: PlugFnWebhookReceipt['verificationStatus'];
  metadata?: Record<string, unknown>;
}

export interface CreateWebhookDeliveryInput {
  [webhookSignatureProof]?: boolean;
  receiptId: string;
  sinkId?: string;
  handlerName?: string;
  status?: PlugFnWebhookDelivery['status'];
  nextAttemptAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface CreateSyncJobInput {
  provider: string;
  connectionId: string;
  resource: string;
  mode: PlugFnSyncJob['mode'];
  owner?: PlugFnConnectionOwner;
  cursor?: string;
  checkpoint?: unknown;
  metadata?: Record<string, unknown>;
}

export interface UpdateSyncJobProgressInput {
  status?: PlugFnSyncJob['status'];
  claimToken?: string;
  cursor?: string;
  checkpoint?: unknown;
  fetchedCount?: number;
  persistedCount?: number;
  skippedCount?: number;
  error?: string;
}

export class AdapterRuntimeStorage {
  private readonly adapter: PlugFnDatabaseStorageAdapter;
  private readonly webhookReceiptClaimLocks = new Map<string, Promise<void>>();
  private readonly syncCheckpointLocks = new Map<string, Promise<void>>();

  constructor(adapter: DbAdapter | PlugFnDatabaseStorageAdapter) {
    this.adapter = ensurePlugFnDatabaseAdapter(adapter);
  }

  createProviderInstallation(
    input: CreateProviderInstallationInput
  ): Promise<PlugFnProviderInstallation> {
    const now = new Date();
    const owner = ownerFields(input.owner);
    if (!owner.ownerKind || !owner.ownerId) {
      throw new Error('provider installation owner is required');
    }
    return this.adapter.createProviderInstallation({
      id: generateId('install'),
      provider: input.provider,
      ownerKind: owner.ownerKind,
      ownerId: owner.ownerId,
      tenantId: owner.tenantId,
      organizationId: owner.organizationId,
      installedByUserId: owner.installedByUserId,
      delegatedToUserId: owner.delegatedToUserId,
      status: 'active',
      scopes: input.scopes,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    });
  }

  listProviderInstallations(
    filters: Record<string, unknown> = {}
  ): Promise<PlugFnProviderInstallation[]> {
    return this.adapter.listProviderInstallations(filters);
  }

  updateProviderInstallation(
    id: string,
    updates: Partial<PlugFnProviderInstallation>
  ): Promise<PlugFnProviderInstallation> {
    return this.adapter.updateProviderInstallation(id, {
      ...updates,
      updatedAt: new Date(),
    });
  }

  createConnectionGrant(input: CreateConnectionGrantInput): Promise<PlugFnConnectionGrant> {
    return this.adapter.createConnectionGrant({
      id: generateId('grant'),
      connectionId: input.connectionId,
      granteeUserId: input.granteeUserId,
      grant: input.grant,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
    });
  }

  listConnectionGrants(connectionId: string): Promise<PlugFnConnectionGrant[]> {
    return this.adapter.listConnectionGrants(connectionId);
  }

  deleteConnectionGrant(id: string): Promise<void> {
    return this.adapter.deleteConnectionGrant(id);
  }

  async createWebhookReceipt(input: CreateWebhookReceiptInput): Promise<PlugFnWebhookReceipt> {
    const { provider, idempotencyKey, idempotencyNamespace = 'standalone' } = input;
    if (idempotencyNamespace === 'workflow' && (
      !idempotencyKey || !input[webhookSignatureProof] ||
      !isBindingId(input[webhookReceiptTenantId]) || !isBindingId(input.connectionId)
    )) throw webhookBindingRequired('verified workflow receipt admission required');
    if (!idempotencyKey) return this.persistWebhookReceipt(input).then(normalizeWebhookStorageRow);

    const claimKey = JSON.stringify([provider, idempotencyNamespace, idempotencyKey]);
    return this.withWebhookReceiptClaimLock(claimKey, async () => {
      const existing = await this.findStoredWebhookReceipt(
        provider,
        idempotencyKey,
        idempotencyNamespace
      );
      if (existing) {
        return this.admitExistingWebhookReceipt(input, existing);
      }

      try {
        return await this.persistWebhookReceipt(input);
      } catch (error) {
        // The unique index arbitrates claims in this namespace across runtime instances.
        const concurrentlyCreated = await this.findStoredWebhookReceipt(
          provider,
          idempotencyKey,
          idempotencyNamespace
        );
        if (concurrentlyCreated) {
          return this.admitExistingWebhookReceipt(input, concurrentlyCreated);
        }
        throw error;
      }
    }).then(normalizeWebhookStorageRow);
  }

  private async admitExistingWebhookReceipt(input: CreateWebhookReceiptInput, receipt: PlugFnWebhookReceipt) {
    if (input.idempotencyNamespace !== 'workflow' || hasWebhookSignatureProof(receipt)) {
      return assertMatchingWebhookReceipt(receipt, input.payloadHash);
    }
    // A row without verified admission cannot reserve a workflow receipt key.
    const now = new Date();
    await this.adapter.database.updateMany({
      model: this.adapter.models.webhookReceipts,
      where: [
        { field: 'id', operator: 'eq', value: receipt.id },
        { field: 'provider', operator: 'eq', value: input.provider },
        { field: 'workflowIdempotencyKey', operator: 'eq', value: receipt.workflowIdempotencyKey },
        { field: 'signatureVerified', operator: 'eq', value: receipt.signatureVerified ?? null },
      ],
      data: {
        event: input.event,
        connectionId: input.connectionId,
        workflowTenantId: input[webhookReceiptTenantId],
        idempotencyKey: null,
        ownerKind: null,
        ownerId: null,
        payloadHash: input.payloadHash,
        headersRedacted: input.headersRedacted,
        verificationStatus: 'verified',
        signatureVerified: true,
        createdAt: now,
        receivedAt: now,
        metadata: webhookReceiptMetadata(input),
      },
    });
    const admitted = await this.adapter.getWebhookReceipt(receipt.id);
    if (!admitted || !hasWebhookSignatureProof(admitted)) {
      throw new WebhookHandlerError('WEBHOOK_HANDLER_FAILED', 'could not admit workflow receipt', 503);
    }
    return assertMatchingWebhookReceipt(admitted, input.payloadHash);
  }

  private persistWebhookReceipt(input: CreateWebhookReceiptInput): Promise<PlugFnWebhookReceipt> {
    const now = new Date();
    const { idempotencyKey } = input;
    const receiptKey = input.idempotencyNamespace === 'workflow' && idempotencyKey
      ? { workflowIdempotencyKey: workflowReceiptKey(input.provider, idempotencyKey) }
      : { idempotencyKey };
    return this.adapter.createWebhookReceipt({
      id: receiptKey.workflowIdempotencyKey ? `whrec_${receiptKey.workflowIdempotencyKey}` : generateId('whrec'),
      provider: input.provider,
      event: input.event,
      ...receiptKey,
      ...(receiptKey.workflowIdempotencyKey ? { workflowTenantId: input[webhookReceiptTenantId] } : {}),
      connectionId: input.connectionId,
      ...ownerFields(receiptKey.workflowIdempotencyKey ? undefined : input.owner),
      headersRedacted: input.headersRedacted,
      payloadHash: input.payloadHash,
      verificationStatus: input.verificationStatus ?? 'not-required',
      ...(receiptKey.workflowIdempotencyKey && input[webhookSignatureProof] ? { signatureVerified: true } : {}),
      receivedAt: now,
      createdAt: now,
      metadata: webhookReceiptMetadata(input),
    });
  }

  private async withWebhookReceiptClaimLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.webhookReceiptClaimLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.webhookReceiptClaimLocks.set(key, tail);

    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
      if (this.webhookReceiptClaimLocks.get(key) === tail) {
        this.webhookReceiptClaimLocks.delete(key);
      }
    }
  }

  getWebhookReceipt(id: string): Promise<PlugFnWebhookReceipt | null> {
    return this.adapter.getWebhookReceipt(id).then(normalizeWebhookStorageRow);
  }

  findWebhookReceiptByIdempotencyKey(
    provider: string,
    idempotencyKey: string,
    namespace: PlugFnWebhookReceiptNamespace = 'standalone'
  ): Promise<PlugFnWebhookReceipt | null> {
    return this.findStoredWebhookReceipt(provider, idempotencyKey, namespace).then(normalizeWebhookStorageRow);
  }

  private async findStoredWebhookReceipt(
    provider: string,
    idempotencyKey: string,
    namespace: PlugFnWebhookReceiptNamespace,
  ): Promise<PlugFnWebhookReceipt | null> {
    if (namespace === 'standalone') {
      const receipt = await this.adapter.findWebhookReceiptByIdempotencyKey(provider, idempotencyKey);
      return receipt?.workflowIdempotencyKey ? null : receipt;
    }
    return this.adapter.database.findOne<PlugFnWebhookReceipt>({
      model: this.adapter.models.webhookReceipts,
      where: [
        { field: 'provider', operator: 'eq', value: provider },
        { field: 'workflowIdempotencyKey', operator: 'eq', value: workflowReceiptKey(provider, idempotencyKey) },
      ],
    });
  }

  async updateWebhookReceipt(
    id: string,
    updates: Partial<PlugFnWebhookReceipt>
  ): Promise<PlugFnWebhookReceipt> {
    assertWebhookUpdateFields(updates, 'receipt');
    const normalizedUpdates = { ...updates };
    delete normalizedUpdates.signatureVerified;
    delete normalizedUpdates.workflowIdempotencyKey;
    delete normalizedUpdates.workflowTenantId;
    let existing: PlugFnWebhookReceipt | null = null;
    if (normalizedUpdates.provider === undefined) delete normalizedUpdates.provider;
    if ('provider' in normalizedUpdates || 'connectionId' in normalizedUpdates || 'idempotencyKey' in normalizedUpdates ||
        'id' in normalizedUpdates || 'event' in normalizedUpdates || 'payloadHash' in normalizedUpdates ||
        'ownerKind' in normalizedUpdates || 'ownerId' in normalizedUpdates) {
      existing = await this.adapter.getWebhookReceipt(id);
      if (existing) assertWebhookReceiptProvider(existing, normalizedUpdates.provider);
      if (existing?.workflowIdempotencyKey) {
        delete normalizedUpdates.provider;
        delete normalizedUpdates.connectionId;
        delete normalizedUpdates.idempotencyKey;
        delete normalizedUpdates.id;
        delete normalizedUpdates.event;
        delete normalizedUpdates.payloadHash;
        delete normalizedUpdates.ownerKind;
        delete normalizedUpdates.ownerId;
      }
    }
    if (updates.metadata !== undefined) {
      const metadata: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updates.metadata ?? {})) {
        if (value === undefined) {
          continue;
        }
        metadata[key] = value;
      }
      // Receipt metadata uses replacement semantics. Avoid a cross-instance
      // read/merge/write race and always preserve the runtime-owned timestamp.
      metadata.updatedAt = new Date().toISOString();
      normalizedUpdates.metadata = metadata;
    }
    if (Object.keys(normalizedUpdates).length === 0) {
      const receipt = existing ?? await this.adapter.getWebhookReceipt(id);
      if (!receipt) {
        throw new NotFoundError(this.adapter.models.webhookReceipts, [{ field: 'id', operator: 'eq', value: id }]);
      }
      return normalizeWebhookStorageRow(receipt);
    }
    return this.adapter.updateWebhookReceipt(id, normalizedUpdates).then(normalizeWebhookStorageRow);
  }

  async createWebhookDelivery(input: CreateWebhookDeliveryInput): Promise<PlugFnWebhookDelivery> {
    const workflowScoped = await this.workflowDeliveryScope(input.receiptId);
    const now = new Date();
    return this.adapter.createWebhookDelivery({
      id: generateId('whdel'),
      receiptId: input.receiptId,
      sinkId: input.sinkId,
      handlerName: input.handlerName,
      ...(workflowScoped ? { workflowScoped } : {}),
      ...(workflowScoped && input[webhookSignatureProof] ? { signatureVerified: true } : {}),
      status: input.status ?? 'pending',
      attempts: 0,
      nextAttemptAt: input.nextAttemptAt,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    }).then(normalizeWebhookStorageRow);
  }

  async updateWebhookDelivery(
    id: string,
    updates: Partial<PlugFnWebhookDelivery>,
  ): Promise<PlugFnWebhookDelivery> {
    assertWebhookUpdateFields(updates, 'delivery');
    const fields = { ...updates };
    delete fields.workflowScoped;
    delete fields.signatureVerified;
    if (fields.receiptId === undefined) {
      delete fields.receiptId;
    } else {
      const model = this.adapter.models.webhookDeliveries;
      const where: WhereClause[] = [{ field: 'id', operator: 'eq', value: id }];
      const existing = await this.adapter.database.findOne<PlugFnWebhookDelivery>({ model, where });
      if (!existing) throw new NotFoundError(model, where);
      if (existing.receiptId !== fields.receiptId && (
        existing.workflowScoped || await this.workflowDeliveryScope(existing.receiptId) ||
        await this.workflowDeliveryScope(fields.receiptId)
      )) throw webhookDeliveryReassignmentConflict();
    }
    return this.adapter.updateWebhookDelivery(id, { ...fields, updatedAt: new Date() }).then(normalizeWebhookStorageRow);
  }

  private async workflowDeliveryScope(receiptId: string): Promise<true | null> {
    const receipt = await this.adapter.getWebhookReceipt(receiptId);
    return receipt?.workflowIdempotencyKey ? true : null;
  }

  updateClaimedWebhookDelivery(
    id: string,
    claimToken: string,
    updates: Partial<PlugFnWebhookDelivery>
  ): Promise<PlugFnWebhookDelivery | null> {
    return this.adapter.updateClaimedWebhookDelivery(id, claimToken, {
      ...webhookRetryUpdates(updates),
      updatedAt: new Date(),
    }).then(normalizeWebhookStorageRow);
  }

  listWebhookDeliveries(receiptId: string): Promise<PlugFnWebhookDelivery[]> {
    return this.adapter.listWebhookDeliveries(receiptId).then((rows) => rows.map(normalizeWebhookStorageRow));
  }

  listWebhookDeliveriesForRetry(now = new Date(), limit = 100, leaseMs?: number): Promise<PlugFnWebhookDelivery[]> {
    return this.adapter.listWebhookDeliveriesForRetry(now, limit, leaseMs).then((rows) => rows.map(normalizeWebhookStorageRow));
  }

  claimWebhookDeliveriesForRetry(
    now = new Date(),
    limit = 100,
    workerId = generateId('webhook_worker'),
    leaseMs?: number
  ): Promise<PlugFnWebhookDelivery[]> {
    return this.adapter.claimWebhookDeliveriesForRetry(now, limit, workerId, leaseMs).then((rows) => rows.map(normalizeWebhookStorageRow));
  }

  createSyncJob(input: CreateSyncJobInput): Promise<PlugFnSyncJob> {
    const now = new Date();
    return this.adapter.createSyncJob({
      id: generateId('sync'),
      provider: input.provider,
      connectionId: input.connectionId,
      resource: input.resource,
      mode: input.mode,
      status: 'queued',
      ...ownerFields(input.owner),
      cursor: input.cursor,
      checkpoint: input.checkpoint,
      fetchedCount: 0,
      persistedCount: 0,
      skippedCount: 0,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    });
  }

  getSyncJob(id: string): Promise<PlugFnSyncJob | null> {
    return this.adapter.getSyncJob(id);
  }

  listSyncJobs(
    filters: Record<string, unknown> = {},
    limit = 100,
    offset = 0
  ): Promise<PlugFnSyncJob[]> {
    return this.adapter.listSyncJobs(filters, limit, offset);
  }

  claimQueuedSyncJobs(
    limit = 25,
    leaseMs?: number,
    workerId = generateId('sync_worker')
  ): Promise<PlugFnSyncJob[]> {
    return this.adapter.claimQueuedSyncJobs(limit, workerId, leaseMs);
  }

  updateSyncJob(id: string, updates: UpdateSyncJobProgressInput): Promise<PlugFnSyncJob> {
    return this.adapter.updateSyncJob(id, {
      ...updates,
      updatedAt: new Date(),
    });
  }

  updateClaimedSyncJob(id: string, claimToken: string, updates: UpdateSyncJobProgressInput = {}): Promise<PlugFnSyncJob | null> {
    return this.adapter.updateClaimedSyncJob(id, claimToken, { ...updates, updatedAt: new Date() });
  }

  checkpointClaimedSyncJob(
    id: string,
    claimToken: string,
    updates: UpdateSyncJobProgressInput,
    checkpointInput?: { provider: string; connectionId: string; resource: string; checkpoint: unknown }
  ): Promise<PlugFnSyncJob | null> {
    return this.withSyncCheckpointLock(id, async () => {
      if (!this.adapter.database.capabilities.transactions.supported) {
        const job = await this.updateClaimedSyncJob(id, claimToken, updates);
        if (!job) return null;
        if (checkpointInput) await this.upsertSyncCheckpoint(checkpointInput);
        return job;
      }
      return this.adapter.database.transaction(async (transaction) => {
        let job: PlugFnSyncJob;
        try {
          job = await transaction.update<PlugFnSyncJob>({
            model: this.adapter.models.syncJobs,
            where: [
              { field: 'id', operator: 'eq', value: id },
              { field: 'status', operator: 'eq', value: 'running' },
              { field: 'claimToken', operator: 'eq', value: claimToken },
            ],
            data: { ...updates, updatedAt: new Date() },
          });
        } catch (error) {
          if (error instanceof NotFoundError) return null;
          throw error;
        }
        if (checkpointInput) {
          const now = new Date();
          await transaction.upsert<PlugFnSyncCheckpoint>({
            model: this.adapter.models.syncCheckpoints,
            where: [
              { field: 'connectionId', operator: 'eq', value: checkpointInput.connectionId },
              { field: 'resource', operator: 'eq', value: checkpointInput.resource },
            ],
            create: { id: checkpointId(checkpointInput.connectionId, checkpointInput.resource), ...checkpointInput, updatedAt: now },
            update: { provider: checkpointInput.provider, checkpoint: checkpointInput.checkpoint, updatedAt: now },
            conflictTarget: ['connectionId', 'resource'],
          });
        }
        return job;
      });
    });
  }

  private async withSyncCheckpointLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.syncCheckpointLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => current);
    this.syncCheckpointLocks.set(key, queued);
    await previous.catch(() => {});
    try { return await work(); }
    finally {
      release();
      if (this.syncCheckpointLocks.get(key) === queued) this.syncCheckpointLocks.delete(key);
    }
  }

  async completeSyncJob(
    id: string,
    updates: Omit<UpdateSyncJobProgressInput, 'status' | 'error'> = {},
    claimToken?: string
  ): Promise<PlugFnSyncJob> {
    const where: WhereClause[] = [
      { field: 'id', operator: 'eq', value: id },
      { field: 'status', operator: 'eq', value: 'running' },
    ];
    if (claimToken) where.push({ field: 'claimToken', operator: 'eq', value: claimToken });
    const updated = await this.adapter.database.updateMany({
      model: this.adapter.models.syncJobs,
      where,
      data: {
        ...updates,
        status: 'completed',
        claimToken: undefined,
        updatedAt: new Date(),
      },
    });

    const job = await this.adapter.getSyncJob(id);
    if (!job) {
      throw new Error(`Sync job ${id} not found after completion`);
    }
    if (updated === 0 && claimToken) throw syncJobClaimLost(id);
    if (updated === 0 && !['completed', 'cancelled', 'failed'].includes(job.status)) {
      throw new Error(`Sync job ${id} could not transition to completed from ${job.status}`);
    }
    return job;
  }

  async cancelSyncJob(id: string): Promise<PlugFnSyncJob> {
    await this.adapter.database.updateMany({
      model: this.adapter.models.syncJobs,
      where: [
        { field: 'id', operator: 'eq', value: id },
        { field: 'status', operator: 'in', value: ['queued', 'running'] },
      ],
      data: {
        status: 'cancelled',
        updatedAt: new Date(),
      },
    });

    const job = await this.adapter.getSyncJob(id);
    if (!job) {
      throw {
        code: 'NOT_FOUND',
        message: 'sync job not found',
        status: 404,
        retryable: false,
      };
    }
    if (job.status !== 'cancelled') {
      throw {
        code: 'SYNC_JOB_TERMINAL',
        message: `sync job cannot be cancelled from ${job.status}`,
        status: 409,
        retryable: false,
        details: { status: job.status },
      };
    }
    return job;
  }

  async failSyncJob(id: string, error: string, claimToken?: string): Promise<PlugFnSyncJob> {
    const where: WhereClause[] = [
      { field: 'id', operator: 'eq', value: id },
      { field: 'status', operator: 'eq', value: 'running' },
    ];
    if (claimToken) where.push({ field: 'claimToken', operator: 'eq', value: claimToken });
    const updated = await this.adapter.database.updateMany({
      model: this.adapter.models.syncJobs,
      where,
      data: {
        status: 'failed',
        claimToken: undefined,
        error,
        updatedAt: new Date(),
      },
    });

    const job = await this.adapter.getSyncJob(id);
    if (!job) {
      throw new Error(`Sync job ${id} not found after failure`);
    }
    if (updated === 0 && claimToken) throw syncJobClaimLost(id);
    if (updated === 0 && !['completed', 'cancelled', 'failed'].includes(job.status)) {
      throw new Error(`Sync job ${id} could not transition to failed from ${job.status}`);
    }
    return job;
  }

  upsertSyncCheckpoint(input: {
    provider: string;
    connectionId: string;
    resource: string;
    checkpoint: unknown;
  }): Promise<PlugFnSyncCheckpoint> {
    return this.adapter.upsertSyncCheckpoint({
      id: checkpointId(input.connectionId, input.resource),
      provider: input.provider,
      connectionId: input.connectionId,
      resource: input.resource,
      checkpoint: input.checkpoint,
      updatedAt: new Date(),
    });
  }

  getSyncCheckpoint(
    connectionId: string,
    resource: string
  ): Promise<PlugFnSyncCheckpoint | null> {
    return this.adapter.getSyncCheckpoint(connectionId, resource);
  }

  createProviderEvent(input: Omit<PlugFnProviderEvent, 'id' | 'createdAt'>): Promise<PlugFnProviderEvent> {
    return this.adapter.createProviderEvent({
      ...input,
      id: generateId('event'),
      createdAt: new Date(),
    });
  }

  listProviderEvents(
    filters: Record<string, unknown> = {},
    limit = 100
  ): Promise<PlugFnProviderEvent[]> {
    return this.adapter.listProviderEvents(filters, limit);
  }

  upsertSecretRef(input: Omit<PlugFnSecretRef, 'createdAt' | 'updatedAt'>): Promise<PlugFnSecretRef> {
    const now = new Date();
    return this.adapter.upsertSecretRef({
      ...input,
      createdAt: now,
      updatedAt: now,
    });
  }

  listSecretRefs(filters: Record<string, unknown> = {}): Promise<PlugFnSecretRef[]> {
    return this.adapter.listSecretRefs(filters);
  }
}

function syncJobClaimLost(id: string): Error {
  const error = new Error(`sync job ${id} claim is no longer owned by this worker`);
  error.name = 'SyncJobClaimLostError';
  return error;
}

function workflowReceiptKey(provider: string, idempotencyKey: string): string {
  return createHash('sha256').update(JSON.stringify([provider, idempotencyKey])).digest('hex');
}

function assertMatchingWebhookReceipt(
  receipt: PlugFnWebhookReceipt,
  payloadHash: string
): PlugFnWebhookReceipt {
  if (receipt.payloadHash !== payloadHash) {
    throw new WebhookHandlerError(
      'WEBHOOK_IDEMPOTENCY_CONFLICT', 'webhook idempotency key was reused with a different payload', 409,
    );
  }
  return receipt;
}

function webhookReceiptMetadata(input: CreateWebhookReceiptInput): Record<string, unknown> | undefined {
  const metadata = { ...input.metadata };
  delete metadata.plugfnTenantId;
  if (input.owner?.tenantId) metadata.plugfnTenantId = input.owner.tenantId;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function ownerFields(owner: PlugFnConnectionOwner | undefined): {
  ownerKind?: PlugFnConnectionOwner['kind'];
  ownerId?: string;
  tenantId?: string;
  organizationId?: string;
  installedByUserId?: string;
  delegatedToUserId?: string;
  grants?: string[];
} {
  if (!owner) {
    return {};
  }

  if (owner.kind === 'user') {
    return {
      ownerKind: owner.kind,
      ownerId: owner.userId,
      tenantId: owner.tenantId,
    };
  }

  if (owner.kind === 'organization') {
    return {
      ownerKind: owner.kind,
      ownerId: owner.organizationId,
      tenantId: owner.tenantId,
      organizationId: owner.organizationId,
      installedByUserId: owner.installedByUserId,
    };
  }

  return {
    ownerKind: owner.kind,
    ownerId: owner.organizationId,
    tenantId: owner.tenantId,
    organizationId: owner.organizationId,
    installedByUserId: owner.installedByUserId,
    delegatedToUserId: owner.delegatedToUserId,
    grants: [...owner.grants],
  };
}

function generateId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function checkpointId(connectionId: string, resource: string): string {
  return `ckpt_${connectionId}_${resource}`.replace(/[^a-zA-Z0-9_:-]/g, '_');
}
