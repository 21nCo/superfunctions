/**
 * Storage abstraction for FlowFn job persistence
 */

import { snapshotJob } from "../queue/job.js";
import { Job, JobStatus } from "../queue/types.js";

export interface JobStorage {
  /**
   * Save a job
   */
  save(queue: string, job: Job): Promise<void>;

  /**
   * Get a job by ID
   */
  get(queue: string, jobId: string): Promise<Job | null>;

  /**
   * Get jobs by status
   */
  getByStatus(queue: string, status: JobStatus): Promise<Job[]>;

  /**
   * Get all jobs for a queue
   */
  getAll(queue: string): Promise<Job[]>;

  /**
   * Update job status
   */
  updateStatus(queue: string, jobId: string, status: JobStatus): Promise<void>;

  /**
   * Update job data
   */
  update(queue: string, jobId: string, updates: Partial<Job>): Promise<void>;

  /**
   * Delete a job
   */
  delete(queue: string, jobId: string): Promise<void>;

  /**
   * Delete jobs older than grace period with given status
   */
  clean(queue: string, grace: number, status: JobStatus): Promise<number>;

  /**
   * Get job count by status
   */
  count(queue: string, status?: JobStatus): Promise<number>;

  /**
   * Check if job exists with deduplication key
   */
  existsByDeduplicationKey(queue: string, key: string): Promise<boolean>;
}

/**
 * In-memory implementation of JobStorage
 */
export class MemoryJobStorage implements JobStorage {
  private jobs = new Map<string, Map<string, Job>>();
  async save(queue: string, job: Job): Promise<void> {
    const snapshot = snapshotJob(job);
    let entries = this.jobs.get(queue);
    if (!entries) {
      entries = new Map();
      this.jobs.set(queue, entries);
    }
    entries.set(job.id, snapshot);
  }
  async get(queue: string, jobId: string): Promise<Job | null> {
    const job = this.jobs.get(queue)?.get(jobId);
    return job ? snapshotJob(job) : null;
  }
  async getByStatus(queue: string, status: JobStatus): Promise<Job[]> {
    return (await this.getAll(queue)).filter((job) => job.state === status);
  }
  async getAll(queue: string): Promise<Job[]> {
    return [...(this.jobs.get(queue)?.values() ?? [])].map(snapshotJob);
  }
  async updateStatus(
    queue: string,
    jobId: string,
    status: JobStatus,
  ): Promise<void> {
    const job = await this.get(queue, jobId);
    if (job) {
      job.state = status;
      if (status === "completed" || status === "failed")
        job.finishedOn = Date.now();
      await this.save(queue, job);
    }
  }
  async update(
    queue: string,
    jobId: string,
    updates: Partial<Job>,
  ): Promise<void> {
    const job = await this.get(queue, jobId);
    if (job) await this.save(queue, { ...job, ...updates, id: jobId } as Job);
  }
  async delete(queue: string, jobId: string): Promise<void> {
    this.jobs.get(queue)?.delete(jobId);
  }
  async clean(
    queue: string,
    grace: number,
    status: JobStatus,
  ): Promise<number> {
    if (!Number.isFinite(grace) || grace < 0)
      throw new Error("Grace must be nonnegative and finite");
    const expired = (await this.getByStatus(queue, status)).filter(
      (job) => Date.now() - (job.finishedOn ?? job.timestamp) >= grace,
    );
    for (const job of expired) await this.delete(queue, job.id);
    return expired.length;
  }
  async count(queue: string, status?: JobStatus): Promise<number> {
    return status
      ? (await this.getByStatus(queue, status)).length
      : (this.jobs.get(queue)?.size ?? 0);
  }
  async existsByDeduplicationKey(queue: string, key: string): Promise<boolean> {
    return (await this.getAll(queue)).some(
      (job) => job.opts.deduplicationKey === key,
    );
  }
  clear(): void {
    this.jobs.clear();
  }
}
