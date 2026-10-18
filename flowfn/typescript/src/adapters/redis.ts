import { randomUUID } from "node:crypto";
import { FlowAdapter } from "./base.js";
import { Job, QueueStats } from "../queue/types.js";
import {
  Message,
  MessageHandler,
  Subscription,
  StreamInfo,
  ConsumerOptions,
  SubscribeOptions,
  TrimStrategy,
} from "../stream/types.js";
import { WorkflowExecution } from "../workflow/types.js";
import { Redis, type RedisOptions } from "ioredis";

export interface RedisAdapterOptions {
  connection?: Redis | RedisOptions;
  prefix?: string;
}

export class RedisAdapter implements FlowAdapter {
  private redis: Redis;
  private prefix: string;
  private subscriptions = new Set<Subscription>();
  private closed = false;

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

  async createJob(queue: string, job: Job): Promise<Job> {
    const value = { ...job, timestamp: Date.now(), state: job.opts.delay ? "delayed" : "waiting", delay: job.opts.delay ?? 0 };
    const result = await this.redis.eval(`
      local proposed = cjson.decode(ARGV[1])
      local existing = redis.call('HGET', KEYS[1], proposed.id)
      if existing then return existing end
      if proposed.deduplicationId then
        local entries = redis.call('HVALS', KEYS[1])
        for _,entry in ipairs(entries) do
          local job = cjson.decode(entry)
          if job.deduplicationId == proposed.deduplicationId and job.state ~= 'completed' and job.state ~= 'failed' then return entry end
        end
      end
      redis.call('HSET', KEYS[1], proposed.id, ARGV[1])
      if proposed.delay > 0 then redis.call('ZADD', KEYS[2], proposed.timestamp + proposed.delay, proposed.id) end
      return ARGV[1]
    `, 2, this.key("jobs", queue), this.key("delayed", queue), JSON.stringify(value));
    return JSON.parse(String(result));
  }
  async enqueue(queue: string, job: Job): Promise<string> {
    const value = {
      ...job,
      timestamp: Date.now(),
      state: job.opts.delay ? "delayed" : "waiting",
      delay: job.opts.delay ?? 0,
    };
    await this.writeJob(queue, value as Job, true);
    return job.id;
  }
  async dequeue(queue: string, name?: string, leaseDuration = 30_000): Promise<Job | null> {
    const result = await this.redis.eval(
      `
      local entries = redis.call('HGETALL', KEYS[1])
      local chosen = nil
      for i=1,#entries,2 do
        local job = cjson.decode(entries[i+1])
        local ready = job.state == 'waiting' or (job.state == 'delayed' and job.timestamp + (job.delay or 0) <= tonumber(ARGV[1]))
        if ready and (ARGV[2] == '' or job.name == ARGV[2]) then
          for _,id in ipairs(job.opts.waitFor or {}) do
            local dependency = redis.call('HGET',KEYS[1],id)
            if not dependency or cjson.decode(dependency).state ~= 'completed' then ready = false end
          end
          if ready and (not chosen or (job.opts.priority or 0) > (chosen.opts.priority or 0) or ((job.opts.priority or 0) == (chosen.opts.priority or 0) and ((job.opts.lifo and job.timestamp > chosen.timestamp) or (not job.opts.lifo and job.timestamp < chosen.timestamp)))) then chosen = job end
        end
      end
      if not chosen then return nil end
      chosen.state = 'active'; chosen.processedOn = tonumber(ARGV[1]); local time = redis.call('TIME'); local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000); chosen.lease = {token=ARGV[3], expiresAt=now+tonumber(ARGV[4])}
      local encoded = cjson.encode(chosen)
      redis.call('HSET',KEYS[1],chosen.id,encoded)
      redis.call('ZREM',KEYS[2],chosen.id)
      return encoded
    `,
      2,
      this.key("jobs", queue),
      this.key("delayed", queue),
      Date.now(),
      name ?? "",
      randomUUID(),
      leaseDuration,
    );
    return result ? JSON.parse(String(result)) : null;
  }
  private async writeJob(queue: string, job: Job, enqueue = false): Promise<void> {
    const result = await this.redis.eval(`
      local time = redis.call('TIME'); local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
      local value = cjson.decode(ARGV[1])
      local raw = redis.call('HGET', KEYS[1], value.id)
      local old = raw and cjson.decode(raw) or nil
      local token = value.lease and value.lease.token
      if old and old.lease then
        if old.lease.token ~= token or old.lease.expiresAt <= now then return 0 end
      elseif token then return 0 end
      if ARGV[3] == '1' and value.deduplicationId then
        for _,entry in ipairs(redis.call('HVALS',KEYS[1])) do
          local other = cjson.decode(entry)
          if other.id ~= value.id and other.deduplicationId == value.deduplicationId and other.state ~= 'completed' and other.state ~= 'failed' then return -1 end
        end
      end
      if ARGV[3] == '1' or value.state == 'completed' or value.state == 'failed' then value.lease = nil
      elseif old and old.lease then value.lease = old.lease end
      redis.call('HSET',KEYS[1],value.id,cjson.encode(value))
      if value.state == 'delayed' then redis.call('ZADD',KEYS[2],value.timestamp + value.delay,value.id) else redis.call('ZREM',KEYS[2],value.id) end
      return 1
    `, 2, this.key("jobs", queue), this.key("delayed", queue), JSON.stringify(job), Date.now(), enqueue ? "1" : "0");
    if (Number(result) === -1) throw new Error("Active job already owns deduplication key");
    if (Number(result) !== 1) throw new Error("Job lease lost");
  }
  async saveJob(queue: string, job: Job): Promise<void> { await this.writeJob(queue, job); }
  async renewJobLease(queue: string, id: string, token: string, duration: number): Promise<boolean> {
    return Number(await this.redis.eval(`
      local time = redis.call('TIME'); local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
      local raw = redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end
      local job = cjson.decode(raw)
      if job.state ~= 'active' or not job.lease or job.lease.token ~= ARGV[2] or job.lease.expiresAt <= now then return 0 end
      job.lease.expiresAt = now + tonumber(ARGV[4])
      redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); return 1
    `, 1, this.key("jobs", queue), id, token, Date.now(), duration)) === 1;
  }
  async recoverStalledJobs(queue: string, maxStalledCount: number): Promise<Job[]> {
    const result = await this.redis.eval(`
      local time = redis.call('TIME'); local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
      local recovered = {}
      for _,raw in ipairs(redis.call('HVALS',KEYS[1])) do
        local job = cjson.decode(raw)
        if job.state == 'active' and job.lease and job.lease.expiresAt <= now then
          job.lease = nil; job.stalledCount = (job.stalledCount or 0) + 1; job.state = 'waiting'
          if job.stalledCount > tonumber(ARGV[2]) then job.state = 'failed'; job.failedReason = 'Job exceeded maximum stalled count'; job.finishedOn = tonumber(ARGV[1]) end
          redis.call('HSET',KEYS[1],job.id,cjson.encode(job)); table.insert(recovered,cjson.encode(job))
        end
      end
      return recovered
    `, 1, this.key("jobs", queue), Date.now(), maxStalledCount) as string[];
    return result.map(raw => JSON.parse(raw));
  }
  async removeJob(queue: string, id: string): Promise<void> {
    await this.redis.hdel(this.key("jobs", queue), id);
    await this.redis.zrem(this.key("delayed", queue), id);
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
      job.state = requeue ? "waiting" : "failed";
      if (!requeue) job.finishedOn ??= Date.now();
      await this.writeJob(queue, job, requeue);
    }
  }

  async publish(stream: string, message: Message): Promise<string> {
    if (this.closed) throw new Error("Adapter is closed");
    return (await this.redis.xadd(
      this.key("stream", stream),
      "*",
      "data",
      JSON.stringify(message.data),
      "headers",
      JSON.stringify(message.headers ?? {}),
      "metadata",
      JSON.stringify({
        partition: message.partition,
        key: message.key,
        timestamp: message.timestamp,
      }),
    ))!;
  }
  private message(stream: string, id: string, fields: string[]): Message {
    const values: Record<string, string> = {};
    for (let index = 0; index < fields.length; index += 2)
      values[fields[index]] = fields[index + 1];
    return {
      id,
      stream,
      data: JSON.parse(values.data),
      headers: JSON.parse(values.headers ?? "{}"),
      timestamp: Number(id.split("-")[0]),
      ...JSON.parse(values.metadata ?? "{}"),
      ack: async () => {},
      nack: async () => {},
    };
  }
  async subscribe(
    stream: string,
    handler: MessageHandler<any>,
    options: SubscribeOptions = {},
  ): Promise<Subscription> {
    const key = this.key("stream", stream);
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const latest = options.fromBeginning
      ? []
      : await this.redis.xrevrange(key, "+", "-", "COUNT", 1);
    let cursor = latest[0]?.[0] ?? "0-0";
    const poll = async () => {
      try {
        const rows = (await this.redis.xread(
          "COUNT",
          100,
          "STREAMS",
          key,
          cursor,
        )) as any;
        for (const [, messages] of rows ?? [])
          for (const [id, fields] of messages) {
            if (!active) return;
            await handler(this.message(stream, id, fields));
            cursor = id;
          }
      } catch {
        /* Retain cursor and retry failed delivery while subscribed. */
      } finally {
        if (active) timer = setTimeout(() => void poll(), 20);
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
    if (
      !group ||
      !consumer ||
      !Number.isInteger(options.maxInFlight ?? 1) ||
      (options.maxInFlight ?? 1) < 1
    )
      throw new Error("Invalid consumer configuration");
    if (
      options.commitInterval !== undefined &&
      (!Number.isFinite(options.commitInterval) || options.commitInterval < 0)
    )
      throw new Error("Invalid commitInterval");
    if (
      options.visibilityTimeout !== undefined &&
      (!Number.isFinite(options.visibilityTimeout) ||
        options.visibilityTimeout <= 0)
    )
      throw new Error("Invalid visibilityTimeout");
    const key = this.key("stream", stream),
      retryKey = this.key("retry", JSON.stringify([stream, group]));
    try {
      await this.redis.xgroup(
        "CREATE",
        key,
        group,
        options.fromBeginning ? "0" : "$",
        "MKSTREAM",
      );
    } catch (error) {
      if (!(error as Error).message.includes("BUSYGROUP")) throw error;
    }
    let active = true,
      paused = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      polling = false;
    const pending = new Map<string, symbol>(),
      commits = new Set<ReturnType<typeof setTimeout>>();
    const deliver = (id: string, fields: string[]) => {
      const token = Symbol();
      pending.set(id, token);
      const settle = async (requeue: boolean) => {
        if (!active || pending.get(id) !== token) return;
        if (requeue) {
          await this.redis.rpush(retryKey, id);
        } else {
          await this.redis.eval(
            `local p=redis.call('XPENDING',KEYS[1],ARGV[1],ARGV[2],ARGV[2],1);if #p>0 and p[1][2]==ARGV[3] then return redis.call('XACK',KEYS[1],ARGV[1],ARGV[2]) end;return 0`,
            1,
            key,
            group,
            id,
            consumer,
          );
        }
        pending.delete(id);
      };
      const message = {
        ...this.message(stream, id, fields),
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
      if (!active || polling) return;
      polling = true;
      try {
        if (!paused) {
          const room = (options.maxInFlight ?? 1) - pending.size;
          if (room > 0) {
            const retry = await this.redis.lpop(retryKey);
            if (retry) {
              const claimed = (await this.redis.xclaim(
                key,
                group,
                consumer,
                0,
                retry,
              )) as Array<[string, string[]]>;
              for (const [id, fields] of claimed) deliver(id, fields);
            } else {
              const rows = (await this.redis.xreadgroup(
                "GROUP",
                group,
                consumer,
                "COUNT",
                room,
                "STREAMS",
                key,
                ">",
              )) as any;
              for (const [, messages] of rows ?? [])
                for (const [id, fields] of messages)
                  if (active && !paused && !pending.has(id))
                    deliver(id, fields);
              if (!rows) {
                const reclaimed = (await this.redis.xautoclaim(
                  key,
                  group,
                  consumer,
                  options.visibilityTimeout ?? 30000,
                  "0-0",
                  "COUNT",
                  room,
                )) as any;
                for (const [id, fields] of reclaimed[1] ?? [])
                  if (active && !paused && !pending.has(id))
                    deliver(id, fields);
              }
            }
          }
        }
      } catch {
        /* Redis reconnects; retain ownership and retry without claiming success. */
      } finally {
        polling = false;
        if (active) timer = setTimeout(() => void poll(), 20);
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
        if (pending.size) await this.redis.rpush(retryKey, ...pending.keys());
        pending.clear();
        this.subscriptions.delete(subscription);
      },
    };
    this.subscriptions.add(subscription);
    void poll();
    return subscription;
  }
  async createConsumerGroup(stream: string, group: string): Promise<void> {
    try {
      await this.redis.xgroup(
        "CREATE",
        this.key("stream", stream),
        group,
        "$",
        "MKSTREAM",
      );
    } catch (error) {
      if (!(error as Error).message.includes("BUSYGROUP")) throw error;
    }
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
    const rows =
      count === undefined
        ? await this.redis.xrange(this.key("stream", stream), start, end)
        : await this.redis.xrange(
            this.key("stream", stream),
            start,
            end,
            "COUNT",
            count,
          );
    return rows.map(([id, fields]) => this.message(stream, id, fields));
  }
  async trimStream(stream: string, strategy: TrimStrategy): Promise<number> {
    for (const value of [strategy.maxLength, strategy.maxAgeSeconds])
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new Error("Invalid retention");
    const key = this.key("stream", stream);
    let removed = 0;
    if (strategy.maxLength !== undefined) {
      if (!Number.isInteger(strategy.maxLength))
        throw new Error("maxLength must be integer");
      removed += Number(
        await this.redis.xtrim(key, "MAXLEN", strategy.maxLength),
      );
    }
    if (strategy.maxAgeSeconds !== undefined) {
      const expired = await this.redis.xrange(
        key,
        "-",
        `${Math.max(0, Math.floor(Date.now() - strategy.maxAgeSeconds * 1000))}-18446744073709551615`,
      );
      if (expired.length)
        removed += await this.redis.xdel(key, ...expired.map((row) => row[0]));
    }
    return removed;
  }

  async saveWorkflowState(
    workflowId: string,
    state: WorkflowExecution,
  ): Promise<void> {
    await this.redis.set(
      this.key("workflow", workflowId),
      JSON.stringify(state),
    );
  }

  async loadWorkflowState(
    workflowId: string,
  ): Promise<WorkflowExecution | null> {
    const data = await this.redis.get(this.key("workflow", workflowId));
    return data ? JSON.parse(data) : null;
  }

  async getJob(queue: string, id: string): Promise<Job | null> {
    const encoded = await this.redis.hget(this.key("jobs", queue), id);
    return encoded ? JSON.parse(encoded) : null;
  }
  async getAllJobs(queue: string): Promise<Job[]> {
    return (await this.redis.hvals(this.key("jobs", queue))).map((encoded) =>
      JSON.parse(encoded),
    );
  }
  async getJobs(queue: string, status: string): Promise<Job[]> {
    return (await this.getAllJobs(queue)).filter((job) => job.state === status);
  }
  async cleanJobs(
    queue: string,
    grace: number,
    status: string,
  ): Promise<number> {
    if (!Number.isFinite(grace) || grace < 0)
      throw new Error("Grace must be nonnegative");
    const expired = (await this.getJobs(queue, status)).filter(
      (job) => Date.now() - (job.finishedOn ?? job.timestamp) >= grace,
    );
    for (const job of expired) await this.removeJob(queue, job.id);
    return expired.length;
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
    for (const job of await this.getAllJobs(queue)) stats[job.state]++;
    return stats;
  }

  async getStreamInfo(stream: string): Promise<StreamInfo> {
    const key = this.key("stream", stream);
    const length = await this.redis.xlen(key);
    let groups = 0,
      lag = 0;
    if (length || (await this.redis.exists(key))) {
      const result = (await this.redis.xinfo("GROUPS", key)) as any[];
      groups = result.length;
      for (const row of result) {
        const fields = Object.fromEntries(
          Array.from({ length: row.length / 2 }, (_, index) => [
            row[index * 2],
            row[index * 2 + 1],
          ]),
        );
        const undelivered =
          fields.lag == null
            ? (
                await this.redis.xrange(
                  key,
                  `(${fields["last-delivered-id"]}`,
                  "+",
                )
              ).length
            : Number(fields.lag);
        lag += Number(fields.pending) + undelivered;
      }
    }
    return { name: stream, length, groups, lag };
  }

  async cleanup(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.subscriptions].map((subscription) => subscription.unsubscribe()),
    );
    await this.redis.quit();
  }
}
