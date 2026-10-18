import { randomUUID } from "node:crypto";
import { Job, JobOptions, JobStatus } from "./types.js";
export interface JobServices {
  save(job: Job): Promise<void>;
  load(id: string): Promise<Job | null>;
  retry(job: Job): Promise<void>;
  progress?(job: Job): void;
}
export function snapshotJob(job: Job): Job {
  return JSON.parse(JSON.stringify(job));
}
export class JobImpl<T = any> implements Job<T> {
  id: string;
  name: string;
  data: T;
  opts: JobOptions;
  state: JobStatus = "waiting";
  progress = 0;
  returnvalue?: any;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  delay = 0;
  attemptsMade = 0;
  failedReason?: string;
  stacktrace?: string[];
  logs: string[] = [];
  discarded = false;
  private services?: JobServices;
  constructor(
    name: string,
    data: T,
    opts: JobOptions = {},
    services?: JobServices,
  ) {
    this.id = opts.jobId ?? randomUUID();
    this.name = name;
    this.data = structuredClone(data);
    this.opts = structuredClone(opts);
    this.timestamp = Date.now();
    this.delay = opts.delay ?? 0;
    Object.defineProperty(this, "services", {
      value: services,
      enumerable: false,
    });
  }
  private async save() {
    await this.services?.save(this);
  }
  async update(data: T extends object ? Partial<T> : T): Promise<void> {
    const copy = structuredClone(data);
    this.data = (this.data !== null && typeof this.data === "object" && !Array.isArray(this.data) && copy !== null && typeof copy === "object" && !Array.isArray(copy) ? { ...this.data, ...copy } : copy) as T;
    await this.save();
  }
  async log(message: string): Promise<void> {
    this.logs.push(String(message));
    if (this.logs.length > 1000) this.logs.shift();
    await this.save();
  }
  async updateProgress(progress: number): Promise<void> {
    if (!Number.isFinite(progress) || progress < 0 || progress > 100)
      throw new Error("Progress must be between 0 and 100");
    this.progress = progress;
    await this.save();
    this.services?.progress?.(this);
  }
  async moveToCompleted(value: any): Promise<void> {
    this.state = "completed";
    this.returnvalue = structuredClone(value);
    this.finishedOn = Date.now();
    await this.save();
  }
  async moveToFailed(error: Error): Promise<void> {
    this.state = "failed";
    this.failedReason = error.message;
    this.finishedOn = Date.now();
    await this.save();
  }
  async retry(): Promise<void> {
    if (this.state !== "failed")
      throw new Error("Only failed jobs can be retried");
    if (!this.services) throw new Error("Retry requires a queue-bound job");
    this.state = "waiting";
    this.attemptsMade = 0;
    this.delay = 0;
    this.opts.delay = 0;
    this.discarded = false;
    delete this.finishedOn;
    delete this.failedReason;
    await this.services.retry(this);
  }
  async discard(): Promise<void> {
    this.discarded = true;
    await this.save();
  }
  async waitUntilFinished(): Promise<any> {
    for (;;) {
      const current = this.services ? await this.services.load(this.id) : this;
      if (!current) throw new Error("Job no longer exists");
      if (current.state === "completed") return current.returnvalue;
      if (current.state === "failed")
        throw new Error(current.failedReason ?? "Job failed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
