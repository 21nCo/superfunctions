import type {
  Queue,
  Job,
  JobOptions,
  QueueOptions,
  JobHandler,
  BatchHandler,
  BatchOptions,
  QueueStats,
  JobStatus,
} from "./types.js";
import type { FlowAdapter } from "../adapters/base.js";
import { JobImpl, snapshotJob } from "./job.js";
import EventEmitter from "eventemitter3";
import { calculateBackoff, validateBackoff } from "../patterns/backoff.js";
import { MemoryDLQManager } from "./dlq.js";
import { RateLimiter } from "../patterns/rate-limit.js";
export class QueueImpl<T = any> extends EventEmitter implements Queue<T> {
  private paused = false;
  private closed = false;
  private workers = new Set<Promise<void>>();
  private inFlight = 0;
  private wakes = new Set<() => void>();
  private controllers = new Set<AbortController>();
  private workerErrors: unknown[] = [];
  private dlq?: MemoryDLQManager;
  private limiter?: RateLimiter;
  private cache = new Map<string, { value: any; expires: number }>();
  private additions: Promise<unknown> = Promise.resolve();
  constructor(
    public name: string,
    private adapter: FlowAdapter,
    private options: QueueOptions = {},
  ) {
    super();
    if (options.dlq?.enabled) this.dlq = new MemoryDLQManager(options.dlq);
    if (options.limiter) {
      if (
        !Number.isInteger(options.limiter.max) ||
        options.limiter.max < 1 ||
        !Number.isFinite(options.limiter.duration) ||
        options.limiter.duration <= 0
      )
        throw new Error("Invalid queue limiter");
      this.limiter = new RateLimiter({
        limit: options.limiter.max,
        window: options.limiter.duration,
      });
    }
    if (
      options.cache?.enabled &&
      (!Number.isFinite(options.cache.ttl) || options.cache.ttl < 0)
    )
      throw new Error("Invalid cache ttl");
  }
  private open() {
    if (this.closed) throw new Error("Queue is closed");
  }
  private async sleep(ms = 20) {
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakes.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.min(ms, 2147483647));
      this.wakes.add(wake);
    });
  }
  private wake() {
    for (const wake of [...this.wakes]) wake();
  }
  private emitSafe(event: string, ...args: any[]) {
    try {
      this.emit(event, ...args);
    } catch {
      /* Observers do not alter job state. */
    }
  }
  private hydrate(raw: Job): JobImpl<T> {
    return Object.assign(
      new JobImpl<T>(raw.name, raw.data, raw.opts, {
        save: async (job) => {
          if (!this.adapter.saveJob)
            throw new Error(
              "Adapter must implement saveJob for queue processing",
            );
          await this.adapter.saveJob(this.name, snapshotJob(job));
        },
        load: (id) => this.adapter.getJob(this.name, id),
        retry: async (job) => {
          this.open();
          await this.adapter.enqueue(this.name, job);
          this.wake();
        },
        progress: (job) => this.emitSafe("progress", job, job.progress),
      }),
      raw,
    );
  }
  async add(name: string, data: T, opts: JobOptions = {}): Promise<Job<T>> {
    this.open();
    const options = { ...this.options.defaultJobOptions, ...opts };
    if (options.backoff) validateBackoff(options.backoff);
    for (const key of ["delay", "timeout"] as const)
      if (
        options[key] !== undefined &&
        (!Number.isFinite(options[key]) || options[key]! < 0)
      )
        throw new Error(`${key} must be nonnegative`);
    if (
      options.attempts !== undefined &&
      (!Number.isInteger(options.attempts) || options.attempts < 1)
    )
      throw new Error("attempts must be a positive integer");
    for (const key of [
      "stackTraceLimit",
      "removeOnComplete",
      "removeOnFail",
    ] as const) {
      const value = options[key];
      if (typeof value === "number" && (!Number.isInteger(value) || value < 0))
        throw new Error(`${key} must be a nonnegative integer`);
    }
    if (options.priority !== undefined && !Number.isFinite(options.priority))
      throw new Error("Priority must be finite");
    const operation = this.additions.then(async () => {
      this.open();
      if (options.jobId) {
        const existing = await this.adapter.getJob(this.name, options.jobId);
        if (existing) return this.hydrate(existing);
      }
      if (options.preventDuplicates || options.deduplicationKey !== undefined) {
        const jobs = await this.adapter.getAllJobs(this.name);
        const existing = jobs.find(
          (job) =>
            !["failed", "completed"].includes(job.state) &&
            (options.deduplicationKey !== undefined
              ? job.opts.deduplicationKey === options.deduplicationKey
              : job.name === name &&
                JSON.stringify(job.data) === JSON.stringify(data)),
        );
        if (existing) return this.hydrate(existing);
      }
      const job = this.hydrate(new JobImpl(name, data, options));
      await this.adapter.enqueue(this.name, job);
      this.emitSafe("waiting", job);
      this.wake();
      return job;
    });
    this.additions = operation.catch(() => undefined);
    return operation;
  }
  async addBulk(jobs: Array<{ name: string; data: T; opts?: JobOptions }>) {
    return Promise.all(
      jobs.map((job) => this.add(job.name, job.data, job.opts)),
    );
  }
  private track(task: Promise<void>) {
    this.workers.add(task);
    void task
      .catch((error) => {
        this.workerErrors.push(error);
        this.paused = true;
      })
      .finally(() => this.workers.delete(task));
  }
  process(handler: JobHandler<T>): void;
  process(name: string, handler: JobHandler<T>): void;
  process(concurrency: number, handler: JobHandler<T>): void;
  process(name: string, concurrency: number, handler: JobHandler<T>): void;
  process(arg1: any, arg2?: any, arg3?: any): void {
    this.open();
    const name = typeof arg1 === "string" ? arg1 : undefined;
    const concurrency =
      typeof arg1 === "number" ? arg1 : typeof arg2 === "number" ? arg2 : 1;
    const handler: JobHandler<T> =
      typeof arg1 === "function"
        ? arg1
        : typeof arg2 === "function"
          ? arg2
          : arg3;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      typeof handler !== "function"
    )
      throw new Error(
        "Processing requires a handler and positive integer concurrency",
      );
    for (let i = 0; i < concurrency; i++) this.track(this.loop(name, handler));
  }
  private async take(name?: string): Promise<JobImpl<T> | null> {
    const raw = await this.adapter.dequeue(this.name, name);
    if (!raw) return null;
    if ((name && raw.name !== name) || this.paused || this.closed) {
      await this.adapter.nack(this.name, raw.id, true);
      return null;
    }
    const job = this.hydrate(raw);
    for (const id of job.opts.waitFor ?? []) {
      const dependency = await this.adapter.getJob(this.name, id);
      if (dependency?.state !== "completed") {
        await this.adapter.nack(this.name, job.id, true);
        return null;
      }
    }
    return job;
  }
  private async loop(
    name: string | undefined,
    handler: JobHandler<T>,
  ): Promise<void> {
    while (!this.closed) {
      if (this.paused) {
        await this.sleep();
        continue;
      }
      const job = await this.take(name);
      if (!job) {
        await this.sleep();
        continue;
      }
      this.inFlight++;
      try {
        await this.runJob(job, handler);
      } finally {
        this.inFlight--;
      }
    }
  }
  private async runJob(job: JobImpl<T>, handler: JobHandler<T>): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    Object.defineProperty(job, "signal", {
      value: controller.signal,
      enumerable: false,
    });
    try {
      if (this.limiter)
        for (;;) {
          const limit = await this.limiter.check();
          if (limit.allowed) break;
          await this.sleep(limit.retryAfter);
          if (this.closed) throw new Error("Queue closed");
        }
      job.state = "active";
      job.processedOn = Date.now();
      await this.adapter.saveJob?.(this.name, snapshotJob(job));
      this.emitSafe("active", job);
      const key = this.options.cache?.enabled
        ? (this.options.cache.keyGenerator?.(job) ??
          JSON.stringify([job.name, job.data]))
        : undefined;
      const cached = key === undefined ? undefined : this.cache.get(key);
      let result: any;
      if (cached && cached.expires > Date.now())
        result = structuredClone(cached.value);
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const task = Promise.resolve().then(() => handler(job));
        try {
          result =
            job.opts.timeout === undefined
              ? await task
              : await Promise.race([
                  task,
                  new Promise((_, reject) => {
                    timer = setTimeout(() => {
                      controller.abort();
                      reject(new Error("Job timed out"));
                    }, job.opts.timeout);
                  }),
                ]);
        } finally {
          if (timer) clearTimeout(timer);
          await task.catch(() => undefined);
        }
        if (key !== undefined)
          this.cache.set(key, {
            value: structuredClone(result),
            expires: Date.now() + this.options.cache!.ttl,
          });
      }
      await job.moveToCompleted(result);
      await this.adapter.ack(this.name, job.id);
      this.emitSafe("completed", job, result);
      await this.prune(job, "completed", job.opts.removeOnComplete);
    } catch (error) {
      await this.fail(job, error as Error);
    } finally {
      this.controllers.delete(controller);
    }
  }
  private async fail(job: JobImpl<T>, error: Error): Promise<void> {
    job.attemptsMade++;
    (job.stacktrace ??= []).push(error.stack ?? error.message);
    if (job.opts.stackTraceLimit !== undefined)
      job.stacktrace =
        job.opts.stackTraceLimit === 0
          ? []
          : job.stacktrace.slice(-job.opts.stackTraceLimit);
    let retry = !this.closed && !job.discarded && job.attemptsMade < (job.opts.attempts ?? 1);
    if (retry) {
      try {
        const backoff = job.opts.backoff;
        const strategy = backoff?.strategy && Object.prototype.hasOwnProperty.call(this.options.backoffStrategies ?? {}, backoff.strategy)
          ? this.options.backoffStrategies![backoff.strategy] : undefined;
        job.opts.delay = backoff ? calculateBackoff(job.attemptsMade, backoff,
          strategy ? () => strategy(job.attemptsMade, error, snapshotJob(job)) : undefined) : 0;
      } catch (cause) {
        error = new Error(`Backoff failed: ${cause instanceof Error ? cause.message : String(cause)}; original failure: ${error.message}`);
        retry = false;
      }
    }
    if (retry) {
      job.delay = job.opts.delay ?? 0;
      job.state = job.delay > 0 ? "delayed" : "waiting";
      await this.adapter.enqueue(this.name, job);
    } else {
      await job.moveToFailed(error);
      await this.adapter.nack(this.name, job.id, false);
      if (this.dlq)
        await this.dlq.moveToDLQ(snapshotJob(job), error.message, this.name);
      await this.prune(job, "failed", job.opts.removeOnFail);
    }
    this.emitSafe("failed", job, error);
  }
  private async prune(job: Job, state: JobStatus, setting?: boolean | number) {
    if (setting === true) await this.adapter.removeJob?.(this.name, job.id);
    else if (typeof setting === "number") {
      if (!Number.isInteger(setting) || setting < 0)
        throw new Error("Removal retention count must be nonnegative");
      const retained = (await this.adapter.getJobs(this.name, state)).sort(
        (a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0),
      );
      for (const stale of retained.slice(setting))
        await this.adapter.removeJob?.(this.name, stale.id);
    }
  }
  processBatch(
    name: string,
    options: number | BatchOptions,
    handler: BatchHandler<T>,
  ): void {
    this.open();
    const size = typeof options === "number" ? options : options.batchSize,
      maxWait = typeof options === "number" ? 1000 : (options.maxWait ?? 1000);
    if (
      !Number.isInteger(size) ||
      size < 1 ||
      !Number.isFinite(maxWait) ||
      maxWait < 0 ||
      typeof handler !== "function"
    )
      throw new Error("Invalid batch configuration");
    this.track(
      (async () => {
        while (!this.closed) {
          if (this.paused) {
            await this.sleep();
            continue;
          }
          const batch: JobImpl<T>[] = [];
          const deadline = Date.now() + maxWait;
          do {
            const job = await this.take(name);
            if (job) batch.push(job);
            else await this.sleep(Math.min(20, maxWait || 20));
          } while (
            !this.closed &&
            !this.paused &&
            batch.length < size &&
            Date.now() < deadline
          );
          if (!batch.length) continue;
          if (this.closed || this.paused) {
            for (const job of batch)
              await this.adapter.nack(this.name, job.id, true);
            continue;
          }
          this.inFlight += batch.length;
          try {
            const results = await handler(batch);
            if (!Array.isArray(results) || results.length !== batch.length)
              throw new Error("Batch handler must return one result per job");
            for (let i = 0; i < batch.length; i++) {
              await batch[i].moveToCompleted(results[i]);
              await this.adapter.ack(this.name, batch[i].id);
              this.emitSafe("completed", batch[i], results[i]);
            }
          } catch (error) {
            for (const job of batch) await this.fail(job, error as Error);
          } finally {
            this.inFlight -= batch.length;
          }
        }
      })(),
    );
  }
  async pause() {
    this.open();
    this.paused = true;
    this.wake();
  }
  async resume() {
    this.open();
    this.paused = false;
    this.wake();
  }
  async drain() {
    for (;;) {
      if (this.workerErrors.length) throw this.workerErrors[0];
      const stats = await this.adapter.getQueueStats(this.name);
      if (!this.inFlight && !stats.waiting && !stats.active && !stats.delayed)
        return;
      if (this.closed || this.paused || !this.workers.size)
        throw new Error("Cannot drain pending jobs without running workers");
      await this.sleep();
    }
  }
  async clean(grace: number, status: JobStatus) {
    return this.adapter.cleanJobs(this.name, grace, status);
  }
  async getJob(id: string): Promise<Job<T> | null> {
    const raw = await this.adapter.getJob(this.name, id);
    return raw ? this.hydrate(raw) : null;
  }
  async getJobs(status: JobStatus): Promise<Job<T>[]> {
    return (await this.adapter.getJobs(this.name, status)).map((job) =>
      this.hydrate(job),
    );
  }
  async getJobCounts(): Promise<QueueStats> {
    return this.adapter.getQueueStats(this.name);
  }
  getDLQ() {
    return this.dlq;
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.wake();
    await Promise.all([...this.workers]);
    this.cache.clear();
  }
}
