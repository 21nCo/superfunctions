import { DEFAULT_SHUTDOWN_TIMEOUT, shutdownTimeout, type ShutdownOptions } from '../core/shutdown.js';
import { FlowFn } from "../core/flow-fn.js";
import { Queue, Job, QueueEvent, QueueProcessor } from "./types.js";
import { EventEmitter } from "eventemitter3";

export interface WorkerOptions {
  flow: FlowFn;
  queues: string[];
  concurrency?: number | Record<string, number>;
  settings?: { leaseDuration?: number; lockDuration?: number; lockRenewTime?: number; stalledInterval?: number; maxStalledCount?: number };
  signals?: NodeJS.Signals[];
  shutdownTimeout?: number;
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
  private processors = new Map<string, QueueProcessor>();
  private closing?: Promise<void>;
  private onFlowClose = (options: ShutdownOptions) => this.close(options);
  private signalHandler = () => { void this.close().catch(error => this.emit('error', error)); };
  constructor(private readonly options: WorkerOptions) {
    super();
    if (options.shutdownTimeout !== undefined && (!Number.isFinite(options.shutdownTimeout) || options.shutdownTimeout < 0 || options.shutdownTimeout > 2147483647)) throw new Error('Invalid shutdown timeout');
    if (options.settings?.leaseDuration !== undefined && options.settings.lockDuration !== undefined && options.settings.leaseDuration !== options.settings.lockDuration) throw new Error('Conflicting lock duration settings');
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
    const settings = this.options.settings;
    if (settings) queue.configureLeaseSettings({ leaseDuration: settings.leaseDuration ?? settings.lockDuration, leaseRenewInterval: settings.lockRenewTime, stalledInterval: settings.stalledInterval, maxStalledCount: settings.maxStalledCount });
    this.processors.set(name, queue.createProcessor(this.concurrency(name), handler));
  }
  async run(): Promise<void> {
    if (this.closed) throw new Error("Worker is closed");
    if (this.started) return;
    this.started = true;
    this.options.flow.on("closing", this.onFlowClose);
    for (const signal of new Set(this.options.signals ?? [])) process.on(signal, this.signalHandler);
    this.options.flow.metrics.registerWorker(this);
    try {
    for (const name of this.options.queues) {
      const queue = this.options.flow.queue(name);
      const listeners: Array<[QueueEvent, (...args: any[]) => void]> = (
        ["active", "completed", "failed", "progress", "stalled"] as QueueEvent[]
      ).map((event) => [event, (...args: any[]) => { if (event === 'stalled' || this.processors.get(name)?.owns(args[0]?.id)) this.emit(event, ...args); }]);
      for (const [event, listener] of listeners) queue.on(event, listener);
      this.subscriptions.set(queue, listeners);
      const handler = this.handlers.get(name);
      if (handler) this.startProcessor(name, handler);
    }
    this.emit("ready");
    } catch (error) { await this.close().catch(() => undefined); throw error; }
  }
  register(queueName: string, handler: (job: Job) => Promise<any>): void {
    if (this.closed) throw new Error("Worker is closed");
    if (!this.options.queues.includes(queueName))
      throw new Error("Queue is outside this worker binding");
    if (this.handlers.has(queueName))
      throw new Error("A processor is already registered for this queue");
    if (typeof handler !== "function")
      throw new Error("A processor must be a function");
    if (this.started) this.startProcessor(queueName, handler);
    this.handlers.set(queueName, handler);
  }
  getStats() { return { activeJobs: [...this.processors.values()].reduce((sum, processor) => sum + processor.activeJobs, 0), running: this.started && !this.closed }; }
  close(options: ShutdownOptions = {}): Promise<void> {
    const timeout = shutdownTimeout({ timeout: options.timeout ?? this.options.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT });
    if (this.closing) return this.closing;
    this.closed = true;
    this.options.flow.off("closing", this.onFlowClose);
    for (const signal of new Set(this.options.signals ?? [])) process.off(signal, this.signalHandler);
    this.closing = this.closeProcessors(timeout);
    try { this.emit("closing"); } catch { /* Observers cannot prevent processor cleanup. */ }
    return this.closing;
  }
  private async closeProcessors(timeout: number): Promise<void> {
    try {
      const results = await Promise.allSettled([...this.processors.values()].map(processor => processor.close({ timeout })));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    } finally {
      for (const [queue, listeners] of this.subscriptions)
        for (const [event, listener] of listeners) queue.off(event, listener);
      this.subscriptions.clear();
      this.options.flow.metrics.unregisterWorker(this);
      try { this.emit("closed"); } catch { /* Preserve the processor shutdown outcome. */ }
    }
  }
}
export function createWorker(options: WorkerOptions): Worker {
  return new Worker(options);
}
