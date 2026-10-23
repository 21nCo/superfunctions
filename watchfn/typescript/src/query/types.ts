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
  numerator?: any;
  denominator?: any;
}

export interface QueryOptions {
  metric?: string;
  where?: QueryFilter;
  timeRange?: string | TimeRange;
  groupBy?: string | string[] | any;
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
