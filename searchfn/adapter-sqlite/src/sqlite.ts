/**
 * SqliteAdapter — server-side full-text search on SQLite FTS5 through an injected driver.
 *
 * Supports: initialize, index (upsert), search, searchAll, remove, clear, rebuild, dispose.
 * Ranking is FTS5 bm25() with per-field weights; prefix search uses `"term"*`; namespace and
 * region filters are enforced in SQL. Fuzzy matching is not supported and is ignored.
 *
 * Concurrency: every generation check runs in one `driver.batch()` transaction with the writes,
 * rebuild publication and cleanup that depend on it, so instances sharing a database stay
 * consistent. A driver without `batch()` cannot give that guarantee; callers must serialize
 * all operations on its database.
 */
import type {
  SearchAdapter,
  SearchAdapterCapabilities,
  SearchDefaults,
  SearchDocument,
  IndexParams,
  SearchParams,
  RemoveParams,
  SearchAllParams,
  SearchAllResult,
  InitializeParams,
} from "@searchfn/adapter-contracts";
import { SearchAdapterError, SEARCH_ADAPTER_DISPOSED } from "@searchfn/adapter-contracts";
import {
  normalizeObservability,
  type ObservabilityInput,
  type ObservationLogger,
} from "@superfunctions/observability";
import type { SqliteDriver, SqliteStatement } from "./driver";
import {
  PENDING_GENERATION,
  SqliteSchema,
  compileMatch,
  isMissingTableError,
  isValidTablePrefix,
  type ResourceRow,
  type ResourceState,
  type SearchRow,
} from "./sql";

export interface SqliteAdapterOptions {
  driver: SqliteDriver;
  /** Prefix for adapter-owned tables. Letters, digits and underscores. Default: "searchfn" */
  tablePrefix?: string;
  /** Maximum documents per write transaction. Default: 500 */
  maxBatchSize?: number;
  /** Construct-time defaults applied when query params are omitted. */
  defaults?: SearchDefaults;
  observability?: ObservabilityInput;
}

const DEFAULT_TABLE_PREFIX = "searchfn";
const DEFAULT_MAX_BATCH_SIZE = 500;
/** Upper bound for the JSON bound to one write statement, well under D1's 2 MB value limit. */
const MAX_BATCH_PAYLOAD_BYTES = 512 * 1024;
const MAX_QUERY_TERMS = 32;
const DEFAULT_LIMIT = 10;
const MAX_SCHEMA_ATTEMPTS = 3;

/** A search read a generation that is no longer published. Internal; triggers a reload. */
class StaleGenerationError extends Error {
  constructor(resource: string) {
    super(`Search generation of ${resource} changed during the query`);
  }
}

export const FUZZY_UNSUPPORTED_WARNING =
  "SqliteAdapter does not support fuzzy search; the fuzzy option is ignored and exact (or prefix) matching is used.";

interface NormalizedDocument {
  key: string;
  json: string;
  fieldNames: string[];
}

interface ResolvedSearch {
  query: string;
  fields?: string[];
  limit: number;
  prefix: boolean;
  fieldBoosts?: Record<string, number>;
  namespaceFilter?: string[];
  regionFilter?: string[];
}

export class SqliteAdapter implements SearchAdapter {
  readonly name = "sqlite";
  readonly capabilities: SearchAdapterCapabilities;

  private readonly driver: SqliteDriver;
  private readonly schema: SqliteSchema;
  private readonly maxBatchSize: number;
  private readonly defaults: SearchDefaults;
  private readonly logger?: ObservationLogger;
  private readonly resources = new Map<string, ResourceState>();
  /** Resources named by the last initialize(); null until then. */
  private declared: Set<string> | null = null;
  private resourcesTableReady: Promise<void> | null = null;
  private disposed = false;
  private fuzzyWarned = false;

