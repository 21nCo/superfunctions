import { QueryOptions, QueryResult, AggregateOptions, Aggregation } from "./types";
import { StorageAdapter } from "../storage/types";
import { TimeRangeParser, AbsoluteTimeRange } from "./time-range";

export class QueryValidationError extends Error {
  constructor(message: string) { super(message); this.name = "QueryValidationError"; }
}

export class QueryEngine {
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async aggregate(options: AggregateOptions): Promise<QueryResult> {
    if (!this.isRecord(options)) throw new QueryValidationError("Aggregation options must be an object");
    const { aggregation, field, percentile, numerator, denominator, ...query } = options;
    const shorthand = typeof aggregation === "string" && /^p(?:\d+(?:\.\d+)?)$/.test(aggregation);
    const config: Aggregation = {
      operation: shorthand ? "percentile" : aggregation as Aggregation["operation"],
      field: field ?? (aggregation === "count" ? undefined : "value"),
      percentile: shorthand ? Number(aggregation.slice(1)) : percentile,
      numerator, denominator,
    };
    return this.executeInternal({ ...query, aggregations: { value: config } }, field === undefined && aggregation !== "count" && aggregation !== "rate");
  }

  async execute(options: QueryOptions): Promise<QueryResult> {
    return this.executeInternal(options);
  }

  private async executeInternal(options: QueryOptions, scalarMetric = false): Promise<QueryResult> {
    this.validateOptions(options);
    const start = Date.now();
    let range: AbsoluteTimeRange | undefined;
    try { range = options.timeRange === undefined ? undefined : this.parseRange(options.timeRange); }
    catch (error) { throw new QueryValidationError(error instanceof Error ? error.message : "Invalid time range"); }
    const grouping = this.grouping(options.groupBy);
    let aggregations = options.aggregations;
    const rates = Object.values(aggregations ?? {}).filter(config => config.operation === "rate");
    let data: any[] = [];
    
    // Check if storage has specialized query capabilities
    if ("executeQuery" in this.storage && typeof (this.storage as any).executeQuery === "function") {
        // Storage must return raw matching events, not pre-limited or aggregated rows.
        data = await (this.storage as any).executeQuery({
          ...(scalarMetric || rates.length ? {} : { metric: options.metric }), where: options.where, timeRange: options.timeRange, resolvedTimeRange: range,
        });
    } else {
        // Fallback to in-memory filtering (fetching all might be bad for DB, but fine for memory)
        data = (this.storage.getAll ? await this.storage.getAll() : []) || [];
    }

    // 1. Filter by metric
    if (rates.length) {
      // Rate selectors share global time/where filters but select their own metrics.
      // Keep the outer metric for ordinary aggregates in each resulting group.
      const onlyRates = Object.values(aggregations!).every(config => config.operation === "rate");
      if (options.metric || onlyRates) {
        const metrics = new Set([...(options.metric ? [options.metric] : []), ...rates.flatMap(config => [config.numerator!.metric, config.denominator!.metric])]);
        data = data.filter(event => metrics.has(event.name) || metrics.has(event.type));
      }
    } else if (options.metric) {
      const exact = data.filter((e) => e.name === options.metric || e.type === options.metric);
      if (scalarMetric && exact.length === 0 && options.metric.includes(".")) {
        const at = options.metric.lastIndexOf(".");
        const name = options.metric.slice(0, at);
        const field = options.metric.slice(at + 1);
        data = data.filter((event) => event.name === name || event.type === name);
        aggregations = { value: { ...aggregations!.value, field } };
      } else data = exact;
    }

    // 2. Filter by where clause
    if (options.where) {
      data = data.filter((e) => this.matches(e, options.where!));
    }

    // Match both in-process Date timestamps and serialized ISO/epoch timestamps.
    if (range) {
      data = data.filter((event) => {
        const timestamp = this.timestamp(event.timestamp === undefined ? event.ts : event.timestamp);
        return Number.isFinite(timestamp) && TimeRangeParser.inRange(timestamp, range);
      });
    }

    if (aggregations) data = this.aggregateRows(data, aggregations, grouping, rates.length ? options.metric : undefined);

    // 5. Sorting
    if (options.orderBy) {
      const { field, direction } = options.orderBy;
      data = [...data].sort((a, b) => {
        const valA = aggregations && Object.prototype.hasOwnProperty.call(a, field) ? a[field] : this.getFieldValue(a, field);
        const valB = aggregations && Object.prototype.hasOwnProperty.call(b, field) ? b[field] : this.getFieldValue(b, field);
        if (valA < valB) return direction === "asc" ? -1 : 1;
        if (valA > valB) return direction === "asc" ? 1 : -1;
        return 0;
      });
    }

    // 6. Limit
    if (options.limit !== undefined) {
      data = data.slice(0, options.limit);
    }

    return {
      data,
      meta: {
        count: data.length,
        timeMs: Date.now() - start,
      },
    };
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }

