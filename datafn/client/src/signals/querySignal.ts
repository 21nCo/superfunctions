/**
 * Query Signal Implementation
 *
 * Reactive query signals with caching, lazy fetch, and auto-refresh on mutations.
 */

import type { DatafnSignal, DatafnError, DatafnPlugin, DatafnSchema } from "@datafn/core";
import {
  dfqlKey,
  endpointList,
  findRelationMatch,
  relationTargetEndpoint,
} from "@datafn/core";
import type { EventBus } from "../events/bus.js";
import type { DatafnSignalOptions } from "./options.js";

/** Options the client uses for signals it builds itself. */
export type QuerySignalInternalOptions = {
  /**
   * "count" makes the signal value the query's `count` (the query must ask
   * for `count: true`) instead of its records.
   */
  value?: "records" | "count";
};

/**
 * Refreshes caused by changes are coalesced: every change inside one window
 * (an animation frame in a browser, about 16 ms elsewhere) re-runs a signal's
 * query at most once.
 */
const REFRESH_WINDOW_MS = 16;

function scheduleAfterFrame(run: () => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown })
    .requestAnimationFrame;
  const visible =
    typeof document === "undefined" ||
    (document as { visibilityState?: string }).visibilityState !== "hidden";
  if (typeof raf === "function" && visible) {
    raf(() => run());
    return;
  }
  setTimeout(run, REFRESH_WINDOW_MS);
}

/**
 * Runs a query and reports the query the client's plugins produced from it.
 */
export type ObservedQueryRunner = (
  query: unknown,
  observeQuery: (effectiveQuery: unknown) => void,
) => Promise<unknown>;

/**
 * Signal registry for caching signals by dfqlKey
 */
export class SignalRegistry {
  private signals = new Map<string, DatafnSignal<any>>();
  private client: any;
  private eventBus: EventBus;
  private schema: DatafnSchema;
  private plugins: DatafnPlugin[];
  private observedQuery?: ObservedQueryRunner;

  /**
   * @param plugins The client's plugins. Signals read the query these
   *   plugins produce to tell which fields a merge must touch to matter.
   * @param observedQuery Runs a signal's query and reports the query the
   *   plugins produced. Without it, a signal whose query plugins can rewrite
   *   refreshes on every merge.
   */
  constructor(
    client: any,
    eventBus: EventBus,
    schema: DatafnSchema,
    plugins: DatafnPlugin[] = [],
    observedQuery?: ObservedQueryRunner,
  ) {
    this.client = client;
    this.eventBus = eventBus;
    this.schema = schema;
    this.plugins = plugins;
    this.observedQuery = observedQuery;
  }

  getSignal<T>(
    fullQuery: unknown,
    options?: DatafnSignalOptions,
    internal?: QuerySignalInternalOptions,
  ): DatafnSignal<T> {
    const key = internal?.value === "count"
      ? `count:${dfqlKey(fullQuery)}`
      : dfqlKey(fullQuery);

    // Return cached signal if exists
    if (this.signals.has(key)) {
      return this.signals.get(key) as DatafnSignal<T>;
    }

    // Create new signal
    const signal = createQuerySignal<T>(
      this.client,
      this.eventBus,
      this.schema,
      fullQuery,
      key,
      () => this.removeSignal(key),
      options,
      internal,
      this.plugins,
      this.observedQuery,
    );
    this.signals.set(key, signal);
    return signal;
  }

  /**
   * Remove a signal from the registry (called by signal.dispose())
   */
  private removeSignal(key: string): void {
    this.signals.delete(key);
  }

  /**
   * Dispose all signals in the registry
   */
  disposeAll(): void {
    // Create array copy to avoid iterator invalidation
    const signalsToDispose = Array.from(this.signals.values());
    signalsToDispose.forEach((signal) => signal.dispose());
    // signals.clear() not needed - dispose() removes each signal
  }
}

/**
 * Derive the footprint (set of resources) that affect a query signal (SIG-002)
 *
 * Footprint includes:
 * - Primary resource from query
 * - Resources referenced by relation expansion tokens in select array (via schema lookup)
 *
 * Relation expansion tokens are parsed for patterns like:
 * - "relationName.*" (expand all fields)
 * - "relationName.field" (expand specific field)
 */
