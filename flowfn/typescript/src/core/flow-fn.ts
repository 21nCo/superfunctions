import { FlowAdapter } from "../adapters/base.js";
import { MemoryAdapter } from "../adapters/memory.js";
import { Queue, QueueOptions } from "../queue/types.js";
import { QueueImpl } from "../queue/queue.js";
import { Stream, StreamOptions } from "../stream/types.js";
import { StreamImpl } from "../stream/stream.js";
import {
  Workflow,
  WorkflowBuilder,
  ApprovalDecision,
} from "../workflow/types.js";
import { WorkflowBuilderImpl } from "../workflow/workflow.js";
import { DurableScheduler } from "./durable-scheduler.js";
import { MetricsManager } from "./metrics.js";
import {
  HealthCheckerImpl,
  HealthStatus,
  MemoryEventTracker,
  EventTracker,
} from "../monitoring/health.js";
import { EventEmitter } from "eventemitter3";

export interface FlowFnConfig {
  adapter:
    | FlowAdapter
    | "memory"
    | "redis"
    | "postgres"
    | "d1"
    | "sqs"
    | "kafka";
  namespace?: string;
  defaultJobOptions?: any;
  defaultQueueOptions?: QueueOptions;
  defaultStreamOptions?: StreamOptions;
  telemetry?: {
    enabled: boolean;
    provider?: "opentelemetry" | "custom";
  };
  onError?: (error: Error, context: any) => void;
}

export interface FlowFn {
  queue<T = any>(name: string, options?: QueueOptions): Queue<T>;
  listQueues(): Promise<string[]>;

  stream<T = any>(name: string, options?: StreamOptions): Stream<T>;
  listStreams(): Promise<string[]>;

  workflow<T = any>(name: string): WorkflowBuilder<T>;
  listWorkflows(): Promise<Workflow[]>;
  steps<T = any>(): WorkflowBuilder<T>;
  signalWorkflow(executionId: string, event: string, data?: any): Promise<void>;
  approveWorkflow(
    executionId: string,
    decision: ApprovalDecision,
  ): Promise<void>;

  scheduler(): DurableScheduler;

  metrics: MetricsManager;
  healthCheck(): Promise<HealthStatus>;
  getEventTracker(): EventTracker;

  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;

  close(): Promise<void>;
}

export class FlowFnImpl extends EventEmitter implements FlowFn {
  private adapter: FlowAdapter;
  private workflows = new Map<string, Workflow>();
  private workflowNamespace: string;
  private closed = false;
  private defaultQueueOptions?: QueueOptions;
  private defaultStreamOptions?: StreamOptions;
  private queues: Map<string, Queue> = new Map();
  private streams: Map<string, Stream> = new Map();
  private _metrics: MetricsManager;
  private _scheduler: DurableScheduler;
  private healthChecker: HealthCheckerImpl;
  private eventTracker: EventTracker;
  private startTime: number;

