import { randomUUID } from "node:crypto";
import { wrapWithSchema, type Adapter, type WhereClause } from "@superfunctions/db";
import { StorageAdapter } from "./types";
import { EventRetention, backfillReceivedAt, type EventRetentionConfig, type ReceiptBackfillOptions, type RetentionPageOptions } from "./event-retention";
export type { EventRetentionConfig, ReceiptBackfillOptions, RetentionPageOptions, RetentionPageResult } from "./event-retention";
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
  private readonly retention?: EventRetention;

  constructor(database: WatchFnDatabase, private readonly tableName = "watchfn_events", botfn?: BotFnIssueConfig, retention?: EventRetentionConfig) {
    const schema = getWatchFnSchema(tableName);
    if (database && "create" in database && typeof database.create === "function" &&
        "findMany" in database && typeof database.findMany === "function") {
      this.db = wrapWithSchema(database as Adapter, { ...schema, ...(botfn ? getBugIssueSchema() : {}) });
      if (botfn) this.bugIssues = new BotFnBugIssues(database as Adapter, botfn, tableName);
      if (retention) this.retention = new EventRetention(this.db, retention, tableName, botfn?.namespace);
    } else if (database && "insertEvent" in database && typeof database.insertEvent === "function" &&
        "queryEvents" in database && typeof database.queryEvents === "function") {
      if (botfn || retention) throw new TypeError("BotFn issue ingestion and retention require a shared DB Adapter");
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
    await this.db!.create({ model: this.tableName, data: { id: randomUUID(), payload, ...projectEvent(payload), receivedAt: Date.now() } });
  }

  async query(filter: (event: any) => boolean): Promise<any[]> {
    return (await this.getAll()).filter(filter);
  }

  async getAll(): Promise<any[]> {
    return this.executeQuery({});
  }

  private async *readRows(where: WhereClause[], select?: string[]): AsyncGenerator<StoredEvent> {
    let after: string | undefined;
    // A fixed small page bounds parsed payload memory independently of total rows.
    const pageSize = 128;
    for (;;) {
      const rows = await this.db!.findMany<StoredEvent>({ model: this.tableName,
        where: [...where, ...(after === undefined ? [] : [{ field: "id", operator: "gt" as const, value: after }])],
        orderBy: [{ field: "id", direction: "asc" }], limit: pageSize, ...(select ? { select } : {}) });
      for (const row of rows) yield row;
      if (rows.length < pageSize) return;
      const next = rows[rows.length - 1].id;
      if (typeof next !== "string" || next === after) throw new Error("Storage keyset did not advance");
      after = next;
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

  cleanupRetention(options: RetentionPageOptions = {}) {
    if (!this.retention) throw new Error("Event retention is not configured");
    return this.retention.cleanup(options);
  }

  backfillReceivedAt(options: ReceiptBackfillOptions) {
    if (!this.db) throw new Error("Receipt backfill requires a shared DB Adapter");
    return backfillReceivedAt(this.db, this.tableName, options);
  }

  async executeQuery(options: any): Promise<any[]> {
    const result: any[] = [];
    for await (const event of this.iterateQuery(options)) result.push(event);
    return result;
  }

  /** Live keyset scan, not a snapshot across concurrent inserts/updates/deletes. */
  async *iterateQuery(options: any): AsyncGenerator<any> {
    if (this.legacy) {
      const { resolvedTimeRange: _internalRange, ...legacyOptions } = options ?? {};
      yield* await this.legacy.queryEvents(options && typeof options === "object" ? legacyOptions : options);
      return;
    }
    const predicates = eventProjectionWhere(options);
    if (!predicates.length) {
      for await (const row of this.readRows([])) yield row.payload;
      return;
    }
    // Disjoint projection versions are merged by storage ID. Each stream keeps
    // one bounded page, including the unfiltered migration compatibility paths.
    const clauses: WhereClause[][] = [
      [{ field: "projectionVersion", operator: "eq", value: EVENT_PROJECTION_VERSION }, ...predicates],
      [{ field: "projectionVersion", operator: "eq", value: null }],
      [{ field: "projectionVersion", operator: "ne", value: EVENT_PROJECTION_VERSION }, { field: "projectionVersion", operator: "ne", value: null }],
    ];
    // The old projected union used JS string ordering after SQL retrieval. A
    // metadata-only preflight checks each stream before any payload is yielded:
    // custom collations/non-BMP legacy IDs need the exact materialized fallback.
    let compatible = true;
    for (const where of clauses) {
      let previous: string | undefined;
      for await (const row of this.readRows(where, ["id"])) {
        if (previous !== undefined && row.id < previous) { compatible = false; break; }
        previous = row.id;
      }
      if (!compatible) break;
    }
    if (!compatible) {
      const rows: StoredEvent[] = [];
      for (const where of clauses) for await (const row of this.readRows(where)) rows.push(row);
      rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      for (const row of rows) yield row.payload;
      return;
    }
    const sources = clauses.map(where => this.readRows(where));
    try {
      const heads = [];
      for (const source of sources) heads.push(await source.next());
      for (;;) {
        let selected = -1;
        for (let index = 0; index < heads.length; index++) {
          if (!heads[index].done && (selected < 0 || heads[index].value!.id < heads[selected].value!.id)) selected = index;
        }
        if (selected < 0) return;
        yield heads[selected].value!.payload;
        heads[selected] = await sources[selected].next();
      }
    } finally {
      for (const source of sources) await source.return(undefined);
    }
  }
}