function deriveQueryFootprint(query: any, schema: DatafnSchema): Set<string> {
  const footprint = new Set<string>();

  // Add primary resource
  if (query.resource) {
    footprint.add(query.resource);
  }

  // Parse select array for relation expansion tokens
  if (Array.isArray(query.select) && schema.relations) {
    for (const token of query.select) {
      if (typeof token === "string" && token.includes(".")) {
        const relationName = token.split(".")[0];
        const match = findRelationMatch(schema, query.resource, relationName);
        if (match) {
          endpointList(relationTargetEndpoint(match.relation, match.direction))
            .filter((resource) => resource !== query.resource)
            .forEach((resource) => footprint.add(resource));
        }
      }
    }
  }

  return footprint;
}

/**
 * Extract record IDs from a query result (SIG-002)
 */
function extractRecordIds(result: any): Set<string> | null {
  const ids = new Set<string>();
  
  // Handle result with data array (standard query result)
  if (result && Array.isArray(result.data)) {
    for (const record of result.data) {
      if (record && typeof record.id === "string") {
        ids.add(record.id);
      }
    }
    return ids.size > 0 ? ids : null;
  }
  
  // Handle direct array result (some queries may return arrays directly)
  if (Array.isArray(result)) {
    for (const record of result) {
      if (record && typeof record.id === "string") {
        ids.add(record.id);
      }
    }
    return ids.size > 0 ? ids : null;
  }
  
  // Single record result
  if (result && typeof result.id === "string") {
    ids.add(result.id);
    return ids;
  }
  
  return null;
}

/**
 * Apply optimistic patch to signal cache (SIG-003)
 * 
 * Attempts to patch cached records with mutation data without re-fetching.
 * Returns the patched value if successful, null if patching is not possible.
 */
function applyOptimisticPatch(currentValue: any, event: any): any | null {
  // Only handle merge operations with record data
  if (event.action !== "merge" || !event.record) {
    return null;
  }
  
  // Extract mutation IDs
  const mutationIds = event.ids;
  if (!mutationIds || !Array.isArray(mutationIds) || mutationIds.length === 0) {
    return null;
  }
  
  // Handle result with data array (standard query result format)
  if (currentValue && Array.isArray(currentValue.data)) {
    let patched = false;
    const patchedData = currentValue.data.map((record: any) => {
      if (record && typeof record.id === "string" && mutationIds.includes(record.id)) {
        patched = true;
        // Shallow merge: spread existing record, then apply mutation fields
        return { ...record, ...event.record };
      }
      return record;
    });
    
    if (!patched) {
      // No records were patched (IDs not found in cache)
      return null;
    }
    
    // Return new result object with patched data
    return {
      ...currentValue,
      data: patchedData,
    };
  }
  
  // Handle direct array result
  if (Array.isArray(currentValue)) {
    let patched = false;
    const patchedArray = currentValue.map((record: any) => {
      if (record && typeof record.id === "string" && mutationIds.includes(record.id)) {
        patched = true;
        return { ...record, ...event.record };
      }
      return record;
    });
    
    if (!patched) {
      return null;
    }
    
    return patchedArray;
  }
  
  // Handle single record result
  if (currentValue && typeof currentValue.id === "string" && mutationIds.includes(currentValue.id)) {
    return { ...currentValue, ...event.record };
  }
  
  // Unknown format or no match
  return null;
}

function hasMembershipSensitiveQueryShape(query: any): boolean {
  return Boolean(
    query?.filters ||
      query?.search ||
      query?.sort ||
      query?.limit ||
      query?.offset ||
      query?.count
  );
}

/** Fields DataFn changes as a side effect of capability writes and propagation. */
const CAPABILITY_STATE_FIELDS = [
  "trashedAt",
  "trashedBy",
  "isArchived",
  "archivedAt",
  "isAncestorInactive",
];

/**
 * The ids a query's filters restrict it to: `id` as a value, `eq`/`$eq` or
 * `in`/`$in` of strings, at the top level or in a top-level `$and` clause.
 * Only records with these ids can ever be in the result.
 */