  constructor(config: FlowFnConfig) {
    super();
    this.startTime = Date.now();
    this.workflowNamespace = config.namespace ?? "";

    if (config.adapter === "memory") {
      this.adapter = new MemoryAdapter();
    } else if (typeof config.adapter === "string") {
      // Placeholder for other string-based adapter inits
      throw new Error(
        `Adapter ${config.adapter} not automatically initialized yet. Pass an instance.`,
      );
    } else {
      this.adapter = config.adapter;
    }

    this.defaultQueueOptions = {
      ...config.defaultQueueOptions,
      defaultJobOptions: {
        ...config.defaultJobOptions,
        ...config.defaultQueueOptions?.defaultJobOptions,
      },
    };
    this.defaultStreamOptions = config.defaultStreamOptions;
    if (config.namespace) {
      const original = this.adapter;
      const scoped = new Set([
        "enqueue",
        "createJob",
        "renewJobLease",
        "recoverStalledJobs",
        "dequeue",
        "ack",
        "nack",
        "saveJob",
        "removeJob",
        "publish",
        "subscribe",
        "consume",
        "createConsumerGroup",
        "getJob",
        "getJobs",
        "getAllJobs",
        "cleanJobs",
        "getQueueStats",
        "getStreamInfo",
        "getMessages",
        "trimStream",
      ]);
      this.adapter = new Proxy(original, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return scoped.has(String(property))
            ? (name: string, ...args: any[]) =>
                value.call(
                  target,
                  JSON.stringify([config.namespace, name]),
                  ...args,
                )
            : value.bind(target);
        },
      });
    }
    this._metrics = new MetricsManager(this.adapter, {
      queues: () => this.queues.size,
      streams: () => this.streams.size,
      workflows: () => [...this.workflows.values()],
    });
    this._scheduler = new DurableScheduler(this.adapter, this.workflowNamespace);
    this.healthChecker = new HealthCheckerImpl();
    this.eventTracker = new MemoryEventTracker();

    // Add custom health checks
    this.setupHealthChecks();
  }

  private setupHealthChecks(): void {
    // Queue health check
    this.healthChecker.addCheck("queues", async () => {
      const queueCount = this.queues.size;
      return {
        name: "queues",
        status: "pass",
        details: {
          count: queueCount,
          active: Array.from(this.queues.keys()),
        },
      };
    });

    // Adapter health check
    this.healthChecker.addCheck("adapter", async () => {
      try {
        // Simple ping check
        await this.adapter.getQueueStats("health-check");
        return {
          name: "adapter",
          status: "pass",
          message: "Adapter responding",
        };
      } catch (error) {
        return {
          name: "adapter",
          status: "fail",
          message: (error as Error).message,
        };
      }
    });
  }

  queue<T = any>(name: string, options?: QueueOptions): Queue<T> {
    if (this.closed) throw new Error("FlowFn is closed");
    if (!this.queues.has(name)) {
      this.queues.set(
        name,
        new QueueImpl<T>(name, this.adapter, {
          ...this.defaultQueueOptions,
          ...options,
          defaultJobOptions: {
            ...this.defaultQueueOptions?.defaultJobOptions,
            ...options?.defaultJobOptions,
          },
        }),
      );
      const queue = this.queues.get(name)!;
      for (const event of [
        "waiting",
        "active",
        "completed",
        "failed",
        "progress",
        "stalled",
      ] as const) {
        queue.on(event, (...args) => {
          if (event === "completed" || event === "failed") {
            const job = args[0];
            this._metrics.record("queue.throughput", 1, { queue: name });
            if (job.finishedOn !== undefined && job.processedOn !== undefined)
              this._metrics.record(
                "queue.job.duration",
                Math.max(0, job.finishedOn - job.processedOn),
                { queue: name },
              );
          }
          const job = args[0];
          this.emit(`job:${event === "waiting" ? "created" : event}`, {
            queue: name,
            jobId: job.id,
            duration:
              job.finishedOn !== undefined && job.processedOn !== undefined
                ? Math.max(0, job.finishedOn - job.processedOn)
                : undefined,
            error: event === "failed" ? args[1] : undefined,
            result: event === "completed" ? args[1] : undefined,
            progress: event === "progress" ? args[1] : undefined,
          });
          this.emit(`queue:${event}`, name, ...args);
        });
      }
    }
    return this.queues.get(name) as Queue<T>;
  }

  async listQueues(): Promise<string[]> {
    return Array.from(this.queues.keys());
  }

  stream<T = any>(name: string, options?: StreamOptions): Stream<T> {
    if (this.closed) throw new Error("FlowFn is closed");
    if (!this.streams.has(name)) {
      this.streams.set(
        name,
        new StreamImpl<T>(
          name,
          this.adapter,
          {
            ...this.defaultStreamOptions,
            ...options,
          },
          (metric, value) =>
            this._metrics.record(metric, value, { stream: name }),
        ),
      );
    }
    return this.streams.get(name) as Stream<T>;
  }

  async listStreams(): Promise<string[]> {
    return Array.from(this.streams.keys());
  }

  workflow<T = any>(name: string): WorkflowBuilder<T> {
    if (this.closed) throw new Error("FlowFn is closed");
    return new WorkflowBuilderImpl<T>(
      name,
      this.adapter,
      (workflow) => {
        if (this.workflows.has(workflow.id))
          throw new Error(`Workflow ${name} is already registered`);
        this.workflows.set(workflow.id, workflow);
      },
      this.workflowNamespace,
      (event, data) => {
        this.emit(event, data);
      },
    );
  }

  async listWorkflows(): Promise<Workflow[]> {
    return [...this.workflows.values()];
  }

  steps<T = any>(): WorkflowBuilder<T> {
    return new WorkflowBuilderImpl<T>("branch", this.adapter);
  }

  private async owningWorkflow(executionId: string): Promise<Workflow> {
    const stored = await this.adapter.loadWorkflowState(executionId);
    const workflow = stored && this.workflows.get(stored.workflowId);
    if (!workflow)
      throw new Error("Execution does not belong to a registered workflow");
    return workflow;
  }
  async signalWorkflow(
    executionId: string,
    event: string,
    data?: any,
  ): Promise<void> {
    await (
      await this.owningWorkflow(executionId)
    ).signalEvent(executionId, event, data);
  }
  async approveWorkflow(
    executionId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await (
      await this.owningWorkflow(executionId)
    ).approveExecution(executionId, decision);
  }

  scheduler(): DurableScheduler {
    return this._scheduler;
  }

  get metrics(): MetricsManager {
    return this._metrics;
  }

  async healthCheck(): Promise<HealthStatus> {
    const health = await this.healthChecker.check();

    // Track health check event
    this.eventTracker.track({
      type: "health.check",
      category: "system",
      severity: health.healthy ? "info" : "warn",
      message: health.healthy ? "System healthy" : "System unhealthy",
      metadata: { checksCount: health.checks.length },
    });

    return health;
  }

  /**
   * Get event tracker
   */
  getEventTracker(): EventTracker {
    return this.eventTracker;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this._scheduler.close();
    await Promise.all(
      [...this.workflows.values()].map((workflow) => workflow.close()),
    );
    for (const q of this.queues.values()) await q.close();
    for (const s of this.streams.values()) await s.close();
    await this.adapter.cleanup();
  }
}

export function createFlow(config: FlowFnConfig): FlowFn {
  return new FlowFnImpl(config);
}
