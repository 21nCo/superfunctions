/**
 * Dead-Letter Queue (DLQ) implementation for FlowFn
 */

import { Job, JobOptions } from "../queue/types.js";

export interface DLQOptions {
  /**
   * Queue name for dead-letter jobs
   */
  queueName?: string;

  /**
   * Maximum retries before moving to DLQ
   */
  maxRetries?: number;

  /**
   * Time to live for DLQ items (ms)
   */
  ttl?: number;

  /**
   * Handler called when job moves to DLQ
   */
  onDLQ?: (job: Job, reason: string) => void | Promise<void>;
}

export interface DLQJob<T = any> extends Job<T> {
  /**
   * Original queue name
   */
  originalQueue: string;

  /**
   * Reason for DLQ
   */
  dlqReason: string;

  /**
   * Timestamp when moved to DLQ
   */
  dlqTimestamp: number;

  /**
   * All error messages from attempts
   */
  errors: string[];
}

export interface DLQManager {
  /**
   * Move job to DLQ
   */
  moveToDLQ<T>(
    job: Job<T>,
    reason: string,
    originalQueue?: string,
  ): Promise<DLQJob<T>>;

  /**
   * Get all DLQ jobs
   */
  getAll(): Promise<DLQJob[]>;

  /**
   * Get DLQ jobs by original queue
   */
  getByQueue(queueName: string): Promise<DLQJob[]>;

  /**
   * Retry a DLQ job
   */
  retry<T>(jobId: string): Promise<Job<T>>;

  /**
   * Retry all DLQ jobs from a queue
   */
  retryAll(queueName: string): Promise<number>;

  /**
   * Delete a DLQ job
   */
  delete(jobId: string): Promise<void>;

  /**
   * Clean expired DLQ jobs
   */
  clean(maxAge: number): Promise<number>;

  /**
   * Get DLQ stats
   */
  getStats(): Promise<{ total: number; byQueue: Record<string, number> }>;
}

/**
 * In-memory DLQ implementation
 */
export class MemoryDLQManager implements DLQManager {
  private dlqJobs: Map<string, DLQJob> = new Map();
  private options: DLQOptions;

  constructor(options: DLQOptions = {}) {
    this.options = {
      queueName: "dlq",
      maxRetries: 3,
      ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
      ...options,
    };
  }

  async moveToDLQ<T>(
    job: Job<T>,
    reason: string,
    originalQueue?: string,
  ): Promise<DLQJob<T>> {
    const dlqJob: DLQJob<T> = {
      ...job,
      originalQueue: originalQueue ?? job.name,
      dlqReason: reason,
      dlqTimestamp: Date.now(),
      errors: [...(job.stacktrace || []), job.failedReason || reason].filter(
        Boolean,
      ),
    };

    this.dlqJobs.set(job.id, dlqJob);

    // Call handler if provided
    if (this.options.onDLQ) {
      await Promise.resolve(this.options.onDLQ(job, reason));
    }

    return dlqJob;
  }

  async getAll(): Promise<DLQJob[]> {
    return Array.from(this.dlqJobs.values());
  }

  async getByQueue(queueName: string): Promise<DLQJob[]> {
    return Array.from(this.dlqJobs.values()).filter(
      (job) => job.originalQueue === queueName,
    );
  }

  async retry<T>(jobId: string): Promise<Job<T>> {
    const dlqJob = this.dlqJobs.get(jobId);
    if (!dlqJob) {
      throw new Error(`DLQ job ${jobId} not found`);
    }

    // Remove from DLQ
    this.dlqJobs.delete(jobId);

    // Reset job state for retry
    const retriedJob: Job<T> = {
      ...dlqJob,
      state: "waiting",
      attemptsMade: 0,
      failedReason: undefined,
      stacktrace: [],
      processedOn: undefined,
      finishedOn: undefined,
    } as Job<T>;

    return retriedJob;
  }

  async retryAll(queueName: string): Promise<number> {
    const jobs = await this.getByQueue(queueName);
    let count = 0;

    for (const job of jobs) {
      try {
        await this.retry(job.id);
        count++;
      } catch (err) {
        console.error(`Failed to retry job ${job.id}:`, err);
      }
    }

    return count;
  }

  async delete(jobId: string): Promise<void> {
    this.dlqJobs.delete(jobId);
  }

  async clean(maxAge: number): Promise<number> {
    if (!Number.isFinite(maxAge) || maxAge < 0)
      throw new Error("maxAge must be nonnegative and finite");
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, job] of this.dlqJobs.entries()) {
      if (now - job.dlqTimestamp >= maxAge) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.dlqJobs.delete(id);
    }

    return toDelete.length;
  }

  async getStats(): Promise<{
    total: number;
    byQueue: Record<string, number>;
  }> {
    const byQueue: Record<string, number> = {};

    for (const job of this.dlqJobs.values()) {
      byQueue[job.originalQueue] = (byQueue[job.originalQueue] || 0) + 1;
    }

    return {
      total: this.dlqJobs.size,
      byQueue,
    };
  }

  /**
   * Clear all DLQ jobs (for testing)
   */
  clear(): void {
    this.dlqJobs.clear();
  }
}
