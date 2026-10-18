import { EventEmitter } from 'eventemitter3';
import { Worker, type WorkerOptions } from './worker.js';
import type { FlowFn } from '../core/flow-fn.js';
import type { JobHandler } from './types.js';

export interface WorkerPoolOptions {
  flow: FlowFn;
  queues: string[];
  minWorkers: number;
  maxWorkers: number;
  scaleUpThreshold: number;
  scaleDownDelay: number;
  pollInterval?: number;
  signals?: NodeJS.Signals[];
  workerOptions?: Omit<WorkerOptions, 'flow' | 'queues' | 'signals'>;
}

/** In-process worker groups sharing durable queue ownership, with bounded scaling. */
export class WorkerPool extends EventEmitter {
  private workers: Worker[] = [];
  private handlers = new Map<string, JobHandler<any>>();
  private timer?: ReturnType<typeof setInterval>;
  private scaling?: Promise<void>;
  private idleSince?: number;
  private started = false;
  private stopped = false;
  private closing?: Promise<void>;
  private onSignal = () => { void this.close().catch(error => this.emit('error', error)); };
  constructor(private options: WorkerPoolOptions) {
    super();
    if (!Number.isInteger(options.minWorkers) || options.minWorkers < 0 || !Number.isInteger(options.maxWorkers) || options.maxWorkers < 1 || options.minWorkers > options.maxWorkers) throw new Error('Invalid worker pool bounds');
    if (!Number.isInteger(options.scaleUpThreshold) || options.scaleUpThreshold < 1 || !Number.isFinite(options.scaleDownDelay) || options.scaleDownDelay < 0) throw new Error('Invalid worker pool scaling settings');
    if (options.pollInterval !== undefined && (!Number.isInteger(options.pollInterval) || options.pollInterval < 1 || options.pollInterval > 2147483647)) throw new Error('Invalid worker pool poll interval');
    // Validate bindings and worker settings even when the minimum pool size is zero.
    new Worker({ ...options.workerOptions, flow: options.flow, queues: options.queues });
  }
  register(queue: string, handler: JobHandler<any>): void {
    if (this.stopped) throw new Error('Worker pool is closed');
    if (!this.options.queues.includes(queue)) throw new Error('Queue is outside this worker pool binding');
    if (this.handlers.has(queue)) throw new Error('A processor is already registered for this queue');
    if (typeof handler !== 'function') throw new Error('A processor must be a function');
    this.handlers.set(queue, handler);
    for (const worker of this.workers) worker.register(queue, handler);
  }
  private async add(): Promise<void> {
    if (this.stopped || this.workers.length >= this.options.maxWorkers) return;
    const worker = new Worker({ ...this.options.workerOptions, flow: this.options.flow, queues: this.options.queues });
    for (const [queue, handler] of this.handlers) worker.register(queue, handler);
    for (const event of ['active', 'completed', 'failed', 'progress', 'stalled', 'error']) worker.on(event, (...args) => this.emit(event, ...args));
    this.workers.push(worker);
    try { await worker.run(); }
    catch (error) { this.workers = this.workers.filter(value => value !== worker); await worker.close().catch(() => undefined); throw error; }
    this.emit('scaled', { activeWorkers: this.workers.length });
  }
  async start(): Promise<void> {
    if (this.stopped) throw new Error('Worker pool is closed');
    if (this.started) { await this.scaling; return; }
    this.started = true;
    this.scaling = (async () => { while (!this.stopped && this.workers.length < this.options.minWorkers) await this.add(); })();
    try { await this.scaling; }
    catch (error) { this.started = false; throw error; }
    finally { this.scaling = undefined; }
    if (this.stopped) return;
    for (const signal of new Set(this.options.signals ?? [])) process.on(signal, this.onSignal);
    this.timer = setInterval(() => {
      if (this.scaling || this.stopped) return;
      this.scaling = this.scale().catch(error => { this.emit('error', error); }).finally(() => { this.scaling = undefined; });
    }, this.options.pollInterval ?? 1000);
  }
  private async scale(): Promise<void> {
    const counts = await Promise.all(this.options.queues.map(name => this.options.flow.queue(name).getJobCounts()));
    if (this.stopped) return;
    const waiting = counts.reduce((sum, value) => sum + value.waiting, 0);
    const active = counts.reduce((sum, value) => sum + value.active, 0);
    if (waiting > this.options.scaleUpThreshold || (waiting > 0 && this.workers.length === 0)) {
      this.idleSince = undefined;
      await this.add();
    } else if (waiting === 0 && active === 0) {
      this.idleSince ??= performance.now();
      if (performance.now() - this.idleSince >= this.options.scaleDownDelay && this.workers.length > this.options.minWorkers) {
        const worker = this.workers.pop()!;
        await worker.close();
        this.emit('scaled', { activeWorkers: this.workers.length });
      }
    } else this.idleSince = undefined;
  }
  async getStats() {
    return { activeWorkers: this.workers.filter(worker => worker.getStats().running).length, maxWorkers: this.options.maxWorkers, minWorkers: this.options.minWorkers, activeJobs: this.workers.reduce((sum, worker) => sum + worker.getStats().activeJobs, 0) };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const signal of new Set(this.options.signals ?? [])) process.off(signal, this.onSignal);
    return this.closing = (async () => {
      await this.scaling?.catch(() => undefined);
      const results = await Promise.allSettled(this.workers.splice(0).map(worker => worker.close()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      this.emit('closed');
    })();
  }
}
export function createWorkerPool(options: WorkerPoolOptions): WorkerPool { return new WorkerPool(options); }
