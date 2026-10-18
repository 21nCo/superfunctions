import { randomUUID, createHash } from "node:crypto";
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
    await this.db.execute(
      sql.raw(`CREATE SCHEMA IF NOT EXISTS "${this.schema}";
CREATE TABLE IF NOT EXISTS "${this.schema}".flowfn_jobs (queue text NOT NULL,id text NOT NULL,name text NOT NULL,state text NOT NULL,priority double precision NOT NULL DEFAULT 0,available_at bigint NOT NULL,timestamp bigint NOT NULL,finished_on bigint,data jsonb NOT NULL,PRIMARY KEY(queue,id));
CREATE INDEX IF NOT EXISTS flowfn_jobs_ready ON "${this.schema}".flowfn_jobs(queue,state,available_at);
CREATE TABLE IF NOT EXISTS "${this.schema}".flowfn_messages (id text PRIMARY KEY,stream text NOT NULL,position bigserial UNIQUE,timestamp bigint NOT NULL,data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS flowfn_messages_stream_offset ON "${this.schema}".flowfn_messages(stream,position);
CREATE TABLE IF NOT EXISTS "${this.schema}".flowfn_consumer_groups (id text PRIMARY KEY,stream text NOT NULL,group_id text NOT NULL,last_offset bigint NOT NULL);
CREATE TABLE IF NOT EXISTS "${this.schema}".flowfn_deliveries (stream text NOT NULL,group_id text NOT NULL,message_id text NOT NULL REFERENCES "${this.schema}".flowfn_messages(id) ON DELETE CASCADE,consumer_id text NOT NULL,receipt text NOT NULL,state text NOT NULL,delivered_at bigint NOT NULL,PRIMARY KEY(stream,group_id,message_id));
CREATE TABLE IF NOT EXISTS "${this.schema}".flowfn_workflow_executions (id text PRIMARY KEY,workflow_id text NOT NULL,state jsonb NOT NULL);`),
    );
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
            sql`SELECT * FROM ${this.table(name)}`,
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
    return this.db.transaction(async (tx: any) => {
      // Serialize creation within a queue, including deduplication keys with different IDs.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([this.schema, queue])}, 0))`);
      const jobs = this.table("flowfn_jobs");
      const existing = await this.rows(sql`SELECT data FROM ${jobs} WHERE queue=${queue} AND (id=${job.id} ${job.deduplicationId === undefined ? sql`` : sql`OR (data->>'deduplicationId'=${job.deduplicationId} AND state NOT IN ('completed','failed'))`}) ORDER BY CASE WHEN id=${job.id} THEN 0 ELSE 1 END LIMIT 1`, tx);
      if (existing.length) return existing[0].data as Job;
      const value = { ...job, state: job.opts.delay ? "delayed" : "waiting", timestamp: Date.now(), delay: job.opts.delay ?? 0 };
      await tx.execute(sql`INSERT INTO ${jobs} (queue,id,name,state,priority,available_at,timestamp,finished_on,data) VALUES (${queue},${job.id},${job.name},${value.state},${job.opts.priority ?? 0},${value.timestamp + value.delay},${value.timestamp},NULL,${JSON.stringify(value)}::jsonb)`);
      return value as Job;
    });
  }
  async enqueue(queue: string, job: Job): Promise<string> {
    const value = {
      ...job,
      state: job.opts.delay ? "delayed" : "waiting",
      timestamp: Date.now(),
      delay: job.opts.delay ?? 0,
    };
    await this.withLease(queue, job, async (tx: any) => {
    delete value.lease;
    if (job.deduplicationId !== undefined) {
      const matches = await this.rows(sql`SELECT id FROM ${this.table("flowfn_jobs")} WHERE queue=${queue} AND id<>${job.id} AND data->>'deduplicationId'=${job.deduplicationId} AND state NOT IN ('completed','failed') LIMIT 1`, tx);
      if (matches.length) throw new Error("Active job already owns deduplication key");
    }
    await tx.execute(
      sql`INSERT INTO ${this.table("flowfn_jobs")} (queue,id,name,state,priority,available_at,timestamp,finished_on,data) VALUES (${queue},${job.id},${job.name},${value.state},${job.opts.priority ?? 0},${value.timestamp + value.delay},${value.timestamp},NULL,${JSON.stringify(value)}::jsonb) ON CONFLICT(queue,id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state,priority=EXCLUDED.priority,available_at=EXCLUDED.available_at,timestamp=EXCLUDED.timestamp,finished_on=NULL,data=EXCLUDED.data`,
    );
    }, true);
    return job.id;
  }
  async dequeue(queue: string, name?: string, leaseDuration = 30_000): Promise<Job | null> {
    return this.db.transaction(async (tx: any) => {
      const jobs = this.table("flowfn_jobs");
      const rows = await this.rows(
        sql`SELECT j.* FROM ${jobs} j WHERE j.queue=${queue} AND j.state IN ('waiting','delayed') AND j.available_at<=${Date.now()} ${name ? sql`AND j.name=${name}` : sql``} AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(j.data->'opts'->'waitFor','[]'::jsonb)) dependency WHERE NOT EXISTS (SELECT 1 FROM ${jobs} d WHERE d.queue=j.queue AND d.id=dependency AND d.state='completed')) ORDER BY j.priority DESC, CASE WHEN COALESCE((j.data->'opts'->>'lifo')::boolean,false) THEN -j.timestamp ELSE j.timestamp END ASC FOR UPDATE SKIP LOCKED LIMIT 1`,
        tx,
      );
      if (!rows.length) return null;
      const job = rows[0].data as Job;
      job.lease = { token: randomUUID(), expiresAt: await this.databaseNow(tx) + leaseDuration };
      job.state = "active";
      job.processedOn = Date.now();
      await tx.execute(
        sql`UPDATE ${jobs} SET state='active',data=${JSON.stringify(job)}::jsonb WHERE queue=${queue} AND id=${job.id}`,
      );
      return job;
    });
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
    await this.withLease(queue, job, async (tx, current) => {
      const value = { ...job, lease: ["completed", "failed"].includes(job.state) ? undefined : current?.lease };
      await tx.execute(sql`UPDATE ${this.table("flowfn_jobs")} SET state=${job.state},finished_on=${job.finishedOn ?? null},data=${JSON.stringify(value)}::jsonb WHERE queue=${queue} AND id=${job.id}`);
    });
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
    const poll = async () => {
      try {
        const rows = await this.rows(
          sql`SELECT * FROM ${this.table("flowfn_messages")} WHERE stream=${stream} AND position>${cursor} ORDER BY position LIMIT 100`,
        );
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
    const pending = new Map<string, string>(),
      commits = new Set<ReturnType<typeof setTimeout>>();
    const deliveries = this.table("flowfn_deliveries"),
      messages = this.table("flowfn_messages"),
      groups = this.table("flowfn_consumer_groups");
    const claim = async () =>
      this.db.transaction(async (tx: any) => {
        await this.rows(
          sql`SELECT id FROM ${groups} WHERE id=${this.groupId(stream, group)} FOR UPDATE`,
          tx,
        );
        const old = await this.rows(
          sql`SELECT d.message_id,m.* FROM ${deliveries} d JOIN ${messages} m ON m.id=d.message_id WHERE d.stream=${stream} AND d.group_id=${group} AND (d.state='waiting' OR (d.state='active' AND d.delivered_at<=${Date.now() - lease})) ORDER BY m.position FOR UPDATE OF d SKIP LOCKED LIMIT 1`,
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
          sql`INSERT INTO ${deliveries} (stream,group_id,message_id,consumer_id,receipt,state,delivered_at) VALUES (${stream},${group},${row.id},${consumer},${receipt},'active',${Date.now()}) ON CONFLICT(stream,group_id,message_id) DO UPDATE SET consumer_id=EXCLUDED.consumer_id,receipt=EXCLUDED.receipt,state='active',delivered_at=EXCLUDED.delivered_at`,
        );
        return { row, receipt };
      });
    const deliver = ({ row, receipt }: { row: any; receipt: string }) => {
      pending.set(row.id, receipt);
      const settle = async (requeue: boolean) => {
        if (!active || pending.get(row.id) !== receipt) return;
        await this.db.execute(
          sql`UPDATE ${deliveries} SET state=${requeue ? "waiting" : "completed"} WHERE stream=${stream} AND group_id=${group} AND message_id=${row.id} AND receipt=${receipt}`,
        );
        pending.delete(row.id);
      };
      const message = {
        ...this.message(row),
        ack: () => settle(false),
        nack: (requeue = true) => settle(requeue),
      };
      void Promise.resolve()
        .then(() => handler(message))
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
        .catch(() => undefined);
    };
    const poll = async () => {
      try {
        while (active && !paused && pending.size < max) {
          const result = await claim();
          if (!result) break;
          if (!active || paused) {
            await this.db.execute(
              sql`UPDATE ${deliveries} SET state='waiting' WHERE stream=${stream} AND group_id=${group} AND message_id=${result.row.id} AND receipt=${result.receipt}`,
            );
            break;
          }
          deliver(result);
        }
      } catch {
        /* Retain pending records for reconnect/recovery. */
      } finally {
        if (active) timer = setTimeout(() => void poll(), this.interval);
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
        for (const [id, receipt] of pending)
          await this.db.execute(
            sql`UPDATE ${deliveries} SET state='waiting' WHERE stream=${stream} AND group_id=${group} AND message_id=${id} AND receipt=${receipt}`,
          );
        pending.clear();
        this.subscriptions.delete(subscription);
      },
    };
    this.subscriptions.add(subscription);
    void poll();
    return subscription;
  }
  async saveWorkflowState(id: string, state: WorkflowExecution): Promise<void> {
    await this.db.execute(
      sql`INSERT INTO ${this.table("flowfn_workflow_executions")} (id,workflow_id,state) VALUES (${id},${state.workflowId},${JSON.stringify(state)}::jsonb) ON CONFLICT(id) DO UPDATE SET workflow_id=EXCLUDED.workflow_id,state=EXCLUDED.state`,
    );
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
  async cleanup(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.subscriptions].map((subscription) => subscription.unsubscribe()),
    );
  }
}
