import { randomUUID } from "node:crypto";
import { wrapWithSchema, type Adapter, type WhereClause } from "@superfunctions/db";
import { StorageAdapter } from "./types";
import { projectEvent, eventProjectionWhere, EVENT_PROJECTION_VERSION } from "./projection";
import { getWatchFnSchema } from "./schema";
import { BotFnBugIssues } from "../integrations/botfn/store";
import { getBugIssueSchema } from "../integrations/botfn/schema";
import type { BotFnIssueConfig } from "../integrations/botfn/types";
export { getWatchFnSchema } from "./schema";

/** @deprecated Compatibility bridge; new applications should supply a shared DB Adapter. */
export interface DatabaseAdapter {
  insertEvent(event: any): Promise<void>;
  queryEvents(params: any): Promise<any[]>;
}

export type WatchFnDatabase = Adapter | DatabaseAdapter;
interface StoredEvent { id: string; payload: Record<string, unknown> }

export class DatabaseStorage implements StorageAdapter {
  private readonly db?: Adapter;
  private readonly legacy?: DatabaseAdapter;
  readonly bugIssues?: BotFnBugIssues;

  constructor(database: WatchFnDatabase, private readonly tableName = "watchfn_events", botfn?: BotFnIssueConfig) {
    const schema = getWatchFnSchema(tableName);
    if (database && "create" in database && typeof database.create === "function" &&
        "findMany" in database && typeof database.findMany === "function") {
      this.db = wrapWithSchema(database as Adapter, schema);
      if (botfn) this.bugIssues = new BotFnBugIssues(database as Adapter, botfn, tableName);
    } else if (database && "insertEvent" in database && typeof database.insertEvent === "function" &&
        "queryEvents" in database && typeof database.queryEvents === "function") {
      if (botfn) throw new TypeError("BotFn issue ingestion requires a shared DB Adapter");
      this.legacy = database as DatabaseAdapter;
    } else {
      throw new TypeError("Database must be a shared DB Adapter or legacy insertEvent/queryEvents adapter");
    }
  }

  getSchema() { return { ...getWatchFnSchema(this.tableName), ...(this.bugIssues ? getBugIssueSchema() : {}) }; }

  async add(event: any): Promise<void> {
    if (this.bugIssues && event?.type === "bug_report") return this.bugIssues.ingest(event);
    if (this.legacy) {
      await this.legacy.insertEvent(event);
      return;
    }
    // Snapshot JSON before handing it to an asynchronous backend. Storage identity
    // is distinct from producer IDs; duplicate event IDs remain separate arrivals.
    const payload = JSON.parse(JSON.stringify(event));
    await this.db!.create({ model: this.tableName, data: { id: randomUUID(), payload, ...projectEvent(payload) } });
  }

  async query(filter: (event: any) => boolean): Promise<any[]> {
    return (await this.getAll()).filter(filter);
  }

  async getAll(): Promise<any[]> {
    if (this.legacy) return this.legacy.queryEvents({});
    const events: Record<string, unknown>[] = [];
    const pageSize = 1000;
    // Explicit pages avoid silent truncation by adapter default result limits.
    for (let offset = 0; ; offset += pageSize) {
      const rows = await this.db!.findMany<StoredEvent>({ model: this.tableName, where: [],
        orderBy: [{ field: "id", direction: "asc" }], limit: pageSize, offset });
      events.push(...rows.map(row => row.payload));
      if (rows.length < pageSize) return events;
    }
  }

  private async readRows(where: WhereClause[]): Promise<StoredEvent[]> {
    const result: StoredEvent[] = [];
    let after: string | undefined;
    for (;;) {
      const rows = await this.db!.findMany<StoredEvent>({ model: this.tableName,
        where: [...where, ...(after === undefined ? [] : [{ field: "id", operator: "gt" as const, value: after }])],
        orderBy: [{ field: "id", direction: "asc" }], limit: 1000 });
      result.push(...rows);
      if (rows.length < 1000) return result;
      after = rows[rows.length - 1].id;
    }
  }

  /** Offline migration step: stop all writers/workers; resume until nextCursor is null. */
  async backfillEventProjections(options: { after?: string; limit?: number } = {}): Promise<{ processed: number; nextCursor: string | null }> {
    if (!this.db) throw new Error("Event projection backfill requires a shared DB Adapter");
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || (options.after !== undefined && (typeof options.after !== "string" || !options.after.length || options.after.length > 512))) throw new TypeError("Invalid event projection backfill page");
    // Explicitly select every projection column first: missing migrations fail
    // before any updates, including an empty legacy table.
    await this.db.findMany({ model: this.tableName, where: [], select: ["id", ...Object.keys(projectEvent({}))], limit: 1 });
    const rows = await this.db.findMany<StoredEvent>({ model: this.tableName,
      where: options.after === undefined ? [] : [{ field: "id", operator: "gt", value: options.after }],
      orderBy: [{ field: "id", direction: "asc" }], limit });
    for (const row of rows) {
      const updated = await this.db.updateMany({ model: this.tableName, where: [{ field: "id", operator: "eq", value: row.id }], data: projectEvent(row.payload) });
      if (updated !== 1) throw new Error("Event changed during offline projection backfill");
    }
    return { processed: rows.length, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null };
  }

  async executeQuery(options: any): Promise<any[]> {
    if (this.legacy) {
      if (!options || typeof options !== "object") return this.legacy.queryEvents(options);
      const { resolvedTimeRange: _internalRange, ...legacyOptions } = options;
      return this.legacy.queryEvents(legacyOptions);
    }
    const predicates = eventProjectionWhere(options);
    if (!predicates.length) return this.getAll();
    // The legacy path is deliberately unfiltered: incomplete/unknown versions
    // cannot cause old matching events to disappear during a migration.
    const indexed = await this.readRows([{ field: "projectionVersion", operator: "eq", value: EVENT_PROJECTION_VERSION }, ...predicates]);
    const missing = await this.readRows([{ field: "projectionVersion", operator: "eq", value: null }]);
    const unknown = await this.readRows([{ field: "projectionVersion", operator: "ne", value: EVENT_PROJECTION_VERSION }, { field: "projectionVersion", operator: "ne", value: null }]);
    // Merge by storage ID; callers needing semantic ordering must set orderBy.
    return [...indexed, ...missing, ...unknown].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(row => row.payload);
  }
}
