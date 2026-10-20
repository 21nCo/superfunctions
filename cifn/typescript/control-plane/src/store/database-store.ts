import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Adapter, WhereClause } from '@superfunctions/db';
import { wrapWithSchema } from '@superfunctions/db/schema';
import type { Run, RunStatus, Job, JobStatus, Step, StepStatus } from '../pipeline/types.js';
import type { Artifact, Runner, CreateRunInput, ListRunsOptions, ListRunsResult } from './memory-store.js';
import type { ControlPlaneStore } from './store.js';
import { createRunRecord } from './records.js';
import type { PreparedRun, DispatchIntent, DispatchDelivery } from '../dispatch/types.js';
import type { JobPayload } from '../queue/flowfn-client.js';
import { CIFN_STATE_TABLE, getCiFnStoreSchema } from './database-schema.js';

interface EncryptedPayload { version: 1; iv: string; tag: string; ciphertext: string }
interface StateRow {
  id: string; namespace: string; kind: 'run' | 'runner' | 'meta'; status: string;
  createdAt: string; revision: number; payload: EncryptedPayload;
}
interface RunState { run: Run; definition: CreateRunInput; artifacts: Artifact[]; secretValues: string[]; dispatches?: DispatchIntent[] }
export interface DatabaseStoreOptions {
  database: Adapter;
  /** Exactly 32 bytes supplied by the deployment. Never generated or persisted by CiFn. */
  encryptionKey: Uint8Array;
  namespace?: string;
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
  private onRunStatusChange?: (run: Run) => void;

  private constructor(options: DatabaseStoreOptions) {
    if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.byteLength !== 32) {
      throw new Error('CiFn durable storage requires an explicit 32-byte encryption key');
    }
    if (options.database.id === 'memory') throw new Error('CiFn durable storage requires a persistent database adapter');
    if (options.namespace !== undefined && (!options.namespace.trim() || options.namespace.length > 128)) {
      throw new Error('CiFn storage namespace must contain 1 to 128 characters');
    }
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
      const change = update(value);
      if (!change.changed) return change.result;
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
    const state: RunState = { run, definition, artifacts: [], secretValues: [] };
    await this.database.create({ model: CIFN_STATE_TABLE, data: this.row('run', run.id, run.status, run.createdAt, state) });
    return clone(run);
  }
  async createPreparedRun(prepared: PreparedRun): Promise<Run> {
    const definition = clone(prepared.input);
    const run = createRunRecord(definition);
    const dispatches: DispatchIntent[] = prepared.jobs.map(job => {
      const id = JSON.stringify([run.id, job.jobKey, 1]);
      return { id, payload: { ...clone(job), runId: run.id, dispatchId: id }, state: 'ready', nextDeliveryAt: 0 };
    });
    const state: RunState = { run, definition, artifacts: [], secretValues: [...prepared.secretValues], dispatches };
    await this.database.create({ model: CIFN_STATE_TABLE, data: this.row('run', run.id, run.status, run.createdAt, state) });
    return clone(run);
  }
  /** Privileged reconciliation metadata; excludes job environments and secret values. */
  async getDispatchStates(runId: string): Promise<Array<{ dispatchId: string; jobKey: string; state: 'ready' | 'claimed'; claim?: DispatchIntent['claim'] }>> {
    const state = await this.read<RunState>('run', runId);
    return (state?.dispatches ?? []).map(intent => ({ dispatchId: intent.id, jobKey: intent.payload.jobKey, state: intent.state, claim: intent.claim }));
  }
  async listDispatchRuns(cursor?: string): Promise<{ runIds: string[]; nextCursor?: string }> {
    const page = await this.page({ limit: 100, cursor }, ['queued', 'running']);
    return { runIds: page.rows.map(row => this.decode<RunState>(row).run.id), nextCursor: page.nextCursor };
  }
  async leaseDispatches(runId: string, now: number, leaseMs: number): Promise<DispatchDelivery[]> {
    return await this.mutate<RunState, DispatchDelivery[]>('run', runId, state => {
      if (TERMINAL.includes(state.run.status)) return { result: [], changed: false };
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
      if (TERMINAL.includes(state.run.status) || !intent || intent.state !== 'ready' || !job || job.status !== 'pending' || !labels.includes(intent.payload.jobSpec['runs-on'])) {
        return { result: undefined, changed: false };
      }
      const now = new Date().toISOString();
      const token = randomUUID();
      intent.state = 'claimed'; intent.claim = { token, runnerId, claimedAt: now }; delete intent.publication;
      job.status = 'running'; job.startedAt = now; state.run.status = 'running'; state.run.updatedAt = now;
      return { result: { ...clone(intent.payload), claimToken: token }, changed: true, status: 'running' };
    });
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
    await this.database.create({ model: CIFN_STATE_TABLE, data: this.row('runner', runner.id, 'registered', runner.lastSeenAt, runner) });
    return runner;
  }
  async getRunner(runnerId: string): Promise<Runner | undefined> { return this.read<Runner>('runner', runnerId); }
  async updateRunnerLastSeen(runnerId: string): Promise<void> {
    await this.mutate<Runner, void>('runner', runnerId, runner => { runner.lastSeenAt = new Date().toISOString(); return { result: undefined, changed: true }; });
  }
}
