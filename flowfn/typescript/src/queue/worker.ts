import { FlowFn } from "../core/flow-fn.js";
import { Queue, Job, QueueEvent } from "./types.js";
import EventEmitter from "eventemitter3";

export interface WorkerOptions {
  flow: FlowFn;
  queues: string[];
  concurrency?: number | Record<string, number>;
  settings?: { leaseDuration?: number; stalledInterval?: number; maxStalledCount?: number };
}

/** Owns registered processors and forwards their queue lifecycle events. */
export class Worker extends EventEmitter {
  private readonly handlers = new Map<string, (job: Job) => Promise<any>>();
  private readonly subscriptions = new Map<
    Queue,
    Array<[QueueEvent, (...args: any[]) => void]>
  >();
  private started = false;
  private closed = false;
  constructor(private readonly options: WorkerOptions) {
    super();
    if (
      new Set(options.queues).size !== options.queues.length ||
      options.queues.some((name) => !name.trim())
    )
      throw new Error("Worker queues must be unique non-empty names");
    for (const name of options.queues) {
      const concurrency = this.concurrency(name);
      if (!Number.isInteger(concurrency) || concurrency < 1)
        throw new Error("Worker concurrency must be a positive integer");
    }
  }
  private concurrency(name: string) {
    return typeof this.options.concurrency === "number"
      ? this.options.concurrency
      : (this.options.concurrency?.[name] ?? 1);
  }
  private startProcessor(name: string, handler: (job: Job) => Promise<any>) {
    const queue = this.options.flow.queue(name);
    if (this.options.settings) queue.configureLeaseSettings(this.options.settings);
    queue.process(this.concurrency(name), handler);
  }
  async run(): Promise<void> {
    if (this.closed) throw new Error("Worker is closed");
    if (this.started) return;
    this.started = true;
    this.options.flow.metrics.registerWorker(this);
    for (const name of this.options.queues) {
      const queue = this.options.flow.queue(name);
      const listeners: Array<[QueueEvent, (...args: any[]) => void]> = (
        ["active", "completed", "failed", "progress", "stalled"] as QueueEvent[]
      ).map((event) => [event, (...args: any[]) => this.emit(event, ...args)]);
      for (const [event, listener] of listeners) queue.on(event, listener);
      this.subscriptions.set(queue, listeners);
      const handler = this.handlers.get(name);
      if (handler) this.startProcessor(name, handler);
    }
    this.emit("ready");
  }
  register(queueName: string, handler: (job: Job) => Promise<any>): void {
    if (this.closed) throw new Error("Worker is closed");
    if (!this.options.queues.includes(queueName))
      throw new Error("Queue is outside this worker binding");
    if (this.handlers.has(queueName))
      throw new Error("A processor is already registered for this queue");
    if (typeof handler !== "function")
      throw new Error("A processor must be a function");
    this.handlers.set(queueName, handler);
    if (this.started) this.startProcessor(queueName, handler);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit("closing");
    try {
      await Promise.all(
        [...this.handlers.keys()].map((name) =>
          this.options.flow.queue(name).close(),
        ),
      );
    } finally {
      for (const [queue, listeners] of this.subscriptions)
        for (const [event, listener] of listeners) queue.off(event, listener);
      this.subscriptions.clear();
      this.options.flow.metrics.unregisterWorker(this);
      this.emit("closed");
    }
  }
}
export function createWorker(options: WorkerOptions): Worker {
  return new Worker(options);
}