  constructor(options: SqliteAdapterOptions) {
    if (!options?.driver) {
      throw new SearchAdapterError("DFQL_INVALID", "SqliteAdapter requires a driver");
    }
    const tablePrefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
    if (!isValidTablePrefix(tablePrefix)) {
      throw new SearchAdapterError(
        "DFQL_INVALID",
        "tablePrefix must start with a letter or underscore and contain at most 48 letters, digits or underscores",
      );
    }
    const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
      throw new SearchAdapterError("DFQL_INVALID", "maxBatchSize must be a positive integer");
    }

    this.driver = options.driver;
    this.schema = new SqliteSchema(tablePrefix);
    this.maxBatchSize = maxBatchSize;
    this.defaults = options.defaults ?? {};
    this.logger = normalizeObservability(options.observability)?.child({
      component: "searchfn.sqlite",
    }).logger;
    this.capabilities = {
      persistent: true,
      searchAll: true,
      fuzzy: false,
      prefix: true,
      fieldBoosts: true,
      metadataFilters: true,
      maxBatchSize,
    };
  }

  async initialize({ resources }: InitializeParams): Promise<void> {
    if (this.disposed) {
      this.disposed = false;
    }
    const declared = resources.map(({ name, searchFields }) => ({
      name: requireResourceName(name),
      fields: normalizeSearchFields(name, searchFields),
    }));

    await this.ensureResourcesTable();
    for (const { name, fields } of declared) {
      await this.applyFields(name, fields, false);
    }
    this.declared = new Set(declared.map(({ name }) => name));
  }

  async index({ resource, documents, signal }: IndexParams): Promise<void> {
    this.assertNotDisposed();
    assertNotAborted(signal, "Index operation");
    requireResourceName(resource);
    if (documents.length === 0 || !(await this.isMaintained(resource))) return;

    const normalized = normalizeDocuments(documents);
    const payloads = chunkJson(normalized, this.maxBatchSize, "document");
    await this.ensureResourcesTable();

    for (const payload of payloads) {
      assertNotAborted(signal, "Index operation");
      await this.withResource(
        resource,
        () => this.resolveForWrite(resource, normalized),
        (state) => this.execute(this.schema.upsert(state, payload)),
        undefined,
      );
    }
  }

  async search(params: SearchParams): Promise<Array<string | number>> {
    this.assertNotDisposed();
    assertNotAborted(params.signal, "Search operation");
    requireResourceName(params.resource);
    if (!this.isDeclared(params.resource)) return [];

    const rows = await this.searchResource(params.resource, this.resolveSearch(params, params.limit));
    return rows.map((row) => row.id);
  }

  async searchAll(params: SearchAllParams): Promise<SearchAllResult[]> {
    this.assertNotDisposed();
    assertNotAborted(params.signal, "SearchAll operation");

    const limit = normalizeLimit(params.limit);
    const resolved = this.resolveSearch(params, params.limitPerResource ?? limit);
    const resources = (
      params.resources && params.resources.length > 0
        ? Array.from(new Set(params.resources.map(requireResourceName)))
        : this.declared
          ? Array.from(this.declared).sort(compareText)
          : await this.listResources()
    ).filter((resource) => this.isDeclared(resource));

    const results: SearchAllResult[] = [];
    for (const resource of resources) {
      assertNotAborted(params.signal, "SearchAll operation");
      for (const row of await this.searchResource(resource, resolved)) {
        results.push({ resource, id: row.id, score: row.score });
      }
    }

    results.sort(compareResults);
    return results.slice(0, limit);
  }

  async remove({ resource, ids, signal }: RemoveParams): Promise<void> {
    this.assertNotDisposed();
    assertNotAborted(signal, "Remove operation");
    requireResourceName(resource);
    if (ids.length === 0 || !(await this.isMaintained(resource))) return;

    const keys = Array.from(new Set(ids.map((id) => documentKey(id))));
    const payloads = chunkJson(
      keys.map((key) => ({ key, json: JSON.stringify(key) })),
      this.maxBatchSize,
      "id",
    );
    for (const payload of payloads) {
      assertNotAborted(signal, "Remove operation");
      await this.withResource(
        resource,
        () => this.resolveForRead(resource),
        (state) => this.execute(this.schema.remove(state, payload)),
        undefined,
      );
    }
  }

  async clear(resource: string, signal?: AbortSignal): Promise<void> {
    this.assertNotDisposed();
    assertNotAborted(signal, "Clear operation");
    requireResourceName(resource);
    if (!this.isDeclared(resource)) return;

    await this.withResource(
      resource,
      () => this.resolveForRead(resource),
      (state) => this.execute(this.schema.clear(state)),
      undefined,
    );
  }

  /**
   * Recreate the FTS index of a resource from its stored documents in one transaction.
   * Use it to repair an index after a partial write from a driver without `batch()`.
   * Rebuilds the persisted field list, never this instance's cached one, and drops every
   * older FTS generation. Idempotent; a no-op for an unknown or undeclared resource.
   */
  async rebuild(resource: string, signal?: AbortSignal): Promise<void> {
    this.assertNotDisposed();
    assertNotAborted(signal, "Rebuild operation");
    requireResourceName(resource);
    if (!this.isDeclared(resource)) return;

    await this.applyFields(resource, undefined, true);
  }

  /** Mark the adapter disposed. The injected driver stays open; its owner closes it. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.resources.clear();
    this.declared = null;
    this.resourcesTableReady = null;
  }

  // -------------------------------------------------------------------------
  // Resource state
  // -------------------------------------------------------------------------

  private ensureResourcesTable(): Promise<void> {
    this.resourcesTableReady ??= this.driver
      .exec(this.schema.createResourcesTable())
      .catch((error: unknown) => {
        this.resourcesTableReady = null;
        throw error;
      });
    return this.resourcesTableReady;
  }

  /** Read a resource row. Pending registrations are finished when `complete` is set. */
  private async loadState(resource: string, complete: boolean): Promise<ResourceState | undefined> {
    let rows: ResourceRow[];
    try {
      rows = await this.driver.all<ResourceRow>(this.schema.selectResource(), [resource]);
    } catch (error) {
      if (isMissingTableError(error)) return undefined;
      throw error;
    }
    const row = rows[0];
    if (!row) {
      this.resources.delete(resource);
      return undefined;
    }

    let state: ResourceState = {
      id: Number(row.id),
      resource,
      fields: parseStoredFields(resource, row.fields),
      generation: Number(row.generation),
    };
    if (state.generation === PENDING_GENERATION) {
      if (!complete) return undefined;
      try {
        await this.execute(this.schema.completeRegistration(state));
      } catch (error) {
        // Another instance finished the registration first.
        if (!this.schema.isStaleGenerationError(error)) throw error;
      }
      const completed = await this.loadState(resource, false);
      if (!completed) {
        throw new SearchAdapterError("SEARCH_BACKEND_ERROR", `Could not register search resource ${resource}`);
      }
      if (completed.generation > 0) {
        // Generation 0 is retired. A driver without batch() may have recreated it after the
        // guard passed; drop it so it does not linger.
        await this.driver.exec(this.schema.dropFtsTable(completed, 0));
      }
      state = completed;
    }
    this.resources.set(resource, state);
    return state;
  }

  private async register(resource: string, fields: string[]): Promise<ResourceState> {
    const insert = this.schema.insertPendingResource(resource, fields);
    await this.driver.run(insert.sql, insert.params);
    const state = await this.loadState(resource, true);
    if (!state) {
      throw new SearchAdapterError("SEARCH_BACKEND_ERROR", `Could not register search resource ${resource}`);
    }
    return state;
  }

  /**
   * After initialize(), only declared resources are registered and searched, so records of
   * resources without search fields (for example every @datafn/server mutation) are ignored.
   */
  private isDeclared(resource: string): boolean {
    return this.declared === null || this.declared.has(resource);
  }

  /**
   * Writes also reach a resource that is registered but not declared here, so its index never
   * misses a mutation and re-declaring it cannot expose stale records. They never register one.
   */
  private async isMaintained(resource: string): Promise<boolean> {
    return this.isDeclared(resource) || (await this.resolveForRead(resource)) !== undefined;
  }

  private async resolveForRead(resource: string): Promise<ResourceState | undefined> {
    return this.resources.get(resource) ?? (await this.loadState(resource, true));
  }

  private async resolveForWrite(
    resource: string,
    documents: NormalizedDocument[],
  ): Promise<ResourceState> {
    const existing = await this.resolveForRead(resource);
    if (existing) return existing;

    // index() before initialize(): declare the fields present in this call.
    const fields = Array.from(new Set(documents.flatMap((document) => document.fieldNames)));
    if (fields.length === 0) {
      throw new SearchAdapterError(
        "DFQL_INVALID",
        `Cannot infer search fields for uninitialized resource ${resource}; call initialize() first`,
      );
    }
    return this.register(resource, normalizeSearchFields(resource, fields));
  }

  /**
   * Make `fields` the indexed field list of a resource, rebuilding the FTS table when the
   * list changes (or always, with `force`). Without `fields`, rebuild the persisted list of an
   * existing resource. Retries when another writer rebuilt concurrently.
   */
  private async applyFields(resource: string, fields: string[] | undefined, force: boolean): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let state = await this.loadState(resource, true);
      if (!state) {
        if (!fields) return;
        state = await this.register(resource, fields);
      }
      const target = fields ?? state.fields;
      if (!force && sameFields(state.fields, target)) return;

      try {
        await this.execute(this.schema.rebuild(state, target, await this.listFtsGenerations(state)));
        this.resources.set(resource, { ...state, fields: target, generation: state.generation + 1 });
        return;
      } catch (error) {
        this.resources.delete(resource);
        // Retry only a lost compare-and-swap. Any other failure aborted the batch; without
        // batch() it may leave tables behind, which the next rebuild drops in its transaction.
        if (!this.schema.isStaleGenerationError(error) || attempt >= MAX_SCHEMA_ATTEMPTS) throw error;
      }
    }
  }

  private async listFtsGenerations(state: ResourceState): Promise<number[]> {
    const statement = this.schema.selectFtsTables(state);
    const rows = await this.driver.all<{ name: string }>(statement.sql, statement.params);
    return rows.flatMap(({ name }) => {
      const generation = this.schema.ftsGeneration(state, String(name));
      return generation === undefined ? [] : [generation];
    });
  }

  private async listResources(): Promise<string[]> {
    try {
      const rows = await this.driver.all<{ resource: string }>(this.schema.selectResourceNames());
      return rows.map((row) => row.resource);
    } catch (error) {
      if (isMissingTableError(error)) return [];
      throw error;
    }
  }

  /**
   * Run `operation` against the cached resource state. Every operation verifies the published
   * generation (writes with a guard statement, searches through the generation column), so
   * when another instance swapped the FTS generation out, reload the state and retry. A
   * missing table alone is not trusted as the signal: a retired table may still exist.
   */
  private async withResource<T>(
    resource: string,
    resolve: () => Promise<ResourceState | undefined>,
    operation: (state: ResourceState) => Promise<T>,
    missing: T,
  ): Promise<T> {
    let state = await resolve();
    for (let attempt = 1; state; attempt++) {
      try {
        return await operation(state);
      } catch (error) {
        const stale = error instanceof StaleGenerationError || this.schema.isStaleGenerationError(error);
        if (attempt >= MAX_SCHEMA_ATTEMPTS || (!stale && !isMissingTableError(error))) throw error;
        this.resources.delete(resource);
        const refreshed = await resolve();
        if (refreshed?.id === state.id && refreshed.generation === state.generation) throw error;
        state = refreshed;
      }
    }
    return missing;
  }

  private async execute(statements: SqliteStatement[]): Promise<void> {
    if (this.driver.batch) {
      await this.driver.batch(statements);
      return;
    }
    for (const statement of statements) {
      await this.driver.run(statement.sql, statement.params);
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  private resolveSearch(params: SearchParams | SearchAllParams, limit: number | undefined): ResolvedSearch {
    if (typeof params.query !== "string") {
      throw new SearchAdapterError("DFQL_INVALID", "query must be a string");
    }
    const fuzzy = params.fuzzy ?? this.defaults.fuzzy;
    if (fuzzy !== undefined && fuzzy !== false && fuzzy !== 0) {
      this.warnFuzzyIgnored();
    }
    return {
      query: params.query,
      fields: params.fields,
      limit: normalizeLimit(limit),
      prefix: (params.prefix ?? this.defaults.prefix) === true,
      fieldBoosts: params.fieldBoosts ?? this.defaults.fieldBoosts,
      namespaceFilter: normalizeFilter(params.namespaceFilter),
      regionFilter: normalizeFilter(params.regionFilter),
    };
  }

  private async searchResource(
    resource: string,
    search: ResolvedSearch,
  ): Promise<Array<{ id: string | number; score: number }>> {
    const cached = this.resources.get(resource);
    if (cached && search.fields?.length && !search.fields.some((field) => cached.fields.includes(field))) {
      // No SQL would run against the cached generation, so a stale field list would never be
      // noticed. Re-read it before concluding that none of the requested fields is indexed.
      this.resources.delete(resource);
    }
    const rows = await this.withResource(
      resource,
      () => this.resolveForRead(resource),
      async (state) => {
        let columns: number[] | undefined;
        if (search.fields && search.fields.length > 0) {
          const requested = new Set(search.fields);
          columns = state.fields.flatMap((field, index) => (requested.has(field) ? [index] : []));
          if (columns.length === 0) return [];
          if (columns.length === state.fields.length) columns = undefined;
        }

        const match = compileMatch(search.query, {
          columns,
          prefix: search.prefix,
          maxTerms: MAX_QUERY_TERMS,
        });
        if (!match) return [];

        const statement = this.schema.search(state, {
          match,
          weights: state.fields.map((field) => fieldWeight(search.fieldBoosts, field)),
          namespaceFilter: search.namespaceFilter,
          regionFilter: search.regionFilter,
          limit: search.limit,
        });
        const result = await this.driver.all<SearchRow>(statement.sql, statement.params);
        if (result.length === 0 || Number(result[0].generation) !== state.generation) {
          throw new StaleGenerationError(resource);
        }
        return result.filter((row) => row.doc_id !== null && row.doc_id !== undefined);
      },
      [] as SearchRow[],
    );

    return rows.map((row) => ({
      id: decodeId(String(row.doc_id), String(row.id_type)),
      score: Number(row.score),
    }));
  }

  private warnFuzzyIgnored(): void {
    if (this.fuzzyWarned) return;
    this.fuzzyWarned = true;
    if (this.logger?.warn) {
      this.logger.warn(FUZZY_UNSUPPORTED_WARNING, { adapter: this.name });
    } else {
      console.warn(`[searchfn] ${FUZZY_UNSUPPORTED_WARNING}`);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new SearchAdapterError(
        SEARCH_ADAPTER_DISPOSED,
        "Search adapter is disposed. Call initialize() before use.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) {
    throw new SearchAdapterError("DFQL_ABORTED", `${operation} aborted`);
  }
}

function requireResourceName(resource: unknown): string {
  if (typeof resource !== "string" || resource.length === 0) {
    throw new SearchAdapterError("DFQL_INVALID", "resource must be a non-empty string");
  }
  return resource;
}

function normalizeSearchFields(resource: string, fields: unknown): string[] {
  if (!Array.isArray(fields)) {
    throw new SearchAdapterError("DFQL_INVALID", `searchFields for ${resource} must be an array`);
  }
  const normalized: string[] = [];
  for (const field of fields) {
    if (typeof field !== "string" || field.length === 0 || field.includes("\u0000")) {
      throw new SearchAdapterError(
        "DFQL_INVALID",
        `searchFields for ${resource} must be non-empty strings without NUL characters`,
      );
    }
    if (!normalized.includes(field)) normalized.push(field);
  }
  if (normalized.length === 0) {
    throw new SearchAdapterError("DFQL_INVALID", `searchFields for ${resource} must not be empty`);
  }
  return normalized;
}

function parseStoredFields(resource: string, raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((field) => typeof field === "string")) {
      return parsed;
    }
  } catch {
    // fall through
  }
  throw new SearchAdapterError(
    "SEARCH_INDEX_FORMAT_MISMATCH",
    `Stored search fields for ${resource} are not a JSON string array`,
  );
}

function sameFields(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((field) => rightSet.has(field));
}

function documentKey(id: unknown): string {
  if (typeof id === "string") return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  throw new SearchAdapterError("DFQL_INVALID", "document ids must be strings or finite numbers");
}

function decodeId(key: string, type: string): string | number {
  return type === "n" ? Number(key) : key;
}

function metadataValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function fieldValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Validate documents and serialize them for the JSON write parameter. Last duplicate id wins. */
function normalizeDocuments(documents: SearchDocument[]): NormalizedDocument[] {
  const byKey = new Map<string, NormalizedDocument>();
  for (const document of documents) {
    if (!document || typeof document !== "object") {
      throw new SearchAdapterError("DFQL_INVALID", "documents must be objects");
    }
    const key = documentKey(document.id);
    if (!document.fields || typeof document.fields !== "object" || Array.isArray(document.fields)) {
      throw new SearchAdapterError("DFQL_INVALID", `document ${key} must have a fields object`);
    }

    // Null prototype so a field named "__proto__" is stored like any other.
    const fields: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(document.fields)) {
      const text = fieldValue(value);
      if (text !== undefined) fields[name] = text;
    }
    const json = JSON.stringify({
      i: key,
      t: typeof document.id === "number" ? "n" : "s",
      n: metadataValue(document.metadata?.__ns),
      r: metadataValue(document.metadata?.__region),
      f: fields,
    });
    byKey.delete(key);
    byKey.set(key, { key, json, fieldNames: Object.keys(fields) });
  }
  return Array.from(byKey.values());
}

