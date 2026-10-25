import { z } from "zod";

export const AggregationIntervalSchema = z.enum([
  "1m",
  "5m",
  "15m",
  "1h",
  "6h",
  "1d",
]);
export type AggregationInterval = z.output<typeof AggregationIntervalSchema>;

export const AggregationFunctionSchema = z.enum([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
]);
export type AggregationFunction = z.output<typeof AggregationFunctionSchema>;

export interface MetricPoint {
  timestamp: number;
  value: number;
  tags?: Record<string, string>;
}

export interface AggregatedMetric {
  metric: string;
  interval: AggregationInterval;
  timestamp: number;
  value: number;
  function: AggregationFunction;
  tags?: Record<string, string>;
}

interface RollingWindow {
  values: number[];
  timestamps: number[];
  maxSize: number;
}

export class MetricAggregator {
  private windows: Map<string, RollingWindow> = new Map();
  private aggregations: Map<string, Map<string, AggregatedMetric>> = new Map();

  constructor(
    private options: {
      intervals?: AggregationInterval[];
      functions?: AggregationFunction[];
      windowSize?: number;
      maxDataPoints?: number;
    } = {}
  ) {
    this.options.intervals = options.intervals || ["1m", "5m", "1h"];
    this.options.functions = options.functions || ["count", "avg", "p95"];
    this.options.windowSize = options.windowSize || options.maxDataPoints || 1000;
  }

  /**
   * Add a metric point and update rolling windows
   */
  add(metric: string, point: MetricPoint): void {
    const key = this.getWindowKey(metric, point.tags);
    let window = this.windows.get(key);

    if (!window) {
      window = {
        values: [],
        timestamps: [],
        maxSize: this.options.windowSize!,
      };
      this.windows.set(key, window);
    }

    window.values.push(point.value);
    window.timestamps.push(point.timestamp);

    // Keep window size in check
    if (window.values.length > window.maxSize) {
      window.values.shift();
      window.timestamps.shift();
    }

    // Trigger aggregation for configured intervals
    this.options.intervals!.forEach((interval) => {
      this.aggregateWindow(metric, interval, point.timestamp, point.tags);
    });
  }

