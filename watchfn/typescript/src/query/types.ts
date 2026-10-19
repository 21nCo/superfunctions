export type QueryOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "exists";

export interface QueryFilter {
  [field: string]: any | { [op in QueryOperator]?: any };
}

export interface TimeRange {
  from?: string | Date | number;
  to?: string | Date | number;
  shortcut?: string;
}

export interface Aggregation {
  operation: "count" | "avg" | "sum" | "min" | "max" | "count_distinct" | "rate" | "percentile";
  field?: string;
  percentile?: number;
  numerator?: { metric: string };
  denominator?: { metric: string };
}

export type QueryGrouping = string | { interval: string };

export interface QueryOptions {
  metric?: string;
  where?: QueryFilter;
  timeRange?: string | TimeRange | [string | Date | number, string | Date | number];
  groupBy?: QueryGrouping | QueryGrouping[];
  aggregations?: Record<string, Aggregation>;
  orderBy?: { field: string; direction: "asc" | "desc" };
  limit?: number;
}

export interface QueryResult {
  data: any[];
  meta: {
    count: number;
    timeMs: number;
  };
}

/** A scalar metric aggregation produces rows with a numeric (or empty null) value. */
export interface AggregateOptions extends Omit<QueryOptions, "aggregations"> {
  aggregation: Aggregation["operation"] | `p${number}`;
  field?: string;
  percentile?: number;
  numerator?: { metric: string };
  denominator?: { metric: string };
}