const encoder = new TextEncoder();

/**
 * Group serialized values into JSON array payloads of at most `maxBatchSize` items and
 * MAX_BATCH_PAYLOAD_BYTES UTF-8 bytes. Runs before any write, so a value that cannot fit is
 * rejected before an earlier chunk commits.
 */
function chunkJson(
  items: ReadonlyArray<{ key: string; json: string }>,
  maxBatchSize: number,
  kind: "document" | "id",
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let bytes = 2;
  for (const { key, json } of items) {
    const size = encoder.encode(json).length + 1;
    if (2 + size > MAX_BATCH_PAYLOAD_BYTES) {
      throw new SearchAdapterError(
        "DFQL_INVALID",
        `Serialized ${kind} ${key.slice(0, 64)} exceeds the ${MAX_BATCH_PAYLOAD_BYTES}-byte write limit`,
      );
    }
    if (current.length > 0 && (current.length >= maxBatchSize || bytes + size > MAX_BATCH_PAYLOAD_BYTES)) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      bytes = 2;
    }
    current.push(json);
    bytes += size;
  }
  if (current.length > 0) chunks.push(`[${current.join(",")}]`);
  return chunks;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.floor(limit));
}

function normalizeFilter(filter: string[] | undefined): string[] | undefined {
  if (!filter || filter.length === 0) return undefined;
  return filter.map((value) => String(value));
}

function fieldWeight(boosts: Record<string, number> | undefined, field: string): number {
  const weight = boosts && Object.prototype.hasOwnProperty.call(boosts, field) ? boosts[field] : 1;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
    throw new SearchAdapterError("DFQL_INVALID", `fieldBoosts.${field} must be a finite number >= 0`);
  }
  return weight;
}

/** Code-unit order, independent of the host locale. */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareResults(left: SearchAllResult, right: SearchAllResult): number {
  if (left.score !== right.score) return right.score - left.score;
  return compareText(left.resource, right.resource) || compareText(String(left.id), String(right.id));
}
