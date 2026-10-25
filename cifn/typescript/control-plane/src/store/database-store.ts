import { expireLogLedger, stepOutputCheckpoint, stepOutputId, type StepOutputCheckpoint, type StepOutputDelivery } from '../log-delivery/forwarding.js';
import { validateApiErrorTelemetry, type ApiErrorTelemetry } from '../observability/error-context.js';
import { captureLifecycle, appendLifecycle, emptyLifecycle, LIFECYCLE_MAX_EVENTS, type LifecycleOwner, type LifecycleLedger, type LifecycleRecord } from '../observability/lifecycle.js';
import { MAX_STEP_EVENTS, validateStepEvent, type StepEvent } from '../dispatch/step-events.js';
import { redactSecrets } from "../secrets/redact.js";
import { LOG_JOB_BYTES, LOG_MAX_EVENTS, LOG_RETENTION_MS, validateLogPacket, type LogPacket, type LogLedger } from "../log-delivery/protocol.js";
import type { EmailDeliveryResult } from '../sendfn/email-transport.js';
import { notificationDestination, type SendFnConfig, type NotificationDestination } from '../sendfn/sendfn-client.js';
import { notificationBackoff, type NotificationIntent } from '../sendfn/outbox.js';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Adapter, WhereClause } from '@superfunctions/db';
import { wrapWithSchema } from '@superfunctions/db/schema';
import type { Run, RunStatus, Job, JobStatus, Step, StepStatus } from '../pipeline/types.js';
import type { Artifact, Runner, CreateRunInput, ListRunsOptions, ListRunsResult } from './memory-store.js';
import type { ControlPlaneStore } from './store.js';
import { createRunRecord } from './records.js';
import type { PreparedRun, DispatchIntent, DispatchDelivery, ClaimIdentity, JobCompletion } from '../dispatch/types.js';
import { ClaimConflictError, validateCompletion } from '../dispatch/types.js';
import type { JobPayload } from '../queue/flowfn-client.js';
import { CIFN_STATE_TABLE, getCiFnStoreSchema } from './database-schema.js';

interface EncryptedPayload { version: 1; iv: string; tag: string; ciphertext: string }
interface StateRow {
  id: string; namespace: string; kind: 'run' | 'runner' | 'meta'; status: string;
  createdAt: string; revision: number; payload: EncryptedPayload;
}
interface TelemetryState { lifecycle?: LifecycleLedger }
interface RunnerState extends Runner, TelemetryState {}
interface ApiTelemetryState extends TelemetryState { maximum: number }
interface RunState { lifecycle?: LifecycleLedger; run: Run; definition: CreateRunInput; artifacts: Artifact[]; secretValues: string[]; dispatches?: DispatchIntent[]; dispatchProtocolVersion?: 2; notificationDestination?: NotificationDestination; notification?: NotificationIntent; logs?: Record<string, LogLedger> }
export interface DatabaseStoreOptions {
  database: Adapter;
  /** Exactly 32 bytes supplied by the deployment. Never generated or persisted by CiFn. */
  encryptionKey: Uint8Array;
  namespace?: string;
  notifications?: SendFnConfig;
  logRetentionMs?: number;
  /** Namespace-persisted API-error admission cap; must match across workers. */
  apiTelemetryMaxEvents?: number;
}
export interface RecoveryCandidate { run: Run; definition: CreateRunInput }
export interface RecoveryPage { candidates: RecoveryCandidate[]; nextCursor?: string }

const TERMINAL: RunStatus[] = ['success', 'failure', 'cancelled'];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Durable state repository. Mutations resolve only after database acknowledgement. */
export class DatabaseStore implements ControlPlaneStore {
  private readonly database: Adapter;
  private readonly key: Buffer;
  private readonly namespace: string;
  private notificationUrl?: NotificationDestination;
  private logRetentionMs: number;
  private apiTelemetryMaxEvents: number;
  private onRunStatusChange?: (run: Run) => void;

