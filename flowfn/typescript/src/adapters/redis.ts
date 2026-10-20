import { DeliveryLease } from '../stream/delivery-lease.js';
import { boundedShutdown, shutdownTimeout, type ShutdownOptions } from '../core/shutdown.js';
import { createHash, randomUUID } from "node:crypto";
import { validateWorkflowMutation, type WorkflowMutation } from '../storage/workflow-control.js';
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

// KEYS: jobs, delayed, ready, sequence, index-version. Migration runs once per queue.
const QUEUE_INDEX_LUA = `
  local function assignMember(job)
    if not job.queueMember then
      local sequence = redis.call('INCR', KEYS[4])
      local order = job.opts.lifo and (9007199254740991 - sequence) or sequence
      job.queueMember = (job.opts.lifo and '0:' or '1:') .. string.format('%020.0f',order) .. ':' .. job.id
    end
  end
  local function indexJob(job)
    assignMember(job)
    redis.call('ZREM',KEYS[3],job.queueMember)
    redis.call('ZREM',KEYS[2],job.id)
    if job.state == 'waiting' then redis.call('ZADD',KEYS[3],-(job.opts.priority or 0),job.queueMember)
    elseif job.state == 'delayed' then redis.call('ZADD',KEYS[2],job.timestamp + (job.delay or 0),job.id) end
  end
  if not redis.call('GET',KEYS[5]) then
    local jobs = {}
    for _,raw in ipairs(redis.call('HVALS',KEYS[1])) do table.insert(jobs,cjson.decode(raw)) end
    table.sort(jobs,function(a,b) if a.timestamp == b.timestamp then return a.id < b.id else return a.timestamp < b.timestamp end end)
    for _,job in ipairs(jobs) do indexJob(job); redis.call('HSET',KEYS[1],job.id,cjson.encode(job)) end
    redis.call('SET',KEYS[5],'1')
  end
`;

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

  private readonly scriptHashes = new Map<string, string>();

  private async executeScript(script: string, keyCount: number, ...args: Array<string | number | Buffer>): Promise<unknown> {
    let hash = this.scriptHashes.get(script);
    if (!hash) {
      hash = createHash("sha1").update(script).digest("hex");
      this.scriptHashes.set(script, hash);
    }
    try {
      return await this.redis.evalsha(hash, keyCount, ...args);
    } catch (error) {
      // Only NOSCRIPT proves the command did not execute. A transport failure
      // may follow a committed mutation and must never cause blind replay.
      if (!(error instanceof Error) || !error.message.startsWith("NOSCRIPT ")) throw error;
      return this.redis.eval(script, keyCount, ...args);
    }
  }

  private key(type: string, name: string): string {
    return `${this.prefix}${type}:${name}`;
  }

  private queueKeys(queue: string): string[] {
    return ["jobs", "delayed", "ready", "sequence", "queue-index"].map(kind => this.key(kind, queue));
  }
  async createJob(queue: string, job: Job): Promise<Job> {
    const value = { ...job, timestamp: Date.now(), state: job.opts.delay ? "delayed" : "waiting", delay: job.opts.delay ?? 0 };
    const result = await this.executeScript(`${QUEUE_INDEX_LUA}
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
      indexJob(proposed)
      local encoded = cjson.encode(proposed)
      redis.call('HSET', KEYS[1], proposed.id, encoded)
      return encoded
    `, 5, ...this.queueKeys(queue), JSON.stringify(value));
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
    const result = await this.executeScript(
      `
      ${QUEUE_INDEX_LUA}
      for _,id in ipairs(redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[1])) do
        local raw = redis.call('HGET',KEYS[1],id)
        if raw then
          local job = cjson.decode(raw)
          redis.call('ZADD',KEYS[3],-(job.opts.priority or 0),job.queueMember)
        end
        redis.call('ZREM',KEYS[2],id)
      end
      local chosen = nil
      local offset = 0
      while not chosen do
        local members = redis.call('ZRANGE',KEYS[3],offset,offset+31)
        if #members == 0 then break end
        local removed = 0
        for _,member in ipairs(members) do
          local raw = redis.call('HGET',KEYS[1],string.sub(member,24))
          if raw then
            local job = cjson.decode(raw)
            local ready = job.state == 'waiting' or job.state == 'delayed'
            if ready and (ARGV[2] == '' or job.name == ARGV[2]) then
              for _,id in ipairs(job.opts.waitFor or {}) do
                local dependency = redis.call('HGET',KEYS[1],id)
                if not dependency or cjson.decode(dependency).state ~= 'completed' then ready = false end
              end
              if ready then chosen = job; break end
            end
          else redis.call('ZREM',KEYS[3],member); removed = removed + 1 end
        end
        offset = offset + #members - removed
      end
      if not chosen then return nil end
      chosen.state = 'active'; chosen.processedOn = tonumber(ARGV[1]); local time = redis.call('TIME'); local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000); chosen.lease = {token=ARGV[3], expiresAt=now+tonumber(ARGV[4])}
      local encoded = cjson.encode(chosen)
      redis.call('HSET',KEYS[1],chosen.id,encoded)
      redis.call('ZREM',KEYS[2],chosen.id)
      redis.call('ZREM',KEYS[3],chosen.queueMember)
      return encoded
    `,
      5,
      ...this.queueKeys(queue),
      Date.now(),
      name ?? "",
      randomUUID(),
      leaseDuration,
    );
    return result ? JSON.parse(String(result)) : null;
  }
  private async writeJob(queue: string, job: Job, enqueue = false): Promise<void> {
    const result = await this.executeScript(`${QUEUE_INDEX_LUA}
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
      if old and old.queueMember then redis.call('ZREM',KEYS[3],old.queueMember) end
      if ARGV[3] == '1' then value.queueMember = nil elseif old then value.queueMember = old.queueMember end
      indexJob(value)
      redis.call('HSET',KEYS[1],value.id,cjson.encode(value))
      return 1
    `, 5, ...this.queueKeys(queue), JSON.stringify(job), Date.now(), enqueue ? "1" : "0");
    if (Number(result) === -1) throw new Error("Active job already owns deduplication key");
    if (Number(result) !== 1) throw new Error("Job lease lost");
  }
  async saveJob(queue: string, job: Job): Promise<void> { await this.writeJob(queue, job); }
  async renewJobLease(queue: string, id: string, token: string, duration: number): Promise<boolean> {
    return Number(await this.executeScript(`
      local time = redis.call('TIME'); local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
      local raw = redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end
      local job = cjson.decode(raw)
      if job.state ~= 'active' or not job.lease or job.lease.token ~= ARGV[2] or job.lease.expiresAt <= now then return 0 end
      job.lease.expiresAt = now + tonumber(ARGV[4])
      redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); return 1
    `, 1, this.key("jobs", queue), id, token, Date.now(), duration)) === 1;
  }
  async recoverStalledJobs(queue: string, maxStalledCount: number): Promise<Job[]> {
    const result = await this.executeScript(`${QUEUE_INDEX_LUA}
      local time = redis.call('TIME'); local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
      local recovered = {}
      for _,raw in ipairs(redis.call('HVALS',KEYS[1])) do
        local job = cjson.decode(raw)
        if job.state == 'active' and job.lease and job.lease.expiresAt <= now then
          job.lease = nil; job.stalledCount = (job.stalledCount or 0) + 1; job.state = 'waiting'
          if job.stalledCount > tonumber(ARGV[2]) then job.state = 'failed'; job.failedReason = 'Job exceeded maximum stalled count'; job.finishedOn = tonumber(ARGV[1]) end
          job.queueMember = nil; indexJob(job)
          redis.call('HSET',KEYS[1],job.id,cjson.encode(job)); table.insert(recovered,cjson.encode(job))
        end
      end
      return recovered
    `, 5, ...this.queueKeys(queue), Date.now(), maxStalledCount) as string[];
    return result.map(raw => JSON.parse(raw));
  }
  async removeJob(queue: string, id: string): Promise<void> {
    await this.executeScript(`
      local raw = redis.call('HGET',KEYS[1],ARGV[1])
      if raw then local job = cjson.decode(raw); if job.queueMember then redis.call('ZREM',KEYS[3],job.queueMember) end end
      redis.call('HDEL',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1]); return 1
    `, 3, this.key("jobs", queue), this.key("delayed", queue), this.key("ready", queue), id);
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
      retryKey = this.key("retry", JSON.stringify([stream, group])),
      tokenKey = this.key("delivery-tokens", JSON.stringify([stream, group]));
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
    const leases = new Map<string, DeliveryLease>();
    const callbacks = new Set<string>();
    const pending = new Map<string, string>(),
      commits = new Set<ReturnType<typeof setTimeout>>();
    const release = async (id: string, token: string, requeue: boolean) => {
      return Boolean(await this.executeScript(`
if redis.call('EXISTS',KEYS[1])==0 then redis.call('HDEL',KEYS[2],ARGV[2]); return 0 end
local p=redis.call('XPENDING',KEYS[1],ARGV[1],ARGV[2],ARGV[2],1)
if #p==0 or p[1][2]~=ARGV[3] or redis.call('HGET',KEYS[2],ARGV[2])~=ARGV[4] then return 0 end
if tonumber(p[1][3])>=tonumber(ARGV[6]) then return 0 end
redis.call('HDEL',KEYS[2],ARGV[2])
if ARGV[5]=='1' then redis.call('RPUSH',KEYS[3],ARGV[2]); return 1 end
return redis.call('XACK',KEYS[1],ARGV[1],ARGV[2])
`, 3, key, tokenKey, retryKey, group, id, consumer, token, requeue ? '1' : '0', options.visibilityTimeout ?? 30000));
    };
    const deliver = (id: string, fields: string[], token: string, acquiredAt: number) => {
      pending.set(id, token);
      callbacks.add(token);
      const lease = new DeliveryLease(options.visibilityTimeout ?? 30000, acquiredAt, async () => Boolean(await this.executeScript(`
-- flowfn renew stream delivery
if redis.call('HGET',KEYS[2],ARGV[2])~=ARGV[4] then return 0 end
local p=redis.call('XPENDING',KEYS[1],ARGV[1],ARGV[2],ARGV[2],1)
if #p==0 or p[1][2]~=ARGV[3] or tonumber(p[1][3])>=tonumber(ARGV[5]) then return 0 end
local claimed=redis.call('XCLAIM',KEYS[1],ARGV[1],ARGV[3],0,ARGV[2],'JUSTID')
return #claimed
`, 2, key, tokenKey, group, id, consumer, token, options.visibilityTimeout ?? 30000)), () => {
        if (pending.get(id) === token) pending.delete(id);
        leases.delete(token);
      });
      leases.set(token, lease);
      const settle = async (requeue: boolean) => {
        if (!active || pending.get(id) !== token) return;
        const owned = await release(id, token, requeue);
        if (owned) lease.stop(); else lease.abort();
        leases.delete(token);
        if (pending.get(id) === token) pending.delete(id);
      };
      const message = {
        ...this.message(stream, id, fields),
        signal: lease.controller.signal,
        ack: () => settle(false),
        nack: (requeue = true) => settle(requeue),
      };
      void Promise.resolve()
        .then(() => { if (lease.controller.signal.aborted) throw new Error("Stream delivery lease lost"); return handler(message); })
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
        .finally(() => { lease.stop(); leases.delete(token); callbacks.delete(token); });
    };
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        if (!paused) {
          const room = (options.maxInFlight ?? 1) - new Set([...pending.values(), ...callbacks]).size;
          if (room > 0) {
            const attempt = randomUUID();
            const acquiredAt = performance.now();
            const messages = await this.executeScript(`
local messages={}
-- A retry is claimable only after its previous token was released atomically.
for i=1,tonumber(ARGV[3]) do
  local id=redis.call('LPOP',KEYS[3]); if not id then break end
  if not redis.call('HGET',KEYS[2],id) then
    local p=redis.call('XPENDING',KEYS[1],ARGV[1],id,id,1)
    if #p>0 then
      local rows=redis.call('XCLAIM',KEYS[1],ARGV[1],ARGV[2],0,id)
      for _,row in ipairs(rows) do table.insert(messages,row) end
    end
  end
end
local room=tonumber(ARGV[3])-#messages
if room>0 then
  local reclaimed=redis.call('XAUTOCLAIM',KEYS[1],ARGV[1],ARGV[2],ARGV[4],'0-0','COUNT',room)
  for _,row in ipairs(reclaimed[2]) do table.insert(messages,row) end
  for _,id in ipairs(reclaimed[3] or {}) do redis.call('HDEL',KEYS[2],id) end
end
room=tonumber(ARGV[3])-#messages
if room>0 then
  local rows=redis.call('XREADGROUP','GROUP',ARGV[1],ARGV[2],'COUNT',room,'STREAMS',KEYS[1],'>')
  if rows then for _,row in ipairs(rows[1][2]) do table.insert(messages,row) end end
end
for _,row in ipairs(messages) do redis.call('HSET',KEYS[2],row[1],ARGV[5]..':'..row[1]) end
return messages
`, 3, key, tokenKey, retryKey, group, consumer, room, options.visibilityTimeout ?? 30000, attempt) as Array<[string, string[]]>;
            for (const [id, fields] of messages) {
              const token = `${attempt}:${id}`;
              if (active && !paused) deliver(id, fields, token, acquiredAt);
              else await release(id, token, true);
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
        for (const lease of leases.values()) lease.abort();
        leases.clear();
        await Promise.all([...pending].map(([id, token]) => release(id, token, true)));
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
      removed += Number(await this.executeScript(`
local time=redis.call('TIME')
local cutoff=math.floor(tonumber(time[1])*1000+tonumber(time[2])/1000-tonumber(ARGV[1])*1000)
if cutoff<0 then return 0 end
return redis.call('XTRIM',KEYS[1],'MINID',string.format('%.0f',cutoff+1)..'-0')
`, 1, key, strategy.maxAgeSeconds));
    }
    return removed;
  }

  async mutateWorkflowState(id: string, change: WorkflowMutation): Promise<WorkflowExecution | null> {
    validateWorkflowMutation(change, id);
    const encoded = await this.executeScript(`
local raw=redis.call('GET',KEYS[1]); local stored=raw and cjson.decode(raw) or nil
local current=stored
if stored and stored.__flowfnState then current=cjson.decode(stored.__flowfnState); current.revision=stored.revision; current.lease=stored.lease end
local change=cjson.decode(ARGV[1]); local revision=current and (current.revision or 0) or cjson.null
if revision~=change.expectedRevision then return nil end
if not current and not change.state then return nil end
if current and change.state and current.workflowId~=change.state.workflowId then return nil end
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local lease=current and current.lease
if change.acquire then
  if lease and lease.expiresAt>now then return nil end
elseif lease then
  if lease.token~=change.token or lease.expiresAt<=now then return nil end
elseif change.token then return nil end
local next={__flowfnState=ARGV[2]~='' and ARGV[2] or (stored.__flowfnState or raw)}
next.revision=(current and current.revision or 0)+1
next.lease=nil
if change.acquire or change.renew then next.lease={token=change.token,expiresAt=now+(change.acquire or change.renew)}
elseif lease and not change.release then next.lease=lease end
local output=cjson.encode(next); redis.call('SET',KEYS[1],output); return output
`, 1, this.key('workflow', id), JSON.stringify(change), change.state ? JSON.stringify(change.state) : '');
    return encoded ? this.decodeWorkflow(String(encoded)) : null;
  }
  private decodeWorkflow(encoded: string): WorkflowExecution {
    const stored = JSON.parse(encoded);
    if (!stored.__flowfnState) return stored;
    const value = JSON.parse(stored.__flowfnState);
    value.revision = stored.revision;
    delete value.lease;
    if (stored.lease) value.lease = stored.lease;
    return value;
  }
  async saveWorkflowState(
    workflowId: string,
    state: WorkflowExecution,
  ): Promise<void> {
    const saved = await this.executeScript(`local raw=redis.call('GET',KEYS[1]); if raw and cjson.decode(raw).revision then return 0 end; redis.call('SET',KEYS[1],ARGV[1]); return 1`, 1, this.key('workflow', workflowId), JSON.stringify(state));
    if (!saved) throw new Error('Workflow requires a revision-checked mutation');
  }

  async loadWorkflowState(
    workflowId: string,
  ): Promise<WorkflowExecution | null> {
    const data = await this.redis.get(this.key("workflow", workflowId));
    return data ? this.decodeWorkflow(data) : null;
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

  async cleanup(options: ShutdownOptions = {}): Promise<void> {
    const timeout = shutdownTimeout(options);
    this.closed = true;
    const work = (async () => {
      await Promise.all([...this.subscriptions].map(subscription => subscription.unsubscribe()));
      await this.redis.quit();
    })();
    try {
      await boundedShutdown(work, timeout, 'Redis adapter', () => this.redis.disconnect());
    } catch (error) {
      this.redis.disconnect();
      throw error;
    }
  }
}
