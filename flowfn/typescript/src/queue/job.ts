import { Job, JobOptions, JobStatus } from './types.js';
import { v4 as uuidv4 } from 'uuid';

export class JobImpl<T = any> implements Job<T> {
  id: string;
  name: string;
  data: T;
  opts: JobOptions;
  
  state: JobStatus = 'waiting';
  progress: number = 0;
  returnvalue?: any;
  
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  delay: number = 0;
  
  attemptsMade: number = 0;
  failedReason?: string;
  stacktrace?: string[];

  constructor(name: string, data: T, opts?: JobOptions) {
      this.id = opts?.jobId || uuidv4();
      this.name = name;
      this.data = data;
      this.opts = opts || {};
      this.timestamp = Date.now();
  }
  
  async update(data: Partial<T>): Promise<void> {
    this.data = { ...this.data, ...data };
  }

  async log(message: string): Promise<void> {
    // console.log(`[Job ${this.id}] ${message}`);
  }

  async updateProgress(progress: number): Promise<void> {
    this.progress = progress;
  }

  async moveToCompleted(returnValue: any): Promise<void> {
    this.state = 'completed';
    this.returnvalue = returnValue;
    this.finishedOn = Date.now();
  }

  async moveToFailed(error: Error): Promise<void> {
    this.state = 'failed';
    this.failedReason = error.message;
    this.finishedOn = Date.now();
  }

  async retry(): Promise<void> {
     // logical retry
  }

  async discard(): Promise<void> {
      // discard
  }

  async waitUntilFinished(): Promise<any> {
      // Poll or wait for event
      return Promise.resolve();
  }
}
