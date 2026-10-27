export type QueueSqlDialect = 'sqlite' | 'postgres';

export type QueueSqlValue = string | number | null;

/**
 * The SQL primitive `DatabaseQueueAdapter` runs on. It has the shape of the
 * `rawSql` executor on `@superfunctions/db` SQL adapters: each `?` marks one
 * positional parameter, which the client renders for its dialect. The
 * adapter's statements contain no other `?`.
 */
export interface QueueSqlClient {
  readonly dialect: QueueSqlDialect;
  /** Runs a statement that returns rows (`SELECT`, `… RETURNING`). */
  query(sql: string, params: readonly QueueSqlValue[]): Promise<Record<string, unknown>[]>;
  /** Runs a statement without a result set (the migration DDL). */
  execute(sql: string, params: readonly QueueSqlValue[]): Promise<void>;
}

/** Structural subset of a better-sqlite3 `Database`. */
export interface BetterSqlite3DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

/** Wraps a better-sqlite3 database (SQLite >= 3.35 for `RETURNING`). */
export function createSqliteQueueClient(db: BetterSqlite3DatabaseLike): QueueSqlClient {
  return {
    dialect: 'sqlite',
    async query(sql, params) {
      return db.prepare(sql).all(...params) as Record<string, unknown>[];
    },
    async execute(sql, params) {
      db.prepare(sql).run(...params);
    },
  };
}

/** Structural subset of a Cloudflare `D1Database`. */
export interface D1DatabaseLike {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] }>;
      run(): Promise<unknown>;
    };
  };
}

/** Wraps a Cloudflare D1 binding. */
export function createD1QueueClient(db: D1DatabaseLike): QueueSqlClient {
  return {
    dialect: 'sqlite',
    async query(sql, params) {
      const result = await db.prepare(sql).bind(...params).all();
      return (result.results ?? []) as Record<string, unknown>[];
    },
    async execute(sql, params) {
      await db.prepare(sql).bind(...params).run();
    },
  };
}

/** Structural subset of a node-postgres `Pool`/`Client`, also satisfied by PGlite. */
export interface PostgresQueryableLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

function numberPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/**
 * Wraps a Postgres connection or pool. With a pool, every statement may run
 * on a different connection; the adapter never relies on session state.
 */
export function createPostgresQueueClient(db: PostgresQueryableLike): QueueSqlClient {
  return {
    dialect: 'postgres',
    async query(sql, params) {
      const result = await db.query(numberPlaceholders(sql), [...params]);
      return result.rows as Record<string, unknown>[];
    },
    async execute(sql, params) {
      await db.query(numberPlaceholders(sql), [...params]);
    },
  };
}
