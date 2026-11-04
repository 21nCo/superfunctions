import type { Adapter, RawSqlExecutor, RawSqlValue } from "@superfunctions/db";
import type { Attributes, JsonValue, StorageAdapter, StorageQuery, StoredEvent } from "../types.js";
import { LIMITS, isPlainObject, isTimestampMs, storedTimestampMs } from "../validation.js";

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
  if (!isTimestampMs(ms)) {
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

/** Bind values for one event. Timestamps outside the range `toEvent` reads back are rejected before any SQL runs. */
function eventParams(event: StoredEvent): RawSqlValue[] {
  return [
    event.id,
    event.type,
    storedTimestampMs(event.timestamp, "timestamp", "sqlite"),
    storedTimestampMs(event.receivedAt, "receivedAt", "sqlite"),
    JSON.stringify(event.attributes),
    event.data === undefined ? null : JSON.stringify(event.data),
  ];
}

/**
 * One statement queue per borrowed executor. Every storage on the same
 * connection shares it, so their transactions and queries never interleave.
 */
const queues = new WeakMap<RawSqlExecutor, Promise<unknown>>();

function serialize<T>(sql: RawSqlExecutor, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(sql) ?? Promise.resolve()).then(task);
  queues.set(
    sql,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * Runs `work` in a transaction this storage begins and commits itself.
 * `BEGIN IMMEDIATE` fails when the connection is already inside a transaction,
 * so the storage refuses to write into a caller's transaction (where the
 * caller could still roll the events back) and never commits or rolls back
 * work it did not start.
 */
async function ownTransaction(sql: RawSqlExecutor, work: () => Promise<void>): Promise<void> {
  try {
    await sql.execute("BEGIN IMMEDIATE");
  } catch (error) {
    throw new Error(
      "sqlite storage: could not begin its own transaction (it does not write inside a transaction it did not start)",
      { cause: error },
    );
  }
  try {
    await work();
    await sql.execute("COMMIT");
  } catch (error) {
    try {
      await sql.execute("ROLLBACK");
    } catch {
      // SQLite already rolled this transaction back (for example after an I/O error).
    }
    throw error;
  }
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
    // Values are compared as their stored JSON text, never as SQLite's decoded a.value: SQLite decodes
    // JSON lossily (integer literals become exact int64s, extreme exponents round differently from
    // JavaScript, and an escaped lone surrogate such as "\ud800" does not survive decoding). The
    // attributes column is always JSON.stringify output, which is one canonical text per value
    // (+0 and -0 both "0"; lone surrogates escaped), and SQLite returns that text unchanged from ->,
    // so text equality is exactly JavaScript's === for strings, numbers and booleans alike.
    const types = typeof value === "boolean" ? "'true', 'false'" : typeof value === "number" ? "'integer', 'real'" : "'text'";
    where.push(
      `EXISTS (SELECT 1 FROM json_each(e.attributes) AS a WHERE a.key = ? AND a.type IN (${types}) AND (e.attributes -> a.fullkey) = ?)`,
    );
    params.push(key, JSON.stringify(value));
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
 * Durable event storage on a `@superfunctions/db` SQLite adapter. Tested with
 * the Drizzle adapter on better-sqlite3; other SQLite drivers are untested
 * (D1 rejects `BEGIN`, so it is not supported).
 *
 * Each write runs in its own `BEGIN IMMEDIATE ... COMMIT`, and `write`
 * resolves only after `COMMIT` succeeded. A write while the connection is
 * inside a transaction the storage did not start fails without touching that
 * transaction. Durability follows the connection's journal and `synchronous`
 * settings.
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
      // The probe and the schema run in the connection's queue, so they never interleave with
      // another storage's transaction on the same connection.
      await serialize(sql, async () => {
        const [probe] = await sql.query("SELECT json_valid('{}') AS ok");
        if (!probe || Number(probe.ok) !== 1) throw new Error("sqlite storage: the SQLite build lacks JSON support");
        if (ensureSchema) {
          await ownTransaction(sql, async () => {
            for (const statement of SQLITE_SCHEMA) await sql.execute(statement);
          });
        }
      });
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
      await serialize(sql, () =>
        ownTransaction(sql, () => sql.execute(`INSERT INTO ${SQLITE_EVENTS_TABLE} (${COLUMNS}) VALUES ${values}`, params)),
      );
    },
    async query(query) {
      requireOpen();
      const { sql: text, params } = buildSqliteQuery(query);
      // Queued behind pending writes, so a query never sees a write that has not committed yet.
      const rows = await serialize(sql, () => sql.query(text, params));
      return rows.map(toEvent);
    },
  };
}
