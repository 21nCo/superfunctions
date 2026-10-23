import { TimeSeriesPoint } from "./index";

export type AggregationFunc =
  | "avg"
  | "sum"
  | "min"
  | "max"
  | "count"
  | "p50"
  | "p95"
  | "p99";

export interface AggregationConfig {
  interval: string; // e.g., "1m", "5m", "1h", "1d"
  functions: AggregationFunc[];
  retention: number; // milliseconds
}

export interface AggregatedPoint {
  timestamp: number;
  interval: string;
  function: AggregationFunc;
  value: number;
  count: number;
}

export class TimeSeriesAggregator {
  /**
   * Aggregate time series points into intervals
   */
  aggregate(
    points: TimeSeriesPoint[],
    interval: string,
    functions: AggregationFunc[]
  ): Map<AggregationFunc, AggregatedPoint[]> {
    const intervalMs = this.parseInterval(interval);
    const buckets = this.groupByInterval(points, intervalMs);
    const results = new Map<AggregationFunc, AggregatedPoint[]>();

    for (const func of functions) {
      const aggregated: AggregatedPoint[] = [];

      for (const [bucketTs, bucketPoints] of buckets) {
        const values = bucketPoints.map((p) => p.value);
        const value = this.calculateAggregation(values, func);

        aggregated.push({
          timestamp: bucketTs,
          interval,
          function: func,
          value,
          count: values.length,
        });
      }

      results.set(func, aggregated);
    }

    return results;
  }

  /**
   * Downsample high-resolution data to lower resolution
   */
  downsample(
    points: AggregatedPoint[],
    targetInterval: string,
    func: AggregationFunc
  ): AggregatedPoint[] {
    const intervalMs = this.parseInterval(targetInterval);
    const buckets = new Map<number, AggregatedPoint[]>();

    for (const point of points) {
      const bucketTs = Math.floor(point.timestamp / intervalMs) * intervalMs;
      if (!buckets.has(bucketTs)) {
        buckets.set(bucketTs, []);
      }
      buckets.get(bucketTs)!.push(point);
    }

    const results: AggregatedPoint[] = [];
    for (const [bucketTs, bucketPoints] of buckets) {
      const values = bucketPoints.map((p) => p.value);
      const counts = bucketPoints.map((p) => p.count);

      results.push({
        timestamp: bucketTs,
        interval: targetInterval,
        function: func,
        value: this.calculateAggregation(values, func),
        count: counts.reduce((sum, c) => sum + c, 0),
      });
    }

    return results;
  }

  /**
   * Group points by interval buckets
   */
  private groupByInterval(
    points: TimeSeriesPoint[],
    intervalMs: number
  ): Map<number, TimeSeriesPoint[]> {
    const buckets = new Map<number, TimeSeriesPoint[]>();

    for (const point of points) {
      const bucketTs = Math.floor(point.timestamp / intervalMs) * intervalMs;
      if (!buckets.has(bucketTs)) {
        buckets.set(bucketTs, []);
      }
      buckets.get(bucketTs)!.push(point);
    }

    return buckets;
  }

  /**
   * Calculate aggregation function
   */
  private calculateAggregation(
    values: number[],
    func: AggregationFunc
  ): number {
    if (values.length === 0) return 0;

    switch (func) {
      case "sum":
        return values.reduce((sum, v) => sum + v, 0);
      case "avg":
        return values.reduce((sum, v) => sum + v, 0) / values.length;
      case "min":
        return Math.min(...values);
      case "max":
        return Math.max(...values);
      case "count":
        return values.length;
      case "p50":
        return this.percentile(values, 50);
      case "p95":
        return this.percentile(values, 95);
      case "p99":
        return this.percentile(values, 99);
      default:
        return 0;
    }
  }

  /**
   * Calculate percentile
   */
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

  /**
   * Parse interval string to milliseconds
   */
  private parseInterval(interval: string): number {
    const match = interval.match(/^(\d+)(m|h|d)$/);
    if (!match) {
      throw new Error(`Invalid interval: ${interval}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return value * multipliers[unit];
  }
}
