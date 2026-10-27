/**
 * SqliteDriver — the injected port between SqliteAdapter and a SQLite engine.
 *
 * The adapter never imports a driver package. Callers pass one of the bindings
 * below (or their own implementation), so better-sqlite3, @libsql/client and D1
 * stay optional peers and the package runs unchanged on Node and Workers.
 */

export type SqliteValue = string | number | null;

export interface SqliteStatement {
  sql: string;
  params?: readonly SqliteValue[];
}

export interface SqliteRunResult {
  changes?: number;
}

export interface SqliteDriver {
  /** Execute one parameterless statement (DDL). The adapter never passes more than one. */
  exec(sql: string): Promise<void>;
  /** Execute a query and return its rows as plain objects keyed by column name. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): Promise<T[]>;
  /** Execute a statement that returns no rows. */
  run(sql: string, params?: readonly SqliteValue[]): Promise<SqliteRunResult>;
  /**
   * Execute statements in order inside one transaction: all commit or none do.
   * Optional, but required for concurrent use: the adapter checks the index generation in
   * the same batch as the writes and rebuilds that depend on it. Without it statements run
   * one by one, so every operation on the database must be serialized by the caller, and a
   * failure can leave a partial write (repair it with `SqliteAdapter.rebuild()`).
   */
  batch?(statements: readonly SqliteStatement[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// better-sqlite3
// ---------------------------------------------------------------------------

/** Structural subset of a better-sqlite3 `Statement`. */
export interface BetterSqlite3StatementLike {
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): unknown[];
}

/** Structural subset of a better-sqlite3 `Database`. */
export interface BetterSqlite3DatabaseLike {
  prepare(sql: string): BetterSqlite3StatementLike;
  exec(sql: string): unknown;
  transaction(
    fn: (statements: readonly SqliteStatement[]) => void,
  ): (statements: readonly SqliteStatement[]) => void;
}

/** Bind a better-sqlite3 `Database`. Batches run in `db.transaction()`. */
export function fromBetterSqlite3(db: BetterSqlite3DatabaseLike): SqliteDriver {
  const runAll = db.transaction((statements) => {
    for (const statement of statements) {
      db.prepare(statement.sql).run(...(statement.params ?? []));
    }
  });

  return {
    async exec(sql) {
      db.exec(sql);
    },
    async all<T>(sql: string, params: readonly SqliteValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async run(sql, params = []) {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
    async batch(statements) {
      runAll(statements);
    },
  };
}

// ---------------------------------------------------------------------------
// libSQL / Turso
// ---------------------------------------------------------------------------

interface LibsqlInStatement {
  sql: string;
  args: SqliteValue[];
}

/** Structural subset of an @libsql/client `ResultSet`. */
export interface LibsqlResultSetLike {
  columns: string[];
  rows: ArrayLike<unknown>[];
  rowsAffected: number;
}

/** Structural subset of an @libsql/client `Client`. */
export interface LibsqlClientLike {
  execute(statement: LibsqlInStatement): Promise<LibsqlResultSetLike>;
  batch(statements: LibsqlInStatement[], mode?: "write" | "read" | "deferred"): Promise<unknown>;
}

/** Bind an @libsql/client `Client` (local file, embedded replica or Turso). Batches use write mode. */
export function fromLibsql(client: LibsqlClientLike): SqliteDriver {
  const toStatement = (sql: string, params: readonly SqliteValue[] = []): LibsqlInStatement => ({
    sql,
    args: [...params],
  });

  return {
    async exec(sql) {
      await client.execute(toStatement(sql));
    },
    async all<T>(sql: string, params?: readonly SqliteValue[]) {
      const result = await client.execute(toStatement(sql, params));
      return result.rows.map((row) => {
        const record: Record<string, unknown> = {};
        result.columns.forEach((column, index) => {
          record[column] = normalizeLibsqlValue(row[index]);
        });
        return record as T;
      });
    },
    async run(sql, params) {
      const result = await client.execute(toStatement(sql, params));
      return { changes: result.rowsAffected };
    },
    async batch(statements) {
      await client.batch(
        statements.map((statement) => toStatement(statement.sql, statement.params)),
        "write",
      );
    },
  };
}

function normalizeLibsqlValue(value: unknown): unknown {
  // Clients created with intMode "bigint" return integers as bigint.
  return typeof value === "bigint" ? Number(value) : value;
}

// ---------------------------------------------------------------------------
// Cloudflare D1
// ---------------------------------------------------------------------------

/** Structural subset of a D1 `D1PreparedStatement`. */
export interface D1PreparedStatementLike {
  bind(...values: SqliteValue[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

/** Structural subset of a D1 `D1Database` binding. */
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

/** Bind a Cloudflare D1 database. `db.batch()` runs as one implicit transaction. */
export function fromD1(db: D1DatabaseLike): SqliteDriver {
  const prepare = (sql: string, params: readonly SqliteValue[] = []): D1PreparedStatementLike => {
    const statement = db.prepare(sql);
    return params.length > 0 ? statement.bind(...params) : statement;
  };

  return {
    async exec(sql) {
      // D1's exec() splits on newlines; a prepared statement runs the SQL as one unit.
      await prepare(sql).run();
    },
    async all<T>(sql: string, params?: readonly SqliteValue[]) {
      const result = await prepare(sql, params).all<T>();
      return result.results ?? [];
    },
    async run(sql, params) {
      const result = await prepare(sql, params).run();
      return { changes: result.meta?.changes };
    },
    async batch(statements) {
      if (statements.length === 0) return;
      await db.batch(statements.map((statement) => prepare(statement.sql, statement.params)));
    },
  };
}
