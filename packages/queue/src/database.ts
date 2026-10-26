import { DEFAULT_QUEUE_JOBS_TABLE, queueJobsMigrationStatements, quoteQueueTableName } from './migrations.js';
import type { QueueSqlClient, QueueSqlValue } from './sql-client.js';
import type {
  ClaimOptions,
  ClaimedJob,
  EnqueueOptions,
  EnqueueResult,
  FailOptions,
  LeaseFence,
  QueueAdapter,
  QueueJob,
  QueueJobState,
} from './types.js';
import {
  QueueError,
  normalizeEnqueueOptions,
  normalizeFailOptions,
  normalizeFence,
  normalizeJobId,
  normalizeLeaseMs,
  normalizeLimit,
  normalizeQueueName,
  readClock,
} from './validation.js';

export interface DatabaseQueueAdapterOptions {
  client: QueueSqlClient;
  /** Defaults to `queue_jobs`. */
  tableName?: string;
  /**
   * Clock in epoch milliseconds, defaults to `Date.now`. Leases are compared
   * against this clock, so processes sharing a table need synchronized clocks
   * and leases longer than their skew.
   */
  now?: () => number;
}

interface Statements {
  insert: string;
  findDeduped: string;
  claim: string;
  ack: string;
  ackFenced: string;
  retry: string;
  retryFenced: string;
  deadLetter: string;
  deadLetterFenced: string;
  extend: string;
  extendFenced: string;
  peek: string;
  size: string;
}

const LIVE_STATES = "state IN ('pending', 'leased')";
const MAX_DEDUPE_ATTEMPTS = 3;

function buildStatements(client: QueueSqlClient, table: string): Statements {
  const postgres = client.dialect === 'postgres';
  const payload = postgres ? 'payload::text AS payload' : 'payload';
  const columns = `id, queue, ${payload}, state, attempt, available_at, lease_until, dedupe_key, last_error, created_at, updated_at`;
  const leased = (fenced: boolean) => `id = ? AND state = 'leased'${fenced ? ' AND attempt = ?' : ''} RETURNING id`;

  const statements: Statements = {
    insert:
      `INSERT INTO ${table} (queue, payload, state, attempt, available_at, dedupe_key, created_at, updated_at) ` +
      `VALUES (?, ?, 'pending', 0, ?, ?, ?, ?) ` +
      `ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND ${LIVE_STATES} DO NOTHING RETURNING id`,
    findDeduped: `SELECT id FROM ${table} WHERE queue = ? AND dedupe_key = ? AND ${LIVE_STATES}`,
    // One statement: the subquery picks the next claimable job and the UPDATE
    // leases it, so two claimers can never lease the same row. Postgres skips
    // rows another transaction has locked instead of waiting on them; SQLite
    // runs the whole statement under its single writer lock.
    claim:
      `UPDATE ${table} SET state = 'leased', attempt = attempt + 1, lease_until = ?, updated_at = ? ` +
      `WHERE id = (SELECT id FROM ${table} WHERE queue = ? AND ` +
      `((state = 'pending' AND available_at <= ?) OR (state = 'leased' AND lease_until <= ?)) ` +
      `ORDER BY available_at, id LIMIT 1${postgres ? ' FOR UPDATE SKIP LOCKED' : ''}) ` +
      `RETURNING id, ${payload}, attempt`,
    ack: `DELETE FROM ${table} WHERE ${leased(false)}`,
    ackFenced: `DELETE FROM ${table} WHERE ${leased(true)}`,
    retry: `UPDATE ${table} SET state = 'pending', available_at = ?, lease_until = NULL, last_error = ?, updated_at = ? WHERE ${leased(false)}`,
    retryFenced: `UPDATE ${table} SET state = 'pending', available_at = ?, lease_until = NULL, last_error = ?, updated_at = ? WHERE ${leased(true)}`,
    deadLetter: `UPDATE ${table} SET state = 'dead', lease_until = NULL, last_error = ?, updated_at = ? WHERE ${leased(false)}`,
    deadLetterFenced: `UPDATE ${table} SET state = 'dead', lease_until = NULL, last_error = ?, updated_at = ? WHERE ${leased(true)}`,
    extend: `UPDATE ${table} SET lease_until = ?, updated_at = ? WHERE ${leased(false)}`,
    extendFenced: `UPDATE ${table} SET lease_until = ?, updated_at = ? WHERE ${leased(true)}`,
    peek: `SELECT ${columns} FROM ${table} WHERE queue = ? AND ${LIVE_STATES} ORDER BY available_at, id LIMIT ?`,
    size: `SELECT COUNT(*) AS count FROM ${table} WHERE queue = ? AND ${LIVE_STATES}`,
  };

  if (!postgres) {
    return statements;
  }
  // Every statement above is written with `?`; none contains a literal `?`.
  const numbered = {} as Statements;
  for (const [name, sql] of Object.entries(statements) as [keyof Statements, string][]) {
    let index = 0;
    numbered[name] = sql.replace(/\?/g, () => `$${++index}`);
  }
  return numbered;
}

