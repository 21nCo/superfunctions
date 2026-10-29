/**
 * PostgresAdapter — Full-text search adapter using Postgres-native tsvector/tsquery.
 *
 * Supports: index (upsert), search, searchAll, remove, clear, initialize, dispose.
 * Resilience: configurable timeout, bounded retries with jitter for transient errors.
 *
 * Statements run through a PostgresDriver: either one the caller injects (`driver`, for example
 * `fromPostgresJs(sql)` on Cloudflare Workers with Hyperdrive) or a `pg` Pool the adapter creates
 * from `connectionString`. `pg` is imported only on that second path.
 */
import type { Pool } from "pg";
import type {
  SearchAdapter,
  SearchAdapterCapabilities,
  SearchDefaults,
  IndexParams,
  SearchParams,
  RemoveParams,
  SearchAllParams,
  SearchAllResult,
  InitializeParams,
} from "@searchfn/adapter-contracts";
import { SearchAdapterError, SEARCH_ADAPTER_DISPOSED } from "@searchfn/adapter-contracts";
import { ensureMetaTable, ensureResourceTable } from "./postgres-schema";
import { buildUpsertQuery, buildDeleteQuery, buildSearchQuery, buildClearQuery } from "./postgres-sql";
import type { UpsertRow } from "./postgres-sql";
import { redactSensitive } from "./internal/redaction";
import { runWithRetry, type RetryPolicy } from "./internal/retry";
import { retryBudgetExhaustedError, withRedactedErrorMessage } from "./internal/errors";
import { normalizeObservability, type ObservabilityInput, type ObservationLogger } from "@superfunctions/observability";
import { fromPg, type PostgresDriver, type PostgresQueryable } from "./driver";

export type PostgresRetryPolicy = RetryPolicy;

export interface PostgresAdapterLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

interface PostgresAdapterSharedOptions {
  schema?: string;
  /** Retry policy for transient DB errors. */
  retry?: PostgresRetryPolicy;
  /** Maximum documents per index batch. Default: 10000 */
  maxBatchSize?: number;
  observability?: ObservabilityInput;
  /** Construct-time defaults applied when query params are omitted. */
  defaults?: SearchDefaults;
}

export interface PostgresConnectionStringOptions extends PostgresAdapterSharedOptions {
  /** The adapter creates a `pg` Pool for this DSN and ends it on `dispose()`. */
  connectionString: string;
  /** Query timeout in milliseconds (`statement_timeout` on the created Pool). Default: 30000 */
  queryTimeoutMs?: number;
  driver?: never;
}

export interface PostgresDriverOptions extends PostgresAdapterSharedOptions {
  /**
   * Caller-owned driver, for example `fromPostgresJs(sql)` or `fromPg(pool)`. The adapter never
   * closes it. Configure timeouts on the client itself.
   */
  driver: PostgresDriver;
  connectionString?: never;
  queryTimeoutMs?: never;
}

export type PostgresAdapterOptions = PostgresConnectionStringOptions | PostgresDriverOptions;

/** The adapter-created Pool for `connectionString`, and the driver bound to it. */
interface OwnedPool {
  pool: Pool;
  driver: PostgresDriver;
}

/** Postgres error codes that are considered transient/retryable. */
const RETRYABLE_PG_CODES = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "57014", // query_canceled (timeout)
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  // postgres.js connection error codes; pg never reports these.
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  // Node socket error codes, reported by both pg and postgres.js.
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return RETRYABLE_PG_CODES.has((err as { code: string }).code);
  }
  if (err instanceof Error && err.message.includes("ECONNREFUSED")) return true;
  if (err instanceof Error && err.message.includes("ETIMEDOUT")) return true;
  return false;
}

function coerceId(value: string): string | number {
  if (/^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && String(parsed) === value) {
      return parsed;
    }
  }
  return value;
}

const MAX_SAFE_POSTGRES_PARAMS = 60_000;

interface SearchRow {
  doc_id: string;
  score: string | number;
}

export class PostgresAdapter implements SearchAdapter {
  readonly name = "postgres";
  readonly capabilities: SearchAdapterCapabilities = {
    persistent: true,
    searchAll: true,
    fuzzy: true,
    fieldBoosts: false,
    prefix: true,
  };

  private readonly injectedDriver: PostgresDriver | null;
  private ownedPool: Promise<OwnedPool> | null = null;
  private disposed = false;
  private readonly knownResources = new Map<string, string[]>();
  private readonly queryTimeoutMs: number;
  private readonly maxBatchSize: number;
  private readonly defaults: SearchDefaults;
  private readonly logger?: PostgresAdapterLogger;

