import { boundedShutdown, shutdownTimeout, type ShutdownOptions } from '../core/shutdown.js';
import { OperationObserver } from '../instrumentation.js';
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
  QueueProcessor,
} from "./types.js";
import type { FlowAdapter } from "../adapters/base.js";
import { JobImpl, snapshotJob } from "./job.js";
import { EventEmitter } from "eventemitter3";
import { calculateBackoff, validateBackoff } from "../patterns/backoff.js";
import { MemoryDLQManager } from "./dlq.js";
import { RateLimiter } from "../patterns/rate-limit.js";
interface ProcessorState<T> { stopped: boolean; jobs: Set<JobImpl<T>> }
export class QueueImpl<T = any> extends EventEmitter implements Queue<T> {
  private paused = false;
  private closed = false;
  private closing?: Promise<void>;
  private workers = new Set<Promise<void>>();
  private producers = new Set<Promise<unknown>>();
  private inFlight = 0;
  private wakes = new Set<() => void>();
  private drainWakes = new Set<() => void>();
  private drainEpoch = 0;
  private controllers = new Set<AbortController>();
  private workerErrors: unknown[] = [];
  private dlq?: MemoryDLQManager;
  private limiter?: RateLimiter;
  private cache = new Map<string, { value: any; expires: number }>();
  private leases = new Map<string, { token: string; timer: ReturnType<typeof setInterval>; lost: boolean; controller?: AbortController }>();
  private recoveredAt = 0;
  constructor(
    public name: string,
    private adapter: FlowAdapter,
    private options: QueueOptions = {},
    private observer = new OperationObserver(),
  ) {
    super();
    this.configureLeaseSettings(options);
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
  configureLeaseSettings(settings: { leaseDuration?: number; leaseRenewInterval?: number; stalledInterval?: number; maxStalledCount?: number }) {
    const defaults = { leaseDuration: 30_000, leaseRenewInterval: Math.max(1, Math.floor((settings.leaseDuration ?? this.options.leaseDuration ?? 30_000) / 3)), stalledInterval: 30_000, maxStalledCount: 1 };
    for (const key of ['leaseDuration', 'leaseRenewInterval', 'stalledInterval', 'maxStalledCount'] as const) {
      const value = settings[key];
      if (value !== undefined && (!Number.isInteger(value) || value < (key === 'maxStalledCount' ? 0 : 1))) throw new Error(`Invalid ${key}`);
      if (this.workers.size && value !== undefined && value !== (this.options[key] ?? defaults[key])) throw new Error('Cannot change lease settings while processing');
    }
    const duration = settings.leaseDuration ?? this.options.leaseDuration ?? 30_000;
    const renewal = settings.leaseRenewInterval ?? this.options.leaseRenewInterval ?? Math.max(1, Math.floor(duration / 3));
    if (renewal >= duration) throw new Error('Renew interval must be shorter than lease duration');
    for (const key of ['leaseDuration', 'leaseRenewInterval', 'stalledInterval', 'maxStalledCount'] as const) if (settings[key] !== undefined) this.options[key] = settings[key];
  }
  private releaseLease(job: Job) {
    const guard = this.leases.get(job.id);
    if (guard && guard.token === job.lease?.token) { clearInterval(guard.timer); this.leases.delete(job.id); }
  }
  private guardLease(job: Job, claimedAt: number) {
    if (!job.lease || !this.adapter.renewJobLease) throw new Error("Adapter must support job leases");
    const duration = this.options.leaseDuration ?? 30_000;
    let pending = false;
    let validUntil = claimedAt + duration;
    const guard = { token: job.lease.token, lost: performance.now() >= validUntil, controller: undefined as AbortController | undefined, timer: setInterval(async () => {
      if (guard.lost) return;
      if (performance.now() >= validUntil) { guard.lost = true; guard.controller?.abort(); return; }
      if (pending) return;
      pending = true;
      const started = performance.now();
      try {
        if (!await this.adapter.renewJobLease!(this.name, job.id, job.lease!.token, duration)) {
          guard.lost = true; guard.controller?.abort();
        } else validUntil = started + duration;
      } catch {
        if (performance.now() >= validUntil) { guard.lost = true; guard.controller?.abort(); }
      }
      finally { pending = false; }
    }, Math.min(2147483647, this.options.leaseRenewInterval ?? Math.max(1, Math.floor(duration / 3)))) };
    const previous = this.leases.get(job.id);
    if (previous) { previous.lost = true; previous.controller?.abort(); clearInterval(previous.timer); }
    this.leases.set(job.id, guard);
  }
  private open() {
    if (this.closed) throw new Error("Queue is closed");
  }
  private async sleep(ms = 20, wakes = this.wakes) {
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        wakes.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.min(ms, 2147483647));
      wakes.add(wake);
    });
  }
  private wakeDrains() {
    this.drainEpoch++;
    for (const wake of [...this.drainWakes]) wake();
  }
  private wake() {
    for (const wake of [...this.wakes]) wake();
    this.wakeDrains();
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
    const operation = Promise.resolve().then(async () => {
      this.open();
      if (!this.adapter.createJob)
        throw new Error("Adapter must implement atomic createJob for enqueue");
      const proposed = new JobImpl(name, data, options);
      proposed.traceContext = this.observer.capture();
      if (options.deduplicationKey !== undefined)
        proposed.deduplicationId = JSON.stringify(["key", options.deduplicationKey]);
      else if (options.preventDuplicates)
        proposed.deduplicationId = JSON.stringify(["data", name, data]);
      const job = this.hydrate(await this.adapter.createJob(this.name, snapshotJob(proposed)));
      this.emitSafe("waiting", job);
      this.wake();
      return job;
    });
    this.producers.add(operation);
    void operation.then(() => this.producers.delete(operation), () => this.producers.delete(operation));
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
    this.createProcessor(concurrency, handler, name);
  }
  createProcessor(concurrency: number, handler: JobHandler<T>, name?: string): QueueProcessor {
    this.open();
    if (!Number.isInteger(concurrency) || concurrency < 1 || typeof handler !== 'function') throw new Error('Processing requires a handler and positive integer concurrency');
    const group: ProcessorState<T> = { stopped: false, jobs: new Set() };
    const tasks = Array.from({ length: concurrency }, () => this.loop(name, handler, group));
    for (const task of tasks) this.track(task);
    let closing: Promise<void> | undefined;
    return {
      get activeJobs() { return group.jobs.size; },
      owns: id => [...group.jobs].some(job => job.id === id),
      close: (options = {}) => {
        if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0 || options.timeout > 2147483647)) return Promise.reject(new Error('Invalid shutdown timeout'));
        if (closing) return closing;
        group.stopped = true;
        for (const job of group.jobs) { const guard = this.leases.get(job.id); if (guard && guard.token === job.lease?.token) guard.controller?.abort(); }
        this.wake();
        const complete = Promise.all(tasks).then(() => undefined);
        if (options.timeout === undefined) return closing = complete;
        closing = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            for (const job of group.jobs) {
              const guard = this.leases.get(job.id);
              if (guard && guard.token === job.lease?.token) { guard.lost = true; guard.controller?.abort(); this.releaseLease(job); }
            }
            this.inFlight -= group.jobs.size;
            group.jobs.clear();
            for (const task of tasks) this.workers.delete(task);
            reject(new Error('Processor shutdown timed out; active leases were abandoned'));
          }, options.timeout);
          complete.then(resolve, reject).finally(() => clearTimeout(timer));
        });
        return closing;
      },
    };
  }
  private async take(name?: string): Promise<JobImpl<T> | null> {
    if (Date.now() - this.recoveredAt >= (this.options.stalledInterval ?? 30_000)) {
      this.recoveredAt = Date.now();
      if (!this.adapter.recoverStalledJobs) throw new Error("Adapter must support stalled job recovery");
      for (const stalled of await this.adapter.recoverStalledJobs(this.name, this.options.maxStalledCount ?? 1)) {
        const job = this.hydrate(stalled);
        this.emitSafe("stalled", job);
        if (job.state === "failed") {
          if (this.dlq) await this.dlq.moveToDLQ(snapshotJob(job), job.failedReason!, this.name);
          this.emitSafe("failed", job, new Error(job.failedReason));
          await this.prune(job, "failed", job.opts.removeOnFail);
        }
      }
    }
    const claimedAt = performance.now();
    const raw = await this.adapter.dequeue(this.name, name, this.options.leaseDuration ?? 30_000);
    if (!raw) {
      // An empty storage claim after local work settled can unblock drain now.
      // Notify only drain callers, never other idle processors (which would spin).
      if (!this.inFlight) this.wakeDrains();
      return null;
    }
    if ((name && raw.name !== name) || this.paused || this.closed) {
      await this.adapter.nack(this.name, raw.id, true, raw.lease?.token);
      return null;
    }
    const job = this.hydrate(raw);
    for (const id of job.opts.waitFor ?? []) {
      const dependency = await this.adapter.getJob(this.name, id);
      if (dependency?.state !== "completed") {
        await this.adapter.nack(this.name, job.id, true, job.lease?.token);
        return null;
      }
    }
    this.guardLease(job, claimedAt);
    return job;
  }
  private async loop(
    name: string | undefined,
    handler: JobHandler<T>,
    group: ProcessorState<T>,
  ): Promise<void> {
    while (!this.closed && !group.stopped) {
      if (this.paused) {
        await this.sleep();
        continue;
      }
      const job = await this.take(name);
      if (!job) {
        await this.sleep();
        continue;
      }
      if (group.stopped || this.closed) {
        await this.adapter.nack(this.name, job.id, true, job.lease?.token);
        this.releaseLease(job);
        return;
      }
      group.jobs.add(job);
      this.inFlight++;
      try {
        await this.runJob(job, handler);
      } finally {
        if (group.jobs.delete(job)) this.inFlight--;
      }
    }
  }
  private async runJob(job: JobImpl<T>, handler: JobHandler<T>): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const guard = this.leases.get(job.id)!;
    guard.controller = controller;
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
      if (guard.lost) return;
      // dequeue already atomically persists active state and processing time.
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
        const task = this.observer.run('flowfn.job.execute', { 'flowfn.queue': this.name, 'flowfn.job.id': job.id, 'flowfn.job.name': job.name }, () => handler(job), job.traceContext ?? {});
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
        if (guard.lost) return;
        if (key !== undefined)
          this.cache.set(key, {
            value: structuredClone(result),
            expires: Date.now() + this.options.cache!.ttl,
          });
      }
      if (guard.lost) return;
      await job.moveToCompleted(result);
      this.emitSafe("completed", job, result);
      await this.prune(job, "completed", job.opts.removeOnComplete);
    } catch (error) {
      if (!guard.lost && !(error instanceof Error && error.message === "Job lease lost")) await this.fail(job, error as Error);
    } finally {
      this.releaseLease(job);
      this.controllers.delete(controller);
    }
  }
  private async fail(job: JobImpl<T>, error: Error): Promise<void> {
    try { await this.failOwned(job, error); }
    catch (failure) {
      if (!(failure instanceof Error && failure.message === "Job lease lost")) throw failure;
    }
  }
  private async failOwned(job: JobImpl<T>, error: Error): Promise<void> {
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
            for (const job of batch) {
              await this.adapter.nack(this.name, job.id, true, job.lease?.token);
              this.releaseLease(job);
            }
            continue;
          }
          this.inFlight += batch.length;
          try {
            const arrivals: Array<{ job: Job<T>; resolve: (value: any) => void; reject: (error: unknown) => void }> = [];
            let settledWithoutHandler = 0;
            let launched = false;
            const dispatch = () => {
              if (launched || arrivals.length + settledWithoutHandler !== batch.length || !arrivals.length) return;
              launched = true;
              if (this.closed) { arrivals.forEach(entry => entry.reject(new Error("Queue closed"))); return; }
              void Promise.resolve().then(() => handler(arrivals.map(entry => entry.job))).then(results => {
                if (!Array.isArray(results) || results.length !== arrivals.length)
                  throw new Error("Batch handler must return one result per job");
                arrivals.forEach((entry, index) => entry.resolve(results[index]));
              }).catch(error => arrivals.forEach(entry => entry.reject(error)));
            };
            const results = await Promise.allSettled(batch.map(async job => {
              let arrived = false;
              try {
                await this.runJob(job, current => new Promise((resolve, reject) => {
                  arrived = true;
                  arrivals.push({ job: current, resolve, reject });
                  dispatch();
                }));
              } finally {
                if (!arrived) { settledWithoutHandler++; dispatch(); }
              }
            }));
            const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (rejected) throw rejected.reason;
          } finally {
            for (const job of batch) this.releaseLease(job);
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
      const epoch = this.drainEpoch;
      const stats = await this.adapter.getQueueStats(this.name);
      if (!this.inFlight && !stats.waiting && !stats.active && !stats.delayed)
        return;
      if (this.closed || this.paused || !this.workers.size)
        throw new Error("Cannot drain pending jobs without running workers");
      // A notification during the awaited stats read must not be lost.
      // Keep the timer fallback for progress made by remote workers.
      if (epoch === this.drainEpoch) await this.sleep(20, this.drainWakes);
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
  close(options: ShutdownOptions = {}): Promise<void> {
    const timeout = shutdownTimeout(options);
    if (this.closing) return this.closing;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.wake();
    const abandon = () => {
      for (const guard of this.leases.values()) { guard.lost = true; guard.controller?.abort(); clearInterval(guard.timer); }
      this.leases.clear();
      this.workers.clear();
      this.cache.clear();
    };
    const work = (async () => {
      await Promise.allSettled([...this.producers]);
      await Promise.all([...this.workers]);
    })();
    return this.closing = boundedShutdown(work, timeout, `Queue ${this.name}`, abandon).finally(abandon);
  }
}