export function resolvePinnedQueryIds(query: any): Set<string> | undefined {
  const fromClause = (clause: unknown): Set<string> | undefined => {
    if (!isPlainObject(clause)) return undefined;
    const pinned = idsFromIdFilter(clause.id);
    if (pinned) return pinned;
    if (Array.isArray(clause.$and)) {
      for (const sub of clause.$and) {
        const pinned = fromClause(sub);
        if (pinned) return pinned;
      }
    }
    return undefined;
  };
  return fromClause(query?.filters);
}

/**
 * The ids one `id` filter value restricts a query to: a string, or a single
 * `eq`/`$eq` string or `in`/`$in` list of strings.
 */
function idsFromIdFilter(idFilter: unknown): Set<string> | undefined {
  if (typeof idFilter === "string") return new Set([idFilter]);
  // Exactly one operator: aliases given together (`eq` and `$eq`) are
  // resolved by the executor, not here.
  if (!isPlainObject(idFilter) || Object.keys(idFilter).length !== 1) return undefined;
  const [operator, operand] = Object.entries(idFilter)[0];
  if ((operator === "eq" || operator === "$eq") && typeof operand === "string") {
    return new Set([operand]);
  }
  if (
    (operator === "in" || operator === "$in") &&
    Array.isArray(operand) &&
    operand.every((value: unknown) => typeof value === "string")
  ) {
    return new Set(operand as string[]);
  }
  return undefined;
}

/** The field a sort term names: `"-field"`, `"field:dir"` or `{ field }`. */
function sortTermField(term: unknown): unknown {
  if (typeof term !== "string") return (term as { field?: unknown } | null | undefined)?.field;
  if (term.startsWith("-")) return term.slice(1);
  return term.split(":")[0];
}

/**
 * Whether a query reads only its records' own fields: deriveMembershipFields
 * rejects relations and dotted paths in select and filters and every
 * field-independent shape (search, temporal, aggregates); sort terms must
 * also name own fields.
 */
function readsOwnFieldsOnly(schema: DatafnSchema, query: any): boolean {
  if (!deriveMembershipFields(query, schema)) return false;
  for (const term of Array.isArray(query.sort) ? query.sort : []) {
    const field = sortTermField(term);
    if (
      typeof field !== "string" ||
      field.includes(".") ||
      findRelationMatch(schema, query.resource, field)
    ) {
      return false;
    }
  }
  return true;
}

function resourceHasRelations(schema: DatafnSchema, resource: string): boolean {
  return (schema.relations ?? []).some(
    (relation) =>
      endpointList(relation.from).includes(resource) || endpointList(relation.to).includes(resource),
  );
}

/** Fields a local merge stamps without the caller naming them. */
const IMPLICIT_MERGE_FIELDS = ["updatedAt", "updatedBy"];