  private field(value: unknown): asserts value is string {
    if (typeof value !== "string" || !value.trim() || value.split(".").some(part =>
      !part || ["__proto__", "constructor", "prototype"].includes(part))) {
      throw new QueryValidationError("Invalid query field");
    }
  }

  private validateOptions(options: QueryOptions): void {
    if (!this.isRecord(options)) throw new QueryValidationError("Query options must be an object");
    if (options.metric !== undefined && (typeof options.metric !== "string" || !options.metric.trim())) throw new QueryValidationError("Invalid metric");
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) throw new QueryValidationError("Limit must be a nonnegative integer");
    if (options.orderBy !== undefined) {
      if (!this.isRecord(options.orderBy) || !["asc", "desc"].includes(options.orderBy.direction)) throw new QueryValidationError("Invalid order direction");
      this.field(options.orderBy.field);
    }
    if (options.where !== undefined) {
      if (!this.isRecord(options.where)) throw new QueryValidationError("Where must be an object");
      for (const [field, filter] of Object.entries(options.where)) {
        this.field(field);
        if (filter !== null && typeof filter === "object") {
          if (!this.isRecord(filter) || !Object.keys(filter).length) throw new QueryValidationError("Invalid filter");
          for (const [op, value] of Object.entries(filter)) {
            if (!["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists"].includes(op)) throw new QueryValidationError("Unknown filter operator");
            if (["gt", "gte", "lt", "lte"].includes(op) && (typeof value !== "number" || !Number.isFinite(value))) throw new QueryValidationError("Ordered filter requires a finite number");
            if (op === "exists" && typeof value !== "boolean") throw new QueryValidationError("Exists requires a boolean");
            if (op === "contains" && typeof value !== "string") throw new QueryValidationError("Contains requires a string");
          }
        }
      }
    }
    const groups = this.grouping(options.groupBy);
    if (groups.length && !options.aggregations) throw new QueryValidationError("Grouping requires an aggregation");
    if (options.aggregations !== undefined) {
      if (!this.isRecord(options.aggregations) || !Object.keys(options.aggregations).length) throw new QueryValidationError("Aggregations must be a nonempty object");
      for (const [name, aggregation] of Object.entries(options.aggregations)) {
        this.field(name);
        if (groups.some(group => group.key === name)) throw new QueryValidationError("Aggregation name collides with group field");
        if (!this.isRecord(aggregation) || !["count", "sum", "avg", "min", "max", "count_distinct", "percentile", "rate"].includes(aggregation.operation)) {
          throw new QueryValidationError("Unsupported aggregation operation");
        }
        if (aggregation.operation === "rate") {
          for (const selector of [aggregation.numerator, aggregation.denominator]) {
            if (!this.isRecord(selector) || Object.keys(selector).length !== 1 || typeof selector.metric !== "string" || !selector.metric.trim()) {
              throw new QueryValidationError("Rate requires numerator and denominator metric selectors");
            }
          }
        } else if (aggregation.operation !== "count" || aggregation.field !== undefined) this.field(aggregation.field);
        if (aggregation.operation === "percentile" && (typeof aggregation.percentile !== "number" || !Number.isFinite(aggregation.percentile) || aggregation.percentile < 0 || aggregation.percentile > 100)) throw new QueryValidationError("Percentile must be between 0 and 100");
      }
    }
  }

  private grouping(value: QueryOptions["groupBy"]): Array<{ key: string; interval?: number }> {
    if (value === undefined) return [];
    const fields = Array.isArray(value) ? value : [value];
    if (!fields.length) throw new QueryValidationError("Grouping must not be empty");
    const result = fields.map(field => {
      if (typeof field === "string") { this.field(field); return { key: field }; }
      if (!this.isRecord(field) || Object.keys(field).length !== 1 || typeof field.interval !== "string") throw new QueryValidationError("Invalid time grouping");
      const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(field.interval);
      if (!match) throw new QueryValidationError("Invalid group interval");
      const unit: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
      const interval = Number(match[1]) * unit[match[2]];
      if (!Number.isSafeInteger(interval) || interval <= 0) throw new QueryValidationError("Invalid group interval");
      return { key: "timestamp", interval };
    });
    if (new Set(result.map(group => group.key)).size !== result.length) throw new QueryValidationError("Duplicate group field");
    return result;
  }

  private aggregateRows(events: any[], configs: Record<string, Aggregation>, grouping: Array<{ key: string; interval?: number }>, metric?: string): any[] {
    const groups = new Map<string, { labels: Record<string, any>; events: any[] }>();
    if (!grouping.length) groups.set("[]", { labels: {}, events: [] });
    for (const event of events) {
      const labels: Record<string, any> = {};
      let valid = true;
      for (const group of grouping) {
        let value = this.getFieldValue(event, group.key);
        if (group.interval) {
          const timestamp = this.timestamp(event.timestamp === undefined ? event.ts : event.timestamp);
          if (!Number.isFinite(timestamp)) { valid = false; break; }
          value = Math.floor(timestamp / group.interval) * group.interval;
        }
        if (value === undefined) value = null;
        if (value !== null && !["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) throw new QueryValidationError("Group fields must be finite scalar values");
        Object.defineProperty(labels, group.key, { value, enumerable: true });
      }
      if (!valid) continue;
      const key = JSON.stringify(Object.values(labels));
      if (!groups.has(key)) groups.set(key, { labels, events: [] });
      groups.get(key)!.events.push(event);
    }
    return [...groups.values()].map(group => {
      const row = { ...group.labels };
      for (const [name, config] of Object.entries(configs)) {
        Object.defineProperty(row, name, { value: this.aggregateValue(config.operation === "rate" || !metric ? group.events : group.events.filter(event => event.name === metric || event.type === metric), config), enumerable: true });
      }
      return row;
    });
  }

  private aggregateValue(events: any[], config: Aggregation): number | null {
    if (config.operation === "count") return events.length;
    if (config.operation === "rate") {
      const count = (metric: string) => events.filter(event => event.name === metric || event.type === metric).length;
      const denominator = count(config.denominator!.metric);
      return denominator === 0 ? null : count(config.numerator!.metric) / denominator;
    }
    const raw = events.map(event => this.getFieldValue(event, config.field!));
    if (config.operation === "count_distinct") {
      const values = raw.filter(value => value !== undefined && value !== null);
      if (values.some(value => !["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value))) throw new QueryValidationError("Distinct fields must be finite scalar values");
      return new Set(values).size;
    }
    const values = raw.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (!values.length) return config.operation === "sum" ? 0 : null;
    let value: number;
    switch (config.operation) {
      case "sum": value = values.reduce((sum, current) => sum + current, 0); break;
      case "avg": value = values.reduce((mean, current) => mean + current / values.length, 0); break;
      case "min": value = values.reduce((min, current) => Math.min(min, current)); break;
      case "max": value = values.reduce((max, current) => Math.max(max, current)); break;
      case "percentile": {
        const sorted = [...values].sort((a, b) => a - b);
        const index = config.percentile! / 100 * (sorted.length - 1);
        const low = Math.floor(index), high = Math.ceil(index), weight = index - low;
        value = sorted[low] * (1 - weight) + sorted[high] * weight;
        break;
      }
      default: throw new QueryValidationError("Unsupported aggregation");
    }
    if (!Number.isFinite(value)) throw new QueryValidationError("Aggregation exceeds finite numeric range");
    return value;
  }

  private matches(event: any, filters: any): boolean {
    for (const [field, filter] of Object.entries(filters)) {
      const value = this.getFieldValue(event, field);
      
      if (typeof filter !== "object" || filter === null || filter instanceof RegExp) {
        if (value !== filter) return false;
      } else {
        const f = filter as any;
        // Operator logic
        if ("eq" in f && value !== f.eq) return false;
        if ("neq" in f && value === f.neq) return false;
        if ("gt" in f && (value == null || !(value > f.gt))) return false;
        if ("gte" in f && (value == null || !(value >= f.gte))) return false;
        if ("lt" in f && (value == null || !(value < f.lt))) return false;
        if ("lte" in f && (value == null || !(value <= f.lte))) return false;
        if ("contains" in f && (value == null || !String(value).includes(f.contains))) return false;
        if ("exists" in f && f.exists === (value === undefined || value === null)) return false;
      }
    }
    return true;
  }

  private timestamp(value: unknown): number {
    if (typeof value === "number") return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string" && value.trim()) return Date.parse(value);
    return NaN;
  }

  private parseRange(value: NonNullable<QueryOptions["timeRange"]>): AbsoluteTimeRange {
    if (typeof value === "string") return this.validateRange(TimeRangeParser.parse(value));
    if (Array.isArray(value)) {
      if (value.length !== 2) throw new QueryValidationError("Time range tuple requires two bounds");
      return this.validateRange({ from: this.timestamp(value[0]), to: this.timestamp(value[1]) });
    }
    if (value.shortcut !== undefined) {
      return this.validateRange(TimeRangeParser.parse(value.shortcut));
    }
    if (value.from === undefined && value.to === undefined) throw new Error("Time range requires a bound or shortcut");
    const from = value.from === undefined ? -Infinity : this.timestamp(value.from);
    const to = value.to === undefined ? Infinity : this.timestamp(value.to);
    if ((value.from !== undefined && !Number.isFinite(from)) ||
        (value.to !== undefined && !Number.isFinite(to)) || from > to) {
      throw new Error("Invalid time range bounds");
    }
    return TimeRangeParser.parse({ from, to });
  }

  private validateRange(range: AbsoluteTimeRange): AbsoluteTimeRange {
    if (!Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from > range.to) {
      throw new Error("Invalid time range bounds");
    }
    return range;
  }

  private getFieldValue(event: any, path: string): any {
    const parts = path.split(".");
    const read = (root: any): any => {
      let value = root;
      for (const part of parts) {
        if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
        value = value[part];
      }
      return value;
    };
    // Explicit top-level fields take precedence even when false, zero, empty or null.
    if (event != null && Object.prototype.hasOwnProperty.call(event, parts[0])) return read(event);
    return read(event?.properties);
  }
}
