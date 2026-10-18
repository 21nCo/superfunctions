import type { ShutdownOptions } from '../core/shutdown.js';
export interface Queue<T = any> {
  name: string;

  // Adding jobs
  add(name: string, data: T, opts?: JobOptions): Promise<Job<T>>;
  addBulk(
    jobs: Array<{ name: string; data: T; opts?: JobOptions }>,
  ): Promise<Job<T>[]>;

  configureLeaseSettings(options: { leaseDuration?: number; leaseRenewInterval?: number; stalledInterval?: number; maxStalledCount?: number }): void;

  // Processing
  createProcessor(concurrency: number, handler: JobHandler<T>, name?: string): QueueProcessor;
  process(handler: JobHandler<T>): void;
  process(name: string, handler: JobHandler<T>): void;
  process(concurrency: number, handler: JobHandler<T>): void;
  process(name: string, concurrency: number, handler: JobHandler<T>): void;

  // Batch processing
  processBatch(name: string, batchSize: number, handler: BatchHandler<T>): void;
  processBatch(
    name: string,
    options: BatchOptions,
    handler: BatchHandler<T>,
  ): void;

  // Management
  pause(): Promise<void>;
  resume(): Promise<void>;
  drain(): Promise<void>;
  clean(grace: number, status: JobStatus): Promise<number>;

  // DLQ methods
  getDLQ?(): any; // Returns DLQManager if configured

  // Queries
  getJob(jobId: string): Promise<Job<T> | null>;
  getJobs(status: JobStatus): Promise<Job<T>[]>;
  getJobCounts(): Promise<QueueStats>;

  // Events
  on(event: QueueEvent, handler: (...args: any[]) => void): void;
  off(event: QueueEvent, handler: (...args: any[]) => void): void;

  // Lifecycle
  close(options?: ShutdownOptions): Promise<void>;
}
export interface QueueProcessor {
  readonly activeJobs: number;
  owns(jobId: string): boolean;
  close(options?: { timeout?: number }): Promise<void>;
}

export type QueueEvent =
  | "completed"
  | "failed"
  | "stalled"
  | "progress"
  | "waiting"
  | "active";

export interface Job<T = any> {
  readonly signal?: AbortSignal;
  /** Persisted queue-scoped enqueue deduplication identity. */
  deduplicationId?: string;
  lease?: { token: string; expiresAt: number };
  stalledCount?: number;
  id: string;
  name: string;
  data: T;
  opts: JobOptions;

  // Status
  state: JobStatus;
  progress: number;
  returnvalue?: any;

  // Timing
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  delay: number;

  // Retries
  attemptsMade: number;
  failedReason?: string;
  stacktrace?: string[];
  logs?: string[];
  discarded?: boolean;

  // Methods
  update(data: T extends object ? Partial<T> : T): Promise<void>;
  log(message: string): Promise<void>;
  updateProgress(progress: number): Promise<void>;
  moveToCompleted(returnValue: any): Promise<void>;
  moveToFailed(error: Error): Promise<void>;
  retry(): Promise<void>;
  discard(): Promise<void>;
  waitUntilFinished(): Promise<any>;
}

export type JobStatus =
  | "waiting"
  | "active"
  | "completed"
  | "failed"
  | "delayed"
  | "paused";

export interface JobOptions {
  priority?: number;
  delay?: number;
  attempts?: number;
  backoff?: BackoffOptions;
  lifo?: boolean;
  timeout?: number;
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
  stackTraceLimit?: number;
  jobId?: string;
  preventDuplicates?: boolean;
  deduplicationKey?: string;
  waitFor?: string[]; // Job IDs dependency
}

export interface BackoffOptions {
  type: "fixed" | "exponential" | "custom";
  delay: number;
  maxDelay?: number;
  /** Name resolved against the processing queue backoffStrategies registry. */
  strategy?: string;
}

export type BackoffStrategy = (attemptsMade: number, error: Error, job: Job) => number;

export interface QueueOptions {
  backoffStrategies?: Record<string, BackoffStrategy>;
  stalledInterval?: number;
  leaseDuration?: number;
  leaseRenewInterval?: number;
  maxStalledCount?: number;
  defaultJobOptions?: JobOptions;
  limiter?: RateLimiterOptions;
  cache?: CacheOptions;
  dlq?: {
    enabled: boolean;
    maxRetries?: number;
    queueName?: string;
  };
}

export interface RateLimiterOptions {
  max: number;
  duration: number;
}

export interface CacheOptions {
  enabled: boolean;
  ttl: number;
  keyGenerator?: (job: Job) => string;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export type JobHandler<T> = (job: Job<T>) => Promise<any>;
export type BatchHandler<T> = (jobs: Job<T>[]) => Promise<any[]>;

export interface BatchOptions {
  batchSize: number;
  maxWait?: number;
}
