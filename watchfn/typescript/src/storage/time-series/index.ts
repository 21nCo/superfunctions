import { DataCompressor } from "../../utils/compression";

export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
  tags?: Record<string, string>;
}

export interface TimeSeriesMetadata {
  metric: string;
  interval: string;
  aggregation: string;
  firstTimestamp: number;
  lastTimestamp: number;
  count: number;
  compressed: boolean;
}

export interface TimeSeriesBucket {
  metadata: TimeSeriesMetadata;
  points: TimeSeriesPoint[];
  compressedData?: Buffer;
}

export class TimeSeriesDatabase {
  private buckets: Map<string, TimeSeriesBucket> = new Map();
  private compressionEnabled: boolean;
  private compressionThreshold: number;

  constructor(
    options: {
      compressionEnabled?: boolean;
      compressionThreshold?: number; // Number of points before compression
    } = {}
  ) {
    this.compressionEnabled = options.compressionEnabled ?? true;
    this.compressionThreshold = options.compressionThreshold ?? 100;
  }

  /**
   * Write a time series point
   */
  async write(metric: string, point: TimeSeriesPoint): Promise<void> {
    const key = this.getBucketKey(metric, point.timestamp, point.tags);
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        metadata: {
          metric,
          interval: this.getInterval(point.timestamp),
          aggregation: "raw",
          firstTimestamp: point.timestamp,
          lastTimestamp: point.timestamp,
          count: 0,
          compressed: false,
        },
        points: [],
      };
      this.buckets.set(key, bucket);
    }

    // Decompress if needed
    if (bucket.metadata.compressed && bucket.compressedData) {
      bucket.points = await DataCompressor.decompress(bucket.compressedData);
      bucket.metadata.compressed = false;
      delete bucket.compressedData;
    }

    bucket.points.push(point);
    bucket.metadata.lastTimestamp = point.timestamp;
    bucket.metadata.count++;

    // Compress if threshold reached
    if (
      this.compressionEnabled &&
      bucket.points.length >= this.compressionThreshold
    ) {
      await this.compressBucket(key, bucket);
    }
  }

  /**
   * Write multiple points in batch
   */
  async writeBatch(metric: string, points: TimeSeriesPoint[]): Promise<void> {
    for (const point of points) {
      await this.write(metric, point);
    }
  }

  /**
   * Read time series data for a time range
   */
  async read(
    metric: string,
    from: number,
    to: number,
    tags?: Record<string, string>
  ): Promise<TimeSeriesPoint[]> {
    const results: TimeSeriesPoint[] = [];

    for (const [key, bucket] of this.buckets) {
      if (!this.matchesBucket(bucket, metric, from, to, tags)) {
        continue;
      }

      let points = bucket.points;
      if (bucket.metadata.compressed && bucket.compressedData) {
        points = await DataCompressor.decompress(bucket.compressedData);
      }

      for (const point of points) {
        if (point.timestamp >= from && point.timestamp <= to) {
          results.push(point);
        }
      }
    }

    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Query aggregated data
   */
  async query(options: {
    metric: string;
    from: number;
    to: number;
    aggregation: "avg" | "sum" | "min" | "max" | "count";
    interval?: string;
    tags?: Record<string, string>;
  }): Promise<TimeSeriesPoint[]> {
    const points = await this.read(
      options.metric,
      options.from,
      options.to,
      options.tags
    );

    if (!options.interval) {
      // Return raw points
      return points;
    }

    // Group by interval and aggregate
    const intervalMs = this.parseInterval(options.interval);
    const buckets = new Map<number, number[]>();

    for (const point of points) {
      const bucketTs = Math.floor(point.timestamp / intervalMs) * intervalMs;
      if (!buckets.has(bucketTs)) {
        buckets.set(bucketTs, []);
      }
      buckets.get(bucketTs)!.push(point.value);
    }

    const results: TimeSeriesPoint[] = [];
    for (const [timestamp, values] of buckets) {
      const value = this.aggregate(values, options.aggregation);
      results.push({ timestamp, value });
    }

    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Delete old data based on retention
   */
  async prune(retentionMs: number): Promise<number> {
    const cutoff = Date.now() - retentionMs;
    let deleted = 0;

    for (const [key, bucket] of this.buckets) {
      if (bucket.metadata.lastTimestamp < cutoff) {
        this.buckets.delete(key);
        deleted++;
      } else if (bucket.metadata.firstTimestamp < cutoff) {
        // Partial bucket deletion
        let points = bucket.points;
        if (bucket.metadata.compressed && bucket.compressedData) {
          points = await DataCompressor.decompress(bucket.compressedData);
        }

        const filtered = points.filter((p) => p.timestamp >= cutoff);
        bucket.points = filtered;
        bucket.metadata.count = filtered.length;
        bucket.metadata.firstTimestamp = filtered[0]?.timestamp || cutoff;

        if (bucket.metadata.compressed) {
          await this.compressBucket(key, bucket);
        }
      }
    }

    return deleted;
  }

  /**
   * Get storage statistics
   */
  getStats(): {
    buckets: number;
    totalPoints: number;
    compressedBuckets: number;
    uncompressedBuckets: number;
  } {
    let totalPoints = 0;
    let compressedBuckets = 0;
    let uncompressedBuckets = 0;

    for (const bucket of this.buckets.values()) {
      totalPoints += bucket.metadata.count;
      if (bucket.metadata.compressed) {
        compressedBuckets++;
      } else {
        uncompressedBuckets++;
      }
    }

    return {
      buckets: this.buckets.size,
      totalPoints,
      compressedBuckets,
      uncompressedBuckets,
    };
  }

  private async compressBucket(
    key: string,
    bucket: TimeSeriesBucket
  ): Promise<void> {
    bucket.compressedData = await DataCompressor.compress(bucket.points);
    bucket.points = [];
    bucket.metadata.compressed = true;
  }

  private matchesBucket(
    bucket: TimeSeriesBucket,
    metric: string,
    from: number,
    to: number,
    tags?: Record<string, string>
  ): boolean {
    if (bucket.metadata.metric !== metric) {
      return false;
    }

    if (
      bucket.metadata.lastTimestamp < from ||
      bucket.metadata.firstTimestamp > to
    ) {
      return false;
    }

    if (tags && bucket.points[0]?.tags) {
      for (const [key, value] of Object.entries(tags)) {
        if (bucket.points[0].tags[key] !== value) {
          return false;
        }
      }
    }

    return true;
  }

  private getBucketKey(
    metric: string,
    timestamp: number,
    tags?: Record<string, string>
  ): string {
    const interval = this.getInterval(timestamp);
    const tagStr = tags ? JSON.stringify(tags) : "";
    return `${metric}:${interval}:${tagStr}`;
  }

  private getInterval(timestamp: number): string {
    // Bucket by hour
    const hour = Math.floor(timestamp / (60 * 60 * 1000)) * (60 * 60 * 1000);
    return new Date(hour).toISOString();
  }

  private parseInterval(interval: string): number {
    const match = interval.match(/^(\d+)(m|h|d)$/);
    if (!match) throw new Error(`Invalid interval: ${interval}`);

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return value * multipliers[unit];
  }

  private aggregate(values: number[], aggregation: string): number {
    if (values.length === 0) return 0;

    switch (aggregation) {
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
      default:
        return 0;
    }
  }
}
