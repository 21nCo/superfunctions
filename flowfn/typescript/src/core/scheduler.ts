import { boundedShutdown, shutdownTimeout, type ShutdownOptions } from './shutdown.js';
import parser from "cron-parser";
export interface ScheduleOptions {
  /** Change to start a new durable schedule generation when handler behavior changes. */
  version?: string;
  pattern?: string;
  timezone?: string;
  data?: any;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  every?: number;
}
interface Task {
  options: ScheduleOptions;
  handler: (data: any) => any;
  nextRun: number;
  timer?: ReturnType<typeof setTimeout>;
  count: number;
  paused: boolean;
  running?: Promise<void>;
  lastError?: string;
}
export class Scheduler {
  private tasks = new Map<string, Task>();
  private active = new Set<Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;
  private next(options: ScheduleOptions, now: number): number {
    return options.pattern
      ? parser
          .parseExpression(options.pattern, {
            currentDate: new Date(now),
            tz: options.timezone,
          })
          .next()
          .getTime()
      : now + options.every!;
  }
  async schedule(
    name: string,
    pattern: string | ScheduleOptions,
    handler: (data: any) => any,
  ): Promise<void> {
    if (this.closed) throw new Error("Scheduler is closed");
    const options = typeof pattern === "string" ? { pattern } : { ...pattern };
    if (!name.trim() || typeof handler !== "function")
      throw new Error("Schedule requires a name and handler");
    if (Boolean(options.pattern) === (options.every !== undefined))
      throw new Error("Schedule requires exactly one cron pattern or interval");
    if (
      options.every !== undefined &&
      (!Number.isFinite(options.every) || options.every <= 0)
    )
      throw new Error("Interval must be positive");
    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 0)
    )
      throw new Error("Limit must be a nonnegative integer");
    for (const date of [options.startDate, options.endDate])
      if (date !== undefined && !Number.isFinite(date.getTime()))
        throw new Error("Schedule dates must be valid");
    if (
      options.startDate &&
      options.endDate &&
      options.startDate > options.endDate
    )
      throw new Error("Schedule start must precede end");
    const nextRun = this.next(
      options,
      Math.max(Date.now(), options.startDate?.getTime() ?? 0),
    );
    await this.cancel(name);
    if (
      options.limit === 0 ||
      (options.endDate && nextRun > options.endDate.getTime())
    )
      return;
    const task: Task = { options, handler, nextRun, count: 0, paused: false };
    this.tasks.set(name, task);
    this.plan(name, task);
  }
  repeat(name: string, options: ScheduleOptions, handler: (data: any) => any) {
    return this.schedule(name, options, handler);
  }
  private plan(name: string, task: Task) {
    if (
      this.closed ||
      task.paused ||
      this.tasks.get(name) !== task ||
      task.running
    )
      return;
    if (task.timer) clearTimeout(task.timer);
    const delay = Math.max(0, task.nextRun - Date.now());
    task.timer = setTimeout(
      () => {
        if (this.closed || task.paused || this.tasks.get(name) !== task) return;
        // Node timers cannot represent waits beyond 2^31-1 milliseconds.
        if (Date.now() < task.nextRun) {
          this.plan(name, task);
          return;
        }
        const run = Promise.resolve()
          .then(async () => {
            try {
              await task.handler(task.options.data);
              delete task.lastError;
            } catch (error) {
              task.lastError =
                error instanceof Error ? error.message : String(error);
            } finally {
              task.count++;
            }
          })
          .finally(() => {
            task.running = undefined;
            this.active.delete(run);
            if (this.tasks.get(name) !== task || this.closed) return;
            if (
              task.options.limit !== undefined &&
              task.count >= task.options.limit
            ) {
              this.tasks.delete(name);
              return;
            }
            try {
              task.nextRun = this.next(task.options, Date.now());
            } catch (error) {
              task.lastError = String(error);
              task.paused = true;
              return;
            }
            if (
              task.options.endDate &&
              task.nextRun > task.options.endDate.getTime()
            ) {
              this.tasks.delete(name);
              return;
            }
            this.plan(name, task);
          });
        task.running = run;
        this.active.add(run);
      },
      Math.min(delay, 2147483647),
    );
  }
  async list() {
    return [...this.tasks].map(([name, task]) => ({
      name,
      nextRun: new Date(task.nextRun),
      count: task.count,
      paused: task.paused,
      lastError: task.lastError,
    }));
  }
  async cancel(name: string) {
    const task = this.tasks.get(name);
    if (task?.timer) clearTimeout(task.timer);
    this.tasks.delete(name);
  }
  async pause(name: string) {
    const task = this.tasks.get(name);
    if (task) {
      task.paused = true;
      if (task.timer) clearTimeout(task.timer);
    }
  }
  async resume(name: string) {
    const task = this.tasks.get(name);
    if (task?.paused) {
      task.paused = false;
      task.nextRun = this.next(task.options, Date.now());
      this.plan(name, task);
    }
  }
  close(options: ShutdownOptions = {}): Promise<void> {
    const timeout = shutdownTimeout(options);
    if (this.closing) return this.closing;
    this.closed = true;
    for (const task of this.tasks.values()) if (task.timer) clearTimeout(task.timer);
    this.tasks.clear();
    return this.closing = boundedShutdown(Promise.all([...this.active]), timeout, 'Scheduler', () => this.active.clear());
  }
}