function toNumber(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(result)) {
    throw new QueueError('FLOWFN_QUEUE_ROW_INVALID');
  }
  return result;
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

function parsePayload<TPayload>(value: unknown): TPayload {
  if (typeof value !== 'string') {
    throw new QueueError('FLOWFN_QUEUE_ROW_INVALID');
  }
  return JSON.parse(value) as TPayload;
}

function serializePayload(payload: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new QueueError('FLOWFN_QUEUE_PAYLOAD_INVALID');
  }
  if (serialized === undefined) {
    throw new QueueError('FLOWFN_QUEUE_PAYLOAD_INVALID');
  }
  return serialized;
}

/**
 * Durable queue on a SQL table, for SQLite (better-sqlite3, >= 3.35), D1 and
 * Postgres. Create the table with `migrate()` or the shipped migration files
 * before use. Payloads are stored as JSON, so they must be JSON-serializable
 * and are returned as their JSON round trip.
 */
export class DatabaseQueueAdapter<TPayload> implements QueueAdapter<TPayload> {
  private readonly client: QueueSqlClient;
  private readonly tableName: string;
  private readonly statements: Statements;
  private readonly now: () => number;

  constructor(options: DatabaseQueueAdapterOptions) {
    const dialect = options?.client?.dialect;
    if (dialect !== 'sqlite' && dialect !== 'postgres') {
      throw new QueueError('FLOWFN_QUEUE_DIALECT_INVALID');
    }
    this.client = options.client;
    this.tableName = options.tableName ?? DEFAULT_QUEUE_JOBS_TABLE;
    this.statements = buildStatements(this.client, quoteQueueTableName(this.tableName));
    this.now = options.now ?? Date.now;
  }

  /** Creates the jobs table and its indexes if they do not exist. */
  async migrate(): Promise<void> {
    for (const statement of queueJobsMigrationStatements(this.client.dialect, this.tableName)) {
      await this.client.query(statement, []);
    }
  }

  async enqueue(queueName: string, payload: TPayload, options?: EnqueueOptions): Promise<EnqueueResult> {
    const queue = normalizeQueueName(queueName);
    const { delayMs, dedupeKey } = normalizeEnqueueOptions(options);
    const serialized = serializePayload(payload);

    // A conflicting live job can be acked between the insert and the lookup;
    // the next insert then succeeds, so a few rounds always settle.
    for (let round = 0; round < MAX_DEDUPE_ATTEMPTS; round += 1) {
      const now = readClock(this.now);
      const inserted = await this.client.query(this.statements.insert, [
        queue,
        serialized,
        now + delayMs,
        dedupeKey,
        now,
        now,
      ]);
      if (inserted.length > 0) {
        return { id: String(inserted[0].id), deduplicated: false };
      }
      if (dedupeKey === null) {
        break;
      }
      const existing = await this.client.query(this.statements.findDeduped, [queue, dedupeKey]);
      if (existing.length > 0) {
        return { id: String(existing[0].id), deduplicated: true };
      }
    }
    throw new QueueError('FLOWFN_QUEUE_ENQUEUE_CONFLICT');
  }

