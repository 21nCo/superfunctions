import { FlowAdapter } from "./base.js";
import { Job, QueueStats } from "../queue/types.js";
import {
  Message,
  MessageHandler,
  Subscription,
  StreamInfo,
} from "../stream/types.js";
import { WorkflowExecution } from "../workflow/types.js";
import Redis, { RedisOptions } from "ioredis";

export interface RedisAdapterOptions {
  connection?: Redis | RedisOptions;
  prefix?: string;
}

export class RedisAdapter implements FlowAdapter {
  private redis: Redis;
  private prefix: string;
  private subscriptions: Map<string, Redis[]> = new Map();

  constructor(options: RedisAdapterOptions = {}) {
    if (options.connection instanceof Redis) {
      this.redis = options.connection;
    } else {
      this.redis = new Redis((options.connection as RedisOptions) || {});
    }
    this.prefix = options.prefix || "flowfn:";
  }

  private key(type: string, name: string): string {
    return `${this.prefix}${type}:${name}`;
  }

  async enqueue(queueName: string, job: Job): Promise<string> {
    const queueKey = this.key("queue", queueName);
    const jobKey = this.key("job", job.id);

    // Store job data
    await this.redis.set(jobKey, JSON.stringify(job));

    if (job.opts.delay && job.opts.delay > 0) {
      const delayedKey = this.key("delayed", queueName);
      await this.redis.zadd(delayedKey, Date.now() + job.opts.delay, job.id);
    } else {
      await this.redis.lpush(queueKey, job.id);
    }

    return job.id;
  }

  async dequeue(queueName: string): Promise<Job | null> {
    const queueKey = this.key("queue", queueName);
    const delayedKey = this.key("delayed", queueName);

    // Check delayed jobs first
    const now = Date.now();
    const delayed = await this.redis.zrangebyscore(
      delayedKey,
      0,
      now,
      "LIMIT",
      0,
      1
    );
    if (delayed.length > 0) {
      const jobId = delayed[0];
      await this.redis.zrem(delayedKey, jobId);
      await this.redis.lpush(queueKey, jobId);
    }

    const jobId = await this.redis.rpop(queueKey);
    if (!jobId) return null;

    const jobData = await this.redis.get(this.key("job", jobId));
    if (!jobData) return null;

    return JSON.parse(jobData);
  }

  async ack(queue: string, jobId: string): Promise<void> {
    await this.redis.del(this.key("job", jobId));
  }

  async nack(
    queueName: string,
    jobId: string,
    requeue: boolean = true
  ): Promise<void> {
    if (requeue) {
      await this.redis.lpush(this.key("queue", queueName), jobId);
    }
  }

  async publish(streamName: string, message: Message): Promise<string> {
    const streamKey = this.key("stream", streamName);
    const id = await this.redis.xadd(
      streamKey,
      "*",
      "data",
      JSON.stringify(message.data),
      "headers",
      JSON.stringify(message.headers || {})
    );
    return id || "";
  }

