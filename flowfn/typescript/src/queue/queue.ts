import {
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
import { FlowAdapter } from "../adapters/base.js";
import { JobImpl } from "./job.js";
import EventEmitter from "eventemitter3";
import { calculateBackoff } from "../patterns/backoff.js";

export class QueueImpl<T = any> extends EventEmitter implements Queue<T> {
  name: string;
  private adapter: FlowAdapter;
  private options: QueueOptions;
  private isProcessing = false;
  private currentWorkers: Set<Promise<void>> = new Set();

  constructor(name: string, adapter: FlowAdapter, options: QueueOptions = {}) {
    super();
    this.name = name;
    this.adapter = adapter;
    this.options = options;
  }

  async add(name: string, data: T, opts?: JobOptions): Promise<Job<T>> {
    const job = new JobImpl<T>(name, data, {
      ...this.options.defaultJobOptions,
      ...opts,
    });
    await this.adapter.enqueue(this.name, job);
    this.emit("waiting", job);
    return job;
  }

  async addBulk(
    jobs: Array<{ name: string; data: T; opts?: JobOptions }>
  ): Promise<Job<T>[]> {
    return Promise.all(jobs.map((j) => this.add(j.name, j.data, j.opts)));
  }

  process(arg1: any, arg2?: any, arg3?: any): void {
    let handler: JobHandler<T>;
    let concurrency = 1;

    if (typeof arg1 === "number") {
      concurrency = arg1;
      handler = arg2;
    } else if (typeof arg1 === "string") {
      // name based processing, ignore name for now in simple impl
      if (typeof arg2 === "number") {
        concurrency = arg2;
        handler = arg3;
      } else {
        handler = arg2;
      }
    } else {
      handler = arg1;
    }

    this.resume();
    for (let i = 0; i < concurrency; i++) {
      const worker = this.startProcessing(handler);
      this.currentWorkers.add(worker);
      worker.finally(() => this.currentWorkers.delete(worker));
    }
  }

  private async startProcessing(handler: JobHandler<T>) {
    while (this.isProcessing) {
      const jobData = await this.adapter.dequeue(this.name);
      if (jobData) {
        const job = Object.assign(
          new JobImpl(jobData.name, jobData.data, jobData.opts),
          jobData
        );

        // Check dependencies
        if (job.opts.waitFor && job.opts.waitFor.length > 0) {
          let allDone = true;
          for (const depId of job.opts.waitFor) {
            const depJob = await this.adapter.getJob(this.name, depId);
            if (!depJob || depJob.state !== "completed") {
              allDone = false;
              break;
            }
          }

          if (!allDone) {
            // Not ready, requeue
            await this.adapter.enqueue(this.name, job);
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
        }

        try {
          job.state = "active";
          job.processedOn = Date.now();
          this.emit("active", job);

          const result = await handler(job);

          await job.moveToCompleted(result);
          await this.adapter.ack(this.name, job.id);
          this.emit("completed", job, result);
        } catch (err: any) {
          job.attemptsMade++;
          job.stacktrace = job.stacktrace || [];
          job.stacktrace.push(err.stack);

          const maxAttempts = job.opts.attempts || 1;
          if (job.attemptsMade < maxAttempts) {
            job.state = "delayed";
            const backoff = job.opts.backoff
              ? calculateBackoff(job.attemptsMade, job.opts.backoff)
              : 0;
            job.opts.delay = backoff;
            await this.adapter.enqueue(this.name, job);
            this.emit("failed", job, err); // failed but retrying
          } else {
            await job.moveToFailed(err);
            // In real impl, move to DLQ or just ack to remove from active
            await this.adapter.ack(this.name, job.id);
            this.emit("failed", job, err);
          }
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  processBatch(
    arg1: string | any,
    arg2: number | BatchOptions | any,
    arg3?: BatchHandler<T>
  ): void {
    let handler: BatchHandler<T>;
    let batchSize = 10;
    let maxWait = 1000;

    if (typeof arg2 === "function") {
      handler = arg2;
    } else {
      handler = arg3!;
      if (typeof arg2 === "number") {
        batchSize = arg2;
      } else {
        batchSize = arg2.batchSize;
        maxWait = arg2.maxWait || 1000;
      }
    }

    this.resume();
    this.startBatchProcessing(handler, batchSize, maxWait);
  }

  private async startBatchProcessing(
    handler: BatchHandler<T>,
    batchSize: number,
    maxWait: number
  ) {
    while (this.isProcessing) {
      const batch: Job[] = [];
      const start = Date.now();

      while (batch.length < batchSize && Date.now() - start < maxWait) {
        const jobData = await this.adapter.dequeue(this.name);
        if (jobData) {
          const job = Object.assign(
            new JobImpl(jobData.name, jobData.data, jobData.opts),
            jobData
          );
          batch.push(job);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      if (batch.length > 0) {
        try {
          for (const job of batch) {
            (job as any).state = "active";
            (job as any).processedOn = Date.now();
          }

          const results = await handler(batch);

          for (let i = 0; i < batch.length; i++) {
            await batch[i].moveToCompleted(results[i]);
            await this.adapter.ack(this.name, batch[i].id);
          }
        } catch (err) {
          for (const job of batch) {
            await job.moveToFailed(err as Error);
            await this.adapter.ack(this.name, job.id);
          }
        }
      }
    }
  }

  async pause(): Promise<void> {
    this.isProcessing = false;
  }

  async resume(): Promise<void> {
    this.isProcessing = true;
  }

  async drain(): Promise<void> {
    await Promise.all(this.currentWorkers);
  }

  async clean(grace: number, status: JobStatus): Promise<number> {
    return this.adapter.cleanJobs(this.name, grace, status);
  }

  async getJob(jobId: string): Promise<Job<T> | null> {
    const job = await this.adapter.getJob(this.name, jobId);
    return job as Job<T> | null;
  }

  async getJobs(status: JobStatus): Promise<Job<T>[]> {
    const jobs = await this.adapter.getJobs(this.name, status);
    return jobs as Job<T>[];
  }

  async getJobCounts(): Promise<QueueStats> {
    return this.adapter.getQueueStats(this.name);
  }

  async close(): Promise<void> {
    this.isProcessing = false;
    await this.drain();
  }
}
