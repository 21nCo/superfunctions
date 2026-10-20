import { randomUUID } from "node:crypto";
import { wrapWithSchema, type Adapter } from "@superfunctions/db";
import { StorageAdapter } from "./types";
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
    await this.db!.create({ model: this.tableName, data: { id: randomUUID(), payload } });
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

  async executeQuery(options: any): Promise<any[]> {
    // QueryEngine applies its canonical filters/sort/limit after loading events.
    return this.legacy ? this.legacy.queryEvents(options) : this.getAll();
  }
}
