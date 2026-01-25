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

  constructor(adapter: FlowAdapter) {
    this.adapter = adapter;
  }

  /**
   * Record a metric data point
   */
  record(name: string, value: number, tags?: Record<string, string>): void {
    const key = this.getMetricKey(name, tags);
    if (!this.metrics.has(key)) {
      this.metrics.set(key, []);
    }

    const dataPoints = this.metrics.get(key)!;
    dataPoints.push({
      timestamp: Date.now(),
      value,
      tags,
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
    }
  ): TimeSeriesMetrics | null {
    const key = this.getMetricKey(name, options?.tags);
    let dataPoints = this.metrics.get(key) || [];

    if (options?.since) {
      dataPoints = dataPoints.filter((dp) => dp.timestamp >= options.since!);
    }

    if (options?.limit) {
      dataPoints = dataPoints.slice(-options.limit);
    }

    if (dataPoints.length === 0) {
      return null;
    }

    return this.calculateAggregations(dataPoints);
  }

  private calculateAggregations(
    dataPoints: MetricDataPoint[]
  ): TimeSeriesMetrics {
    const values = dataPoints.map((dp) => dp.value).sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const count = values.length;

    return {
      dataPoints,
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
    if (!tags) return name;
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(",");
    return `${name}{${tagStr}}`;
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
      throughput: throughputMetrics?.avg || 0,
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
      lag: 0,
      throughput: throughputMetrics?.avg || 0,
      avgLatency: 0,
    };
  }

  async getWorkflowMetrics(name: string): Promise<any> {
    const metricsData = this.getTimeSeries("workflow.executions", {
      tags: { workflow: name },
    });

    return {
      totalExecutions: metricsData?.count || 0,
      running: 0,
      completed: 0,
      failed: 0,
      successRate: 0,
      avgDuration: metricsData?.avg || 0,
    };
  }

  async getSystemMetrics(): Promise<any> {
    const memUsage =
      typeof process !== "undefined" && process.memoryUsage
        ? process.memoryUsage().heapUsed
        : 0;

    return {
      queues: 0,
      streams: 0,
      workflows: 0,
      workers: 0,
      memoryUsage: memUsage,
    };
  }

  /**
   * Clear old metrics
   */
  cleanup(maxAge: number): void {
    const now = Date.now();
    for (const [key, dataPoints] of this.metrics.entries()) {
      const filtered = dataPoints.filter((dp) => now - dp.timestamp <= maxAge);
      if (filtered.length === 0) {
        this.metrics.delete(key);
      } else {
        this.metrics.set(key, filtered);
      }
    }
  }
}
