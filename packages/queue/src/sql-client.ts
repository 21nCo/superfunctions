export type QueueSqlDialect = 'sqlite' | 'postgres';

export type QueueSqlValue = string | number | null;

/**
 * The single primitive `DatabaseQueueAdapter` needs: run one statement with
 * positional parameters and return its result rows (empty for statements
 * without a result set). Placeholders are `?` for SQLite and `$1..$n` for
 * Postgres; the adapter writes them for the client's dialect.
 */
export interface QueueSqlClient {
  readonly dialect: QueueSqlDialect;
  query(sql: string, params: readonly QueueSqlValue[]): Promise<Record<string, unknown>[]>;
}

/** Structural subset of a better-sqlite3 `Database`. */
export interface BetterSqlite3DatabaseLike {
  prepare(sql: string): {
    readonly reader: boolean;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

/** Wraps a better-sqlite3 database (SQLite >= 3.35 for `RETURNING`). */
export function createSqliteQueueClient(db: BetterSqlite3DatabaseLike): QueueSqlClient {
  return {
    dialect: 'sqlite',
    async query(sql, params) {
      const statement = db.prepare(sql);
      if (statement.reader) {
        return statement.all(...params) as Record<string, unknown>[];
      }
      statement.run(...params);
      return [];
    },
  };
}

/** Structural subset of a Cloudflare `D1Database`. */
export interface D1DatabaseLike {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] }>;
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
  };
}

/** Structural subset of a node-postgres `Pool`/`Client`, also satisfied by PGlite. */
export interface PostgresQueryableLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Wraps a Postgres connection or pool. With a pool, every statement may run
 * on a different connection; the adapter never relies on session state.
 */
export function createPostgresQueueClient(db: PostgresQueryableLike): QueueSqlClient {
  return {
    dialect: 'postgres',
    async query(sql, params) {
      const result = await db.query(sql, [...params]);
      return result.rows as Record<string, unknown>[];
    },
  };
}