/** Query keys whose results can change when any field of a record changes. */
const FIELD_INDEPENDENT_SHAPE_KEYS = [
  "search",
  "groupBy",
  "temporal",
  "aggregate",
  "aggregates",
  "aggregations",
  "having",
  "relation",
  "cursor",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collects the record fields a filter reads. Returns null when the filter
 * reads through a relation or a nested path, which a merge of this record's
 * own fields cannot be checked against.
 */
function collectFilterFields(
  filters: unknown,
  schema: DatafnSchema,
  resource: string,
  out: Set<string>,
  depth = 0,
): boolean {
  if (filters === undefined || filters === null) return true;
  if (!isPlainObject(filters) || depth > 10) return false;
  for (const [key, value] of Object.entries(filters)) {
    if (key === "$and" || key === "$or") {
      if (!Array.isArray(value)) return false;
      for (const sub of value) {
        if (!collectFilterFields(sub, schema, resource, out, depth + 1)) return false;
      }
      continue;
    }
    if (key === "$not") {
      if (!collectFilterFields(value, schema, resource, out, depth + 1)) return false;
      continue;
    }
    if (key.startsWith("$") || key.includes(".")) return false;
    if (findRelationMatch(schema, resource, key)) return false;
    out.add(key);
  }
  return true;
}

function relationFkFields(schema: DatafnSchema, resource: string): Set<string> {
  const fields = new Set<string>();
  for (const relation of schema.relations ?? []) {
    const from = endpointList(relation.from);
    const to = endpointList(relation.to);
    if (relation.type === "many-one" && from.includes(resource)) {
      fields.add(relation.fkField || relation.foreignKey || `${relation.relation ?? to[0]}Id`);
    } else if (relation.type === "one-many" && to.includes(resource)) {
      fields.add(relation.fkField || relation.foreignKey || relation.inverse || `${from[0]}Id`);
    } else if (relation.type === "htree" && to.includes(resource)) {
      fields.add(relation.fkField || relation.foreignKey || relation.inverse || "parentId");
    }
    if (relation.fkResourceField) fields.add(relation.fkResourceField);
  }
  return fields;
}

/**
 * The fields of a record that decide whether it belongs to the query's result
 * and where it sorts, or null when that cannot be told from the query.
 */
function deriveMembershipFields(query: any, schema: DatafnSchema): Set<string> | null {
  if (!isPlainObject(query) || typeof query.resource !== "string") return null;
  for (const key of FIELD_INDEPENDENT_SHAPE_KEYS) {
    if (query[key] !== undefined && query[key] !== null) return null;
  }
  // Relation expansion reads other records, which a merge here may change.
  // A bare relation name ("children", "tags") expands too.
  if (
    query.select !== undefined &&
    (!Array.isArray(query.select) ||
      query.select.some(
        (token: unknown) =>
          typeof token !== "string" ||
          token.includes(".") ||
          Boolean(findRelationMatch(schema, query.resource as string, token)),
      ))
  ) {
    return null;
  }
  const fields = new Set<string>(["id", ...CAPABILITY_STATE_FIELDS]);
  if (!collectFilterFields(query.filters, schema, query.resource, fields)) return null;
  if (query.sort !== undefined) {
    if (!Array.isArray(query.sort)) return null;
    for (const term of query.sort) {
      if (typeof term === "string") {
        const field = term.startsWith("-") ? term.slice(1) : term.split(":")[0];
        fields.add(field);
      } else if (isPlainObject(term) && typeof term.field === "string") {
        fields.add(term.field);
      } else {
        return null;
      }
    }
  }
  for (const field of relationFkFields(schema, query.resource)) fields.add(field);
  // A field the merge stamps implicitly counts as touched when the query reads it.
  return fields;
}

/** Whether a merge event can change which records match the query or their order. */
function mergeCanChangeMembership(
  event: any,
  membershipFields: ReadonlySet<string> | null,
): boolean {
  if (!membershipFields) return true;
  if (!isPlainObject(event.record)) return true;
  for (const key of Object.keys(event.record)) {
    if (membershipFields.has(key)) return true;
  }
  for (const key of IMPLICIT_MERGE_FIELDS) {
    if (membershipFields.has(key)) return true;
  }
  return false;
}

function withIdFilter(query: any, ids: string[]): any {
  const idFilter = { id: { $in: ids } };
  const filters = isPlainObject(query.filters) && Object.keys(query.filters).length > 0
    ? { $and: [query.filters, idFilter] }
    : idFilter;
  const {
    limit: _limit,
    offset: _offset,
    cursor: _cursor,
    count: _count,
    sort: _sort,
    ...rest
  } = query;
  return { ...rest, filters };
}

/**
 * Create a reactive query signal
 */
function createQuerySignal<T>(
  client: any,
  eventBus: EventBus,
  schema: DatafnSchema,
  fullQuery: any,
  signalKey: string,
  removeFromRegistry: () => void,
  options?: DatafnSignalOptions,
  internal?: QuerySignalInternalOptions,
  plugins: DatafnPlugin[] = [],
  observedQuery?: ObservedQueryRunner,
): DatafnSignal<T> {
  const countValue = internal?.value === "count";
  let currentValue: T | undefined;
  let currentCursor: string | null = null;
  const subscribers = new Set<(value: T) => void>();
  let inFlight = false;
  let fullFetchSeq = 0;
  let isRefresh = false;
  let queuedRefresh = false;
  let currentError: DatafnError | null = null;
  const resource = fullQuery.resource;
  let disposed = false;
  let unsubscribeFn: (() => void) | null = null;

  // Track cached record IDs for fine-grained invalidation (SIG-002)
  let cachedIds: Set<string> | null = null;

  // Optimistic update option (SIG-003)
  const disableOptimistic = options?.disableOptimistic ?? false;

  // Helper to notify all subscribers (notify on any state change, not just value change)
  const notifySubscribers = () => {
    subscribers.forEach((fn) => fn(currentValue as T));
  };

  const fetchQuery = async (refresh = false): Promise<void> => {
    if (inFlight) {
      // Queue a refresh to happen after current fetch completes
      if (refresh) {
        queuedRefresh = true;
      }
      return;
    }

    inFlight = true;
    isRefresh = refresh;
    queuedRefresh = false;
    // A full read supersedes any per-record re-read still running.
    fullFetchSeq++;
    // Clear error when starting a new fetch
    if (!refresh) {
      currentError = null;
    }

    try {
      const result = await runFullQuery();
      // Unwrap pagination envelope: emit the record array directly
      const queryResult = result as {
        data?: any[];
        nextCursor?: string | null;
        count?: number;
      };
      currentValue = (
        countValue
          ? typeof queryResult?.count === "number"
            ? queryResult.count
            : Array.isArray(queryResult?.data)
              ? queryResult.data.length
              : Array.isArray(result)
                ? (result as unknown[]).length
                : 0
          : queryResult.data ?? result
      ) as T;
      currentCursor = queryResult.nextCursor ?? null;
      currentError = null;

      // Extract and cache record IDs from result (SIG-002)
      cachedIds = countValue ? null : extractRecordIds(currentValue);

      // Clear flight flags BEFORE notifying so loading/refreshing read correctly
      inFlight = false;
      isRefresh = false;

      notifySubscribers();
    } catch (error: any) {
      // Convert error to DatafnError format
      const dfError: DatafnError = {
        code: error?.code || "INTERNAL",
        message: error?.message || "Query failed",
        details: error?.details,
      };

      if (!refresh) {
        // Initial load error - store and notify
        currentError = dfError;
        // Clear flight flags BEFORE notifying so loading reads correctly
        inFlight = false;
        isRefresh = false;
        notifySubscribers();
        // Preserve throw behavior for initial-load failures
        throw error;
      } else {
        // Refresh error - store but don't notify with error updates
        currentError = dfError;
        // Don't notify subscribers of refresh errors to avoid UI disruption
      }
    } finally {
      inFlight = false;
      isRefresh = false;

      // A change arrived while this fetch ran: refresh once more, coalesced
      // with any other change in the same window.
      if (queuedRefresh) {
        queuedRefresh = false;
        scheduleRefresh();
      }
    }
  };

  // Derive footprint from query with schema lookup (SIG-002)
  const footprint = deriveQueryFootprint(fullQuery, schema);

  // Merges that leave every field in this set unchanged cannot change which
  // records match or their order (SIG-002). Client plugins can rewrite the
  // query (beforeQuery) or the result (afterQuery), so the set also covers
  // the query the plugins produce; until that is known, every merge counts.
  const clientPlugins = plugins.filter(
    (plugin) => Array.isArray(plugin?.runsOn) && plugin.runsOn.includes("client"),
  );
  const queryHooks = clientPlugins.filter((plugin) => typeof plugin.beforeQuery === "function");
  const baseMembershipFields = clientPlugins.some(
    (plugin) => typeof plugin.afterQuery === "function",
  )
    ? null
    : deriveMembershipFields(fullQuery, schema);
  let membershipFields: Set<string> | null =
    queryHooks.length > 0 ? null : baseMembershipFields;

  // A query pinned to record ids (e.g. a KV key's signal) can only change
  // when one of those records does, as long as it reads only those records'
  // own fields: no relation in its select, filters or sort, and no search,
  // whose candidate limit depends on how every record ranks
  // (deriveMembershipFields is null otherwise). Only a resource that takes
  // part in no relation qualifies: there a write changes only the records it
  // names, with no cascade, inactive propagation or tree move. Plugins can
  // rewrite the query or its result, so a signal they run on is never
  // treated as pinned.
  const pinnedIds =
    !resourceHasRelations(schema, resource) &&
    !clientPlugins.some(
      (plugin) => typeof plugin.beforeQuery === "function" || typeof plugin.afterQuery === "function",
    ) &&
    readsOwnFieldsOnly(schema, fullQuery)
      ? resolvePinnedQueryIds(fullQuery)
      : undefined;
  /**
   * How a write to this signal's resource affects its pinned records:
   * "skip" when it names none of them, "refresh" when its record carries an
   * `id` other than the ids it names (a store may write under either), and
   * null to use the general rules. A write that may carry a record but
   * arrives without one (relayed from another tab) is never skipped.
   */
  const pinnedWriteDecision = (event: any): "skip" | "refresh" | null => {
    if (!pinnedIds) return null;
    const ids = event.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id: unknown) => typeof id === "string") ||
      ids.some((id: string) => pinnedIds.has(id))
    ) {
      return null;
    }
    if (event.action === "delete") return "skip";
    if (!isPlainObject(event.record)) return null;
    const recordId = event.record.id;
    if (recordId === undefined) return "skip";
    if (typeof recordId !== "string" || pinnedIds.has(recordId)) return "refresh";
    return "skip";
  };
  let membershipRun = 0;
  /**
   * Runs the signal's query. When plugins can rewrite it, the membership set
   * is rebuilt from the query they produced for this read, without running
   * their hooks a second time.
   */
  const runFullQuery = (): Promise<unknown> => {
    if (!baseMembershipFields || queryHooks.length === 0 || !observedQuery) {
      return client.query(fullQuery);
    }
    const run = ++membershipRun;
    // Until this read reports its query, every merge counts.
    membershipFields = null;
    return observedQuery(fullQuery, (effectiveQuery) => {
      if (run !== membershipRun) return;
      const fields = deriveMembershipFields(effectiveQuery, schema);
      membershipFields = fields ? new Set([...baseMembershipFields, ...fields]) : null;
    });
  };

  // Coalescing state for refreshes (SIG-002): a full re-run, and records to
  // re-read by id.
  let refreshTimerPending = false;
  let pendingFullRefresh = false;
  const pendingRecordIds = new Set<string>();
  // Per-record re-reads run one at a time and never alongside a full read;
  // a full read that starts while one runs makes its result stale.
  let recordsInFlight = false;
  let flushAfterRecords = false;
  // A write that could change the result arrived while no one subscribed.
  let staleWhileIdle = false;

  const flushScheduled = () => {
    refreshTimerPending = false;
    if (disposed) {
      pendingFullRefresh = false;
      pendingRecordIds.clear();
      return;
    }
    if (recordsInFlight) {
      // Keep what is pending and flush once the re-read settles.
      flushAfterRecords = true;
      return;
    }
    if (subscribers.size === 0 && currentValue !== undefined) {
      // Nobody is reading this result: re-read once someone subscribes
      // again instead of on every write while it sits idle.
      pendingFullRefresh = false;
      pendingRecordIds.clear();
      staleWhileIdle = true;
      return;
    }
    if (subscribers.size === 0 && currentError !== null && !inFlight) {
      // The first read failed and nobody is reading: the next subscribe
      // retries it.
      pendingFullRefresh = false;
      pendingRecordIds.clear();
      return;
    }
    if (pendingFullRefresh || inFlight) {
      pendingFullRefresh = false;
      pendingRecordIds.clear();
      fetchQuery(true).catch(() => {});
      return;
    }
    if (pendingRecordIds.size > 0) {
      const ids = [...pendingRecordIds];
      pendingRecordIds.clear();
      recordsInFlight = true;
      refreshRecords(ids)
        .catch(() => scheduleRefresh())
        .finally(() => {
          recordsInFlight = false;
          if (flushAfterRecords) {
            flushAfterRecords = false;
            scheduleFlush();
          }
        });
    }
  };

  const scheduleFlush = () => {
    if (refreshTimerPending) return;
    refreshTimerPending = true;
    scheduleAfterFrame(flushScheduled);
  };

  function scheduleRefresh(): void {
    pendingFullRefresh = true;
    scheduleFlush();
  }

  const scheduleRecordRefresh = (ids: string[]) => {
    ids.forEach((id) => pendingRecordIds.add(id));
    scheduleFlush();
  };

  /**
   * Re-reads changed records that are already in the result and replaces them
   * in place. Falls back to a full refresh when one no longer matches.
   */
  const refreshRecords = async (ids: string[]): Promise<void> => {
    const startedAt = fullFetchSeq;
    const result = await client.query(withIdFilter(fullQuery, ids));
    if (disposed) return;
    // A full read started since this one did, so its result is newer.
    if (fullFetchSeq !== startedAt) return;
    const data: any[] | null = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result)
        ? result
        : null;
    if (!data) {
      scheduleRefresh();
      return;
    }
    const byId = new Map<string, any>();
    for (const record of data) {
      if (record && typeof record.id === "string") byId.set(record.id, record);
    }
    if (ids.some((id) => cachedIds?.has(id) && !byId.has(id))) {
      scheduleRefresh();
      return;
    }
    if (!Array.isArray(currentValue)) {
      scheduleRefresh();
      return;
    }
    let changed = false;
    const next = (currentValue as any[]).map((record) => {
      const fresh = record && typeof record.id === "string" ? byId.get(record.id) : undefined;
      if (fresh === undefined) return record;
      changed = true;
      return fresh;
    });
    if (changed) {
      currentValue = next as T;
      notifySubscribers();
    }
  };

  // Listen for mutation_applied and sync_applied events for auto-refresh (SIG-002, SIG-003)
  // Store unsubscribe function for disposal
  unsubscribeFn = eventBus.subscribe((event) => {
    // Check disposed flag to prevent refresh after dispose
    if (disposed) {
      return;
    }

    // Refresh after sync operations (clone/pull) that may have updated local storage
    if (event.type === "sync_applied") {
      const ctx = (event as any).context;
      const phase = ctx?.phase;
      if (phase === "clone" || phase === "pull") {
        const affectedResources: string[] = ctx?.resources ?? [];
        // Only refresh when specific resources that overlap with this signal's footprint
        // changed.  Removing the "length === 0" broadcast avoids refreshing all signals
        // (including KV) on every pull that returns no records (RC-3 / issue 2026-03-02-k7m4x9r8).
        if (affectedResources.some(r => footprint.has(r))) {
          scheduleRefresh();
        }
      }
      return;
    }

    if (event.type === "mutation_applied" && event.resource) {
      // Check if event.resource is in signal footprint
      if (!footprint.has(event.resource)) {
        return; // Not relevant to this signal
      }
      
      // If mutation is on a related resource (not the primary query resource),
      // always refresh since we can't easily match IDs across relations
      if (event.resource !== resource) {
        scheduleRefresh();
        return;
      }
      
      const pinnedDecision = pinnedWriteDecision(event);
      if (pinnedDecision === "skip") {
        return;
      }
      if (pinnedDecision === "refresh") {
        scheduleRefresh();
        return;
      }

      // Fine-grained invalidation logic (SIG-002) for primary resource mutations
      const action = event.action;
      
      if (action === "insert" || action === "delete" || action === "replace") {
        // Always full re-fetch for insert/delete/replace (no safe patching)
        scheduleRefresh();
        return;
      }
      
      if (action === "merge") {
        // A merge that cannot change membership or order (SIG-002): a record
        // that already existed keeps its place, so only records shown in the
        // result need their new field values.
        if (
          !disableOptimistic &&
          currentValue !== undefined &&
          Array.isArray(event.ids) &&
          event.ids.every((id: unknown) => typeof id === "string") &&
          !mergeCanChangeMembership(event, membershipFields)
        ) {
          if (countValue) {
            if ((event as any).created !== false) scheduleRefresh();
            return;
          }
          const ids = event.ids as string[];
          const shown = ids.filter((id) => cachedIds?.has(id));
          const notShown = ids.length - shown.length;
          const created = (event as any).created;
          if (
            notShown > 0 &&
            (created === true ||
              // A full read in flight may bring these records in from a
              // snapshot older than this edit; cachedIds still describes
              // the previous result.
              inFlight ||
              (created === undefined &&
                (!cachedIds ||
                  cachedIds.size === 0 ||
                  hasMembershipSensitiveQueryShape(fullQuery))))
          ) {
            // A merge can create a record, which may then belong in the
            // result. Without the created flag, keep the earlier rule.
            scheduleRefresh();
            return;
          }
          if (shown.length > 0) {
            if (Array.isArray(currentValue)) {
              const patchedValue = applyOptimisticPatch(currentValue, event);
              if (patchedValue !== null) {
                currentValue = patchedValue as T;
                notifySubscribers();
              }
            }
            scheduleRecordRefresh(shown);
          }
          return;
        }

        // Optimistic signal update (SIG-003) for merge operations
        
        // Skip optimistic patch if disabled or no cached value yet
        if (disableOptimistic || currentValue === undefined) {
          scheduleRefresh();
          return;
        }
        
        // Conservative: if no cached IDs, always refresh
        if (!cachedIds || cachedIds.size === 0) {
          scheduleRefresh();
          return;
        }
        
        // Check if mutation affects any cached record
        if (!event.ids || !Array.isArray(event.ids)) {
          // No ids in event, be conservative and refresh
          scheduleRefresh();
          return;
        }
        
        const affectsCachedRecord = event.ids.some(id => cachedIds!.has(id));
        
        if (!affectsCachedRecord) {
          if (hasMembershipSensitiveQueryShape(fullQuery)) {
            scheduleRefresh();
          }
          return;
        }
        
        // Attempt optimistic patch
        const patchedValue = applyOptimisticPatch(currentValue, event);
        
        if (patchedValue !== null) {
          // Successfully patched - emit immediately
          currentValue = patchedValue as T;
          notifySubscribers();
          
          // Schedule background re-fetch for eventual consistency
          scheduleRefresh();
        } else {
          // Patch failed, fall back to refresh
          scheduleRefresh();
        }
        
        return;
      }
      
      // Unknown action, be conservative
      scheduleRefresh();
    }
  });

  const signal = {
    subscribe(fn: (value: T) => void): () => void {
      subscribers.add(fn);

      // Lazy fetch on first subscribe
      if (subscribers.size === 1 && currentValue === undefined && !inFlight) {
        fetchQuery(false).catch(() => {
          // Initial fetch errors are handled internally
        });
      } else if (currentValue !== undefined) {
        // A write arrived while no one subscribed: re-read once. Decided
        // before delivering, since the handler may subscribe others. Queues
        // behind a read already in flight, which may predate the write.
        if (staleWhileIdle && !disposed) {
          staleWhileIdle = false;
          fetchQuery(true).catch(() => {});
        }
        // Immediately deliver current value to new subscriber
        fn(currentValue);
      }

      // Return unsubscribe function
      return () => {
        subscribers.delete(fn);
      };
    },

    get(): T {
      // Return current value or undefined as T (signals can have undefined state)
      // Disposed signal returns last cached value (no re-fetch)
      return currentValue as T;
    },

    get loading(): boolean {
      return inFlight && !isRefresh;
    },

    get error(): DatafnError | null {
      return currentError;
    },

    get refreshing(): boolean {
      return inFlight && isRefresh;
    },

    get nextCursor(): string | null {
      return currentCursor;
    },

    refresh(): Promise<void> {
      return fetchQuery(true);
    },

    dispose(): void {
      // Guard against double-dispose
      if (disposed) {
        return;
      }

      // Mark as disposed
      disposed = true;

      // Unsubscribe from event bus
      if (unsubscribeFn) {
        unsubscribeFn();
        unsubscribeFn = null;
      }

      // Remove from registry
      removeFromRegistry();

      // Note: We keep currentValue intact so get() returns last cached value
    },
  };
  return signal as DatafnSignal<T>;
}
