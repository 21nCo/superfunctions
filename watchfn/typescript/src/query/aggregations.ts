export type AggregationOperation =
  | "count"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "median"
  | "percentile"
  | "count_distinct"
  | "rate";

export interface AggregationConfig {
  operation: AggregationOperation;
  field?: string;
  percentile?: number;
  numerator?: { metric: string };
  denominator?: { metric: string };
}

export interface AggregationResult {
  value: number;
  count?: number;
  metadata?: Record<string, any>;
}

export class Aggregator {
  /**
   * Perform aggregation on a dataset
   */
  static aggregate(data: any[], config: AggregationConfig): AggregationResult {
    const values = config.field
      ? data
          .map((d) => this.getFieldValue(d, config.field!))
          .filter((v) => v !== undefined)
      : data;

    switch (config.operation) {
      case "count":
        return { value: data.length };

      case "sum":
        return { value: this.sum(values), count: values.length };

      case "avg":
        return { value: this.avg(values), count: values.length };

      case "min":
        return { value: this.min(values) };

      case "max":
        return { value: this.max(values) };

      case "median":
        return { value: this.percentile(values, 50) };

      case "percentile":
        if (!config.percentile) {
          throw new Error("Percentile operation requires percentile value");
        }
        return { value: this.percentile(values, config.percentile) };

      case "count_distinct":
        return { value: this.countDistinct(values) };

      case "rate":
        // Rate calculation handled externally with numerator/denominator
        return { value: 0 };

      default:
        throw new Error(`Unknown aggregation operation: ${config.operation}`);
    }
  }

  /**
   * Perform multiple aggregations on a dataset
   */
  static aggregateMultiple(
    data: any[],
    configs: Record<string, AggregationConfig>
  ): Record<string, AggregationResult> {
    const results: Record<string, AggregationResult> = {};

    for (const [name, config] of Object.entries(configs)) {
      results[name] = this.aggregate(data, config);
    }

    return results;
  }

  /**
   * Group data and aggregate each group
   */
  static groupBy(
    data: any[],
    groupByField: string | string[],
    aggregations: Record<string, AggregationConfig>
  ): Map<string, Record<string, AggregationResult>> {
    const groups = new Map<string, any[]>();
    const fields = Array.isArray(groupByField) ? groupByField : [groupByField];

    // Group data
    for (const item of data) {
      const key = fields.map((f) => this.getFieldValue(item, f)).join(":");
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(item);
    }

    // Aggregate each group
    const results = new Map<string, Record<string, AggregationResult>>();
    for (const [key, groupData] of groups) {
      results.set(key, this.aggregateMultiple(groupData, aggregations));
    }

    return results;
  }

  private static sum(values: number[]): number {
    return values.reduce((sum, v) => sum + v, 0);
  }

  private static avg(values: number[]): number {
    if (values.length === 0) return 0;
    return this.sum(values) / values.length;
  }

  private static min(values: number[]): number {
    if (values.length === 0) return 0;
    return Math.min(...values);
  }

  private static max(values: number[]): number {
    if (values.length === 0) return 0;
    return Math.max(...values);
  }

  private static percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
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

  private static countDistinct(values: any[]): number {
    return new Set(values).size;
  }

  private static getFieldValue(data: Record<string, any>, field: string): any {
    const parts = field.split(".");
    let value: any = data;

    for (const part of parts) {
      if (value === undefined || value === null) {
        return undefined;
      }
      value = value[part];
    }

    return value;
  }

  /**
   * Calculate rate (numerator / denominator)
   */
  static calculateRate(numerator: number, denominator: number): number {
    if (denominator === 0) return 0;
    return numerator / denominator;
  }

  /**
   * Calculate percentile rank of a value
   */
  static percentileRank(values: number[], target: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.filter((v) => v < target).length;
    return (count / sorted.length) * 100;
  }

  /**
   * Calculate standard deviation
   */
  static stdDev(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = this.avg(values);
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    const variance = this.avg(squaredDiffs);
    return Math.sqrt(variance);
  }
}