  /**
   * Get aggregated metrics for a time range
   */
  get(
    metric: string,
    options: {
      interval: AggregationInterval;
      from: number;
      to: number;
      function?: AggregationFunction;
      tags?: Record<string, string>;
    }
  ): AggregatedMetric[];
  get(
    metric: string,
    interval: AggregationInterval,
    from: number,
    to: number,
    aggregationFunction?: AggregationFunction
  ): AggregatedMetric[];
  get(
    metric: string,
    optionsOrInterval: {
      interval: AggregationInterval;
      from: number;
      to: number;
      function?: AggregationFunction;
      tags?: Record<string, string>;
    } | AggregationInterval,
    from?: number,
    to?: number,
    aggregationFunction?: AggregationFunction
  ): AggregatedMetric[] {
    const options = typeof optionsOrInterval === "string"
      ? { interval: optionsOrInterval, from: from!, to: to!, function: aggregationFunction }
      : optionsOrInterval;
    const key = this.getAggregationKey(metric, options.interval, options.tags);
    const aggs = this.aggregations.get(key);

    if (!aggs) {
      return [];
    }

    const results: AggregatedMetric[] = [];
    for (const agg of aggs.values()) {
      const bucketEnd = agg.timestamp + this.getIntervalMs(options.interval);
      if (bucketEnd > options.from && agg.timestamp <= options.to) {
        if (!options.function || agg.function === options.function) {
          results.push(agg);
        }
      }
    }

    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  getStats(): { dataPoints: number; aggregations: number } {
    return {
      dataPoints: Array.from(this.windows.values()).reduce(
        (total, window) => total + window.values.length,
        0
      ),
      aggregations: Array.from(this.aggregations.values()).reduce(
        (total, entries) => total + entries.size,
        0
      ),
    };
  }

  /**
   * Clear old aggregations based on retention
   */
  prune(retentionMs: number): void {
    const cutoff = Date.now() - retentionMs;

    for (const [key, aggs] of this.aggregations) {
      const toDelete: string[] = [];
      for (const [aggregationKey, aggregation] of aggs) {
        if (aggregation.timestamp < cutoff) {
          toDelete.push(aggregationKey);
        }
      }
      toDelete.forEach((aggregationKey) => aggs.delete(aggregationKey));

      if (aggs.size === 0) {
        this.aggregations.delete(key);
      }
    }

    // Also prune rolling windows
    for (const [key, window] of this.windows) {
      const validIndices: number[] = [];
      window.timestamps.forEach((ts, idx) => {
        if (ts >= cutoff) {
          validIndices.push(idx);
        }
      });

      if (validIndices.length === 0) {
        this.windows.delete(key);
      } else if (validIndices.length < window.timestamps.length) {
        window.values = validIndices.map((i) => window.values[i]);
        window.timestamps = validIndices.map((i) => window.timestamps[i]);
      }
    }
  }

  private aggregateWindow(
    metric: string,
    interval: AggregationInterval,
    timestamp: number,
    tags?: Record<string, string>
  ): void {
    const intervalMs = this.getIntervalMs(interval);
    const bucketTimestamp = Math.floor(timestamp / intervalMs) * intervalMs;

    const windowKey = this.getWindowKey(metric, tags);
    const window = this.windows.get(windowKey);

    if (!window || window.values.length === 0) {
      return;
    }

    // Get values within this interval bucket
    const bucketValues = window.values.filter(
      (_, idx) =>
        window.timestamps[idx] >= bucketTimestamp &&
        window.timestamps[idx] < bucketTimestamp + intervalMs
    );

    if (bucketValues.length === 0) {
      return;
    }

    // Calculate each aggregation function
    this.options.functions!.forEach((func) => {
      const value = this.calculateAggregation(bucketValues, func);
      const aggKey = this.getAggregationKey(metric, interval, tags);

      let aggs = this.aggregations.get(aggKey);
      if (!aggs) {
        aggs = new Map();
        this.aggregations.set(aggKey, aggs);
      }

      aggs.set(`${bucketTimestamp}:${func}`, {
        metric,
        interval,
        timestamp: bucketTimestamp,
        value,
        function: func,
        tags,
      });
    });
  }

  private calculateAggregation(
    values: number[],
    func: AggregationFunction
  ): number {
    if (values.length === 0) return 0;

    switch (func) {
      case "count":
        return values.length;
      case "sum":
        return values.reduce((sum, v) => sum + v, 0);
      case "avg":
        return values.reduce((sum, v) => sum + v, 0) / values.length;
      case "min":
        return Math.min(...values);
      case "max":
        return Math.max(...values);
      case "p50":
        return this.percentile(values, 50);
      case "p75":
        return this.percentile(values, 75);
      case "p90":
        return this.percentile(values, 90);
      case "p95":
        return this.percentile(values, 95);
      case "p99":
        return this.percentile(values, 99);
      default:
        return 0;
    }
  }

  private percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;

    if (lower === upper) {
      return sorted[lower];
    }

    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  private getIntervalMs(interval: AggregationInterval): number {
    const intervals: Record<AggregationInterval, number> = {
      "1m": 60 * 1000,
      "5m": 5 * 60 * 1000,
      "15m": 15 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "6h": 6 * 60 * 60 * 1000,
      "1d": 24 * 60 * 60 * 1000,
    };
    return intervals[interval];
  }

  private getWindowKey(metric: string, tags?: Record<string, string>): string {
    return tags ? `${metric}:${JSON.stringify(tags)}` : metric;
  }

  private getAggregationKey(
    metric: string,
    interval: AggregationInterval,
    tags?: Record<string, string>
  ): string {
    return tags
      ? `${metric}:${interval}:${JSON.stringify(tags)}`
      : `${metric}:${interval}`;
  }
}
