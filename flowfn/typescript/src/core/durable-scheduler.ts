import { boundedShutdown, shutdownTimeout, type ShutdownOptions } from './shutdown.js';
import { OperationObserver } from '../instrumentation.js';
import { createHash, randomUUID } from 'node:crypto';
import parser from 'cron-parser';
import { Scheduler, type ScheduleOptions } from './scheduler.js';
import type { FlowAdapter } from '../adapters/base.js';
import type { WorkflowExecution } from '../workflow/types.js';

export interface ScheduleContext { signal: AbortSignal; scheduledAt: number; occurrence: string }
type Handler = (data: any, context: ScheduleContext) => any;
type Definition = { traceContext?: import('../instrumentation.js').FlowTraceContext; name: string; generation: string; options: ScheduleOptions; paused: boolean; cancelled: boolean };
type RunState = { nextRun: number; count: number; lastError?: string };
type Binding = { handler: Handler; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; abort?: () => void };
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** Durable definitions are separate from leased occurrences so cancellation can cross processes. */
export class DurableScheduler extends Scheduler {
  private bindings = new Map<string, Binding>();
  private stopping = false;
  private durableClosing?: Promise<void>;
  private work = new Set<Promise<void>>();
  private scope: string;
  constructor(private adapter: FlowAdapter, namespace = '', private leaseDuration = 30_000, private observer = new OperationObserver()) {
    super();
    this.scope = createHash('sha256').update(JSON.stringify(['scheduler', namespace])).digest('hex');
    if (!Number.isSafeInteger(leaseDuration) || leaseDuration <= 0) throw new Error('Invalid scheduler lease duration');
  }
  private key(name: string) { return `${this.scope}:${createHash('sha256').update(name).digest('hex')}`; }
  private record(id: string, state: any): WorkflowExecution { return { id, workflowId: this.scope, status: 'running', input: null, startedAt: Date.now(), state }; }
  private async update(id: string, change: (current: WorkflowExecution | null) => WorkflowExecution): Promise<WorkflowExecution> {
    if (!this.adapter.mutateWorkflowState) throw new Error('Adapter must support atomic scheduler ownership');
    for (;;) {
      const current = await this.adapter.loadWorkflowState(id);
      const next = await this.adapter.mutateWorkflowState(id, { expectedRevision: current ? current.revision ?? 0 : null, state: change(current) });
      if (next) return next;
    }
  }
  private nextRun(options: ScheduleOptions, now: number): number {
    return options.pattern ? parser.parseExpression(options.pattern, { currentDate: new Date(now), tz: options.timezone }).next().getTime() : now + options.every!;
  }
  private normalize(pattern: string | ScheduleOptions): ScheduleOptions {
    const options = structuredClone(typeof pattern === 'string' ? { pattern } : pattern);
    if (options.version !== undefined && (typeof options.version !== 'string' || !options.version.trim())) throw new Error('Schedule version must be nonempty');
    if (Boolean(options.pattern) === (options.every !== undefined)) throw new Error('Schedule requires exactly one cron pattern or interval');
    if (options.every !== undefined && (!Number.isFinite(options.every) || options.every <= 0)) throw new Error('Interval must be positive');
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) throw new Error('Limit must be a nonnegative integer');
    for (const date of [options.startDate, options.endDate]) if (date !== undefined && (!(date instanceof Date) || !Number.isFinite(date.getTime()))) throw new Error('Schedule dates must be valid');
    if (options.startDate && options.endDate && options.startDate > options.endDate) throw new Error('Schedule start must precede end');
    this.nextRun(options, Date.now());
    return options;
  }
  private options(definition: Definition): ScheduleOptions {
    const options = structuredClone(definition.options);
    if (options.startDate) options.startDate = new Date(options.startDate);
    if (options.endDate) options.endDate = new Date(options.endDate);
    return options;
  }
  override async schedule(name: string, pattern: string | ScheduleOptions, handler: Handler): Promise<void> {
    if (this.stopping) throw new Error('Scheduler is closed');
    if (!name.trim() || typeof handler !== 'function') throw new Error('Schedule requires a name and handler');
    const options = this.normalize(pattern);
    const id = this.key(name);
    const definition = (await this.update(id, current => {
      const existing = current?.state as Definition | undefined;
      if (existing && !existing.cancelled && canonical(existing.options) === canonical(options)) return current!;
      return this.record(id, { name, options, traceContext: this.observer.capture(), generation: randomUUID(), paused: false, cancelled: false });
    })).state as Definition;
    const runId = `${id}:${definition.generation}`;
    if (!await this.adapter.loadWorkflowState(runId)) await this.adapter.mutateWorkflowState!(runId, { expectedRevision: null, state: this.record(runId, { count: 0, nextRun: this.nextRun(options, Math.max(Date.now(), options.startDate?.getTime() ?? 0)) }) });
    const catalogId = `${this.scope}:catalog`;
    await this.update(catalogId, current => this.record(catalogId, { names: [...new Set([...(current?.state?.names ?? []), name])] }));
    const previous = this.bindings.get(name);
    if (previous?.timer) clearTimeout(previous.timer);
    previous?.abort?.();
    const binding = { handler };
    this.bindings.set(name, binding);
    this.pollLater(name, binding, 0);
  }
  override repeat(name: string, options: ScheduleOptions, handler: Handler) { return this.schedule(name, options, handler); }
  private pollLater(name: string, binding: Binding, delay = Math.min(100, this.leaseDuration / 3)) {
    if (this.stopping || this.bindings.get(name) !== binding) return;
    binding.timer = setTimeout(() => {
      const task = this.tick(name, binding).finally(() => { this.work.delete(task); binding.running = undefined; this.pollLater(name, binding); });
      binding.running = task;
      this.work.add(task);
      void task.catch(() => undefined);
    }, delay);
  }
  private async tick(name: string, binding: Binding): Promise<void> {
    const id = this.key(name);
    const definition = (await this.adapter.loadWorkflowState(id))?.state as Definition | undefined;
    if (!definition || definition.paused || definition.cancelled) return;
    const options = this.options(definition);
    const runId = `${id}:${definition.generation}`;
    let record = await this.adapter.loadWorkflowState(runId);
    if (!record) return;
    const state = record.state as RunState;
    if (state.nextRun > Date.now() || (options.limit !== undefined && state.count >= options.limit) || (options.endDate && state.nextRun > options.endDate.getTime())) return;
    const token = randomUUID();
    let deadline = performance.now() + this.leaseDuration;
    const claimed = await this.adapter.mutateWorkflowState!(runId, { expectedRevision: record.revision!, token, acquire: this.leaseDuration });
    if (!claimed) return;
    record = claimed;
    const currentDefinition = (await this.adapter.loadWorkflowState(id))?.state as Definition | undefined;
    if (this.stopping || performance.now() >= deadline || !currentDefinition || currentDefinition.paused || currentDefinition.cancelled || currentDefinition.generation !== definition.generation) {
      await this.adapter.mutateWorkflowState!(runId, { expectedRevision: record.revision!, token, release: true });
      return;
    }
    const controller = new AbortController();
    let lost = false, pending = false, renewal: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setInterval>;
    const lose = () => { lost = true; clearInterval(timer); controller.abort(); };
    binding.abort = lose;
    timer = setInterval(() => {
      if (lost) return;
      if (performance.now() >= deadline) { lose(); return; }
      if (pending) return;
      pending = true;
      renewal = (async () => {
        const latest = (await this.adapter.loadWorkflowState(id))?.state as Definition | undefined;
        if (!latest || latest.cancelled || latest.paused || latest.generation !== definition.generation || this.stopping) { lose(); return; }
        const started = performance.now();
        const renewed = await this.adapter.mutateWorkflowState!(runId, { expectedRevision: record!.revision!, token, renew: this.leaseDuration });
        if (!renewed) { lose(); return; }
        record = renewed;
        deadline = started + this.leaseDuration;
      })().catch(() => undefined).finally(() => { pending = false; });
    }, Math.min(2147483647, Math.max(1, Math.floor(this.leaseDuration / 3))));
    let error: string | undefined;
    try {
      await this.observer.run('flowfn.schedule.execute', { 'flowfn.schedule': name, 'flowfn.occurrence': `${runId}:${state.count}` }, () => binding.handler(structuredClone(options.data), { signal: controller.signal, scheduledAt: state.nextRun, occurrence: `${runId}:${state.count}` }), definition.traceContext ?? {});
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally { clearInterval(timer); binding.abort = undefined; }
    if (lost) return;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([renewal, new Promise<void>(resolve => { deadlineTimer = setTimeout(() => { lose(); resolve(); }, Math.max(0, deadline - performance.now())); })]); }
    finally { if (deadlineTimer) clearTimeout(deadlineTimer); }
    if (lost || performance.now() >= deadline) return;
    const latest = (await this.adapter.loadWorkflowState(id))?.state as Definition | undefined;
    if (!latest || latest.cancelled || latest.paused || latest.generation !== definition.generation) return;
    const next = { ...record!, state: { count: state.count + 1, nextRun: this.nextRun(options, Date.now()), ...(error ? { lastError: error } : {}) } };
    await this.adapter.mutateWorkflowState!(runId, { expectedRevision: record!.revision!, token, release: true, state: next });
  }
  override async list() {
    const names: string[] = (await this.adapter.loadWorkflowState(`${this.scope}:catalog`))?.state?.names ?? [];
    const result = [];
    for (const name of names) {
      const id = this.key(name);
      const definition = (await this.adapter.loadWorkflowState(id))?.state as Definition | undefined;
      if (!definition || definition.cancelled) continue;
      const state = (await this.adapter.loadWorkflowState(`${id}:${definition.generation}`))?.state as RunState | undefined;
      if (!state) continue;
      const options = this.options(definition);
      if ((options.limit !== undefined && state.count >= options.limit) || (options.endDate && state.nextRun > options.endDate.getTime())) continue;
      result.push({ name, count: state.count, nextRun: new Date(state.nextRun), paused: definition.paused, lastError: state.lastError });
    }
    return result;
  }
  private async control(name: string, field: 'paused' | 'cancelled', value: boolean) {
    const id = this.key(name);
    if (!await this.adapter.loadWorkflowState(id)) return;
    await this.update(id, current => ({ ...current!, state: { ...current!.state, [field]: value } }));
  }
  override cancel(name: string) { return this.control(name, 'cancelled', true); }
  override pause(name: string) { return this.control(name, 'paused', true); }
  override resume(name: string) { return this.control(name, 'paused', false); }
  override close(options: ShutdownOptions = {}): Promise<void> {
    const timeout = shutdownTimeout(options);
    if (this.durableClosing) return this.durableClosing;
    this.stopping = true;
    for (const binding of this.bindings.values()) { if (binding.timer) clearTimeout(binding.timer); binding.abort?.(); }
    return this.durableClosing = boundedShutdown(Promise.allSettled([...this.work]), timeout, 'Scheduler', () => { this.bindings.clear(); this.work.clear(); });
  }
}