  private constructor(options: DatabaseStoreOptions) {
    if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.byteLength !== 32) {
      throw new Error('CiFn durable storage requires an explicit 32-byte encryption key');
    }
    if (options.database.id === 'memory') throw new Error('CiFn durable storage requires a persistent database adapter');
    if (options.namespace !== undefined && (!options.namespace.trim() || options.namespace.length > 128)) {
      throw new Error('CiFn storage namespace must contain 1 to 128 characters');
    }
    this.apiTelemetryMaxEvents = options.apiTelemetryMaxEvents ?? LIFECYCLE_MAX_EVENTS;
    if (!Number.isSafeInteger(this.apiTelemetryMaxEvents) || this.apiTelemetryMaxEvents < 1 || this.apiTelemetryMaxEvents > LIFECYCLE_MAX_EVENTS) throw new Error('Invalid API telemetry capacity');
    this.logRetentionMs = options.logRetentionMs ?? LOG_RETENTION_MS;
    if (!Number.isSafeInteger(this.logRetentionMs) || this.logRetentionMs < 1 || this.logRetentionMs > 30 * 86400000) throw new Error("Invalid log retention");
    this.notificationUrl = notificationDestination(options.notifications ?? { enabled: false });
    this.namespace = options.namespace ?? 'default';
    this.key = Buffer.from(options.encryptionKey);
    this.database = wrapWithSchema(options.database, getCiFnStoreSchema());
  }

  static async open(options: DatabaseStoreOptions): Promise<DatabaseStore> {
    const store = new DatabaseStore(options);
    try {
      const seed = store.row('meta', 'configuration', 'ready', new Date().toISOString(), { schemaVersion: 1 });
      const existing = await store.database.findOne<StateRow>({ model: CIFN_STATE_TABLE, where: store.where(seed.id) });
      if (!existing) {
        const orphaned = await store.database.findOne<StateRow>({ model: CIFN_STATE_TABLE,
          where: [{ field: 'namespace', operator: 'eq', value: store.namespace }] });
        // Another process may have initialized this namespace after our first read.
        if (orphaned && !await store.database.findOne<StateRow>({ model: CIFN_STATE_TABLE, where: store.where(seed.id) })) {
          throw new Error('CiFn storage metadata is missing; explicit repair is required');
        }
      }
      const stored = await store.database.upsert<StateRow>({ model: CIFN_STATE_TABLE,
        where: store.where(seed.id), conflictTarget: 'id', create: seed, update: {} });
      const metadata = store.decode<{ schemaVersion: number }>(stored);
      if (metadata.schemaVersion !== 1) throw new Error('Unsupported CiFn storage schema version');
      const telemetry = store.row('meta', 'api-errors', 'ready', new Date().toISOString(), { maximum: store.apiTelemetryMaxEvents, lifecycle: emptyLifecycle() });
      const admitted = await store.database.upsert<StateRow>({ model: CIFN_STATE_TABLE, where: store.where(telemetry.id), conflictTarget: 'id', create: telemetry, update: {} });
      const settings = store.decode<ApiTelemetryState>(admitted);
      if (settings.maximum !== store.apiTelemetryMaxEvents || settings.lifecycle?.version !== 1) throw new Error('API telemetry configuration differs from the persisted namespace');
      return store;
    } catch (cause) {
      store.key.fill(0);
      throw cause;
    }
  }

  private id(kind: StateRow['kind'], id: string): string { return JSON.stringify([this.namespace, kind, id]); }
  private where(id: string): WhereClause[] {
    return [{ field: 'namespace', operator: 'eq', value: this.namespace }, { field: 'id', operator: 'eq', value: id }];
  }
  private aad(row: Omit<StateRow, 'payload'>): Buffer {
    return Buffer.from(JSON.stringify([CIFN_STATE_TABLE, row.id, row.namespace, row.kind, row.status, row.createdAt, row.revision]));
  }
  private encode(row: Omit<StateRow, 'payload'>, value: unknown): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(row));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }
  private decode<T>(row: StateRow): T {
    try {
      const payload = row.payload;
      if (payload.version !== 1 || row.namespace !== this.namespace) throw new Error();
      const iv = Buffer.from(payload.iv, 'base64');
      const tag = Buffer.from(payload.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(this.aad(row));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch {
      // Neither corrupt ciphertext nor key/secret material enters errors or logs.
      throw new Error('CiFn persisted state could not be authenticated');
    }
  }
  private row(kind: StateRow['kind'], id: string, status: string, createdAt: string, value: unknown): StateRow {
    const metadata = { id: this.id(kind, id), namespace: this.namespace, kind, status, createdAt, revision: 0 };
    return { ...metadata, payload: this.encode(metadata, value) };
  }
  private async read<T>(kind: StateRow['kind'], id: string): Promise<T | undefined> {
    const row = await this.database.findOne<StateRow>({ model: CIFN_STATE_TABLE, where: this.where(this.id(kind, id)) });
    return row ? this.decode<T>(row) : undefined;
  }
  private async mutate<T, R>(kind: StateRow['kind'], id: string, update: (value: T) => { result: R; changed: boolean; status?: string }): Promise<R | undefined> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const row = await this.database.findOne<StateRow>({ model: CIFN_STATE_TABLE, where: this.where(this.id(kind, id)) });
      if (!row) return undefined;
      const value = this.decode<T>(row);
      const beforeRun = kind === 'run' ? clone((value as RunState).run) : undefined;
      const change = update(value);
      if (!change.changed) return change.result;
      if (kind === 'run') {
        const state = value as RunState;
        captureLifecycle(this.namespace, state.lifecycle ??= emptyLifecycle(), beforeRun, state.run, state.secretValues);
      }
      if (kind === 'run' && !TERMINAL.includes(row.status as RunStatus)) {
        const state = value as RunState;
        if (TERMINAL.includes(state.run.status)) this.prepareNotification(state);
      }
      const next = { ...row, revision: row.revision + 1, status: change.status ?? row.status };
      const count = await this.database.updateMany({ model: CIFN_STATE_TABLE,
        where: [...this.where(row.id), { field: 'revision', operator: 'eq', value: row.revision }],
        data: { revision: next.revision, status: next.status, payload: this.encode(next, value) } });
      if (count === 1) return change.result;
      if (count !== 0) throw new Error('CiFn storage revision update affected multiple records');
    }
    throw new Error('CiFn storage update conflicted repeatedly; retry the operation');
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const definition = clone(input);
    const run = createRunRecord(definition);
    const state: RunState = { run, definition, artifacts: [], secretValues: [], notificationDestination: this.notificationUrl };
    captureLifecycle(this.namespace, state.lifecycle = emptyLifecycle(), undefined, run, state.secretValues);
    await this.database.create({ model: CIFN_STATE_TABLE, data: this.row('run', run.id, run.status, run.createdAt, state) });
    return clone(run);
  }
  async createPreparedRun(prepared: PreparedRun): Promise<Run> {
    const definition = clone(prepared.input);
    const run = createRunRecord(definition);
    const dispatches: DispatchIntent[] = prepared.jobs.map(job => {
      const id = JSON.stringify([run.id, job.jobKey, 1]);
      return { id, payload: { ...clone(job), runId: run.id, dispatchId: id, trigger: clone(definition.trigger) }, state: (definition.pipelineSpec.jobs[job.jobKey].needs?.length ?? 0) > 0 ? 'blocked' : 'ready', nextDeliveryAt: 0 };
    });
    const state: RunState = { run, definition, artifacts: [], secretValues: [...prepared.secretValues], dispatches, dispatchProtocolVersion: 2, notificationDestination: this.notificationUrl };
    captureLifecycle(this.namespace, state.lifecycle = emptyLifecycle(), undefined, run, state.secretValues);
    await this.database.create({ model: CIFN_STATE_TABLE, data: this.row('run', run.id, run.status, run.createdAt, state) });
    return clone(run);
  }
  private telemetryAddress(owner: LifecycleOwner): { kind: StateRow['kind']; id: string } {
    if (!owner || Object.keys(owner).sort().join(',') !== 'id,kind' || typeof owner.id !== 'string' || !owner.id || owner.id.length > 512) throw new Error('Invalid lifecycle owner');
    if (owner.kind === 'api' && owner.id === 'errors') return { kind: 'meta', id: 'api-errors' };
    if (owner.kind === 'run' || owner.kind === 'runner') return owner;
    throw new Error('Invalid lifecycle owner');
  }
  private mutateTelemetry<R>(owner: LifecycleOwner, change: (state: TelemetryState) => { result: R; changed: boolean }): Promise<R | undefined> {
    const address = this.telemetryAddress(owner);
    return this.mutate<TelemetryState, R>(address.kind, address.id, change);
  }
  async recordApiError(event: ApiErrorTelemetry): Promise<void> {
    validateApiErrorTelemetry(event); event = clone(event);
    const accepted = await this.mutate<ApiTelemetryState, true>('meta', 'api-errors', state => {
      if (!state.lifecycle || state.maximum !== this.apiTelemetryMaxEvents) throw new Error('API telemetry metadata requires repair');
      const base = { timestamp: new Date().toISOString(), code: event.code, route: event.route, method: event.method, status: String(event.status) };
      appendLifecycle(this.namespace, ['api', 'errors'], state.lifecycle,
        [...(event.code === 'PIPELINE_INVALID' ? [{ ...base, type: 'pipeline.parse_error' as const }] : []), { ...base, type: 'api.error' }], state.maximum);
      return { result: true, changed: true };
    });
    if (!accepted) throw new Error('API telemetry metadata is missing');
  }
  /** Bounded keyset scan across run/runner/API owners; cursor is opaque and must be reset on upgrade. */
  async listLifecycleOwners(cursor?: string): Promise<{ owners: LifecycleOwner[]; nextCursor?: string }> {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) throw new Error('Invalid lifecycle cursor');
    const rows = await this.database.findMany<StateRow>({ model: CIFN_STATE_TABLE,
      where: [{ field: 'namespace', operator: 'eq', value: this.namespace }, ...(cursor ? [{ field: 'id', operator: 'gt' as const, value: cursor }] : [])],
      orderBy: [{ field: 'id', direction: 'asc' }], limit: 11 });
    const slice = rows.slice(0, 10); const owners: LifecycleOwner[] = [];
    for (const row of slice) {
      const state = this.decode<TelemetryState>(row);
      if (!state.lifecycle?.records.some(record => record.state === 'pending' || record.state === 'sending')) continue;
      const identity = JSON.parse(row.id) as string[];
      if (row.kind === 'run' || row.kind === 'runner') owners.push({ kind: row.kind, id: identity[2] });
      else if (identity[2] === 'api-errors') owners.push({ kind: 'api', id: 'errors' });
    }
    return { owners, nextCursor: rows.length > 10 ? slice[slice.length - 1].id : undefined };
  }
  getLifecycleRecords(runId: string) { return this.getTelemetryRecords({ kind: 'run', id: runId }); }
  claimLifecycle(runId: string, now: number, leaseMs: number) { return this.claimTelemetry({ kind: 'run', id: runId }, now, leaseMs); }
  finishLifecycle(runId: string, eventId: string, token: string, outcome: 'delivered' | 'unknown', now: number) { return this.finishTelemetry({ kind: 'run', id: runId }, eventId, token, outcome, now); }
  reconcileLifecycle(runId: string, eventId: string, resolution: 'delivered' | 'retry', now: number) { return this.reconcileTelemetry({ kind: 'run', id: runId }, eventId, resolution, now); }
  pruneLifecycle(runId: string, completedBefore: number, limit = 100) { return this.pruneTelemetry({ kind: 'run', id: runId }, completedBefore, limit); }
  /** Privileged metadata: no sink credentials or raw provider errors. */
  async getTelemetryRecords(owner: LifecycleOwner): Promise<LifecycleRecord[]> {
    const address = this.telemetryAddress(owner);
    return clone((await this.read<TelemetryState>(address.kind, address.id))?.lifecycle?.records ?? []);
  }
  async listLifecycleRuns(cursor?: string): Promise<{ runIds: string[]; nextCursor?: string }> {
    const page = await this.page({ limit: 10, cursor });
    return { runIds: page.rows.filter(row => this.decode<RunState>(row).lifecycle?.records.some(record => record.state === 'pending' || record.state === 'sending')).map(row => this.decode<RunState>(row).run.id), nextCursor: page.nextCursor };
  }
  async claimTelemetry(owner: LifecycleOwner, now: number, leaseMs: number): Promise<LifecycleRecord | undefined> {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error('Invalid lifecycle claim bounds');
    return this.mutateTelemetry<LifecycleRecord | undefined>(owner, state => {
      const record = state.lifecycle?.records.find(item => item.state !== 'delivered');
      if (!record || record.state === 'unknown') return { result: undefined, changed: false };
      if (record.state === 'sending') {
        if (!record.claim) throw new Error('Invalid lifecycle claim state');
        if (record.claim.expiresAt > now) return { result: undefined, changed: false };
        record.state = 'unknown'; delete record.claim;
        return { result: undefined, changed: true };
      }
      record.state = 'sending'; record.claim = { token: randomUUID(), expiresAt: now + leaseMs };
      return { result: clone(record), changed: true };
    });
  }
  async finishTelemetry(owner: LifecycleOwner, eventId: string, token: string, outcome: 'delivered' | 'unknown', now: number): Promise<boolean> {
    if (!Number.isSafeInteger(now) || now < 0 || !['delivered', 'unknown'].includes(outcome)) throw new Error('Invalid lifecycle receipt');
    return await this.mutateTelemetry<boolean>(owner, state => {
      const record = state.lifecycle?.records.find(item => item.event.id === eventId);
      if (!record || record.state !== 'sending' || record.claim?.token !== token) return { result: false, changed: false };
      record.state = record.claim.expiresAt <= now ? 'unknown' : outcome;
      if (record.state === 'delivered') record.completedAt = now;
      delete record.claim;
      return { result: true, changed: true };
    }) ?? false;
  }
  /** Operator-only decision. Retrying an unknown event can duplicate a prior sink effect. */
  async reconcileTelemetry(owner: LifecycleOwner, eventId: string, resolution: 'delivered' | 'retry', now: number): Promise<boolean> {
    if (!['delivered', 'retry'].includes(resolution) || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid lifecycle reconciliation');
    return await this.mutateTelemetry<boolean>(owner, state => {
      const record = state.lifecycle?.records.find(item => item.event.id === eventId);
      if (!record || record.state !== 'unknown') return { result: false, changed: false };
      record.state = resolution === 'retry' ? 'pending' : 'delivered';
      if (resolution === 'delivered') record.completedAt = now;
      return { result: true, changed: true };
    }) ?? false;
  }
  /** Explicit host maintenance; unresolved records are never discarded. */
  async pruneTelemetry(owner: LifecycleOwner, completedBefore: number, limit = 100): Promise<number> {
    if (!Number.isSafeInteger(completedBefore) || completedBefore < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid lifecycle pruning bounds');
    return await this.mutateTelemetry<number>(owner, state => {
      if (!state.lifecycle) return { result: 0, changed: false };
      let removed = 0;
      state.lifecycle.records = state.lifecycle.records.filter(record => {
        if (removed < limit && record.state === 'delivered' && record.completedAt !== undefined && record.completedAt < completedBefore) { removed++; return false; }
        return true;
      });
      return { result: removed, changed: removed > 0 };
    }) ?? 0;
  }
  configureNotifications(config: SendFnConfig): void { this.notificationUrl = notificationDestination(config); }
  private prepareNotification(state: RunState): void {
    if (!state.notificationDestination || state.notification) return;
    const run = state.run;
    const status = run.status as 'success' | 'failure' | 'cancelled';
    const id = createHash('sha256').update(JSON.stringify([this.namespace, run.id, status, 1])).digest('hex');
    const clean = (input: string) => {
      let value = input;
      for (const secret of state.secretValues.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join('***');
      return value.slice(0, 512);
    };
    let repo = run.pipelineRef.repo;
    try { const url = new URL(repo); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; repo = url.toString(); } catch { /* Non-URL repository reference. */ }
    state.notification = { id, destination: state.notificationDestination, attempts: 0, nextAttemptAt: 0, payload: {
      eventId: id, runId: run.id, status, pipelineRef: { repo: clean(repo), ref: clean(run.pipelineRef.ref), ...(run.pipelineRef.configPath ? { configPath: clean(run.pipelineRef.configPath) } : {}) },
      trigger: { type: run.trigger.type }, createdAt: run.createdAt, completedAt: run.updatedAt,
      summary: status === 'cancelled' ? `Run ${run.id}: cancellation requested; subprocess termination is tracked separately` : `Run ${run.id} ${status}: ${run.jobs.length} job(s)`,
    } };
  }
  async getNotificationState(runId: string) {
    const intent = (await this.read<RunState>('run', runId))?.notification;
    if (!intent) return undefined;
    return clone({ eventId: intent.id, attempts: intent.attempts, nextAttemptAt: intent.nextAttemptAt, deliveredAt: intent.deliveredAt, emailReceipt: intent.emailReceipt, reconciliation: intent.reconciliation });
  }
  async listNotificationRuns(cursor?: string): Promise<{ runIds: string[]; nextCursor?: string }> {
    const page = await this.page({ limit: 10, cursor }, TERMINAL);
    return { runIds: page.rows.filter(row => { const intent = this.decode<RunState>(row).notification; return intent && !intent.deliveredAt && !intent.reconciliation; }).map(row => this.decode<RunState>(row).run.id), nextCursor: page.nextCursor };
  }
  async claimNotification(runId: string, now: number, leaseMs: number): Promise<NotificationIntent | undefined> {
    return this.mutate<RunState, NotificationIntent | undefined>('run', runId, state => {
      const intent = state.notification;
      if (!intent || intent.deliveredAt || intent.reconciliation || intent.nextAttemptAt > now || (intent.lease && intent.lease.expiresAt > now)) return { result: undefined, changed: false };
      intent.attempts++; intent.lease = { token: randomUUID(), expiresAt: now + leaseMs };
      return { result: clone(intent), changed: true };
    });
  }
  async finishNotification(runId: string, eventId: string, token: string, delivered: boolean | EmailDeliveryResult, now: number): Promise<boolean> {
    return await this.mutate<RunState, boolean>('run', runId, state => {
      const intent = state.notification;
      if (!intent || intent.id !== eventId || intent.deliveredAt || intent.lease?.token !== token || intent.lease.expiresAt <= now) return { result: false, changed: false };
      if (typeof delivered === 'object' && delivered.status === 'reconciliation') {
        intent.reconciliation = { reason: delivered.reason, ...(delivered.transactionId ? { transactionId: delivered.transactionId } : {}), at: new Date(now).toISOString() };
      } else if (delivered === true || (typeof delivered === 'object' && delivered.status === 'accepted')) {
        intent.deliveredAt = new Date(now).toISOString();
        if (typeof delivered === 'object' && delivered.status === 'accepted') intent.emailReceipt = { transactionId: delivered.transactionId, status: delivered.transactionStatus };
      } else intent.nextAttemptAt = now + notificationBackoff(intent.attempts);
      delete intent.lease;
      return { result: true, changed: true };
    }) ?? false;
  }
  /** Privileged reconciliation metadata; excludes job environments and secret values. */
  async getDispatchStates(runId: string): Promise<Array<{ dispatchId: string; jobKey: string; state: DispatchIntent['state']; claim?: DispatchIntent['claim'] }>> {
    const state = await this.read<RunState>('run', runId);
    return (state?.dispatches ?? []).map(intent => ({ dispatchId: intent.id, jobKey: intent.payload.jobKey, state: intent.state, claim: intent.claim }));
  }
  async listDispatchRuns(cursor?: string): Promise<{ runIds: string[]; nextCursor?: string }> {
    const page = await this.page({ limit: 100, cursor }, ['queued', 'running']);
    return { runIds: page.rows.map(row => this.decode<RunState>(row).run.id), nextCursor: page.nextCursor };
  }
  async leaseDispatches(runId: string, now: number, leaseMs: number): Promise<DispatchDelivery[]> {
    return await this.mutate<RunState, DispatchDelivery[]>('run', runId, state => {
      if (state.dispatchProtocolVersion !== 2 || TERMINAL.includes(state.run.status)) return { result: [], changed: false };
      const result: DispatchDelivery[] = [];
      for (const intent of state.dispatches ?? []) {
        if (state.run.jobs.find(job => job.jobKey === intent.payload.jobKey)?.status !== 'pending' || intent.state !== 'ready' || intent.nextDeliveryAt > now || (intent.publication && intent.publication.expiresAt > now)) continue;
        const token = randomUUID();
        intent.publication = { token, expiresAt: now + leaseMs };
        result.push({ dispatchId: intent.id, publicationToken: token, payload: clone(intent.payload) });
      }
      return { result, changed: result.length > 0 };
    }) ?? [];
  }
  async finishPublication(runId: string, dispatchId: string, token: string, nextDeliveryAt: number): Promise<void> {
    await this.mutate<RunState, void>('run', runId, state => {
      const intent = state.dispatches?.find(value => value.id === dispatchId);
      if (!intent || intent.state !== 'ready' || intent.publication?.token !== token) return { result: undefined, changed: false };
      intent.nextDeliveryAt = nextDeliveryAt; delete intent.publication;
      return { result: undefined, changed: true };
    });
  }
  async claimDispatch(runId: string, dispatchId: string, runnerId: string, labels: string[]): Promise<JobPayload | undefined> {
    return this.mutate<RunState, JobPayload | undefined>('run', runId, state => {
      const intent = state.dispatches?.find(value => value.id === dispatchId);
      const job = intent && state.run.jobs.find(value => value.jobKey === intent.payload.jobKey);
      if (state.dispatchProtocolVersion !== 2 || TERMINAL.includes(state.run.status) || !intent || intent.state !== 'ready' || !job || job.status !== 'pending' || !labels.includes(intent.payload.jobSpec['runs-on'])) {
        return { result: undefined, changed: false };
      }
      const now = new Date().toISOString();
      const token = randomUUID();
      intent.state = 'claimed'; intent.claim = { token, runnerId, claimedAt: now, protocolVersion: 1 }; delete intent.publication;
      job.status = 'running'; job.startedAt = now; state.run.status = 'running'; state.run.updatedAt = now;
      return { result: { ...clone(intent.payload), claimToken: token }, changed: true, status: 'running' };
    });
  }
  async acknowledgeDispatch(identity: ClaimIdentity): Promise<void> {
    const changed = await this.mutate<RunState, true>('run', identity.runId, state => {
      const intent = this.boundClaim(state, identity);
      if (TERMINAL.includes(state.run.status) || intent.state !== 'claimed') throw new ClaimConflictError();
      if (intent.claim!.executionId && intent.claim!.executionId !== identity.executionId) throw new ClaimConflictError();
      if (intent.claim!.executionId) return { result: true, changed: false };
      intent.claim!.executionId = identity.executionId;
      intent.claim!.acknowledgedAt = new Date().toISOString();
      return { result: true, changed: true };
    });
    if (!changed) throw new ClaimConflictError();
  }
  async observeDispatch(identity: ClaimIdentity): Promise<{ cancelRequested: boolean; completed: boolean; stopped: boolean }> {
    const state = await this.read<RunState>('run', identity.runId);
    if (!state) throw new ClaimConflictError();
    const intent = this.boundClaim(state, identity);
    if (intent.claim!.executionId && intent.claim!.executionId !== identity.executionId) throw new ClaimConflictError();
    return { cancelRequested: state.run.status === 'cancelled' && !intent.completion, completed: !!intent.completion, stopped: !!intent.claim!.stoppedAt };
  }
  async acknowledgeCancellation(identity: ClaimIdentity): Promise<{ stopped: true }> {
    const result = await this.mutate<RunState, { stopped: true }>('run', identity.runId, state => {
      const intent = this.boundClaim(state, identity);
      if (intent.claim!.executionId && intent.claim!.executionId !== identity.executionId) throw new ClaimConflictError();
      if (state.run.status !== 'cancelled' || intent.completion) throw new ClaimConflictError();
      if (intent.claim!.stoppedAt) return { result: { stopped: true }, changed: false };
      intent.claim!.executionId = identity.executionId;
      intent.claim!.stoppedAt = new Date().toISOString();
      return { result: { stopped: true }, changed: true };
    });
    if (!result) throw new ClaimConflictError();
    return result;
  }
  private boundClaim(state: RunState, identity: ClaimIdentity): DispatchIntent {
    const intent = state.dispatches?.find(value => value.id === identity.dispatchId);
    if (state.dispatchProtocolVersion !== 2 || !intent?.claim || intent.claim.protocolVersion !== 1 || intent.claim.runnerId !== identity.runnerId || intent.claim.token !== identity.claimToken) throw new ClaimConflictError();
    return intent;
  }
  async listRunnerClaims(runnerId: string, cursor?: string) {
    const page = await this.page({ limit: 100, cursor });
    const claims: Array<{ runId: string; dispatchId: string; claimToken: string; executionId?: string; reconciliationRequired: boolean; payload?: JobPayload }> = [];
    for (const row of page.rows) {
      const state = this.decode<RunState>(row);
      for (const intent of state.dispatches ?? []) {
        if (intent.state !== 'claimed' || intent.claim?.runnerId !== runnerId) continue;
        const reconciliationRequired = state.dispatchProtocolVersion !== 2 || TERMINAL.includes(state.run.status) || intent.claim.protocolVersion !== 1;
        claims.push({ runId: state.run.id, dispatchId: intent.id, claimToken: intent.claim.token, executionId: intent.claim.executionId,
          reconciliationRequired, payload: reconciliationRequired ? undefined : { ...intent.payload, claimToken: intent.claim.token } });
      }
    }
    return { claims, nextCursor: page.nextCursor };
  }
  /** One bounded page; removes only expired log payloads, never run/artifact records. */
  async purgeExpiredLogs(cursor?: string): Promise<{ nextCursor?: string }> {
    const page = await this.page({ limit: 100, cursor });
    for (const row of page.rows) {
      const snapshot = this.decode<RunState>(row);
      if (!Object.values(snapshot.logs ?? {}).some(ledger => ledger.status !== 'expired' && Date.now() >= ledger.expiresAt)) continue;
      await this.mutate<RunState, void>('run', snapshot.run.id, state => {
        let changed = false;
        for (const ledger of Object.values(state.logs ?? {})) if (ledger.status !== 'expired' && Date.now() >= ledger.expiresAt) {
          expireLogLedger(ledger, Date.now()); changed = true;
        }
        return { result: undefined, changed };
      });
    }
    return { nextCursor: page.nextCursor };
  }
  /** One bounded run page; no log payload leaves storage until its claim commits. */
  async listStepOutputRuns(cursor?: string): Promise<{ runIds: string[]; nextCursor?: string }> {
    const page = await this.page({ limit: 10, cursor });
    return { runIds: page.rows.filter(row => Object.values(this.decode<RunState>(row).logs ?? {}).some(ledger => ledger.status !== 'expired' && ledger.eventCount > (ledger.forwarding?.delivered ?? 0))).map(row => this.decode<RunState>(row).run.id), nextCursor: page.nextCursor };
  }
  async getStepOutputStatus(runId: string, dispatchId: string): Promise<StepOutputCheckpoint | undefined> {
    return this.mutate<RunState, StepOutputCheckpoint | undefined>('run', runId, state => {
      const ledger = state.logs?.[dispatchId];
      if (!ledger) return { result: undefined, changed: false };
      const missing = !ledger.forwarding;
      const expired = ledger.status !== 'expired' && Date.now() >= ledger.expiresAt;
      if (expired) expireLogLedger(ledger, Date.now());
      return { result: clone(stepOutputCheckpoint(ledger)), changed: expired || missing };
    });
  }
  async claimStepOutput(runId: string, now: number, leaseMs: number): Promise<StepOutputDelivery | undefined> {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000 || !Number.isSafeInteger(now + leaseMs)) throw new Error('Invalid step output claim bounds');
    return this.mutate<RunState, StepOutputDelivery | undefined>('run', runId, state => {
      let changed = false;
      for (const [dispatchId, ledger] of Object.entries(state.logs ?? {})) {
        if (ledger.status === 'expired') continue;
        if (now >= ledger.expiresAt) { expireLogLedger(ledger, now); changed = true; continue; }
        const receipt = stepOutputCheckpoint(ledger);
        if (receipt.claim) {
          if (receipt.claim.state === 'sending' && receipt.claim.expiresAt <= now) { receipt.claim.state = 'unknown'; changed = true; }
          continue;
        }
        if (receipt.delivered >= ledger.eventCount) continue;
        const event = ledger.packets.flatMap(packet => packet.events)[receipt.delivered];
        const intent = state.dispatches?.find(item => item.id === dispatchId);
        if (!event || !intent) throw new Error('Step output payload requires repair');
        const eventId = stepOutputId(this.namespace, runId, dispatchId, receipt.delivered);
        const token = randomUUID(); const expiresAt = now + leaseMs;
        receipt.claim = { eventId, ordinal: receipt.delivered, token, expiresAt, state: 'sending' };
        return { result: { runId, dispatchId, jobKey: redactSecrets([intent.payload.jobKey], state.secretValues)[0], eventId, ordinal: receipt.delivered, token, claimExpiresAt: expiresAt, payloadExpiresAt: ledger.expiresAt, event: clone(event) }, changed: true };
      }
      return { result: undefined, changed };
    });
  }
  async finishStepOutput(runId: string, dispatchId: string, eventId: string, token: string, outcome: 'delivered' | 'unknown', now: number): Promise<boolean> {
    if (!Number.isSafeInteger(now) || now < 0 || !['delivered', 'unknown'].includes(outcome)) throw new Error('Invalid step output receipt');
    return await this.mutate<RunState, boolean>('run', runId, state => {
      const ledger = state.logs?.[dispatchId];
      if (!ledger) return { result: false, changed: false };
      const receipt = stepOutputCheckpoint(ledger); const claim = receipt.claim;
      if (!claim || claim.eventId !== eventId || claim.token !== token || claim.state !== 'sending') return { result: false, changed: false };
      if (now >= ledger.expiresAt) { expireLogLedger(ledger, now); return { result: true, changed: true }; }
      if (claim.expiresAt <= now || outcome === 'unknown') claim.state = 'unknown';
      else { receipt.delivered++; delete receipt.claim; }
      return { result: true, changed: true };
    }) ?? false;
  }
  /** Privileged decision; retry may duplicate an accepted sink effect and is impossible after payload expiry. */
  async reconcileStepOutput(runId: string, dispatchId: string, eventId: string, resolution: 'delivered' | 'retry' | 'undelivered', now: number): Promise<boolean> {
    if (!Number.isSafeInteger(now) || now < 0 || !['delivered', 'retry', 'undelivered'].includes(resolution)) throw new Error('Invalid step output reconciliation');
    return await this.mutate<RunState, boolean>('run', runId, state => {
      const ledger = state.logs?.[dispatchId];
      if (!ledger) return { result: false, changed: false };
      const expired = ledger.status !== 'expired' && now >= ledger.expiresAt;
      if (expired) expireLogLedger(ledger, now);
      const receipt = stepOutputCheckpoint(ledger); const claim = receipt.claim;
      if (!claim || claim.eventId !== eventId || claim.state !== 'unknown') return { result: false, changed: expired };
      if (resolution === 'retry' && ledger.status === 'expired') return { result: false, changed: expired };
      if (resolution === 'undelivered' && ledger.status !== 'expired') throw new Error('Live step output must be retried or confirmed delivered');
      if (resolution === 'delivered') receipt.delivered++;
      if (resolution === 'undelivered') receipt.expired!.undelivered++;
      delete receipt.claim;
      return { result: true, changed: true };
    }) ?? false;
  }
  async appendDispatchLogs(identity: ClaimIdentity, packet: LogPacket): Promise<{ status: LogLedger['status']; nextSequence: number; expiresAt: number }> {
    // Freeze the accepted request before the first database await.
    identity = clone(identity); packet = clone(packet);
    if (!validateLogPacket(packet)) throw new ClaimConflictError();
    const result = await this.mutate<RunState, { status: LogLedger['status']; nextSequence: number; expiresAt: number }>('run', identity.runId, state => {
      const intent = this.boundClaim(state, identity);
      if (intent.claim!.executionId !== identity.executionId) throw new ClaimConflictError();
      const ledgers = state.logs ??= {};
      const ledger = ledgers[intent.id] ??= { status: 'pending', expiresAt: Date.parse(intent.claim!.acknowledgedAt ?? intent.claim!.claimedAt) + this.logRetentionMs, bytes: 0, eventCount: 0, packets: [] };
      const receipt = () => ({ status: ledger.status, nextSequence: ledger.packets.length, expiresAt: ledger.expiresAt });
      if (Date.now() >= ledger.expiresAt) {
        expireLogLedger(ledger, Date.now());
        return { result: receipt(), changed: true };
      }
      const existing = ledger.packets[packet.sequence];
      if (existing) {
        if (existing.digest !== packet.digest) throw new ClaimConflictError();
        return { result: receipt(), changed: false };
      }
      if (ledger.status !== 'pending' || packet.sequence !== ledger.packets.length) throw new ClaimConflictError();
      if (packet.events.some(event => event.ctx.stepKey !== '__job__' && !state.run.jobs.find(job => job.jobKey === intent.payload.jobKey)?.steps.some(step => step.stepKey === event.ctx.stepKey))) throw new ClaimConflictError();
      // Reject rather than re-sign a tainted frame: replay identity must remain stable.
      if (packet.events.some(event => redactSecrets([event.msg], state.secretValues.flatMap(value => value.split(/\r\n|\r|\n/)).filter(value => !/^\*+$/.test(value)))[0] !== event.msg)) throw new ClaimConflictError();
      const bytes = Buffer.byteLength(JSON.stringify(packet.events));
      if (ledger.bytes + bytes > LOG_JOB_BYTES || ledger.eventCount + packet.events.length > LOG_MAX_EVENTS) throw new ClaimConflictError();
      ledger.packets.push(clone(packet)); ledger.bytes += bytes; ledger.eventCount += packet.events.length;
      if (packet.terminal) ledger.status = packet.terminal;
      return { result: receipt(), changed: true };
    });
    if (!result) throw new ClaimConflictError();
    return result;
  }
  async readDispatchLogs(runId: string, jobKey: string) {
    const result = await this.mutate<RunState, { lines: Array<{ line: string; timestamp: string; stepKey: string }>; transfer: { status: LogLedger['status'] | 'unavailable'; expiresAt?: number; eventCount: number } }>('run', runId, state => {
      const intent = state.dispatches?.find(value => value.payload.jobKey === jobKey);
      const ledger = intent && state.logs?.[intent.id];
      if (!ledger) {
        if (!intent?.claim?.executionId) return { result: { lines: [], transfer: { status: 'unavailable', eventCount: 0 } }, changed: false };
        const expiresAt = Date.parse(intent.claim.acknowledgedAt ?? intent.claim.claimedAt) + this.logRetentionMs;
        if (Date.now() >= expiresAt) {
          (state.logs ??= {})[intent.id] = { status: 'expired', expiresAt, bytes: 0, eventCount: 0, packets: [] };
          return { result: { lines: [], transfer: { status: 'expired', expiresAt, eventCount: 0 } }, changed: true };
        }
        return { result: { lines: [], transfer: { status: 'pending', expiresAt, eventCount: 0 } }, changed: false };
      }
      let changed = false;
      if (Date.now() >= ledger.expiresAt && ledger.status !== 'expired') {
        expireLogLedger(ledger, Date.now()); changed = true;
      }
      return { result: { lines: ledger.packets.flatMap(packet => packet.events.map(event => ({ line: event.msg, timestamp: event.ts, stepKey: event.ctx.stepKey }))), transfer: { status: ledger.status, expiresAt: ledger.expiresAt, eventCount: ledger.eventCount } }, changed };
    });
    return result ?? { lines: [], transfer: { status: 'unavailable' as const, eventCount: 0 } };
  }
  /** Acknowledgement follows the existing run-row CAS; no subprocess outcome is inferred. */
  async appendStepEvent(identity: ClaimIdentity, event: StepEvent): Promise<{ nextSequence: number }> {
    identity = clone(identity); event = clone(event);
    if (!validateStepEvent(event)) throw new ClaimConflictError();
    const result = await this.mutate<RunState, { nextSequence: number }>('run', identity.runId, state => {
      const intent = this.boundClaim(state, identity);
      if (intent.claim!.executionId !== identity.executionId) throw new ClaimConflictError();
      const events = intent.stepEvents ??= [];
      const existing = events[event.sequence];
      if (existing) {
        if (existing.digest !== event.digest) throw new ClaimConflictError();
        return { result: { nextSequence: events.length }, changed: false };
      }
      if (TERMINAL.includes(state.run.status) || intent.state !== 'claimed' || intent.completion || event.sequence !== events.length || events.length >= MAX_STEP_EVENTS) throw new ClaimConflictError();
      const job = state.run.jobs.find(job => job.jobKey === intent.payload.jobKey)!;
      const index = job.steps.findIndex(step => step.stepKey === event.stepKey);
      const step = job.steps[index];
      if (!step || job.status !== 'running' || job.steps.slice(0, index).some(prior => !['success', 'failure', 'skipped'].includes(prior.status))) throw new ClaimConflictError();
      if (step.status !== 'pending' && step.status !== 'running') throw new ClaimConflictError();
      if ((step.status === 'running' && event.status === 'running') || (step.status === 'pending' && event.status === 'success')) throw new ClaimConflictError();
      const now = new Date().toISOString();
      step.status = event.status;
      if (event.status === 'running') step.startedAt = now;
      else step.completedAt = now;
      events.push(event);
      state.run.updatedAt = now;
      return { result: { nextSequence: events.length }, changed: true };
    });
    if (!result) throw new ClaimConflictError();
    return result;
  }
  async completeDispatch(identity: ClaimIdentity, completion: JobCompletion): Promise<{ accepted: true }> {
    if (!validateCompletion(completion)) throw new ClaimConflictError();
    const canonical: JobCompletion = { status: completion.status, steps: completion.steps.map(step => ({ stepKey: step.stepKey, status: step.status })) };
    const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    const result = await this.mutate<RunState, { accepted: true }>('run', identity.runId, state => {
      const intent = this.boundClaim(state, identity);
      if (intent.claim!.executionId !== identity.executionId) throw new ClaimConflictError();
      if (intent.completion) {
        if (intent.completion.digest !== digest) throw new ClaimConflictError();
        return { result: { accepted: true }, changed: false };
      }
      if (TERMINAL.includes(state.run.status) || intent.state !== 'claimed') throw new ClaimConflictError();
      const job = state.run.jobs.find(value => value.jobKey === intent.payload.jobKey)!;
      if (canonical.steps.length !== job.steps.length || canonical.steps.some((step, index) => step.stepKey !== job.steps[index].stepKey)
        || (canonical.status === 'success' && canonical.steps.some(step => step.status === 'failure'))
        || (canonical.status === 'skipped' && canonical.steps.some(step => step.status !== 'skipped'))
        || (canonical.status === 'failure' && !canonical.steps.some(step => step.status === 'failure'))) throw new ClaimConflictError();
      if (canonical.steps.some((step, index) => ['success', 'failure', 'skipped'].includes(job.steps[index].status) && job.steps[index].status !== step.status)) throw new ClaimConflictError();
      const now = new Date().toISOString();
      canonical.steps.forEach((step, index) => { job.steps[index].status = step.status; job.steps[index].completedAt ??= now; });
      job.status = canonical.status; job.completedAt = now;
      intent.state = 'completed'; intent.completion = { digest, result: clone(canonical) };
      // Dependency outcomes and newly ready intents commit with the completion.
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const next of state.dispatches ?? []) {
          if (next.state !== 'blocked') continue;
          const needs = state.definition.pipelineSpec.jobs[next.payload.jobKey].needs ?? [];
          const dependencies = needs.map(key => state.run.jobs.find(value => value.jobKey === key)!);
          if (dependencies.some(value => value.status === 'failure' || state.dispatches?.find(item => item.payload.jobKey === value.jobKey)?.blockedByFailure)) {
            const blocked = state.run.jobs.find(value => value.jobKey === next.payload.jobKey)!;
            blocked.status = 'skipped'; blocked.completedAt = now;
            blocked.steps.forEach(step => { step.status = 'skipped'; step.completedAt = now; });
            next.state = 'completed'; next.blockedByFailure = true; progressed = true;
          } else if (dependencies.every(value => value.status === 'success' || value.status === 'skipped')) {
            next.state = 'ready'; progressed = true;
          }
        }
      }
      const done = state.run.jobs.every(value => ['success', 'failure', 'skipped'].includes(value.status));
      state.run.status = done ? (state.run.jobs.some(value => value.status === 'failure') ? 'failure' : 'success') : 'running';
      state.run.updatedAt = now;
      return { result: { accepted: true }, changed: true, status: state.run.status };
    });
    if (!result) throw new ClaimConflictError();
    return result;
  }
  async getRun(runId: string): Promise<Run | undefined> { return (await this.read<RunState>('run', runId))?.run; }

  private async page(options: ListRunsOptions, statuses?: RunStatus[]): Promise<{ rows: StateRow[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(Number.isFinite(options.limit) ? Math.trunc(options.limit!) : 20, 1), 100);
    const where: WhereClause[] = [{ field: 'namespace', operator: 'eq', value: this.namespace }, { field: 'kind', operator: 'eq', value: 'run' }];
    if (statuses) where.push({ field: 'status', operator: 'in', value: statuses });
    else if (options.status) where.push({ field: 'status', operator: 'eq', value: options.status });
    if (options.cursor) {
      const cursor = await this.database.findOne<StateRow>({ model: CIFN_STATE_TABLE, where: this.where(this.id('run', options.cursor)) });
      if (!cursor) return { rows: [] };
      this.decode<RunState>(cursor);
      // Two bounded queries express the keyset boundary without OR predicates
      // that could escape the namespace filter in an adapter.
      const tied = await this.database.findMany<StateRow>({ model: CIFN_STATE_TABLE,
        where: [...where, { field: 'createdAt', operator: 'eq', value: cursor.createdAt }, { field: 'id', operator: 'lt', value: cursor.id }],
        orderBy: [{ field: 'id', direction: 'desc' }], limit: limit + 1 });
      const older = tied.length > limit ? [] : await this.database.findMany<StateRow>({ model: CIFN_STATE_TABLE,
        where: [...where, { field: 'createdAt', operator: 'lt', value: cursor.createdAt }],
        orderBy: [{ field: 'createdAt', direction: 'desc' }, { field: 'id', direction: 'desc' }], limit: limit + 1 - tied.length });
      const rows = [...tied, ...older];
      const slice = rows.slice(0, limit);
      return { rows: slice, nextCursor: rows.length > limit ? this.decode<RunState>(slice[slice.length - 1]).run.id : undefined };
    }
    const rows = await this.database.findMany<StateRow>({ model: CIFN_STATE_TABLE, where, limit: limit + 1,
      orderBy: [{ field: 'createdAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] });
    const slice = rows.slice(0, limit);
    return { rows: slice, nextCursor: rows.length > limit ? this.decode<RunState>(slice[slice.length - 1]).run.id : undefined };
  }
  async listRuns(options: ListRunsOptions = {}): Promise<ListRunsResult> {
    const page = await this.page(options);
    return { runs: page.rows.map(row => this.decode<RunState>(row).run), nextCursor: page.nextCursor };
  }
  /** Read-only recovery inventory. Does not requeue running work or invent a lease. */
  async listRecoveryCandidates(options: Pick<ListRunsOptions, 'limit' | 'cursor'> = {}): Promise<RecoveryPage> {
    const page = await this.page(options, ['queued', 'running']);
    return { candidates: page.rows.map(row => { const value = this.decode<RunState>(row); return { run: value.run, definition: value.definition }; }), nextCursor: page.nextCursor };
  }
  setRunStatusChangeCallback(callback: (run: Run) => void): void { this.onRunStatusChange = callback; }
  async updateRunStatus(runId: string, status: RunStatus): Promise<Run | undefined> {
    const result = await this.mutate<RunState, Run | undefined>('run', runId, state => {
      if (TERMINAL.includes(state.run.status)) return { result: undefined, changed: false };
      state.run.status = status; state.run.updatedAt = new Date().toISOString();
      return { result: state.run, changed: true, status };
    });
    if (result) this.onRunStatusChange?.(clone(result));
    return result;
  }
  async cancelRun(runId: string): Promise<{ run?: Run; error?: 'NOT_FOUND' | 'ALREADY_FINISHED' }> {
    return await this.mutate<RunState, { run?: Run; error?: 'ALREADY_FINISHED' }>('run', runId, state => {
      if (TERMINAL.includes(state.run.status)) return { result: { error: 'ALREADY_FINISHED' }, changed: false };
      state.run.status = 'cancelled'; state.run.updatedAt = new Date().toISOString();
      return { result: { run: state.run }, changed: true, status: 'cancelled' };
    }) ?? { error: 'NOT_FOUND' };
  }
  async updateJobStatus(runId: string, jobKey: string, status: JobStatus, startedAt?: string, completedAt?: string): Promise<Job | undefined> {
    return this.mutate<RunState, Job | undefined>('run', runId, state => {
      const job = state.run.jobs.find(value => value.jobKey === jobKey);
      if (!job) return { result: undefined, changed: false };
      job.status = status;
      if (startedAt) job.startedAt = startedAt; if (completedAt) job.completedAt = completedAt;
      state.run.updatedAt = new Date().toISOString();
      return { result: job, changed: true };
    });
  }
  async updateStepStatus(runId: string, jobKey: string, stepKey: string, status: StepStatus, startedAt?: string, completedAt?: string): Promise<Step | undefined> {
    return this.mutate<RunState, Step | undefined>('run', runId, state => {
      const step = state.run.jobs.find(value => value.jobKey === jobKey)?.steps.find(value => value.stepKey === stepKey);
      if (!step) return { result: undefined, changed: false };
      step.status = status;
      if (startedAt) step.startedAt = startedAt; if (completedAt) step.completedAt = completedAt;
      state.run.updatedAt = new Date().toISOString();
      return { result: step, changed: true };
    });
  }
  async addArtifact(runId: string, artifact: Artifact): Promise<void> {
    const result = await this.mutate<RunState, true>('run', runId, state => { state.artifacts.push(clone(artifact)); return { result: true, changed: true }; });
    if (!result) throw new Error('Cannot add an artifact to a missing run');
  }
  async getArtifacts(runId: string): Promise<Artifact[]> { return (await this.read<RunState>('run', runId))?.artifacts ?? []; }
  async registerJobSecretValues(runId: string, jobKey: string, secretValues: string[]): Promise<void> {
    if (!secretValues.every(value => typeof value === 'string')) throw new Error('Secret redaction values must be strings');
    const result = await this.mutate<RunState, true>('run', runId, state => {
      if (!state.run.jobs.some(job => job.jobKey === jobKey)) throw new Error('Cannot register secrets for a missing job');
      state.secretValues = [...new Set([...state.secretValues, ...secretValues.filter(Boolean)])];
      return { result: true, changed: true };
    });
    if (!result) throw new Error('Cannot register secrets for a missing run');
  }
  async getSecretValues(runId: string): Promise<string[]> { return (await this.read<RunState>('run', runId))?.secretValues ?? []; }
  async createRunner(labels: string[] = [], secretHash: string): Promise<Runner> {
    const runner = { id: randomUUID(), labels: [...labels], lastSeenAt: new Date().toISOString(), secretHash };
    const lifecycle = emptyLifecycle();
    appendLifecycle(this.namespace, ['runner', runner.id], lifecycle, [{ type: 'runner.registered', timestamp: runner.lastSeenAt, runnerId: runner.id, status: 'registered' }]);
    await this.database.create({ model: CIFN_STATE_TABLE, data: this.row('runner', runner.id, 'registered', runner.lastSeenAt, { ...runner, lifecycle }) });
    return runner;
  }
  async getRunner(runnerId: string): Promise<Runner | undefined> {
    const stored = await this.read<RunnerState>('runner', runnerId);
    return stored ? { id: stored.id, labels: [...stored.labels], lastSeenAt: stored.lastSeenAt, secretHash: stored.secretHash } : undefined;
  }
  async updateRunnerLastSeen(runnerId: string): Promise<void> {
    await this.mutate<RunnerState, void>('runner', runnerId, runner => { runner.lastSeenAt = new Date().toISOString();
      appendLifecycle(this.namespace, ['runner', runnerId], runner.lifecycle ??= emptyLifecycle(), [{ type: 'runner.heartbeat', timestamp: runner.lastSeenAt, runnerId, status: 'heartbeat' }]);
      return { result: undefined, changed: true }; });
  }
}
