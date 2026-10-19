import { QueryOptions, QueryResult } from "./types";
import { StorageAdapter } from "../storage/types";
import { TimeRangeParser, AbsoluteTimeRange } from "./time-range";

export class QueryEngine {
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async execute(options: QueryOptions): Promise<QueryResult> {
    const start = Date.now();
    const range = options.timeRange === undefined ? undefined : this.parseRange(options.timeRange);
    let data: any[] = [];
    
    // Check if storage has specialized query capabilities
    if ("executeQuery" in this.storage && typeof (this.storage as any).executeQuery === "function") {
        data = await (this.storage as any).executeQuery(options);
    } else {
        // Fallback to in-memory filtering (fetching all might be bad for DB, but fine for memory)
        data = (this.storage.getAll ? await this.storage.getAll() : []) || [];
    }

    // 1. Filter by metric
    if (options.metric) {
      data = data.filter((e) => e.name === options.metric || e.type === options.metric);
    }

    // 2. Filter by where clause
    if (options.where) {
      data = data.filter((e) => this.matches(e, options.where!));
    }

    // Match both in-process Date timestamps and serialized ISO/epoch timestamps.
    if (range) {
      data = data.filter((event) => {
        const timestamp = this.timestamp(event.timestamp);
        return Number.isFinite(timestamp) && TimeRangeParser.inRange(timestamp, range);
      });
    }

    // 4. Aggregations (simplified)
    if (options.aggregations) {
        // TODO: Implement aggregations
    }

    // 5. Sorting
    if (options.orderBy) {
      const { field, direction } = options.orderBy;
      data = [...data].sort((a, b) => {
        const valA = this.getFieldValue(a, field);
        const valB = this.getFieldValue(b, field);
        if (valA < valB) return direction === "asc" ? -1 : 1;
        if (valA > valB) return direction === "asc" ? 1 : -1;
        return 0;
      });
    }

    // 6. Limit
    if (options.limit) {
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
