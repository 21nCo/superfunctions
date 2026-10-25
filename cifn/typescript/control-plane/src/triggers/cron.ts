import { Scheduler, type ShutdownOptions } from "@flowfn/core";
import { prepareRun, acceptRun } from "../dispatch/prepare.js";
import type { SecFnClient } from "../secrets/secfn-client.js";
import type { ControlPlaneStore } from "../store/store.js";
import type { PipelineSpec } from "../pipeline/types.js";
import type { CreateRunInput } from "../store/memory-store.js";
import type { QueueClient } from "../queue/flowfn-client.js";
import { validate } from "../pipeline/validator.js";
export interface CronPipeline {
  id: string;
  spec: PipelineSpec;
  pipelineRef: { repo: string; ref: string; configPath?: string };
  cronExpression: string;
}
export interface CronSchedulerOptions {
  store: ControlPlaneStore;
  queue: QueueClient;
  secrets?: SecFnClient;
}
/** One host owner. Uses FlowFn's real UTC cron scheduler; no distributed occurrence deduplication. */
export class CronScheduler {
  private pipelines = new Map<string, CronPipeline>();
  private scheduler?: Scheduler;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  constructor(private options: CronSchedulerOptions) {}
  register(pipeline: CronPipeline): void {
    if (this.scheduler || this.stopping)
      throw Error("Stop cron scheduler before changing registrations");
    if (
      this.pipelines.size >= 100 ||
      !pipeline ||
      typeof pipeline.id !== "string" ||
      !pipeline.id ||
      pipeline.id.length > 128 ||
      this.pipelines.has(pipeline.id)
    )
      throw Error("Invalid or duplicate cron registration");
    if (
      typeof pipeline.cronExpression !== "string" ||
      pipeline.cronExpression.length > 256 ||
      pipeline.cronExpression.trim().split(/\s+/).length !== 5
    )
      throw Error("Expected five-field cron expression");
    const snapshot = JSON.parse(JSON.stringify(pipeline)) as CronPipeline;
    if (
      !snapshot.pipelineRef ||
      typeof snapshot.pipelineRef.repo !== "string" ||
      !snapshot.pipelineRef.repo ||
      typeof snapshot.pipelineRef.ref !== "string" ||
      !snapshot.pipelineRef.ref ||
      !validate(snapshot.spec).ok
    )
      throw Error("Invalid cron pipeline");
    this.pipelines.set(snapshot.id, snapshot);
  }
  async triggerPipeline(pipeline: CronPipeline): Promise<string> {
    const input: CreateRunInput = {
      pipelineSpec: pipeline.spec,
      pipelineRef: pipeline.pipelineRef,
      trigger: { type: "schedule", payload: { cron: pipeline.cronExpression } },
    };
    const prepared = await prepareRun(input, this.options.secrets);
    return (await acceptRun(this.options.store, this.options.queue, prepared))
      .id;
  }
  /** intervalMs remains accepted for source compatibility; it never overrides the cron expression. */
  start(_intervalMs?: number): Promise<void> {
    if (this.stopping)
      return Promise.reject(Error("Cron scheduler is stopping"));
    if (this.scheduler) return this.starting ?? Promise.resolve();
    const scheduler = new Scheduler();
    this.scheduler = scheduler;
    const starting = (async () => {
      try {
        // Flow validates every calendar expression with a zero-occurrence schedule
        // before any registration can admit work. No separate parser contract.
        for (const pipeline of this.pipelines.values()) {
          if (this.scheduler !== scheduler) return;
          await scheduler.schedule(
            pipeline.id,
            { pattern: pipeline.cronExpression, timezone: "UTC", limit: 0 },
            () => {},
          );
        }
        for (const pipeline of this.pipelines.values()) {
          if (this.scheduler !== scheduler) break;
          await scheduler.schedule(
            pipeline.id,
            { pattern: pipeline.cronExpression, timezone: "UTC" },
            async () => {
              if (this.scheduler !== scheduler) return;
              const input: CreateRunInput = {
                pipelineSpec: pipeline.spec,
                pipelineRef: pipeline.pipelineRef,
                trigger: {
                  type: "schedule",
                  payload: { cron: pipeline.cronExpression },
                },
              };
              try {
                const prepared = await prepareRun(input, this.options.secrets);
                if (this.scheduler !== scheduler) return;
                await acceptRun(
                  this.options.store,
                  this.options.queue,
                  prepared,
                );
              } catch {
                throw Error("Scheduled run admission failed");
              }
            },
          );
        }
      } catch {
        if (this.scheduler === scheduler) this.scheduler = undefined;
        await scheduler.close();
        throw Error("Invalid cron schedule or scheduling failure");
      }
    })();
    this.starting = starting;
    return starting;
  }
  stop(options: ShutdownOptions = {}): Promise<void> {
    if (this.stopping) return this.stopping;
    const scheduler = this.scheduler;
    this.scheduler = undefined;
    if (!scheduler) return Promise.resolve();
    const stopping = (async () => {
      await this.starting?.catch(() => {});
      await scheduler.close(options);
    })();
    this.stopping = stopping;
    // A rejected close retains the stop fence: ownership was not proved released.
    void stopping.then(
      () => {
        if (this.stopping === stopping) {
          this.stopping = undefined;
          this.starting = undefined;
        }
      },
      () => {},
    );
    return stopping;
  }
  async status() {
    return this.scheduler?.list() ?? [];
  }
  getRegisteredPipelines(): CronPipeline[] {
    return JSON.parse(JSON.stringify([...this.pipelines.values()]));
  }
}
/** Host-owned startup configuration only. Every registration must be declared by on.schedule. */
export function parseCronPipelines(value: string | undefined): CronPipeline[] {
  if (value === undefined) return [];
  if (Buffer.byteLength(value) > 500 * 1024)
    throw Error("Cron configuration exceeds limit");
  let entries: unknown;
  try {
    entries = JSON.parse(value);
  } catch {
    throw Error("Invalid cron configuration");
  }
  if (!Array.isArray(entries) || entries.length > 100)
    throw Error("Invalid cron configuration");
  for (const entry of entries) {
    if (
      !entry ||
      !Array.isArray(entry.spec?.on?.schedule) ||
      !entry.spec.on.schedule.some(
        (s: unknown) =>
          !!s &&
          typeof s === "object" &&
          "cron" in s &&
          s.cron === entry.cronExpression,
      )
    )
      throw Error("Cron expression must be declared in pipeline on.schedule");
  }
  return entries as CronPipeline[];
}
