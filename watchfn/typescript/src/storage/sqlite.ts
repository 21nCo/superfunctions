import type { Adapter, RawSqlExecutor, RawSqlValue } from "@superfunctions/db";
import type { Attributes, JsonValue, StorageAdapter, StorageQuery, StoredEvent } from "../types.js";
import { LIMITS, isPlainObject } from "../validation.js";

/** Table created by `createSqliteStorage`. */
export const SQLITE_EVENTS_TABLE = "watchfn_events";

/** Idempotent DDL applied by `open()` unless `ensureSchema` is false. */
export const SQLITE_SCHEMA: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${SQLITE_EVENTS_TABLE} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  attributes TEXT NOT NULL,
  data TEXT
)`,
  `CREATE INDEX IF NOT EXISTS ${SQLITE_EVENTS_TABLE}_ts ON ${SQLITE_EVENTS_TABLE} (ts, seq)`,
  `CREATE INDEX IF NOT EXISTS ${SQLITE_EVENTS_TABLE}_type_ts ON ${SQLITE_EVENTS_TABLE} (type, ts, seq)`,
]);

export interface SqliteStorageOptions {
  /**
   * A `@superfunctions/db` SQL adapter on SQLite, for example
   * `drizzleAdapter({ db: drizzle(new Database(file)), dialect: "sqlite" })`.
   * The storage borrows it: `close()` never closes the adapter or its connection.
   */
  adapter: Pick<Adapter, "rawSql">;
  /** Create the table and indexes on `open()`. Defaults to true. */
  ensureSchema?: boolean;
}

export interface SqliteStorage extends StorageAdapter {
  readonly kind: "sqlite";
  readonly durable: true;
  open(): Promise<void>;
  /** Ends this storage session only; the borrowed adapter stays open. */
  close(): Promise<void>;
}

const COLUMNS = "id, type, ts, received_at, attributes, data";

function sqliteExecutor(adapter: SqliteStorageOptions["adapter"] | undefined): RawSqlExecutor {
  const rawSql = adapter?.rawSql;
  if (!rawSql || typeof rawSql.query !== "function" || typeof rawSql.execute !== "function") {
    throw new TypeError("createSqliteStorage: adapter must be a @superfunctions/db SQL adapter exposing rawSql");
  }
  if (rawSql.dialect !== "sqlite") {
    throw new TypeError(`createSqliteStorage: adapter dialect is ${String(rawSql.dialect)}, expected sqlite`);
  }
  return rawSql;
}

function toMs(value: unknown, column: string): number {
  const ms = typeof value === "bigint" ? Number(value) : value;
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0 || ms > LIMITS.maxTimestampMs) {
    throw new TypeError(`sqlite storage: row has an invalid ${column}`);
  }
  return ms;
}

function parseAttributes(text: unknown): Attributes {
  const parsed: unknown = typeof text === "string" ? JSON.parse(text) : undefined;
  if (!isPlainObject(parsed)) throw new TypeError("sqlite storage: row has invalid attributes");
  for (const value of Object.values(parsed)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new TypeError("sqlite storage: row has invalid attributes");
    }
  }
  return parsed as Attributes;
}

function toEvent(row: Record<string, unknown>): StoredEvent {
  if (typeof row.id !== "string" || typeof row.type !== "string") throw new TypeError("sqlite storage: row is missing id or type");
  const event: StoredEvent = {
    id: row.id,
    type: row.type,
    timestamp: new Date(toMs(row.ts, "ts")).toISOString(),
    receivedAt: new Date(toMs(row.received_at, "received_at")).toISOString(),
    attributes: parseAttributes(row.attributes),
  };
  if (row.data !== null && row.data !== undefined) {
    if (typeof row.data !== "string") throw new TypeError("sqlite storage: row has invalid data");
    event.data = JSON.parse(row.data) as JsonValue;
  }
  return event;
}

function eventParams(event: StoredEvent): RawSqlValue[] {
  const ts = Date.parse(event.timestamp);
  const receivedAt = Date.parse(event.receivedAt);
  if (!Number.isFinite(ts) || !Number.isFinite(receivedAt)) throw new TypeError(`sqlite storage: invalid timestamps on ${event.id}`);
  return [
    event.id,
    event.type,
    ts,
    receivedAt,
    JSON.stringify(event.attributes),
    event.data === undefined ? null : JSON.stringify(event.data),
  ];
}

/** Builds the SELECT for a storage query; every value is a bound parameter. */
export function buildSqliteQuery(query: StorageQuery): { sql: string; params: RawSqlValue[] } {
  const where: string[] = [];
  const params: RawSqlValue[] = [];
  if (query.fromMs !== undefined) {
    where.push("e.ts >= ?");
    params.push(query.fromMs);
  }
  if (query.toMs !== undefined) {
    where.push("e.ts < ?");
    params.push(query.toMs);
  }
  if (query.types && query.types.length > 0) {
    where.push(`e.type IN (${query.types.map(() => "?").join(", ")})`);
    params.push(...query.types);
  }
  for (const [key, value] of query.attributes) {
    // json_each keeps the key a bound value, so attribute names never become JSON paths or SQL.
    if (typeof value === "boolean") {
      where.push("EXISTS (SELECT 1 FROM json_each(e.attributes) AS a WHERE a.key = ? AND a.type = ?)");
      params.push(key, value ? "true" : "false");
    } else if (typeof value === "number") {
      where.push("EXISTS (SELECT 1 FROM json_each(e.attributes) AS a WHERE a.key = ? AND a.type IN ('integer', 'real') AND a.value = ?)");
      params.push(key, value);
    } else {
      where.push("EXISTS (SELECT 1 FROM json_each(e.attributes) AS a WHERE a.key = ? AND a.type = 'text' AND a.value = ?)");
      params.push(key, value);
    }
  }
  const direction = query.order === "asc" ? "ASC" : "DESC";
  const sql =
    `SELECT ${COLUMNS} FROM ${SQLITE_EVENTS_TABLE} AS e` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY e.ts ${direction}, e.seq ${direction} LIMIT ?`;
  params.push(query.limit);
  return { sql, params };
}

