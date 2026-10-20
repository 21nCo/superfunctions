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
    const onlyRates = rates.length > 0 && Object.values(aggregations!).every(config => config.operation === "rate");
    const metrics = new Set([...(options.metric ? [options.metric] : []), ...rates.flatMap(config => [config.numerator!.metric, config.denominator!.metric])]);
    const storageOptions = {
      ...(scalarMetric || rates.length ? {} : { metric: options.metric }),
      where: options.where, timeRange: options.timeRange, resolvedTimeRange: range,
    };
    const source = this.events(storageOptions);
    const primary = this.collector(options, aggregations, grouping, rates.length ? options.metric : undefined);
    const suffixAt = scalarMetric && options.metric?.includes(".") ? options.metric.lastIndexOf(".") : -1;
    const fallbackMetric = suffixAt >= 0 ? options.metric!.slice(0, suffixAt) : undefined;
    const fallbackConfigs = fallbackMetric === undefined ? undefined : { value: { ...aggregations!.value, field: options.metric!.slice(suffixAt + 1) } };
    let fallback = fallbackConfigs ? this.collector(options, fallbackConfigs, grouping) : undefined;
    let exactMetricSeen = false;
    for await (const event of source) {
      const exact = !options.metric || event.name === options.metric || event.type === options.metric;
      // Exact metric presence is determined before residual where/time filters,
      // matching the original suffix fallback rule. Never run a second live scan.
      if (fallback && exact) { exactMetricSeen = true; fallback = undefined; }
      let target = primary;
      if (rates.length) {
        if ((options.metric || onlyRates) && !metrics.has(event.name) && !metrics.has(event.type)) continue;
      } else if (!exact) {
        if (!fallback || (event.name !== fallbackMetric && event.type !== fallbackMetric)) continue;
        target = fallback;
      }
      if (options.where && !this.matches(event, options.where)) continue;
      if (range) {
        const timestamp = this.timestamp(event.timestamp === undefined ? event.ts : event.timestamp);
        if (!Number.isFinite(timestamp) || !TimeRangeParser.inRange(timestamp, range)) continue;
      }
      target.add(event);
    }
    if (fallbackConfigs && !exactMetricSeen) aggregations = fallbackConfigs;
    let data = (fallback ?? primary).finish();

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

  private async *events(options: any): AsyncGenerator<any> {
    if (this.storage.iterateQuery) { yield* this.storage.iterateQuery(options); return; }
    const storage = this.storage as StorageAdapter & { executeQuery?: (options: any) => Promise<any[]> };
    const rows = storage.executeQuery ? await storage.executeQuery(options) : await storage.getAll?.() ?? [];
    yield* rows;
  }

  /** Retain output rows or aggregation state, never complete grouped payloads. */
  private collector(options: QueryOptions, configs: Record<string, Aggregation> | undefined,
    grouping: Array<{ key: string; interval?: number }>, metric?: string): { add(event: any): void; finish(): any[] } {
    if (!configs) {
      const rows: any[] = [];
      return {
        add: event => { if (options.orderBy || options.limit === undefined || rows.length < options.limit) rows.push(event); },
        finish: () => rows,
      };
    }
    type State = { count: number; numerator: number; denominator: number; numericCount: number; sum: number; min?: number; max?: number; samples?: number[]; distinct?: Set<any>; invalidDistinct?: boolean };
    type Group = { labels: Record<string, any>; states: State[] };
    const entries = Object.entries(configs);
    const create = (labels: Record<string, any>): Group => ({ labels, states: entries.map(([, config]) => ({ count: 0, numerator: 0, denominator: 0, numericCount: 0, sum: 0,
      ...(["avg", "percentile"].includes(config.operation) ? { samples: [] } : {}),
      ...(config.operation === "count_distinct" ? { distinct: new Set() } : {}),
    })) });
    const groups = new Map<string, Group>();
    if (!grouping.length) groups.set("[]", create({}));
    let error: unknown;
    const add = (event: any) => {
      if (error) return;
      try {
        const labels: Record<string, any> = {};
        for (const group of grouping) {
          let value = this.getFieldValue(event, group.key);
          if (group.interval) {
            const timestamp = this.timestamp(event.timestamp === undefined ? event.ts : event.timestamp);
            if (!Number.isFinite(timestamp)) return;
            value = Math.floor(timestamp / group.interval) * group.interval;
          }
          if (value === undefined) value = null;
          if (value !== null && !["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) throw new QueryValidationError("Group fields must be finite scalar values");
          Object.defineProperty(labels, group.key, { value, enumerable: true });
        }
        const key = JSON.stringify(Object.values(labels));
        let group = groups.get(key);
        if (!group) { group = create(labels); groups.set(key, group); }
        entries.forEach(([, config], index) => {
          const state = group!.states[index];
          if (config.operation === "rate") {
            if (event.name === config.numerator!.metric || event.type === config.numerator!.metric) state.numerator++;
            if (event.name === config.denominator!.metric || event.type === config.denominator!.metric) state.denominator++;
            return;
          }
          if (metric && event.name !== metric && event.type !== metric) return;
          state.count++;
          if (config.operation === "count") return;
          const value = this.getFieldValue(event, config.field!);
          if (config.operation === "count_distinct") {
            if (value === undefined || value === null) return;
            if (!["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) state.invalidDistinct = true;
            else state.distinct!.add(value);
            return;
          }
          if (typeof value !== "number" || !Number.isFinite(value)) return;
          state.numericCount++;
          switch (config.operation) {
            case "sum": state.sum += value; break;
            case "min": state.min = state.min === undefined ? value : Math.min(state.min, value); break;
            case "max": state.max = state.max === undefined ? value : Math.max(state.max, value); break;
            // Preserve the exact existing sum(value / finalCount) arithmetic and
            // percentile interpolation; payloads are not retained with samples.
            case "avg": case "percentile": state.samples!.push(value); break;
          }
        });
      } catch (failure) { error = failure; }
    };
    const finish = () => {
      if (error) throw error;
      return [...groups.values()].map(group => {
        const row = { ...group.labels };
        entries.forEach(([name, config], index) => {
          const state = group.states[index];
          let value: number | null;
          switch (config.operation) {
            case "count": value = state.count; break;
            case "rate": value = state.denominator ? state.numerator / state.denominator : null; break;
            case "count_distinct":
              if (state.invalidDistinct) throw new QueryValidationError("Distinct fields must be finite scalar values");
              value = state.distinct!.size; break;
            case "sum": value = state.sum; break;
            case "min": value = state.min ?? null; break;
            case "max": value = state.max ?? null; break;
            case "avg": value = state.numericCount ? state.samples!.reduce((mean, current) => mean + current / state.numericCount, 0) : null; break;
            case "percentile": {
              const sorted = state.samples!;
              if (!sorted.length) { value = null; break; }
              sorted.sort((a, b) => a - b);
              const at = config.percentile! / 100 * (sorted.length - 1), low = Math.floor(at), high = Math.ceil(at), weight = at - low;
              value = sorted[low] * (1 - weight) + sorted[high] * weight;
              break;
            }
          }
          if (value !== null && !Number.isFinite(value)) throw new QueryValidationError("Aggregation exceeds finite numeric range");
          Object.defineProperty(row, name, { value, enumerable: true });
        });
        return row;
      });
    };
    return { add, finish };
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