  async subscribe(
    streamName: string,
    handler: MessageHandler<any>
  ): Promise<Subscription> {
    const streamKey = this.key("stream", streamName);
    let active = true;

    // Simple polling for new messages from '$' (end)
    // Real impl might use blocking XREAD but that requires a dedicated connection or careful management
    // We'll use a polling loop with XREAD for simplicity on shared connection
    let lastId = "$";

    const poll = async () => {
      if (!active) return;
      try {
        const results = (await this.redis.xread(
          "STREAMS",
          streamKey,
          lastId,
          "BLOCK",
          1000
        )) as any;
        if (results) {
          for (const [stream, messages] of results) {
            for (const [id, fields] of messages) {
              lastId = id;
              // fields is array [key1, val1, key2, val2...]
              const dataIdx = fields.indexOf("data");
              const headersIdx = fields.indexOf("headers");

              const data = dataIdx > -1 ? JSON.parse(fields[dataIdx + 1]) : {};
              const headers =
                headersIdx > -1 ? JSON.parse(fields[headersIdx + 1]) : {};

              const msg: Message = {
                id,
                stream: streamName,
                data,
                headers,
                timestamp: parseInt(id.split("-")[0]),
                ack: async () => {},
                nack: async () => {},
              };
              handler(msg).catch(console.error);
            }
          }
        }
      } catch (err) {
        console.error("Redis stream poll error", err);
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (active) setTimeout(poll, 0);
    };

    // Start polling in next tick
    setTimeout(poll, 0);

    return {
      unsubscribe: async () => {
        active = false;
      },
    };
  }

  async consume(
    streamName: string,
    group: string,
    consumer: string,
    handler: MessageHandler<any>
  ): Promise<Subscription> {
    const streamKey = this.key("stream", streamName);

    // Ensure group exists
    try {
      await this.redis.xgroup("CREATE", streamKey, group, "$", "MKSTREAM");
    } catch (e: any) {
      if (!e.message.includes("BUSYGROUP")) throw e;
    }

    let active = true;
    const poll = async () => {
      if (!active) return;
      try {
        // Read as consumer group
        const results = (await this.redis.xreadgroup(
          "GROUP",
          group,
          consumer,
          "COUNT",
          10,
          "BLOCK",
          1000,
          "STREAMS",
          streamKey,
          ">"
        )) as any;

        if (results) {
          for (const [stream, messages] of results) {
            for (const [id, fields] of messages) {
              const dataIdx = fields.indexOf("data");
              const headersIdx = fields.indexOf("headers");
              const data = dataIdx > -1 ? JSON.parse(fields[dataIdx + 1]) : {};
              const headers =
                headersIdx > -1 ? JSON.parse(fields[headersIdx + 1]) : {};

              const msg: Message = {
                id,
                stream: streamName,
                data,
                headers,
                timestamp: parseInt(id.split("-")[0]),
                ack: async () => {
                  await this.redis.xack(streamKey, group, id);
                },
                nack: async (requeue = true) => {
                  // Redis streams don't support NACK/requeue natively like AMQP.
                  // The message stays in PEL (Pending Entries List).
                  // We could claim it or just leave it for another consumer to claim.
                },
              };
              handler(msg).catch(console.error);
            }
          }
        }
      } catch (err) {
        console.error("Redis consumer poll error", err);
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (active) setTimeout(poll, 0);
    };

    setTimeout(poll, 0);

    return {
      unsubscribe: async () => {
        active = false;
      },
    };
  }

  async createConsumerGroup(stream: string, group: string): Promise<void> {
    const streamKey = this.key("stream", stream);
    try {
      await this.redis.xgroup("CREATE", streamKey, group, "$", "MKSTREAM");
    } catch (e: any) {
      if (!e.message.includes("BUSYGROUP")) throw e;
    }
  }

  async saveWorkflowState(
    workflowId: string,
    state: WorkflowExecution
  ): Promise<void> {
    await this.redis.set(
      this.key("workflow", workflowId),
      JSON.stringify(state)
    );
  }

  async loadWorkflowState(
    workflowId: string
  ): Promise<WorkflowExecution | null> {
    const data = await this.redis.get(this.key("workflow", workflowId));
    return data ? JSON.parse(data) : null;
  }

  async getJob(queue: string, jobId: string): Promise<Job | null> {
    const jobData = await this.redis.get(this.key("job", jobId));
    return jobData ? JSON.parse(jobData) : null;
  }

  async getJobs(queue: string, status: string): Promise<Job[]> {
    // Simplified implementation - would need custom tracking for status in production
    return [];
  }

  async getAllJobs(queue: string): Promise<Job[]> {
    // Simplified implementation - would need custom tracking in production
    return [];
  }

  async cleanJobs(
    queue: string,
    grace: number,
    status: string
  ): Promise<number> {
    // Simplified implementation - would need custom tracking in production
    return 0;
  }

  async getQueueStats(queueName: string): Promise<QueueStats> {
    const length = await this.redis.llen(this.key("queue", queueName));
    const delayedLength = await this.redis.zcard(
      this.key("delayed", queueName)
    );
    return {
      waiting: length,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: delayedLength,
      paused: 0,
    };
  }

  async getStreamInfo(streamName: string): Promise<StreamInfo> {
    return {
      name: streamName,
      length: 0,
      groups: 0,
    };
  }

  async cleanup(): Promise<void> {
    for (const subs of this.subscriptions.values()) {
      for (const sub of subs) {
        await sub.quit();
      }
    }
    this.subscriptions.clear();
    await this.redis.quit();
  }
}
