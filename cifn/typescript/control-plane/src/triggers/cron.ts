import { prepareRun, acceptRun } from '../dispatch/prepare.js';
import type { SecFnClient } from '../secrets/secfn-client.js';
import type { ControlPlaneStore } from '../store/store.js';
import type { PipelineSpec } from '../pipeline/types.js';
import type { CreateRunInput } from '../store/memory-store.js';
import type { QueueClient } from '../queue/flowfn-client.js';

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

export class CronScheduler {
  private store: ControlPlaneStore;
  private queue: QueueClient;
  private secrets?: SecFnClient;
  private pipelines: CronPipeline[] = [];
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(options: CronSchedulerOptions) {
    this.store = options.store;
    this.queue = options.queue;
    this.secrets = options.secrets;
  }

  register(pipeline: CronPipeline): void {
    this.pipelines.push(pipeline);
  }

  async triggerPipeline(pipeline: CronPipeline): Promise<string> {
    const input: CreateRunInput = {
      pipelineSpec: pipeline.spec,
      pipelineRef: pipeline.pipelineRef,
      trigger: { type: 'schedule', payload: { cron: pipeline.cronExpression } },
    };

    const prepared = await prepareRun(input, this.secrets);
    const run = await acceptRun(this.store, this.queue, prepared);

    return run.id;
  }

  start(intervalMs: number = 60_000): void {
    for (const pipeline of this.pipelines) {
      const timer = setInterval(() => {
        this.triggerPipeline(pipeline).catch(() => {});
      }, intervalMs);
      this.timers.set(pipeline.id, timer);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  getRegisteredPipelines(): CronPipeline[] {
    return [...this.pipelines];
  }
}
