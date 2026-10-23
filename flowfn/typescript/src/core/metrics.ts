import type { Workflow } from "../workflow/types.js";
import { FlowAdapter } from "../adapters/base.js";

export interface MetricDataPoint {
  timestamp: number;
  value: number;
  tags?: Record<string, string>;
}

export interface TimeSeriesMetrics {
  dataPoints: MetricDataPoint[];

  // Aggregations
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
  p50?: number;
  p95?: number;
  p99?: number;
}

export class MetricsManager {
  private adapter: FlowAdapter;
  private metrics: Map<string, MetricDataPoint[]> = new Map();
  private maxDataPoints = 1000;

  private workers = new Set<object>();
  registerWorker(worker: object): void {
    this.workers.add(worker);
  }
  unregisterWorker(worker: object): void {
    this.workers.delete(worker);
  }
  constructor(
    adapter: FlowAdapter,
    private inventory?: {
      queues(): number;
      streams(): number;
      workflows(): Workflow[];
    },
  ) {
    this.adapter = adapter;
  }

  /**
   * Record a metric data point
   */
  record(name: string, value: number, tags?: Record<string, string>): void {
    if (!Number.isFinite(value)) throw new Error("Metric value must be finite");
    const key = this.getMetricKey(name, tags);
    if (!this.metrics.has(key)) {
      this.metrics.set(key, []);
    }

    const dataPoints = this.metrics.get(key)!;
    dataPoints.push({
      timestamp: Date.now(),
      value,
      // A series key includes every tag/value, so its private tag snapshot can
      // be shared. Public snapshots below still own independent tag objects.
      tags: tags ? (dataPoints[0]?.tags ?? { ...tags }) : undefined,
    });

    // Trim if exceeds max
    if (dataPoints.length > this.maxDataPoints) {
      this.metrics.set(key, dataPoints.slice(-this.maxDataPoints));
    }
  }

  /**
   * Get time series for a metric
   */
  getTimeSeries(
    name: string,
    options?: {
      tags?: Record<string, string>;
      since?: number;
      limit?: number;
    },
  ): TimeSeriesMetrics | null {
    const key = this.getMetricKey(name, options?.tags);
    let dataPoints = this.metrics.get(key) || [];

    if (options?.since !== undefined) {
      dataPoints = dataPoints.filter((dp) => dp.timestamp >= options.since!);
    }

    if (options?.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 0)
        throw new Error("Metric limit must be nonnegative");
      dataPoints = options.limit === 0 ? [] : dataPoints.slice(-options.limit);
    }

    if (dataPoints.length === 0) {
      return null;
    }

    return this.calculateAggregations(dataPoints);
  }

  private calculateAggregations(
    dataPoints: MetricDataPoint[],
  ): TimeSeriesMetrics {
    const values = dataPoints.map((dp) => dp.value).sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const count = values.length;

    return {
      dataPoints: dataPoints.map(point => ({
        ...point,
        tags: point.tags ? { ...point.tags } : undefined,
      })),
      min: values[0],
      max: values[count - 1],
      avg: sum / count,
      sum,
      count,
      p50: this.percentile(values, 50),
      p95: this.percentile(values, 95),
      p99: this.percentile(values, 99),
    };
  }

  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil((sorted.length * p) / 100) - 1;
    return sorted[Math.max(0, index)];
  }

  private getMetricKey(name: string, tags?: Record<string, string>): string {
    return JSON.stringify([
      name,
      Object.entries(tags ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ]);
  }

  async getQueueMetrics(name: string): Promise<any> {
    const stats = await this.adapter.getQueueStats(name);

    // Get throughput from recorded metrics
    const throughputMetrics = this.getTimeSeries("queue.throughput", {
      tags: { queue: name },
      since: Date.now() - 60000, // Last minute
    });

    const durationMetrics = this.getTimeSeries("queue.job.duration", {
      tags: { queue: name },
    });

    return {
      ...stats,
      throughput: (throughputMetrics?.sum ?? 0) / 60,
      avgDuration: durationMetrics?.avg || 0,
      p95Duration: durationMetrics?.p95 || 0,
    };
  }

  async getStreamMetrics(name: string): Promise<any> {
    const info = await this.adapter.getStreamInfo(name);

    const throughputMetrics = this.getTimeSeries("stream.throughput", {
      tags: { stream: name },
      since: Date.now() - 1000, // Last second
    });

    return {
      ...info,
      lag: (info as { lag?: number }).lag ?? null,
      throughput: throughputMetrics?.sum ?? 0,
      avgLatency:
        this.getTimeSeries("stream.latency", { tags: { stream: name } })?.avg ??
        null,
    };
  }

  async getWorkflowMetrics(name: string): Promise<any> {
    const workflow = this.inventory
      ?.workflows()
      .find((workflow) => workflow.name === name || workflow.id === name);
    if (!workflow) throw new Error(`Workflow ${name} is not registered`);
    const executions = await workflow.listExecutions();
    const done = executions.filter(
      (execution) => execution.completedAt !== undefined,
    );
    const completed = executions.filter(
      (execution) => execution.status === "completed",
    ).length;
    return {
      totalExecutions: executions.length,
      running: executions.filter(
        (execution) => execution.completedAt === undefined,
      ).length,
      completed,
      failed: executions.filter((execution) => execution.status === "failed")
        .length,
      cancelled: executions.filter(
        (execution) => execution.status === "cancelled",
      ).length,
      successRate: done.length ? (completed / done.length) * 100 : 0,
      avgDuration: done.length
        ? done.reduce(
            (sum, execution) =>
              sum + execution.completedAt! - execution.startedAt,
            0,
          ) / done.length
        : 0,
    };
  }

  async getSystemMetrics(): Promise<any> {
    const memUsage =
      typeof process !== "undefined" && process.memoryUsage
        ? process.memoryUsage().heapUsed
        : 0;

    return {
      queues: this.inventory?.queues() ?? null,
      streams: this.inventory?.streams() ?? null,
      workflows: this.inventory?.workflows().length ?? null,
      workers: this.workers.size,
      memoryUsage: memUsage,
    };
  }

  /**
   * Clear old metrics
   */
  cleanup(maxAge: number): void {
    if (!Number.isFinite(maxAge) || maxAge < 0)
      throw new Error("Metric age must be nonnegative");
    const now = Date.now();
    for (const [key, dataPoints] of this.metrics.entries()) {
      const filtered = dataPoints.filter((dp) => now - dp.timestamp < maxAge);
      if (filtered.length === 0) {
        this.metrics.delete(key);
      } else {
        this.metrics.set(key, filtered);
      }
    }
  }
}
