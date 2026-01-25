import { FlowAdapter } from "../base.js";
import { Job, QueueStats } from "../../queue/types.js";
import {
  Message,
  MessageHandler,
  Subscription,
  StreamInfo,
} from "../../stream/types.js";
import { WorkflowExecution } from "../../workflow/types.js";
import {
  jobs,
  messages,
  workflowExecutions,
  consumerGroups,
} from "./schema.js";
import { eq, and, lt, asc, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

export interface PostgresAdapterOptions {
  db: any; // Drizzle instance
  schema?: string;
  pollInterval?: number;
}

export class PostgresAdapter implements FlowAdapter {
  private db: any;
  private pollInterval: number;
  private activeSubscriptions: Map<string, boolean> = new Map();

  constructor(options: PostgresAdapterOptions) {
    this.db = options.db;
    this.pollInterval = options.pollInterval || 1000;
  }

  async enqueue(queueName: string, job: Job): Promise<string> {
    await this.db.insert(jobs).values({
      id: job.id,
      queue: queueName,
      name: job.name,
      data: job.data,
      opts: job.opts,
      state: job.opts.delay ? "delayed" : "waiting",
      timestamp: job.timestamp,
      delay: job.opts.delay || 0,
      priority: job.opts.priority || 0,
      attemptsMade: 0,
    });
    return job.id;
  }

  async dequeue(queueName: string): Promise<Job | null> {
    // Attempt SKIP LOCKED if supported (Postgres)
    // Drizzle doesn't have a standardized "for update skip locked" across all dialects yet in generic query builder,
    // but assuming Postgres dialect here as per name.

    // We want to find a job that is 'waiting' OR ('delayed' AND timestamp + delay <= now)
    // And mark it 'active' atomically.

    const now = Date.now();

    return await this.db.transaction(async (tx: any) => {
      // This is a raw SQL approach for Postgres SKIP LOCKED as Drizzle query builder support varies
      // Assuming 'jobs' table is 'flowfn_jobs'

      // 1. Check for delayed jobs that are ready
      // (In a real high-perf system, a background process might move delayed -> waiting)
      // For simplicity, we check both here.

      const result = await tx.execute(sql`
            UPDATE flowfn_jobs
            SET state = 'active', processed_on = ${now}
            WHERE id = (
                SELECT id
                FROM flowfn_jobs
                WHERE queue = ${queueName}
                AND (
                    state = 'waiting'
                    OR (state = 'delayed' AND (timestamp + delay) <= ${now})
                )
                ORDER BY priority DESC, timestamp ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING *
        `);

      if (result.length === 0) return null;

      const row = result[0];
      // Normalize back to Job object
      return {
        id: row.id,
        name: row.name,
        data: row.data,
        opts: row.opts,
        state: row.state,
        progress: row.progress,
        returnvalue: row.return_value,
        timestamp: Number(row.timestamp),
        processedOn: Number(row.processed_on),
        finishedOn: Number(row.finished_on),
        delay: Number(row.delay),
        attemptsMade: row.attempts_made,
        failedReason: row.failed_reason,
        stacktrace: row.stacktrace,
        // Re-bind methods in queue implementation
      } as unknown as Job;
    });
  }

  async ack(queue: string, jobId: string): Promise<void> {
    // Usually mark as completed or delete.
    // If removeOnComplete, delete.
    // For now, mark completed.
    await this.db
      .update(jobs)
      .set({ state: "completed", finishedOn: Date.now() })
      .where(eq(jobs.id, jobId));
  }

  async nack(
    queue: string,
    jobId: string,
    requeue: boolean = true
  ): Promise<void> {
    if (requeue) {
      await this.db
        .update(jobs)
        .set({ state: "waiting", processedOn: null }) // Reset for retry
        .where(eq(jobs.id, jobId));
    } else {
      // Leave as active? Or failed?
    }
  }

  async publish(streamName: string, message: Message): Promise<string> {
    await this.db.insert(messages).values({
      id: message.id,
      stream: streamName,
      data: message.data,
      headers: message.headers,
      timestamp: message.timestamp,
      partition: message.partition,
      key: message.key,
    });
    return message.id;
  }

  async subscribe(
    streamName: string,
    handler: MessageHandler<any>
  ): Promise<Subscription> {
    // Polling implementation for streams
    // Real postgres could use LISTEN/NOTIFY

    const subId = uuidv4();
    this.activeSubscriptions.set(subId, true);

    let lastTimestamp = Date.now(); // Start from now

    const poll = async () => {
      if (!this.activeSubscriptions.get(subId)) return;

      try {
        const msgs = await this.db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.stream, streamName),
              sql`${messages.timestamp} > ${lastTimestamp}`
            )
          )
          .orderBy(asc(messages.timestamp))
          .limit(100);

        for (const row of msgs) {
          lastTimestamp = Math.max(lastTimestamp, Number(row.timestamp));

          const msg: Message = {
            id: row.id,
            stream: row.stream,
            data: row.data,
            headers: row.headers as any,
            timestamp: Number(row.timestamp),
            ack: async () => {},
            nack: async () => {},
          };
          handler(msg).catch(console.error);
        }
      } catch (e) {
        console.error("Postgres stream poll error", e);
      }

      if (this.activeSubscriptions.get(subId)) {
        setTimeout(poll, this.pollInterval);
      }
    };

    setTimeout(poll, 0);

    return {
      unsubscribe: async () => {
        this.activeSubscriptions.set(subId, false);
      },
    };
  }

  async createConsumerGroup(stream: string, group: string): Promise<void> {
    // Manage in DB
  }

  async saveWorkflowState(
    workflowId: string,
    state: WorkflowExecution
  ): Promise<void> {
    // Upsert execution
    await this.db
      .insert(workflowExecutions)
      .values({
        id: state.id,
        workflowId: state.workflowId,
        status: state.status,
        input: state.input,
        output: state.output,
        error:
          state.error instanceof Error
            ? state.error.message
            : String(state.error),
        startedAt: state.startedAt,
        completedAt: state.completedAt,
      })
      .onConflictDoUpdate({
        target: workflowExecutions.id,
        set: {
          status: state.status,
          output: state.output,
          error:
            state.error instanceof Error
              ? state.error.message
              : String(state.error),
          updatedAt: Date.now(),
          completedAt: state.completedAt,
        },
      });
  }

  async loadWorkflowState(
    executionId: string
  ): Promise<WorkflowExecution | null> {
    const rows = await this.db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId));
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      workflowId: row.workflowId,
      status: row.status as any, // Cast from DB string to union type
      input: row.input,
      output: row.output,
      error: row.error,
      startedAt: Number(row.startedAt),
      completedAt: row.completedAt ? Number(row.completedAt) : undefined,
    };
  }

  async getJob(queue: string, jobId: string): Promise<Job | null> {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.queue, queue), eq(jobs.id, jobId)));
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      data: row.data,
      opts: row.opts,
      state: row.state,
      timestamp: Number(row.timestamp),
      attemptsMade: row.attempts_made,
    } as any;
  }

  async getQueueStats(queueName: string): Promise<QueueStats> {
    const counts = await this.db
      .select({
        state: jobs.state,
        count: sql<number>`count(*)`,
      })
      .from(jobs)
      .where(eq(jobs.queue, queueName))
      .groupBy(jobs.state);

    const stats: QueueStats = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    };
    for (const c of counts) {
      if (c.state in stats) {
        (stats as any)[c.state] = Number(c.count);
      }
    }
    return stats;
  }

  async getStreamInfo(streamName: string): Promise<StreamInfo> {
    return { name: streamName, length: 0, groups: 0 };
  }

  async consume(
    stream: string,
    group: string,
    consumer: string,
    handler: MessageHandler<any>
  ): Promise<Subscription> {
    // Simplified consumer group implementation
    return this.subscribe(stream, handler);
  }

  async getJobs(queue: string, status: string): Promise<Job[]> {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.queue, queue), eq(jobs.state, status)));
    return rows.map(
      (row: any) =>
        ({
          id: row.id,
          name: row.name,
          data: row.data,
          opts: row.opts,
          state: row.state,
          timestamp: Number(row.timestamp),
          attemptsMade: row.attempts_made,
        }) as any
    );
  }

  async getAllJobs(queue: string): Promise<Job[]> {
    const rows = await this.db.select().from(jobs).where(eq(jobs.queue, queue));
    return rows.map(
      (row: any) =>
        ({
          id: row.id,
          name: row.name,
          data: row.data,
          opts: row.opts,
          state: row.state,
          timestamp: Number(row.timestamp),
          attemptsMade: row.attempts_made,
        }) as any
    );
  }

  async cleanJobs(
    queue: string,
    grace: number,
    status: string
  ): Promise<number> {
    const now = Date.now();
    const result = await this.db
      .delete(jobs)
      .where(
        and(
          eq(jobs.queue, queue),
          eq(jobs.state, status),
          sql`${jobs.finishedOn} < ${now - grace}`
        )
      );
    return result.rowCount || 0;
  }

  async cleanup(): Promise<void> {
    this.activeSubscriptions.clear();
  }
}
