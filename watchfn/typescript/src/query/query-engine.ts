import { QueryOptions, QueryResult } from "./types";
import { StorageAdapter } from "../storage/types";

export class QueryEngine {
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async execute(options: QueryOptions): Promise<QueryResult> {
    const start = Date.now();
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

    // 3. Filter by timeRange (simplified)
    if (options.timeRange) {
        // TODO: Implement time range filtering
    }

    // 4. Aggregations (simplified)
    if (options.aggregations) {
        // TODO: Implement aggregations
    }

    // 5. Sorting
    if (options.orderBy) {
      const { field, direction } = options.orderBy;
      data.sort((a, b) => {
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
        if ("gt" in f && value <= f.gt) return false;
        if ("gte" in f && value < f.gte) return false;
        if ("lt" in f && value >= f.lt) return false;
        if ("lte" in f && value > f.lte) return false;
        if ("contains" in f && !String(value).includes(f.contains)) return false;
        if ("exists" in f && f.exists === (value === undefined || value === null)) return false;
      }
    }
    return true;
  }

  private getFieldValue(event: any, path: string): any {
    if (path.startsWith("properties.")) {
        return event.properties?.[path.split(".")[1]];
    }
    return event[path] || event.properties?.[path];
  }
}