  constructor(private readonly options: PostgresAdapterOptions) {
    const driver = options.driver;
    if (driver !== undefined) {
      if (driver === null || typeof driver.query !== "function") {
        throw new SearchAdapterError("DFQL_INVALID", "driver must provide a query(sql, params) function");
      }
      if (options.connectionString !== undefined) {
        throw new SearchAdapterError("DFQL_INVALID", "Pass either connectionString or driver, not both");
      }
      if (options.queryTimeoutMs !== undefined) {
        throw new SearchAdapterError(
          "DFQL_INVALID",
          "queryTimeoutMs applies only to connectionString; configure timeouts on the injected driver's client",
        );
      }
    }
    this.injectedDriver = driver ?? null;
    const observability = normalizeObservability(options.observability)?.child({
      component: "searchfn.postgres",
    });
    this.queryTimeoutMs = options.queryTimeoutMs ?? 30_000;
    this.maxBatchSize = options.maxBatchSize ?? 10_000;
    this.defaults = options.defaults ?? {};
    this.logger = postgresLoggerFromObservability(observability?.logger);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new SearchAdapterError(
        SEARCH_ADAPTER_DISPOSED,
        "Search adapter is disposed. Call initialize() before use.",
      );
    }
  }

  private async getDriver(): Promise<PostgresDriver> {
    // An operation that resumes after dispose() must not create a Pool that nothing will end.
    this.assertNotDisposed();
    if (this.injectedDriver) return this.injectedDriver;
    // Cache the promise so concurrent first calls share one Pool.
    this.ownedPool ??= this.createPool();
    return (await this.ownedPool).driver;
  }

  private async createPool(): Promise<OwnedPool> {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: this.options.connectionString,
      statement_timeout: this.queryTimeoutMs,
      max: 10,
    });
    return { pool, driver: fromPg(pool) };
  }

  /** Run `fn` in a driver transaction, or statement by statement when the driver has none. */
  private async inTransaction(driver: PostgresDriver, fn: (tx: PostgresQueryable) => Promise<void>): Promise<void> {
    if (driver.transaction) {
      await driver.transaction(fn);
    } else {
      await fn(driver);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    // Once retries run out, report the last transient error (redacted), not a bare budget message.
    const exhausted = retryBudgetExhaustedError();
    let lastError: unknown;
    try {
      return await runWithRetry(fn, {
        policy: this.options.retry,
        isRetryableError: (error) => {
          lastError = error;
          return isRetryable(error);
        },
        exhaustedError: exhausted,
        onRetry: ({ attempt, delayMs, reason }) => {
          this.logger?.warn(
            "adapter.retry",
            redactSensitive({
              backend: "postgres",
              attempt,
              delayMs,
              reason,
            }),
          );
        },
      });
    } catch (error) {
      if (error === exhausted) throw withRedactedErrorMessage("Postgres operation failed", lastError);
      if (error instanceof SearchAdapterError) throw error;
      throw withRedactedErrorMessage("Postgres operation failed", error);
    }
  }

  async initialize({ resources }: InitializeParams): Promise<void> {
    if (this.disposed) {
      this.disposed = false;
      this.ownedPool = null;
    }

    const driver = await this.getDriver();
    const nextKnownResources = new Map<string, string[]>();

    await this.withRetry(async () => {
      await ensureMetaTable(driver, this.options.schema);
      for (const { name, searchFields } of resources) {
        await ensureResourceTable(driver, name, searchFields, this.options.schema);
        nextKnownResources.set(name, searchFields);
      }
    });
    this.knownResources.clear();
    for (const [name, searchFields] of nextKnownResources.entries()) {
      this.knownResources.set(name, searchFields);
    }
  }

  async index({ resource, documents, signal }: IndexParams): Promise<void> {
    this.assertNotDisposed();
    if (documents.length === 0) return;

    const driver = await this.getDriver();

    // Process in batches
    for (let offset = 0; offset < documents.length; offset += this.maxBatchSize) {
      if (signal?.aborted) {
        throw new SearchAdapterError("DFQL_ABORTED", "Index operation aborted");
      }
      this.assertNotDisposed();

      const chunk = documents.slice(offset, offset + this.maxBatchSize);

      // Build upsert rows: one row per (docId, fieldName)
      const rows: UpsertRow[] = [];
      const docIds = new Set<string>();

      for (const doc of chunk) {
        const docId = String(doc.id);
        docIds.add(docId);
        for (const [fieldName, fieldValue] of Object.entries(doc.fields)) {
          rows.push({ docId, fieldName, fieldValue });
        }
      }

      await this.withRetry(async () => {
        await this.inTransaction(driver, async (tx) => {
          // Delete existing rows for these doc_ids to ensure clean upsert
          const deleteIds = Array.from(docIds);
          for (let i = 0; i < deleteIds.length; i += MAX_SAFE_POSTGRES_PARAMS) {
            const deleteBatch = deleteIds.slice(i, i + MAX_SAFE_POSTGRES_PARAMS);
            const q = buildDeleteQuery(resource, deleteBatch, this.options.schema);
            await tx.query(q.text, q.values);
          }

          // Insert new rows in sub-batches to avoid parameter limit (65535)
          const maxParamsPerQuery = MAX_SAFE_POSTGRES_PARAMS;
          const paramsPerRow = 3;
          const subBatchSize = Math.floor(maxParamsPerQuery / paramsPerRow);

          for (let i = 0; i < rows.length; i += subBatchSize) {
            const subBatch = rows.slice(i, i + subBatchSize);
            const q = buildUpsertQuery(resource, subBatch, this.options.schema);
            await tx.query(q.text, q.values);
          }
        });
      });
    }
  }

  async search(params: SearchParams): Promise<Array<string | number>> {
    this.assertNotDisposed();

    const limit = Math.max(1, params.limit ?? 10);
    const effectivePrefix = params.prefix ?? this.defaults.prefix;
    const effectiveFuzzy = params.fuzzy ?? this.defaults.fuzzy;

    // Check if table exists by trying to query - return empty for unknown resource
    const driver = await this.getDriver();
    const result = await this.withRetry(async () => {
      const q = buildSearchQuery(params.resource, params.query, {
        fields: params.fields,
        limit,
        fuzzy: effectiveFuzzy,
        prefix: effectivePrefix,
        schema: this.options.schema,
      });
      try {
        return await driver.query<SearchRow>(q.text, q.values);
      } catch (err) {
        // Table doesn't exist - return empty
        if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "42P01") {
          return { rows: [] };
        }
        throw err;
      }
    });

    return result.rows.map((row) => coerceId(row.doc_id));
  }

  async searchAll(params: SearchAllParams): Promise<SearchAllResult[]> {
    this.assertNotDisposed();

    const limit = params.limit ?? 10;
    const limitPerResource = params.limitPerResource ?? limit;
    const effectivePrefix = params.prefix ?? this.defaults.prefix;
    const effectiveFuzzy = params.fuzzy ?? this.defaults.fuzzy;

    // Determine resources to search
    let resources: string[];
    if (params.resources && params.resources.length > 0) {
      resources = params.resources;
    } else {
      resources = Array.from(this.knownResources.keys());
    }

    const allResults: SearchAllResult[] = [];
    const driver = await this.getDriver();

    for (const resource of resources) {
      if (params.signal?.aborted) {
        throw new SearchAdapterError("DFQL_ABORTED", "SearchAll operation aborted");
      }
      this.assertNotDisposed();

      const result = await this.withRetry(async () => {
        const q = buildSearchQuery(resource, params.query, {
          fields: params.fields,
          limit: limitPerResource,
          fuzzy: effectiveFuzzy,
          prefix: effectivePrefix,
          schema: this.options.schema,
        });
        try {
          return await driver.query<SearchRow>(q.text, q.values);
        } catch (err) {
          if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "42P01") {
            return { rows: [] };
          }
          throw err;
        }
      });

      for (const row of result.rows) {
        allResults.push({
          resource,
          id: coerceId(row.doc_id),
          score: Number.parseFloat(String(row.score)),
        });
      }
    }

    // Deterministic sort: score DESC, resource ASC, id ASC
    allResults.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.resource !== b.resource) return a.resource < b.resource ? -1 : 1;
      const aId = String(a.id);
      const bId = String(b.id);
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    });

    return allResults.slice(0, limit);
  }

  async remove({ resource, ids, signal }: RemoveParams): Promise<void> {
    this.assertNotDisposed();
    if (ids.length === 0) return;

    if (signal?.aborted) {
      throw new SearchAdapterError("DFQL_ABORTED", "Remove operation aborted");
    }

    const driver = await this.getDriver();

    await this.withRetry(async () => {
      const q = buildDeleteQuery(resource, ids, this.options.schema);
      try {
        await driver.query(q.text, q.values);
      } catch (err) {
        // Table doesn't exist - idempotent, no-op
        if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "42P01") {
          return;
        }
        throw err;
      }
    });
  }

  async clear(resource: string, signal?: AbortSignal): Promise<void> {
    this.assertNotDisposed();

    if (signal?.aborted) {
      throw new SearchAdapterError("DFQL_ABORTED", "Clear operation aborted");
    }

    const driver = await this.getDriver();

    await this.withRetry(async () => {
      const q = buildClearQuery(resource, this.options.schema);
      try {
        await driver.query(q.text, q.values);
      } catch (err) {
        // Table doesn't exist - idempotent, no-op
        if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "42P01") {
          return;
        }
        throw err;
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.knownResources.clear();
    const owned = this.ownedPool;
    this.ownedPool = null;
    if (owned) {
      // A Pool that never got created (pg failed to load) has nothing to end.
      const created = await owned.catch(() => null);
      await created?.pool.end();
    }
  }
}

function postgresLoggerFromObservability(
  logger: ObservationLogger | undefined,
): PostgresAdapterLogger | undefined {
  if (!logger) return undefined;
  return {
    debug: (message, context) => logger.debug?.(message, context),
    warn: (message, context) => logger.warn?.(message, context),
    error: (message, context) => logger.error?.(message, context),
  };
}
