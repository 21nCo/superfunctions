/**
 * Storage abstraction for FlowFn job persistence
 */

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
  private jobs: Map<string, Job> = new Map();
  private deduplicationKeys: Map<string, string> = new Map(); // key -> jobId

  async save(queue: string, job: Job): Promise<void> {
    const key = `${queue}:${job.id}`;
    this.jobs.set(key, { ...job });

    // Store deduplication key if present
    if (job.opts.deduplicationKey) {
      const dedupKey = `${queue}:${job.opts.deduplicationKey}`;
      this.deduplicationKeys.set(dedupKey, job.id);
    }
  }

  async get(queue: string, jobId: string): Promise<Job | null> {
    const key = `${queue}:${jobId}`;
    return this.jobs.get(key) || null;
  }

  async getByStatus(queue: string, status: JobStatus): Promise<Job[]> {
    const result: Job[] = [];
    const prefix = `${queue}:`;

    for (const [key, job] of this.jobs.entries()) {
      if (key.startsWith(prefix) && job.state === status) {
        result.push(job);
      }
    }

    return result;
  }

  async getAll(queue: string): Promise<Job[]> {
    const result: Job[] = [];
    const prefix = `${queue}:`;

    for (const [key, job] of this.jobs.entries()) {
      if (key.startsWith(prefix)) {
        result.push(job);
      }
    }

    return result;
  }

  async updateStatus(
    queue: string,
    jobId: string,
    status: JobStatus
  ): Promise<void> {
    const key = `${queue}:${jobId}`;
    const job = this.jobs.get(key);

    if (job) {
      job.state = status;
      if (status === "completed" || status === "failed") {
        job.finishedOn = Date.now();
      }
    }
  }

  async update(
    queue: string,
    jobId: string,
    updates: Partial<Job>
  ): Promise<void> {
    const key = `${queue}:${jobId}`;
    const job = this.jobs.get(key);

    if (job) {
      Object.assign(job, updates);
    }
  }

  async delete(queue: string, jobId: string): Promise<void> {
    const key = `${queue}:${jobId}`;
    const job = this.jobs.get(key);

    if (job?.opts.deduplicationKey) {
      const dedupKey = `${queue}:${job.opts.deduplicationKey}`;
      this.deduplicationKeys.delete(dedupKey);
    }

    this.jobs.delete(key);
  }

  async clean(
    queue: string,
    grace: number,
    status: JobStatus
  ): Promise<number> {
    const now = Date.now();
    const prefix = `${queue}:`;
    const toDelete: string[] = [];

    for (const [key, job] of this.jobs.entries()) {
      if (key.startsWith(prefix) && job.state === status) {
        const timestamp = job.finishedOn || job.timestamp;
        if (now - timestamp > grace) {
          toDelete.push(key);
        }
      }
    }

    for (const key of toDelete) {
      const job = this.jobs.get(key);
      if (job?.opts.deduplicationKey) {
        const dedupKey = `${queue}:${job.opts.deduplicationKey}`;
        this.deduplicationKeys.delete(dedupKey);
      }
      this.jobs.delete(key);
    }

    return toDelete.length;
  }

  async count(queue: string, status?: JobStatus): Promise<number> {
    const prefix = `${queue}:`;
    let count = 0;

    for (const [key, job] of this.jobs.entries()) {
      if (key.startsWith(prefix)) {
        if (!status || job.state === status) {
          count++;
        }
      }
    }

    return count;
  }

  async existsByDeduplicationKey(queue: string, key: string): Promise<boolean> {
    const dedupKey = `${queue}:${key}`;
    return this.deduplicationKeys.has(dedupKey);
  }

  /**
   * Clear all jobs
   */
  clear(): void {
    this.jobs.clear();
    this.deduplicationKeys.clear();
  }
}
