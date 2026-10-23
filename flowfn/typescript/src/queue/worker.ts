import { FlowFn } from '../core/flow-fn.js';
import { Queue, Job } from './types.js';
import EventEmitter from 'eventemitter3';

export interface WorkerOptions {
  flow: FlowFn;
  queues: string[];
  concurrency?: number | Record<string, number>;
  settings?: {
      stalledInterval?: number;
      maxStalledCount?: number;
  };
}

export class Worker extends EventEmitter {
  private flow: FlowFn;
  private queueNames: string[];
  private concurrency: number | Record<string, number>;
  private queues: Queue[] = [];

  constructor(options: WorkerOptions) {
    super();
    this.flow = options.flow;
    this.queueNames = options.queues;
    this.concurrency = options.concurrency || 1;
  }

  async run(): Promise<void> {
    for (const name of this.queueNames) {
        const queue = this.flow.queue(name);
        this.queues.push(queue);
        
        const qConcurrency = typeof this.concurrency === 'number' 
            ? this.concurrency 
            : (this.concurrency[name] || 1);

        queue.on('active', (job) => this.emit('active', job));
        queue.on('completed', (job, result) => this.emit('completed', job, result));
        queue.on('failed', (job, err) => this.emit('failed', job, err));
        
        // This is a bit simplified. In a real system, the worker would 
        // have its own processing loop rather than calling queue.process.
        // But for this abstraction it works.
        // We need a way to pass the handler to the worker.
    }
    this.emit('ready');
  }

  // Helper to register handlers
  register(queueName: string, handler: (job: Job) => Promise<any>) {
      const queue = this.flow.queue(queueName);
      const qConcurrency = typeof this.concurrency === 'number' 
            ? this.concurrency 
            : (this.concurrency[queueName] || 1);
      queue.process(qConcurrency, handler);
  }

  async close(): Promise<void> {
    this.emit('closing');
    await Promise.all(this.queues.map(q => q.close()));
  }
}

export function createWorker(options: WorkerOptions): Worker {
    return new Worker(options);
}