  async claim(queueName: string, options: ClaimOptions): Promise<ClaimedJob<TPayload> | null> {
    const queue = normalizeQueueName(queueName);
    const leaseMs = normalizeLeaseMs(options?.leaseMs);
    const now = readClock(this.now);
    const rows = await this.client.query(this.statements.claim, [now + leaseMs, now, queue, now, now]);
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    return { id: String(row.id), payload: parsePayload<TPayload>(row.payload), attempt: toNumber(row.attempt) };
  }

  async ack(id: string, fence?: LeaseFence): Promise<void> {
    const jobId = normalizeJobId(id);
    const attempt = normalizeFence(fence);
    await this.requireLeasedChange(
      attempt === null ? this.statements.ack : this.statements.ackFenced,
      [],
      jobId,
      attempt
    );
  }

  async fail(id: string, options: FailOptions): Promise<void> {
    const normalized = normalizeFailOptions(options);
    const jobId = normalizeJobId(id);
    const now = readClock(this.now);
    if (normalized.kind === 'dead') {
      await this.requireLeasedChange(
        normalized.attempt === null ? this.statements.deadLetter : this.statements.deadLetterFenced,
        [normalized.reason, now],
        jobId,
        normalized.attempt
      );
      return;
    }
    await this.requireLeasedChange(
      normalized.attempt === null ? this.statements.retry : this.statements.retryFenced,
      [normalized.retryAt, normalized.reason, now],
      jobId,
      normalized.attempt
    );
  }

  async extendLease(id: string, leaseMs: number, fence?: LeaseFence): Promise<void> {
    const normalizedLeaseMs = normalizeLeaseMs(leaseMs);
    const jobId = normalizeJobId(id);
    const attempt = normalizeFence(fence);
    const now = readClock(this.now);
    await this.requireLeasedChange(
      attempt === null ? this.statements.extend : this.statements.extendFenced,
      [now + normalizedLeaseMs, now],
      jobId,
      attempt
    );
  }

  async peek(queueName: string, limit: number): Promise<QueueJob<TPayload>[]> {
    const queue = normalizeQueueName(queueName);
    const normalizedLimit = normalizeLimit(limit);
    if (normalizedLimit === 0) {
      return [];
    }
    const rows = await this.client.query(this.statements.peek, [queue, normalizedLimit]);
    return rows.map((row) => {
      const leaseUntil = toNullableNumber(row.lease_until);
      return {
        id: String(row.id),
        queue: String(row.queue),
        payload: parsePayload<TPayload>(row.payload),
        state: row.state as QueueJobState,
        attempt: toNumber(row.attempt),
        availableAt: new Date(toNumber(row.available_at)),
        leaseUntil: leaseUntil === null ? null : new Date(leaseUntil),
        dedupeKey: (row.dedupe_key as string | null) ?? null,
        lastError: (row.last_error as string | null) ?? null,
        createdAt: new Date(toNumber(row.created_at)),
        updatedAt: new Date(toNumber(row.updated_at)),
      };
    });
  }

  async size(queueName: string): Promise<number> {
    const queue = normalizeQueueName(queueName);
    const rows = await this.client.query(this.statements.size, [queue]);
    return toNumber(rows[0]?.count ?? 0);
  }

  private async requireLeasedChange(
    sql: string,
    values: QueueSqlValue[],
    jobId: number,
    attempt: number | null
  ): Promise<void> {
    const params = attempt === null ? [...values, jobId] : [...values, jobId, attempt];
    const rows = await this.client.query(sql, params);
    if (rows.length === 0) {
      throw new QueueError('FLOWFN_QUEUE_JOB_NOT_LEASED');
    }
  }
}
