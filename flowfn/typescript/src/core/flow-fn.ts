import { FlowAdapter } from "../adapters/base.js";
import { MemoryAdapter } from "../adapters/memory.js";
import { Queue, QueueOptions } from "../queue/types.js";
import { QueueImpl } from "../queue/queue.js";
import { Stream, StreamOptions } from "../stream/types.js";
import { StreamImpl } from "../stream/stream.js";
import { Workflow, WorkflowBuilder } from "../workflow/types.js";
import { WorkflowBuilderImpl } from "../workflow/workflow.js";
import { Scheduler } from "./scheduler.js";
import { MetricsManager } from "./metrics.js";
import {
  HealthCheckerImpl,
  HealthStatus,
  MemoryEventTracker,
  EventTracker,
} from "../monitoring/health.js";
import EventEmitter from "eventemitter3";

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

  scheduler(): Scheduler;

  metrics: MetricsManager;
  healthCheck(): Promise<HealthStatus>;
  getEventTracker(): EventTracker;

  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;

  close(): Promise<void>;
}

export class FlowFnImpl extends EventEmitter implements FlowFn {
  private adapter: FlowAdapter;
  private queues: Map<string, Queue> = new Map();
  private streams: Map<string, Stream> = new Map();
  private _metrics: MetricsManager;
  private _scheduler: Scheduler;
  private healthChecker: HealthCheckerImpl;
  private eventTracker: EventTracker;
  private startTime: number;

  constructor(config: FlowFnConfig) {
    super();
    this.startTime = Date.now();

    if (config.adapter === "memory") {
      this.adapter = new MemoryAdapter();
    } else if (typeof config.adapter === "string") {
      // Placeholder for other string-based adapter inits
      throw new Error(
        `Adapter ${config.adapter} not automatically initialized yet. Pass an instance.`
      );
    } else {
      this.adapter = config.adapter;
    }

    this._metrics = new MetricsManager(this.adapter);
    this._scheduler = new Scheduler();
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
    if (!this.queues.has(name)) {
      this.queues.set(name, new QueueImpl<T>(name, this.adapter, options));
    }
    return this.queues.get(name) as Queue<T>;
  }

  async listQueues(): Promise<string[]> {
    return Array.from(this.queues.keys());
  }

  stream<T = any>(name: string, options?: StreamOptions): Stream<T> {
    if (!this.streams.has(name)) {
      this.streams.set(name, new StreamImpl<T>(name, this.adapter, options));
    }
    return this.streams.get(name) as Stream<T>;
  }

  async listStreams(): Promise<string[]> {
    return Array.from(this.streams.keys());
  }

  workflow<T = any>(name: string): WorkflowBuilder<T> {
    return new WorkflowBuilderImpl<T>(name, this.adapter);
  }

  async listWorkflows(): Promise<Workflow[]> {
    return [];
  }

  scheduler(): Scheduler {
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
    await this.adapter.cleanup();
    for (const q of this.queues.values()) await q.close();
    for (const s of this.streams.values()) await s.close();
  }
}

export function createFlow(config: FlowFnConfig): FlowFn {
  return new FlowFnImpl(config);
}
