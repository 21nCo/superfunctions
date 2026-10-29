/**
 * PostgresDriver — the injected port between PostgresAdapter and a Postgres client.
 *
 * The adapter only needs `query(sql, params)`; `transaction(fn)` makes `index()` atomic.
 * The bindings below adapt node-postgres (`pg`) and postgres.js structurally, so neither
 * package is imported here and Workers bundles that use postgres.js never load `pg`.
 */

/** Rows returned by one statement. */
export interface PostgresQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
}

/** Runs one parameterized statement (`$1`, `$2`, ... placeholders). */
export interface PostgresQueryable {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresDriver extends PostgresQueryable {
  /**
   * Run `fn` inside one transaction on one connection: commit when it resolves, roll back when
   * it rejects. Optional, but without it `index()` deletes and re-inserts a batch as separate
   * statements, so a failure can leave a document removed until the call is retried, and
   * concurrent writers to the same document can interleave.
   */
  transaction?<T>(fn: (tx: PostgresQueryable) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// node-postgres (pg)
// ---------------------------------------------------------------------------

/** Structural subset of a `pg` result. */
export interface PgQueryResultLike {
  rows: unknown[];
}

/** Structural subset of a `pg` `PoolClient`. */
export interface PgPoolClientLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
  release(err?: Error | boolean): void;
}

/** Structural subset of a `pg` `Pool`. */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
  connect(): Promise<PgPoolClientLike>;
}

function pgQueryable(target: { query(text: string, values?: unknown[]): Promise<PgQueryResultLike> }): PostgresQueryable {
  return {
    async query<Row>(sql: string, params?: readonly unknown[]) {
      const result = params === undefined ? await target.query(sql) : await target.query(sql, [...params]);
      return { rows: result.rows as Row[] };
    },
  };
}

/**
 * Bind a `pg` `Pool`. Transactions check out one client, run `BEGIN`/`COMMIT`, and roll back on
 * failure. The caller owns the pool: `PostgresAdapter.dispose()` does not end it.
 */
export function fromPg(pool: PgPoolLike): PostgresDriver {
  return {
    ...pgQueryable(pool),
    async transaction<T>(fn: (tx: PostgresQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      // A client whose ROLLBACK failed may still hold an open transaction; discard it.
      let discard: Error | undefined;
      try {
        await client.query("BEGIN");
        const result = await fn(pgQueryable(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// postgres.js
// ---------------------------------------------------------------------------

/** Structural subset of a postgres.js `Sql` or `TransactionSql`. */
export interface PostgresJsQueryableLike {
  unsafe(query: string, parameters?: unknown[], queryOptions?: { prepare?: boolean }): PromiseLike<readonly unknown[]>;
}

/** Structural subset of a postgres.js `Sql` instance. */
export interface PostgresJsSqlLike extends PostgresJsQueryableLike {
  begin(fn: (sql: PostgresJsQueryableLike) => Promise<unknown>): PromiseLike<unknown>;
}

function postgresJsQueryable(sql: PostgresJsQueryableLike): PostgresQueryable {
  return {
    async query<Row>(text: string, params?: readonly unknown[]) {
      // unsafe() defaults to unnamed statements, which Hyperdrive's transaction pooling does not
      // support reliably; ask for prepared ones. A client created with `prepare: false` still wins.
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params], { prepare: true });
      return { rows: Array.from(rows) as Row[] };
    },
  };
}

/**
 * Bind a postgres.js `sql` instance, for example `postgres(env.HYPERDRIVE.connectionString)` on
 * Cloudflare Workers. Statements run as prepared statements through
 * `sql.unsafe(text, params, { prepare: true })`, as Hyperdrive requires; transactions use
 * `sql.begin()`. The caller owns the instance: `PostgresAdapter.dispose()` does not end it.
 */
export function fromPostgresJs(sql: PostgresJsSqlLike): PostgresDriver {
  return {
    ...postgresJsQueryable(sql),
    async transaction<T>(fn: (tx: PostgresQueryable) => Promise<T>): Promise<T> {
      return (await sql.begin((tx) => fn(postgresJsQueryable(tx)))) as T;
    },
  };
}
