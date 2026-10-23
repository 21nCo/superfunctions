import { DeliveryLease } from '../../stream/delivery-lease.js';
import { boundedShutdown, shutdownTimeout, type ShutdownOptions } from '../../core/shutdown.js';
import { randomUUID, createHash } from "node:crypto";
import { mutateWorkflow, validateWorkflowMutation, type WorkflowMutation } from '../../storage/workflow-control.js';
import { sql, type SQL } from "drizzle-orm";
import type { FlowAdapter } from "../base.js";
import type { Job, QueueStats } from "../../queue/types.js";
import type {
  Message,
  MessageHandler,
  Subscription,
  StreamInfo,
  SubscribeOptions,
  ConsumerOptions,
  TrimStrategy,
} from "../../stream/types.js";
import type { WorkflowExecution } from "../../workflow/types.js";
export interface PostgresAdapterOptions {
  db: any;
  schema?: string;
  pollInterval?: number;
}
/** Drizzle PostgreSQL adapter. initialize() creates its owned tables in the chosen schema. */
export class PostgresAdapter implements FlowAdapter {
  private db: any;
  private schema: string;
  private interval: number;
  private subscriptions = new Set<Subscription>();
  private closed = false;
  constructor(options: PostgresAdapterOptions) {
    this.db = options.db;
    this.schema = options.schema ?? "public";
    this.interval = options.pollInterval ?? 100;
    if (
      this.schema.length > 63 ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.schema)
    )
      throw new Error("Invalid PostgreSQL schema");
    if (!Number.isFinite(this.interval) || this.interval < 1)
      throw new Error("pollInterval must be positive");
  }
  private table(name: string): SQL {
    return sql`${sql.identifier(this.schema)}.${sql.identifier(name)}`;
  }
  private async rows(query: SQL, db = this.db): Promise<any[]> {
    const result = await db.execute(query);
    return Array.isArray(result) ? result : (result.rows ?? []);
  }
  async initialize(): Promise<void> {
    const columns = await this.rows(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${this.schema} AND table_name='flowfn_jobs'`,
    );
    if (
      columns.length &&
      !columns.some((row) => row.column_name === "available_at")
    )
      throw new Error(
        "Legacy FlowFn PostgreSQL schema: stop workers and call migrateLegacySchema() before initialization",
      );
    if (columns.length && !columns.some(row => row.column_name === "enqueue_order"))
      throw new Error("FlowFn PostgreSQL queue ordering migration required: stop all writers and call migrateQueueOrderingSchema() before initialization");
    await this.db.execute(
      sql.raw(`CREATE SCHEMA IF NOT EXISTS "${this.schema}";
CREATE TABLE IF NOT EXISTS "${this.schema}".flowfn_jobs (queue text NOT NULL,id text NOT NULL,name text NOT NULL,state text NOT NULL,priority double precision NOT NULL DEFAULT 0,available_at bigint NOT NULL,timestamp bigint NOT NULL,finished_on bigint,data jsonb NOT NULL,enqueue_order bigserial UNIQUE NOT NULL,PRIMARY KEY(queue,id));
CREATE INDEX IF NOT EXISTS flowfn_jobs_ready ON "${this.schema}".flowfn_jobs(queue,state,available_at);
CREATE INDEX IF NOT EXISTS flowfn_jobs_claim_order ON "${this.schema}".flowfn_jobs(queue,priority DESC,(CASE WHEN COALESCE((data->'opts'->>'lifo')::boolean,false) THEN 0 ELSE 1 END),(CASE WHEN COALESCE((data->'opts'->>'lifo')::boolean,false) THEN enqueue_order END) DESC,enqueue_order ASC) WHERE state IN ('waiting','delayed');
CREATE TABLE IF NOT EXISTS "${this.schema}".flowfn_messages (id text PRIMARY KEY,stream text NOT NULL,position bigserial UNIQUE,timestamp bigint NOT NULL,data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS flowfn_messages_stream_offset ON "${this.schema}".flowfn_messages(stream,position);
CREATE TABLE IF NOT EXISTS "${this.schema}".flowfn_consumer_groups (id text PRIMARY KEY,stream text NOT NULL,group_id text NOT NULL,last_offset bigint NOT NULL);
CREATE TABLE IF NOT EXISTS "${this.schema}".flowfn_deliveries (stream text NOT NULL,group_id text NOT NULL,message_id text NOT NULL REFERENCES "${this.schema}".flowfn_messages(id) ON DELETE CASCADE,consumer_id text NOT NULL,receipt text NOT NULL,state text NOT NULL,delivered_at bigint NOT NULL,PRIMARY KEY(stream,group_id,message_id));
CREATE TABLE IF NOT EXISTS "${this.schema}".flowfn_workflow_executions (id text PRIMARY KEY,workflow_id text NOT NULL,state jsonb NOT NULL);`),
    );
  }
  /** Explicit quiesced upgrade. Historical timestamp ties receive deterministic IDs, not reconstructed insertion order. */
  async migrateQueueOrderingSchema(): Promise<void> {
    if (this.subscriptions.size) throw new Error("Stop subscriptions before migration");
    await this.db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([this.schema, "queue-order-migration"])}, 0))`);
      let columns = await this.rows(sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${this.schema} AND table_name='flowfn_jobs'`, tx);
      if (!columns.length) {
        await new PostgresAdapter({ db: tx, schema: this.schema, pollInterval: this.interval }).initialize();
        return;
      }
      await tx.execute(sql`LOCK TABLE ${this.table("flowfn_jobs")} IN ACCESS EXCLUSIVE MODE`);
      columns = await this.rows(sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${this.schema} AND table_name='flowfn_jobs'`, tx);
      if (!columns.some(row => row.column_name === "available_at")) throw new Error("Legacy FlowFn PostgreSQL schema requires migrateLegacySchema()");
      if (columns.some(row => row.column_name === "enqueue_order")) return;
      await tx.execute(sql.raw(`CREATE SEQUENCE "${this.schema}".flowfn_jobs_enqueue_order_seq AS bigint;
ALTER TABLE "${this.schema}".flowfn_jobs ADD COLUMN enqueue_order bigint;
WITH ranked AS (SELECT queue,id,row_number() OVER (ORDER BY timestamp,queue COLLATE "C",id COLLATE "C") AS position FROM "${this.schema}".flowfn_jobs)
UPDATE "${this.schema}".flowfn_jobs j SET enqueue_order=ranked.position FROM ranked WHERE j.queue=ranked.queue AND j.id=ranked.id;
SELECT setval('"${this.schema}".flowfn_jobs_enqueue_order_seq'::regclass,COALESCE(MAX(enqueue_order),1),COUNT(*)>0) FROM "${this.schema}".flowfn_jobs;
ALTER TABLE "${this.schema}".flowfn_jobs ALTER COLUMN enqueue_order SET DEFAULT nextval('"${this.schema}".flowfn_jobs_enqueue_order_seq'::regclass), ALTER COLUMN enqueue_order SET NOT NULL, ADD UNIQUE(enqueue_order);
ALTER SEQUENCE "${this.schema}".flowfn_jobs_enqueue_order_seq OWNED BY "${this.schema}".flowfn_jobs.enqueue_order;`));
    });
  }
  /** Explicit transactional upgrade retaining the old tables as *_legacy_v0 backups. Stop all workers first. */
  async migrateLegacySchema(): Promise<void> {
    if (this.subscriptions.size)
      throw new Error("Stop subscriptions before migration");
    const columns = await this.rows(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${this.schema} AND table_name='flowfn_jobs'`,
    );
    if (
      !columns.length ||
      columns.some((row) => row.column_name === "available_at")
    ) {
      await this.migrateQueueOrderingSchema();
      await this.initialize();
      return;
    }
    await this.db.transaction(async (tx: any) => {
      const names = [
        "flowfn_jobs",
        "flowfn_messages",
        "flowfn_consumer_groups",
        "flowfn_workflow_executions",
      ];
      const snapshots: Record<string, any[]> = {};
      for (const name of names) {
        const exists = await this.rows(
          sql`SELECT 1 FROM information_schema.tables WHERE table_schema=${this.schema} AND table_name=${name}`,
          tx,
        );
        if (exists.length) {
          snapshots[name] = await this.rows(
            sql`SELECT * FROM ${this.table(name)} ${name === "flowfn_jobs" ? sql`ORDER BY timestamp,queue COLLATE "C",id COLLATE "C"` : sql``}`,
            tx,
          );
          await tx.execute(
            sql`ALTER TABLE ${this.table(name)} RENAME TO ${sql.identifier(`${name}_legacy_v0`)}`,
          );
        }
      }
      const destination = new PostgresAdapter({
        db: tx,
        schema: this.schema,
        pollInterval: this.interval,
      });
      await destination.initialize();
      for (const row of snapshots.flowfn_jobs ?? []) {
        const job = {
          id: row.id,
          name: row.name,
          data: row.data,
          opts: row.opts ?? {},
          state: row.state,
          progress: row.progress ?? 0,
          returnvalue: row.return_value,
          timestamp: Number(row.timestamp),
          processedOn:
            row.processed_on === null ? undefined : Number(row.processed_on),
          finishedOn:
            row.finished_on === null ? undefined : Number(row.finished_on),
          delay: Number(row.delay ?? 0),
          attemptsMade: row.attempts_made ?? 0,
          failedReason: row.failed_reason,
          stacktrace: row.stacktrace,
        } as Job;
        await destination.enqueue(row.queue, job);
        await destination.saveJob(row.queue, job);
        await tx.execute(
          sql`UPDATE ${this.table("flowfn_jobs")} SET timestamp=${job.timestamp},available_at=${job.timestamp + job.delay} WHERE queue=${row.queue} AND id=${job.id}`,
        );
      }
      for (const row of (snapshots.flowfn_messages ?? []).sort(
        (a, b) =>
          Number(a.timestamp) - Number(b.timestamp) || a.id.localeCompare(b.id),
      ))
        await destination.publish(row.stream, {
          id: row.id,
          stream: row.stream,
          data: row.data,
          headers: row.headers,
          timestamp: Number(row.timestamp),
          partition: row.partition,
          key: row.key,
          ack: async () => {},
          nack: async () => {},
        });
      for (const row of snapshots.flowfn_workflow_executions ?? []) {
        const state = row.state?.__flowfnExecution ?? {
          id: row.id,
          workflowId: row.workflow_id,
          status: row.status,
          input: row.input,
          state: row.state,
          output: row.output,
          error: row.error,
          startedAt: Number(row.started_at),
          completedAt:
            row.completed_at === null ? undefined : Number(row.completed_at),
        };
        await destination.saveWorkflowState(row.id, state);
      }
      // Legacy groups were broadcast-only; preserve their rows in backups and replay retained messages for each group.
      for (const row of snapshots.flowfn_consumer_groups ?? [])
        await destination.ensureGroup(row.stream, row.group_id, true);
    });
  }
  async createJob(queue: string, job: Job): Promise<Job> {
    if (job.deduplicationId === undefined) {
      // The primary key arbitrates IDs without serializing unrelated producers.
      for (let attempt = 0; attempt < 3; attempt++) {
        const value = { ...job, state: job.opts.delay ? "delayed" : "waiting", delay: job.opts.delay ?? 0 };
        const inserted = await this.rows(sql`WITH clock AS MATERIALIZED (SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now) INSERT INTO ${this.table("flowfn_jobs")} (queue,id,name,state,priority,available_at,timestamp,finished_on,data) SELECT ${queue},${job.id},${job.name},${value.state},${job.opts.priority ?? 0},clock.now + ${value.delay},clock.now,NULL,${JSON.stringify(value)}::jsonb || jsonb_build_object('timestamp',clock.now) FROM clock ON CONFLICT(queue,id) DO NOTHING RETURNING data`);
        if (inserted.length) return inserted[0].data as Job;
        const existing = await this.getJob(queue, job.id);
        if (existing) return existing;
      }
      throw new Error("Concurrent job removal prevented enqueue");
    }
    return this.db.transaction(async (tx: any) => {
      // Serialize creation within a queue, including deduplication keys with different IDs.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([this.schema, queue])}, 0))`);
      const jobs = this.table("flowfn_jobs");
      const existing = await this.rows(sql`SELECT data FROM ${jobs} WHERE queue=${queue} AND (id=${job.id} ${job.deduplicationId === undefined ? sql`` : sql`OR (data->>'deduplicationId'=${job.deduplicationId} AND state NOT IN ('completed','failed'))`}) ORDER BY CASE WHEN id=${job.id} THEN 0 ELSE 1 END LIMIT 1`, tx);
      if (existing.length) return existing[0].data as Job;
      const value = { ...job, state: job.opts.delay ? "delayed" : "waiting", delay: job.opts.delay ?? 0 };
      const inserted = await this.rows(sql`WITH clock AS MATERIALIZED (SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now) INSERT INTO ${jobs} (queue,id,name,state,priority,available_at,timestamp,finished_on,data) SELECT ${queue},${job.id},${job.name},${value.state},${job.opts.priority ?? 0},clock.now + ${value.delay},clock.now,NULL,${JSON.stringify(value)}::jsonb || jsonb_build_object('timestamp',clock.now) FROM clock RETURNING data`, tx);
      return inserted[0].data as Job;
    });
  }
  async enqueue(queue: string, job: Job): Promise<string> {
    const value = {
      ...job,
      state: job.opts.delay ? "delayed" : "waiting",
      delay: job.opts.delay ?? 0,
    };
    await this.withLease(queue, job, async (tx: any) => {
    delete value.lease;
    if (job.deduplicationId !== undefined) {
      const matches = await this.rows(sql`SELECT id FROM ${this.table("flowfn_jobs")} WHERE queue=${queue} AND id<>${job.id} AND data->>'deduplicationId'=${job.deduplicationId} AND state NOT IN ('completed','failed') LIMIT 1`, tx);
      if (matches.length) throw new Error("Active job already owns deduplication key");
    }
    await tx.execute(
      sql`WITH clock AS MATERIALIZED (SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now) INSERT INTO ${this.table("flowfn_jobs")} (queue,id,name,state,priority,available_at,timestamp,finished_on,data) SELECT ${queue},${job.id},${job.name},${value.state},${job.opts.priority ?? 0},clock.now + ${value.delay},clock.now,NULL,${JSON.stringify(value)}::jsonb || jsonb_build_object('timestamp',clock.now) FROM clock ON CONFLICT(queue,id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state,priority=EXCLUDED.priority,available_at=EXCLUDED.available_at,timestamp=EXCLUDED.timestamp,enqueue_order=EXCLUDED.enqueue_order,finished_on=NULL,data=EXCLUDED.data`,
    );
    }, true);
    return job.id;
  }
  async dequeue(queue: string, name?: string, leaseDuration = 30_000): Promise<Job | null> {
    const jobs = this.table("flowfn_jobs");
    // Candidate row ownership and the lease update share one SQL statement.
    // Sample the lease clock only after the candidate has acquired its row lock.
    const rows = await this.rows(sql`WITH ready_clock AS MATERIALIZED (
        SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now
      ), candidate AS MATERIALIZED (
        SELECT j.id FROM ${jobs} j CROSS JOIN ready_clock
        WHERE j.queue=${queue} AND j.state IN ('waiting','delayed') AND j.available_at<=ready_clock.now
          ${name ? sql`AND j.name=${name}` : sql``}
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(j.data->'opts'->'waitFor','[]'::jsonb)) dependency
            WHERE NOT EXISTS (SELECT 1 FROM ${jobs} d WHERE d.queue=j.queue AND d.id=dependency AND d.state='completed'))
        ORDER BY j.priority DESC, CASE WHEN COALESCE((j.data->'opts'->>'lifo')::boolean,false) THEN 0 ELSE 1 END ASC, CASE WHEN COALESCE((j.data->'opts'->>'lifo')::boolean,false) THEN j.enqueue_order END DESC, j.enqueue_order ASC
        FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ), claim AS MATERIALIZED (
        SELECT candidate.id,floor(extract(epoch from clock_timestamp())*1000)::bigint AS now FROM candidate
      )
      UPDATE ${jobs} j SET state='active',data=j.data || jsonb_build_object('state','active','processedOn',claim.now,
        'lease',jsonb_build_object('token',${randomUUID()}::text,'expiresAt',claim.now+${leaseDuration}))
      FROM claim WHERE j.queue=${queue} AND j.id=claim.id RETURNING j.data`);
    return rows.length ? rows[0].data as Job : null;
  }
  private async databaseNow(tx: any = this.db): Promise<number> {
    const rows = await this.rows(sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now`, tx);
    return Number(rows[0].now);
  }
  private async withLease(queue: string, job: Job, action: (tx: any, current?: Job) => Promise<void>, serialize = false) {
    await this.db.transaction(async (tx: any) => {
      if (serialize) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([this.schema, queue])}, 0))`);
      const rows = await this.rows(sql`SELECT data FROM ${this.table("flowfn_jobs")} WHERE queue=${queue} AND id=${job.id} FOR UPDATE`, tx);
      const current = rows[0]?.data as Job | undefined;
      if (current?.lease ? current.lease.token !== job.lease?.token || current.lease.expiresAt <= await this.databaseNow(tx) : !!job.lease)
        throw new Error("Job lease lost");
      await action(tx, current);
    });
  }
  async saveJob(queue: string, job: Job): Promise<void> {
    const terminal = ["completed", "failed"].includes(job.state);
    const payload = sql`${JSON.stringify(job)}::jsonb - 'lease'`;
    const value = terminal ? payload : sql`(${payload}) || CASE WHEN data ? 'lease' THEN jsonb_build_object('lease',data->'lease') ELSE '{}'::jsonb END`;
    const token = job.lease?.token ?? null;
    const rows = await this.rows(sql`UPDATE ${this.table("flowfn_jobs")} SET state=${job.state},finished_on=${job.finishedOn ?? null},data=${value} WHERE queue=${queue} AND id=${job.id} AND ((NOT (data ? 'lease') AND ${token}::text IS NULL) OR (data->'lease'->>'token'=${token} AND (data->'lease'->>'expiresAt')::bigint>floor(extract(epoch from clock_timestamp())*1000)::bigint)) RETURNING id`);
    if (!rows.length) throw new Error("Job lease lost");
  }
  async renewJobLease(queue: string, id: string, token: string, duration: number): Promise<boolean> {
    const now = sql`floor(extract(epoch from clock_timestamp()) * 1000)::bigint`;
    const rows = await this.rows(sql`UPDATE ${this.table("flowfn_jobs")} SET data=jsonb_set(data,'{lease,expiresAt}',to_jsonb((${now} + ${duration})::bigint)) WHERE queue=${queue} AND id=${id} AND state='active' AND data->'lease'->>'token'=${token} AND (data->'lease'->>'expiresAt')::bigint>${now} RETURNING id`);
    return rows.length === 1;
  }
  async recoverStalledJobs(queue: string, maxStalledCount: number): Promise<Job[]> {
    return this.db.transaction(async (tx: any) => {
      const jobs = this.table("flowfn_jobs");
      const rows = await this.rows(sql`SELECT data FROM ${jobs} WHERE queue=${queue} AND state='active' AND (data->'lease'->>'expiresAt')::bigint<=${await this.databaseNow(tx)} FOR UPDATE SKIP LOCKED`, tx);
      const recovered: Job[] = [];
      for (const row of rows) {
        const job = row.data as Job;
        delete job.lease;
        job.stalledCount = (job.stalledCount ?? 0) + 1;
        job.state = job.stalledCount > maxStalledCount ? "failed" : "waiting";
        if (job.state === "failed") { job.failedReason = "Job exceeded maximum stalled count"; job.finishedOn = Date.now(); }
        await tx.execute(sql`UPDATE ${jobs} SET state=${job.state},finished_on=${job.finishedOn ?? null},data=${JSON.stringify(job)}::jsonb WHERE queue=${queue} AND id=${job.id}`);
        recovered.push(job);
      }
      return recovered;
    });
  }
  async removeJob(queue: string, id: string): Promise<void> {
    await this.db.execute(
      sql`DELETE FROM ${this.table("flowfn_jobs")} WHERE queue=${queue} AND id=${id}`,
    );
  }
  async ack(queue: string, id: string, token?: string): Promise<void> {
    const job = await this.getJob(queue, id);
    if (job && job.state !== "failed") {
      if (job.lease?.token !== token) throw new Error("Job lease lost");
      job.state = "completed";
      job.finishedOn ??= Date.now();
      await this.saveJob(queue, job);
    }
  }
  async nack(queue: string, id: string, requeue = true, token?: string): Promise<void> {
    const job = await this.getJob(queue, id);
    if (job) {
      if (job.lease?.token !== token) throw new Error("Job lease lost");
      if (requeue) { job.opts.delay = 0; await this.enqueue(queue, job); return; }
      job.state = "failed";
      if (!requeue) job.finishedOn ??= Date.now();
      await this.saveJob(queue, job);
    }
  }
  async getJob(queue: string, id: string): Promise<Job | null> {
    return (
      (
        await this.rows(
          sql`SELECT data FROM ${this.table("flowfn_jobs")} WHERE queue=${queue} AND id=${id}`,
        )
      )[0]?.data ?? null
    );
  }
  async getAllJobs(queue: string): Promise<Job[]> {
    return (
      await this.rows(
        sql`SELECT data FROM ${this.table("flowfn_jobs")} WHERE queue=${queue} ORDER BY timestamp,id`,
      )
    ).map((row) => row.data);
  }
  async getJobs(queue: string, status: string): Promise<Job[]> {
    return (
      await this.rows(
        sql`SELECT data FROM ${this.table("flowfn_jobs")} WHERE queue=${queue} AND state=${status}`,
      )
    ).map((row) => row.data);
  }
  async cleanJobs(
    queue: string,
    grace: number,
    status: string,
  ): Promise<number> {
    if (!Number.isFinite(grace) || grace < 0) throw new Error("Invalid grace");
    return (
      await this.rows(
        sql`DELETE FROM ${this.table("flowfn_jobs")} WHERE queue=${queue} AND state=${status} AND COALESCE(finished_on,timestamp)<=${Date.now() - grace} RETURNING id`,
      )
    ).length;
  }
  async getQueueStats(queue: string): Promise<QueueStats> {
    const stats: QueueStats = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    };
    for (const row of await this.rows(
      sql`SELECT state,count(*) AS count FROM ${this.table("flowfn_jobs")} WHERE queue=${queue} GROUP BY state`,
    ))
      stats[row.state as keyof QueueStats] = Number(row.count);
    return stats;
  }
  async publish(stream: string, message: Message): Promise<string> {
    if (this.closed) throw new Error("Adapter is closed");
    const payload = Object.fromEntries(
      Object.entries(message).filter(
        ([, value]) => typeof value !== "function",
      ),
    );
    await this.db.execute(
      sql`INSERT INTO ${this.table("flowfn_messages")} (id,stream,timestamp,data) VALUES (${message.id},${stream},${message.timestamp},${JSON.stringify(payload)}::jsonb)`,
    );
    return message.id;
  }
  private message(row: any): Message {
    return {
      ...row.data,
      id: row.id,
      offset: Number(row.position),
      timestamp: Number(row.timestamp),
      ack: async () => {},
      nack: async () => {},
    };
  }
  async getMessages(
    stream: string,
    start: string,
    end: string,
    count?: number,
  ): Promise<Message[]> {
    if (count !== undefined && (!Number.isInteger(count) || count < 0))
      throw new Error("Invalid count");
    if (count === 0) return [];
    const messages = this.table("flowfn_messages");
    const lower =
      start === "-" || start === "0"
        ? sql``
        : sql`AND position >= (SELECT position FROM ${messages} WHERE stream=${stream} AND id=${start})`;
    const upper =
      end === "+" || end === "z"
        ? sql``
        : sql`AND position <= (SELECT position FROM ${messages} WHERE stream=${stream} AND id=${end})`;
    return (
      await this.rows(
        sql`SELECT * FROM ${messages} WHERE stream=${stream} ${lower} ${upper} ORDER BY position ${count === undefined ? sql`` : sql`LIMIT ${count}`}`,
      )
    ).map((row) => this.message(row));
  }
  async trimStream(stream: string, strategy: TrimStrategy): Promise<number> {
    for (const value of [strategy.maxLength, strategy.maxAgeSeconds])
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new Error("Invalid retention");
    let count = 0;
    const messages = this.table("flowfn_messages");
    if (strategy.maxLength !== undefined) {
      if (!Number.isInteger(strategy.maxLength))
        throw new Error("maxLength must be integer");
      count += (
        await this.rows(
          sql`DELETE FROM ${messages} WHERE id IN (SELECT id FROM ${messages} WHERE stream=${stream} ORDER BY position DESC OFFSET ${strategy.maxLength}) RETURNING id`,
        )
      ).length;
    }
    if (strategy.maxAgeSeconds !== undefined)
      count += (
        await this.rows(
          sql`DELETE FROM ${messages} WHERE stream=${stream} AND timestamp<=${Date.now() - strategy.maxAgeSeconds * 1000} RETURNING id`,
        )
      ).length;
    return count;
  }
  private groupId(stream: string, group: string) {
    return createHash("sha256")
      .update(JSON.stringify([stream, group]))
      .digest("hex");
  }
  private async ensureGroup(
    stream: string,
    group: string,
    beginning = false,
  ): Promise<void> {
    const max = (
      await this.rows(
        sql`SELECT COALESCE(max(position),0) AS position FROM ${this.table("flowfn_messages")} WHERE stream=${stream}`,
      )
    )[0].position;
    await this.db.execute(
      sql`INSERT INTO ${this.table("flowfn_consumer_groups")} (id,stream,group_id,last_offset) VALUES (${this.groupId(stream, group)},${stream},${group},${beginning ? 0 : Number(max)}) ON CONFLICT DO NOTHING`,
    );
  }
  async createConsumerGroup(stream: string, group: string): Promise<void> {
    await this.ensureGroup(stream, group);
  }
  async getStreamInfo(stream: string): Promise<StreamInfo> {
    const length = (
      await this.rows(
        sql`SELECT count(*) AS count FROM ${this.table("flowfn_messages")} WHERE stream=${stream}`,
      )
    )[0].count;
    const groups = (
      await this.rows(
        sql`SELECT count(*) AS count FROM ${this.table("flowfn_consumer_groups")} WHERE stream=${stream}`,
      )
    )[0].count;
    const lag = (
      await this.rows(sql`SELECT
      (SELECT count(*) FROM ${this.table("flowfn_messages")} m JOIN ${this.table("flowfn_consumer_groups")} g ON g.stream=m.stream WHERE m.stream=${stream} AND m.position>g.last_offset)
      + (SELECT count(*) FROM ${this.table("flowfn_deliveries")} WHERE stream=${stream} AND state!='completed') AS lag`)
    )[0].lag;
    return {
      name: stream,
      length: Number(length),
      groups: Number(groups),
      lag: Number(lag),
    };
  }
  async subscribe(
    stream: string,
    handler: MessageHandler<any>,
    options: SubscribeOptions = {},
  ): Promise<Subscription> {
    let cursor = options.fromBeginning
        ? 0
        : Number(
            (
              await this.rows(
                sql`SELECT COALESCE(max(position),0) AS position FROM ${this.table("flowfn_messages")} WHERE stream=${stream}`,
              )
            )[0].position,
          ),
      active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    let read: Promise<any[]> | undefined;
    const poll = async () => {
      try {
        const rows = await (read = this.rows(
          sql`SELECT * FROM ${this.table("flowfn_messages")} WHERE stream=${stream} AND position>${cursor} ORDER BY position LIMIT 100`,
        ));
        for (const row of rows) {
          if (!active) return;
          await handler(this.message(row));
          cursor = Number(row.position);
        }
      } catch {
        /* Failed deliveries retain cursor for retry. */
      } finally {
        if (active) timer = setTimeout(() => void poll(), this.interval);
      }
    };
    const subscription: Subscription = {
      unsubscribe: async () => {
        active = false;
        if (timer) clearTimeout(timer);
        await read?.catch(() => undefined);
        this.subscriptions.delete(subscription);
      },
    };
    this.subscriptions.add(subscription);
    void poll();
    return subscription;
  }
  async consume(
    stream: string,
    group: string,
    consumer: string,
    handler: MessageHandler<any>,
    options: ConsumerOptions = { groupId: group },
  ): Promise<Subscription> {
    const max = options.maxInFlight ?? 1,
      lease = options.visibilityTimeout ?? 30000;
    if (
      !group ||
      !consumer ||
      !Number.isInteger(max) ||
      max < 1 ||
      !Number.isFinite(lease) ||
      lease <= 0
    )
      throw new Error("Invalid consumer options");
    if (
      options.commitInterval !== undefined &&
      (!Number.isFinite(options.commitInterval) || options.commitInterval < 0)
    )
      throw new Error("Invalid commit interval");
    await this.ensureGroup(stream, group, options.fromBeginning);
    let active = true,
      paused = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let pollTask: Promise<void> | undefined;
    const settlements = new Set<Promise<unknown>>();
    const leases = new Map<string, DeliveryLease>();
    const callbacks = new Set<string>();
    const pending = new Map<string, string>(),
      commits = new Set<ReturnType<typeof setTimeout>>();
    const deliveries = this.table("flowfn_deliveries"),
      messages = this.table("flowfn_messages"),
      groups = this.table("flowfn_consumer_groups");
    const serverNow = sql`floor(extract(epoch from clock_timestamp()) * 1000)::bigint`;
    const claim = async () => {
      const acquiredAt = performance.now();
      return this.db.transaction(async (tx: any) => {
        await this.rows(
          sql`SELECT id FROM ${groups} WHERE id=${this.groupId(stream, group)} FOR UPDATE`,
          tx,
        );
        const old = await this.rows(
          sql`SELECT d.message_id,m.* FROM ${deliveries} d JOIN ${messages} m ON m.id=d.message_id WHERE d.stream=${stream} AND d.group_id=${group} AND (d.state='waiting' OR (d.state='active' AND d.delivered_at<=${serverNow}-${lease})) ORDER BY m.position FOR UPDATE OF d SKIP LOCKED LIMIT 1`,
          tx,
        );
        let row = old[0];
        if (!row) {
          const next = await this.rows(
            sql`SELECT m.* FROM ${messages} m JOIN ${groups} g ON g.id=${this.groupId(stream, group)} WHERE m.stream=${stream} AND m.position>g.last_offset ORDER BY m.position LIMIT 1`,
            tx,
          );
          row = next[0];
          if (!row) return null;
          await tx.execute(
            sql`UPDATE ${groups} SET last_offset=${Number(row.position)} WHERE id=${this.groupId(stream, group)}`,
          );
        }
        const receipt = randomUUID();
        await tx.execute(
          sql`INSERT INTO ${deliveries} (stream,group_id,message_id,consumer_id,receipt,state,delivered_at) VALUES (${stream},${group},${row.id},${consumer},${receipt},'active',${serverNow}) ON CONFLICT(stream,group_id,message_id) DO UPDATE SET consumer_id=EXCLUDED.consumer_id,receipt=EXCLUDED.receipt,state='active',delivered_at=EXCLUDED.delivered_at`,
        );
        return { row, receipt, acquiredAt };
      });
    };
    const deliver = ({ row, receipt, acquiredAt }: { row: any; receipt: string; acquiredAt: number }) => {
      pending.set(row.id, receipt);
      callbacks.add(receipt);
      const guard = new DeliveryLease(lease, acquiredAt, async () => (await this.rows(
        sql`UPDATE ${deliveries} SET delivered_at=${serverNow} WHERE stream=${stream} AND group_id=${group} AND message_id=${row.id} AND receipt=${receipt} AND state='active' AND delivered_at>${serverNow}-${lease} RETURNING receipt`,
      )).length > 0, () => {
        if (pending.get(row.id) === receipt) pending.delete(row.id);
        leases.delete(receipt);
      });
      leases.set(receipt, guard);
      const settle = async (requeue: boolean) => {
        if (!active || pending.get(row.id) !== receipt) return;
        const task = this.rows(
          sql`UPDATE ${deliveries} SET state=${requeue ? "waiting" : "completed"} WHERE stream=${stream} AND group_id=${group} AND message_id=${row.id} AND receipt=${receipt} AND state='active' AND delivered_at>${serverNow}-${lease} RETURNING receipt`,
        );
        settlements.add(task);
        try { const changed = await task; if (changed.length) guard.stop(); else guard.abort(); leases.delete(receipt); if (pending.get(row.id) === receipt) pending.delete(row.id); }
        finally { settlements.delete(task); }
      };
      const message = {
        ...this.message(row),
        signal: guard.controller.signal,
        ack: () => settle(false),
        nack: (requeue = true) => settle(requeue),
      };
      void Promise.resolve()
        .then(() => { if (guard.controller.signal.aborted) throw new Error("Stream delivery lease lost"); return handler(message); })
        .then(
          async () => {
            if (active && options.autoCommit !== false) {
              if ((options.commitInterval ?? 0) > 0) {
                const commit = setTimeout(() => {
                  commits.delete(commit);
                  void settle(false).catch(() => undefined);
                }, options.commitInterval);
                commits.add(commit);
              } else await settle(false);
            }
          },
          async () => {
            await settle(true);
          },
        )
        .catch(() => undefined)
        .finally(() => { guard.stop(); leases.delete(receipt); callbacks.delete(receipt); });
    };
    const poll = async () => {
      try {
        while (active && !paused && new Set([...pending.values(), ...callbacks]).size < max) {
          const result = await claim();
          if (!result) break;
          if (!active || paused) {
            await this.db.execute(
              sql`UPDATE ${deliveries} SET state='waiting' WHERE stream=${stream} AND group_id=${group} AND message_id=${result.row.id} AND receipt=${result.receipt} AND state='active' AND delivered_at>${serverNow}-${lease}`,
            );
            break;
          }
          deliver(result);
        }
      } catch {
        /* Retain pending records for reconnect/recovery. */
      } finally {
        if (active) timer = setTimeout(() => { pollTask = poll(); }, this.interval);
      }
    };
    const subscription: Subscription = {
      pause: async () => {
        paused = true;
      },
      resume: async () => {
        paused = false;
      },
      unsubscribe: async () => {
        active = false;
        if (timer) clearTimeout(timer);
        for (const commit of commits) clearTimeout(commit);
        for (const guard of leases.values()) guard.abort();
        leases.clear();
        await pollTask;
        await Promise.allSettled([...settlements]);
        for (const [id, receipt] of pending)
          await this.db.execute(
            sql`UPDATE ${deliveries} SET state='waiting' WHERE stream=${stream} AND group_id=${group} AND message_id=${id} AND receipt=${receipt} AND state='active' AND delivered_at>${serverNow}-${lease}`,
          );
        pending.clear();
        this.subscriptions.delete(subscription);
      },
    };
    this.subscriptions.add(subscription);
    pollTask = poll();
    return subscription;
  }
  async mutateWorkflowState(id: string, change: WorkflowMutation): Promise<WorkflowExecution | null> {
    validateWorkflowMutation(change, id);
    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.schema}:workflow:${id}`}, 0))`);
      const rows = await this.rows(sql`SELECT state FROM ${this.table('flowfn_workflow_executions')} WHERE id=${id} FOR UPDATE`, tx);
      const clock = await this.rows(sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now`, tx);
      const next = mutateWorkflow(rows[0]?.state ?? null, change, Number(clock[0].now));
      if (next) await tx.execute(sql`INSERT INTO ${this.table('flowfn_workflow_executions')} (id,workflow_id,state) VALUES (${id},${next.workflowId},${JSON.stringify(next)}::jsonb) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state`);
      return next;
    });
  }
  async saveWorkflowState(id: string, state: WorkflowExecution): Promise<void> {
    const saved = await this.rows(
      sql`INSERT INTO ${this.table("flowfn_workflow_executions")} AS target (id,workflow_id,state) VALUES (${id},${state.workflowId},${JSON.stringify(state)}::jsonb) ON CONFLICT(id) DO UPDATE SET workflow_id=EXCLUDED.workflow_id,state=EXCLUDED.state WHERE target.state->'revision' IS NULL RETURNING id`,
    );
    if (!saved.length) throw new Error('Workflow requires a revision-checked mutation');
  }
  async loadWorkflowState(id: string): Promise<WorkflowExecution | null> {
    return (
      (
        await this.rows(
          sql`SELECT state FROM ${this.table("flowfn_workflow_executions")} WHERE id=${id}`,
        )
      )[0]?.state ?? null
    );
  }
  async cleanup(options: ShutdownOptions = {}): Promise<void> {
    const timeout = shutdownTimeout(options);
    this.closed = true;
    await boundedShutdown(Promise.all([...this.subscriptions].map(subscription => subscription.unsubscribe())), timeout, 'PostgreSQL adapter');
  }
}