/**
 * Durable event storage on a `@superfunctions/db` SQLite adapter (better-sqlite3,
 * libSQL or D1 through Drizzle or Kysely). A batch is one INSERT statement, so
 * it commits atomically; `write` resolves after SQLite reports the commit.
 * Durability follows the connection's journal and `synchronous` settings.
 */
export function createSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  const sql = sqliteExecutor(options?.adapter);
  const ensureSchema = options.ensureSchema ?? true;
  let open = false;

  function requireOpen(): void {
    if (!open) throw new Error("sqlite storage is not open");
  }

  return {
    kind: "sqlite",
    durable: true,
    async open() {
      if (open) return;
      const [probe] = await sql.query("SELECT json_valid('{}') AS ok");
      if (!probe || Number(probe.ok) !== 1) throw new Error("sqlite storage: the SQLite build lacks JSON support");
      if (ensureSchema) {
        for (const statement of SQLITE_SCHEMA) await sql.execute(statement);
      }
      open = true;
    },
    async close() {
      // The adapter and its connection belong to the caller; only this storage session ends.
      open = false;
    },
    async write(events) {
      requireOpen();
      if (events.length === 0) return;
      if (events.length > LIMITS.maxBatchSize) throw new RangeError(`sqlite storage: at most ${LIMITS.maxBatchSize} events per write`);
      const params = events.flatMap(eventParams);
      const values = events.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      await sql.execute(`INSERT INTO ${SQLITE_EVENTS_TABLE} (${COLUMNS}) VALUES ${values}`, params);
    },
    async query(query) {
      requireOpen();
      const { sql: text, params } = buildSqliteQuery(query);
      const rows = await sql.query(text, params);
      return rows.map(toEvent);
    },
  };
}
