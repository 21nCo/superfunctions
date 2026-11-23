/**
 * Query Execution Utilities
 *
 * Handles query execution via remote adapter or local storage based on hydration state.
 */

import type {
  DatafnNativeRemoteMode,
  DatafnRemoteAdapter,
} from "./client.js";
import type { DatafnChangelogEntry, DatafnStorageAdapter } from "./storage.js";
import type {
  DatafnPlugin,
  DatafnSchema,
  DatafnTemporalConfig,
  SchemaIndex,
} from "@datafn/core";
import {
  endpointIncludes,
  evaluateFilter,
  findRelationMatch,
  hasTemporalGrouping,
  normalizeFilterOps,
  normalizeRelationPayload,
  parseSortTerms,
  relationTargetEndpoint,
  resolveCapabilities,
  resolveEndpointResource,
  sortRecords,
  stripNullsForNonNullableFields,
} from "@datafn/core";
import { sanitizeCapabilityReadonlyFields } from "./capability-fields.js";
import { createClientError } from "./errors.js";
import { unwrapRemoteSuccess } from "./remote/unwrap.js";
import { executeLocalQuery } from "./offline/query.js";
import { runBeforeQuery, runAfterQuery } from "./plugins/run-hooks.js";
import { parseDateFields, parseQueryResultDates } from "./codecs/date.js";
import {
  assertRemoteQueryAllowedForE2ee,
  type DatafnE2eeConfig,
} from "./e2ee.js";

type QueryMetadata = {
  includeTrashed?: boolean;
  includeArchived?: boolean;
  includeAncestorInactive?: boolean;
};

export type PermissionEntry = {
  userId: string;
  level: string;
  grantedBy: string;
  grantedAt: number;
};

export function buildGetPermissionsQuery(
  resource: string,
  version: number,
  id: string,
): Record<string, unknown> {
  return {
    resource,
    version,
    operation: "getPermissions",
    id,
  };
}

function normalizeQueryMetadata(
  query: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !query.metadata ||
    typeof query.metadata !== "object" ||
    Array.isArray(query.metadata)
  ) {
    return query;
  }

  const metadata = query.metadata as Record<string, unknown>;
  const normalizedMetadata: QueryMetadata = {
    ...(metadata.includeTrashed === true ? { includeTrashed: true } : {}),
    ...(metadata.includeArchived === true ? { includeArchived: true } : {}),
    ...(metadata.includeAncestorInactive === true ? { includeAncestorInactive: true } : {}),
  };

  return {
    ...query,
    metadata: normalizedMetadata,
  };
}

function mergeAutoFilters(
  existingFilters: Record<string, unknown> | undefined,
  autoFilters: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  if (autoFilters.length === 0) {
    return existingFilters;
  }
  if (!existingFilters || Object.keys(existingFilters).length === 0) {
    return autoFilters.length === 1 ? autoFilters[0] : { $and: autoFilters };
  }
  if (
    Array.isArray(existingFilters.$and) &&
    Object.keys(existingFilters).length === 1
  ) {
    return {
      $and: [
        ...(existingFilters.$and as Record<string, unknown>[]),
        ...autoFilters,
      ],
    };
  }
  return { $and: [existingFilters, ...autoFilters] };
}

function injectLocalCapabilityAutoFilters(
  query: Record<string, unknown>,
  schema: DatafnSchema,
): Record<string, unknown> {
  const resourceName = query.resource;
  if (typeof resourceName !== "string") {
    return query;
  }

  const resource = schema.resources.find((entry) => entry.name === resourceName);
  if (!resource) {
    return query;
  }

  const capabilities = resolveCapabilities(
    schema.capabilities as any,
    resource.capabilities as any,
  );
  const metadata = query.metadata &&
    typeof query.metadata === "object" &&
    !Array.isArray(query.metadata)
    ? (query.metadata as QueryMetadata)
    : {};
  const autoFilters: Record<string, unknown>[] = [];

  if (
    capabilities.some((capability: unknown) => capability === "trash") &&
    metadata.includeTrashed !== true
  ) {
    autoFilters.push({ trashedAt: { $is_null: true } });
  }

  if (
    capabilities.some((capability: unknown) => capability === "archivable") &&
    metadata.includeArchived !== true
  ) {
    autoFilters.push({ isArchived: { $ne: true } });
  }

  if (
    metadata.includeAncestorInactive !== true &&
    schema.relations?.some((relation) => {
      if (relation.inheritsInactive !== true) return false;
      const dependentEndpoint = relation.type === "many-one" ? relation.from : relation.to;
      return endpointIncludes(dependentEndpoint, resourceName);
    })
  ) {
    autoFilters.push({ isAncestorInactive: { $ne: true } });
  }

  if (autoFilters.length === 0) {
    return query;
  }

  const filters = query.filters &&
    typeof query.filters === "object" &&
    !Array.isArray(query.filters)
    ? (query.filters as Record<string, unknown>)
    : undefined;

  return {
    ...query,
    filters: mergeAutoFilters(filters, autoFilters),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasImpossibleEmptyInFilter(filter: unknown): boolean {
  if (!isPlainRecord(filter)) return false;

  if (Array.isArray(filter.$and)) {
    return filter.$and.some(hasImpossibleEmptyInFilter);
  }

  if (Array.isArray(filter.$or)) {
    return filter.$or.length === 0 || filter.$or.every(hasImpossibleEmptyInFilter);
  }

  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or") continue;
    if (!isPlainRecord(value)) continue;
    const inValue = value.$in ?? value.in;
    if (Array.isArray(inValue) && inValue.length === 0) {
      return true;
    }
  }

  return false;
}

function resolveEmptyQueryResult(query: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(query)) return undefined;
  if (!hasImpossibleEmptyInFilter(query.filters)) return undefined;
  if (query.groupBy || hasTemporalGrouping(query)) {
    return { groups: [], nextCursor: null };
  }
  return {
    data: [],
    nextCursor: null,
    ...(query.count === true ? { count: 0 } : {}),
  };
}

function queryResultRows(result: unknown): unknown[] | null {
  if (Array.isArray(result)) return result;
  if (isPlainRecord(result) && Array.isArray(result.data)) return result.data;
  return null;
}

/** The adapters return 100 changelog entries unless asked for more. */
const ALL_CHANGELOG_ENTRIES = 0xffffffff;

function listPendingChanges(
  storage: DatafnStorageAdapter,
): Promise<DatafnChangelogEntry[]> {
  return storage.changelogList({ limit: ALL_CHANGELOG_ENTRIES });
}

function pendingIdsForResource(
  changes: readonly DatafnChangelogEntry[],
  resource: unknown,
): Set<string> {
  const ids = new Set<string>();
  for (const change of changes) {
    const mutation = change.mutation;
    if (mutation.resource === resource && typeof mutation.id === "string") {
      ids.add(mutation.id);
    }
  }
  return ids;
}

/**
 * The net effect of one record's pending mutations, folded in changelog
 * order: `deleted`, or the fields they wrote (`undefined` = cleared).
 */
type PendingRowEffect = { deleted: boolean; written: Map<string, unknown> };

/** Object field values (not Dates or class instances), merged one level deep. */
function isObjectValue(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const STATE_FIELDS: Record<string, Record<string, unknown>> = {
  restore: { trashedAt: null, trashedBy: null },
  archive: { isArchived: true },
  unarchive: { isArchived: false },
};

function foldPendingRowEffect(
  schema: DatafnSchema,
  remoteRow: Record<string, unknown>,
  entries: readonly DatafnChangelogEntry[],
): PendingRowEffect {
  const effect: PendingRowEffect = { deleted: false, written: new Map() };
  const resource = entries[0]?.mutation.resource as string;
  const fields = schema.resources.find((entry) => entry.name === resource)?.fields ?? [];
  for (const { mutation, timestampMs } of entries) {
    const operation = mutation.operation;
    const record = sanitizeCapabilityReadonlyFields(schema, mutation).record;
    const written = isPlainRecord(record)
      ? Object.entries(record).filter(
          ([key]) => key !== "id" && !findRelationMatch(schema, resource, key),
        )
      : [];
    if (operation === "delete") {
      effect.deleted = true;
      effect.written.clear();
    } else if (operation === "insert" || operation === "replace") {
      effect.deleted = false;
      effect.written.clear();
      // A replace keeps no unwritten declared field; defaults fill them.
      for (const field of fields) {
        const fallback = "default" in field ? structuredClone(field.default) : undefined;
        effect.written.set(field.name, fallback);
      }
      for (const [key, value] of written) effect.written.set(key, value);
    } else if (operation === "merge") {
      effect.deleted = false;
      for (const [key, value] of written) {
        const current = effect.written.has(key) ? effect.written.get(key) : remoteRow[key];
        // Storage adapters merge one level deep.
        effect.written.set(
          key,
          isObjectValue(current) && isObjectValue(value) ? { ...current, ...value } : value,
        );
      }
    } else if (operation === "trash") {
      effect.written.set("trashedAt", timestampMs);
      effect.written.set("trashedBy", null);
    } else if (typeof operation === "string" && Object.prototype.hasOwnProperty.call(STATE_FIELDS, operation)) {
      for (const [key, value] of Object.entries(STATE_FIELDS[operation])) {
        effect.written.set(key, value);
      }
    } else if (operation === "relate" || operation === "unrelate") {
      writeManyOneForeignKeys(schema, resource, mutation, effect.written);
    }
  }
  return effect;
}

/** A relate or unrelate sets the row's own many-one foreign key. */
function writeManyOneForeignKeys(
  schema: DatafnSchema,
  resource: string,
  mutation: Record<string, unknown>,
  written: Map<string, unknown>,
): void {
  if (!isPlainRecord(mutation.relations)) return;
  for (const [relationName, payload] of Object.entries(mutation.relations)) {
    const match = findRelationMatch(schema, resource, relationName);
    if (match?.relation.type !== "many-one" || match.direction !== "forward") continue;
    const { relation } = match;
    const fkField = relation.fkField || relation.foreignKey || `${relationName}Id`;
    const target = normalizeRelationPayload(payload)[0]?.toId;
    if (mutation.operation === "unrelate") written.set(fkField, null);
    else if (target !== undefined) written.set(fkField, target);
  }
}

const WILDCARD_SELECT_TOKENS = new Set(["*", "#", "*#", "#*"]);

function omitKeys(value: unknown, omit: readonly unknown[]): unknown {
  if (!isObjectValue(value) || omit.length === 0) return value;
  const result: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (!omit.includes(key)) result[key] = omitKeys(member, omit);
  }
  return result;
}

/**
 * The written value as the remote projection would return it, or `undefined`
 * when the projection hides the field. A field the select only reaches
 * through nested tokens keeps the members the server returned.
 */
function projectWrittenField(
  query: Record<string, unknown>,
  key: string,
  value: unknown,
  remoteRow: Record<string, unknown>,
): { value: unknown } | undefined {
  const omit = Array.isArray(query.omit) ? query.omit : [];
  if (omit.includes(key)) return undefined;
  const select = query.select;
  const wholeField =
    !Array.isArray(select)
    || select.some((token) => token === key || WILDCARD_SELECT_TOKENS.has(token));
  if (wholeField) return { value: omitKeys(value, omit) };
  if (!(key in remoteRow)) return undefined;
  const remoteValue = remoteRow[key];
  if (isObjectValue(remoteValue) && isObjectValue(value)) {
    const members: Record<string, unknown> = {};
    for (const member of Object.keys(remoteValue)) {
      members[member] = member in value ? value[member] : remoteValue[member];
    }
    return { value: omitKeys(members, omit) };
  }
  return { value: omitKeys(value, omit) };
}

function shownPendingRow(
  schema: DatafnSchema,
  query: Record<string, unknown>,
  resource: string,
  remoteRow: Record<string, unknown>,
  written: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [key, value] of written) {
    const projected = projectWrittenField(query, key, value, remoteRow);
    if (!projected) continue;
    if (projected.value === undefined) removed.push(key);
    else patch[key] = projected.value;
  }
  // Decode dates like the remote page; cleared non-nullable fields read absent.
  const normalized = stripNullsForNonNullableFields(
    parseDateFields(schema, resource, patch),
    schema.resources.find((entry) => entry.name === resource),
  );
  for (const key of Object.keys(patch)) {
    if (!(key in normalized)) removed.push(key);
  }
  const row = { ...remoteRow, ...normalized };
  for (const key of removed) delete row[key];
  return row;
}

function storedRepresentation(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    stored[key] = value instanceof Date ? value.getTime() : value;
  }
  return stored;
}

/**
 * True only when the row's own pending writes make a matching row stop
 * matching. Fields the server did not project are filled from the cached
 * copy for this check only; anything it cannot evaluate keeps the row.
 */
function pendingWritesStopMatch(
  filters: Record<string, unknown> | undefined,
  resource: string,
  base: Record<string, unknown>,
  written: ReadonlyMap<string, unknown>,
): boolean {
  if (!filters) return false;
  const before = storedRepresentation(base);
  const after = { ...before };
  for (const [key, value] of written) {
    if (value === undefined) delete after[key];
    else after[key] = value instanceof Date ? value.getTime() : value;
  }
  try {
    const normalized = normalizeFilterOps(filters);
    return evaluateFilter(before, normalized, { resource })
      && !evaluateFilter(after, normalized, { resource });
  } catch {
    return false;
  }
}

/** Target ids a pending unrelate removed from the queried record's relation. */
function pendingUnrelatedIds(
  changes: readonly DatafnChangelogEntry[],
  query: Record<string, unknown>,
): Set<string> {
  const ids = new Set<string>();
  for (const { mutation } of changes) {
    const payload = isPlainRecord(mutation.relations)
      ? mutation.relations[query.relation as string]
      : undefined;
    if (
      mutation.resource !== query.resource
      || mutation.id !== query.id
      || payload === undefined
    ) {
      continue;
    }
    for (const { toId } of normalizeRelationPayload(payload)) {
      if (mutation.operation === "unrelate") ids.add(toId);
      else if (mutation.operation === "relate") ids.delete(toId);
    }
  }
  return ids;
}

function pendingEntriesByRow(
  changes: readonly DatafnChangelogEntry[],
  rowResource: (id: string) => string | undefined,
): Map<string, DatafnChangelogEntry[]> {
  const byRow = new Map<string, DatafnChangelogEntry[]>();
  for (const change of changes) {
    const { resource, id } = change.mutation;
    if (typeof id !== "string" || resource !== rowResource(id)) continue;
    const entries = byRow.get(id);
    if (entries) entries.push(change);
    else byRow.set(id, [change]);
  }
  return byRow;
}

/** The shown row, or null when its pending changes remove it from the page. */
function overlayPendingRow(
  schema: DatafnSchema,
  query: Record<string, unknown>,
  row: Record<string, unknown>,
  entries: readonly DatafnChangelogEntry[],
  cached: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const resource = entries[0].mutation.resource as string;
  const { deleted, written } = foldPendingRowEffect(schema, row, entries);
  if (deleted) return null;
  // A relation page lists target records; only their capability filters apply.
  const membershipQuery = injectLocalCapabilityAutoFilters(
    {
      resource,
      metadata: query.metadata,
      ...(typeof query.relation === "string" ? {} : { filters: query.filters }),
    },
    schema,
  );
  const filters = isPlainRecord(membershipQuery.filters) ? membershipQuery.filters : undefined;
  if (pendingWritesStopMatch(filters, resource, { ...cached, ...row }, written)) return null;
  return shownPendingRow(schema, query, resource, row, written);
}

function rowIdOf(row: unknown): string | undefined {
  const id = isPlainRecord(row) ? row.id : undefined;
  return typeof id === "string" ? id : undefined;
}

/**
 * A limited first page keeps its remote rows, order and cursor: adding local
 * rows would push remote rows past the remote nextCursor, so they would be
 * skipped. A row on the page with pending local changes is shown as the
 * remote row plus the effects of those changes in changelog order; it is
 * removed only by a pending delete or unrelate, or when the fields those
 * changes wrote make it stop matching the query. The cached local copy is
 * never a source of shown values.
 */
async function overlayPendingRowsOnLimitedPage(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
  remoteResult: unknown,
): Promise<unknown> {
  try {
    const remoteData = queryResultRows(remoteResult);
    if (!remoteData) return remoteResult;
    const isRelationPage = typeof query.relation === "string";
    const match = isRelationPage
      ? findRelationMatch(schema, query.resource as string, query.relation as string)
      : undefined;
    if (isRelationPage && !match) return remoteResult;
    const rowResource = (id: string): string | undefined =>
      match
        ? resolveEndpointResource(relationTargetEndpoint(match.relation, match.direction), id, schema)
        : (query.resource as string);

    const changes = await listPendingChanges(storage);
    const unrelated = isRelationPage ? pendingUnrelatedIds(changes, query) : new Set<string>();
    const pendingByRow = pendingEntriesByRow(changes, rowResource);
    const pendingRows = remoteData.filter((row) => pendingByRow.has(rowIdOf(row) ?? ""));
    if (pendingRows.length === 0 && !remoteData.some((row) => unrelated.has(rowIdOf(row) ?? ""))) {
      return remoteResult;
    }
    // Cached copies only fill fields the server did not project, for matching.
    const cachedRows = new Map(await Promise.all(pendingRows.map(async (row) => {
      const id = rowIdOf(row) as string;
      const resource = pendingByRow.get(id)?.[0].mutation.resource as string;
      return [id, await storage.getRecord(resource, id)] as const;
    })));

    const data: unknown[] = [];
    for (const row of remoteData) {
      const id = rowIdOf(row);
      const entries = id === undefined ? undefined : pendingByRow.get(id);
      if (id !== undefined && unrelated.has(id)) continue;
      const shown = entries && isPlainRecord(row)
        ? overlayPendingRow(schema, query, row, entries, cachedRows.get(id as string) ?? null)
        : row;
      if (shown !== null) data.push(shown);
    }
    return Array.isArray(remoteResult)
      ? data
      : { ...(remoteResult as Record<string, unknown>), data };
  } catch {
    return remoteResult;
  }
}

function mergeQueryDataById(
  remoteResult: unknown,
  localResult: unknown,
  query: Record<string, unknown>,
  pendingLocalIds: ReadonlySet<string>,
): unknown {
  const remoteEnvelope =
    remoteResult && typeof remoteResult === "object" && !Array.isArray(remoteResult)
      ? (remoteResult as Record<string, unknown>)
      : null;
  const localEnvelope =
    localResult && typeof localResult === "object" && !Array.isArray(localResult)
      ? (localResult as Record<string, unknown>)
      : null;
  const remoteData = Array.isArray(remoteEnvelope?.data)
    ? remoteEnvelope.data
    : Array.isArray(remoteResult)
      ? remoteResult
      : null;
  const localData = Array.isArray(localEnvelope?.data)
    ? localEnvelope.data
    : Array.isArray(localResult)
      ? localResult
      : null;

  if (!remoteData || !localData || (localData.length === 0 && pendingLocalIds.size === 0)) {
    return remoteResult;
  }

  const localById = new Map<string, unknown>();
  const localWithoutId: unknown[] = [];
  for (const record of localData) {
    const id = (record as { id?: unknown } | null)?.id;
    if (typeof id === "string") {
      localById.set(id, record);
    } else {
      localWithoutId.push(record);
    }
  }

  const seen = new Set<string>();
  let merged: unknown[] = [];
  for (const record of remoteData) {
    const id = (record as { id?: unknown } | null)?.id;
    if (typeof id === "string") {
      seen.add(id);
      const localRecord = localById.get(id);
      if (localRecord !== undefined) {
        merged.push(localRecord);
      } else if (!pendingLocalIds.has(id)) {
        merged.push(record);
      }
    } else {
      merged.push(record);
    }
  }
  for (const [id, record] of localById) {
    if (!seen.has(id)) merged.push(record);
  }
  merged.push(...localWithoutId);

  if (Array.isArray(query.sort)) {
    merged = sortRecords(
      merged as Record<string, unknown>[],
      parseSortTerms(query.sort as string[]),
    );
  }
  if (typeof query.limit === "number" && query.limit >= 0) {
    merged = merged.slice(0, query.limit);
  }

  if (remoteEnvelope && Array.isArray(remoteEnvelope.data)) {
    return {
      ...remoteEnvelope,
      data: merged,
    };
  }
  return merged;
}

async function overlayLocalQueryResult(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
  remoteResult: unknown,
  schemaIndex?: SchemaIndex,
  temporal?: DatafnTemporalConfig,
): Promise<unknown> {
  const cursor = query.cursor;
  const hasActiveCursor =
    typeof cursor === "object" &&
    cursor !== null &&
    ((cursor as Record<string, unknown>).after != null ||
      (cursor as Record<string, unknown>).before != null);
  const isFirstPage =
    !(typeof query.offset === "number" && query.offset > 0) && !hasActiveCursor;
  if (typeof query.limit === "number" && isFirstPage) {
    return overlayPendingRowsOnLimitedPage(storage, schema, query, remoteResult);
  }
  if (
    typeof query.limit === "number" ||
    (typeof query.offset === "number" && query.offset > 0) ||
    hasActiveCursor
  ) {
    return remoteResult;
  }
  try {
    const {
      limit: _limit,
      offset: _offset,
      cursor: _cursor,
      ...unpaginatedQuery
    } = query;
    const localQuery = injectLocalCapabilityAutoFilters(unpaginatedQuery, schema);
    const [localResult, pendingChanges] = await Promise.all([
      executeLocalQuery(
        storage,
        schema,
        localQuery,
        schemaIndex,
        temporal,
      ),
      listPendingChanges(storage),
    ]);
    const pendingLocalIds = pendingIdsForResource(pendingChanges, query.resource);
    return mergeQueryDataById(remoteResult, localResult, query, pendingLocalIds);
  } catch {
    return remoteResult;
  }
}

async function executeLocalBatchQuery(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  queries: unknown[],
  schemaIndex?: SchemaIndex,
  temporal?: DatafnTemporalConfig,
): Promise<unknown[] | undefined> {
  const localQueries: Array<{
    query: Record<string, unknown>;
    resource: string;
  }> = [];

  for (const entry of queries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }

    const query = entry as Record<string, unknown>;
    const resource = query.resource;
    if (typeof resource !== "string") {
      return undefined;
    }

    const resourceDef = schema.resources.find((item) => item.name === resource);
    if (!resourceDef || resourceDef.isRemoteOnly) {
      return undefined;
    }

    localQueries.push({ query, resource });
  }

  const hydrationStates = await Promise.all(
    localQueries.map(({ resource }) => storage.getHydrationState(resource)),
  );

  if (hydrationStates.some((state) => state !== "ready")) {
    return undefined;
  }

  return Promise.all(
    localQueries.map(async ({ query, resource }) => {
      const localQuery = injectLocalCapabilityAutoFilters(query, schema);
      const result = await executeLocalQuery(
        storage,
        schema,
        localQuery,
        schemaIndex,
        temporal,
      );
      return parseQueryResultDates(schema, resource, result);
    }),
  );
}

/**
 * Execute a query (single or batch) via the remote adapter or local storage.
 *
 * When storage is configured and table hydration state is 'ready', queries execute locally.
 * Otherwise, queries execute via the remote adapter.
 *
 * @param remote - Remote adapter for server queries
 * @param q - Query or array of queries
 * @param storage - Optional storage adapter for local-first execution
 * @param plugins - Optional plugins for hook execution
 * @returns Query result(s)
 */
export async function executeQuery<T = unknown>(
  remote: DatafnRemoteAdapter,
  q: unknown | unknown[],
  storage?: DatafnStorageAdapter,
  plugins: DatafnPlugin[] = [],
  schema?: DatafnSchema,
  schemaIndex?: SchemaIndex,
  nativeRemoteMode?: DatafnNativeRemoteMode,
  temporal?: DatafnTemporalConfig,
  e2ee?: DatafnE2eeConfig,
  observeQuery?: (query: unknown) => void,
): Promise<T | T[]> {
  // Run beforeQuery hooks (fail-closed)
  const transformedQuery = schema
    ? await runBeforeQuery(plugins, schema, q)
    : q;
  const metadataNormalizedQuery = Array.isArray(transformedQuery)
    ? transformedQuery.map((entry) =>
        typeof entry === "object" && entry !== null
          ? normalizeQueryMetadata(entry as Record<string, unknown>)
          : entry,
      )
    : typeof transformedQuery === "object" && transformedQuery !== null
      ? normalizeQueryMetadata(transformedQuery as Record<string, unknown>)
      : transformedQuery;
  const normalizedQuery = metadataNormalizedQuery;
  // Lets a caller see the query the plugins produced without running them again.
  observeQuery?.(normalizedQuery);
  const runRemoteQuery = async (): Promise<unknown> => {
    assertRemoteQueryAllowedForE2ee(e2ee, normalizedQuery);
    return remote.query(normalizedQuery);
  };

  const emptyResult = resolveEmptyQueryResult(normalizedQuery);
  if (emptyResult) {
    return schema
      ? (runAfterQuery(plugins, schema, normalizedQuery, emptyResult) as Promise<T>)
      : (emptyResult as T);
  }

  // If no storage is configured, always use remote execution.
  if (!storage) {
    const response = await runRemoteQuery();
    let result = unwrapRemoteSuccess<T | T[]>(response);

    if (schema && Array.isArray(normalizedQuery)) {
      // REL-013: Apply inbound date codec per-query for batch queries (no-storage path)
      if (Array.isArray(result)) {
        result = (result as any[]).map((queryResult, i) => {
          const query = (normalizedQuery as any[])[i] as Record<string, unknown>;
          const resource = query?.resource as string;
          if (resource) {
            return parseQueryResultDates(schema, resource, queryResult);
          }
          return queryResult;
        }) as any;
      }
    } else if (schema && !Array.isArray(normalizedQuery)) {
      // Apply inbound date codec (CODEC-001)
      const query = normalizedQuery as Record<string, unknown>;
      const resource = query.resource as string;
      if (resource) {
        result = parseQueryResultDates(schema, resource, result) as T | T[];
      }
    }

    // Run afterQuery hooks (fail-open)
    return schema
      ? (runAfterQuery(plugins, schema, normalizedQuery, result) as Promise<
          T | T[]
        >)
      : result;
  }

  if (Array.isArray(normalizedQuery)) {
    const emptyResults = normalizedQuery.map(resolveEmptyQueryResult);
    if (emptyResults.every(Boolean)) {
      return schema
        ? (runAfterQuery(plugins, schema, normalizedQuery, emptyResults) as Promise<T[]>)
        : (emptyResults as T[]);
    }

    if (nativeRemoteMode === "icloud" && schema) {
      const remoteOnlyResource = normalizedQuery
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return undefined;
          }
          const resource = (entry as { resource?: unknown }).resource;
          return typeof resource === "string" ? resource : undefined;
        })
        .find((name) =>
          name &&
          schema.resources.some(
            (resourceDef) =>
              resourceDef.name === name && resourceDef.isRemoteOnly,
          ),
        );

      if (remoteOnlyResource) {
        throw createClientError(
          "DFQL_UNSUPPORTED",
          "Remote-only resource is unsupported in icloud mode",
          { path: "query.resource", resource: remoteOnlyResource },
        );
      }
    }

    if (schema && nativeRemoteMode !== "icloud") {
      const localResult = await executeLocalBatchQuery(
        storage,
        schema,
        normalizedQuery,
        schemaIndex,
        temporal,
      );

      if (localResult) {
        return runAfterQuery(
          plugins,
          schema,
          normalizedQuery,
          localResult,
        ) as Promise<T[]>;
      }
    }

    const response = await runRemoteQuery();
    let result = unwrapRemoteSuccess<T | T[]>(response);

    // REL-013: Apply inbound date codec per-query in batch path
    if (schema && Array.isArray(result)) {
      result = (result as any[]).map((queryResult, i) => {
        const query = (normalizedQuery as any[])[i] as Record<string, unknown>;
        const resource = query?.resource as string;
        if (resource) {
          return parseQueryResultDates(schema, resource, queryResult);
        }
        return queryResult;
      }) as any;
    }

    return schema
      ? (runAfterQuery(plugins, schema, normalizedQuery, result) as Promise<
          T | T[]
        >)
      : result;
  }

  // Single query: check hydration state for local-first routing
  const query = normalizedQuery as Record<string, unknown>;
  const resource = query.resource as string;

  if (resource) {
    // Check if table is remote-only
    const resourceDef = schema?.resources.find((r) => r.name === resource);
    if (resourceDef?.isRemoteOnly) {
      if (nativeRemoteMode === "icloud") {
        throw createClientError(
          "DFQL_UNSUPPORTED",
          "Remote-only resource is unsupported in icloud mode",
          { path: "query.resource", resource },
        );
      }

      // Force remote execution for remote-only tables (SYNC-003)
      const response = await runRemoteQuery();
      let result = unwrapRemoteSuccess<T>(response);
      
      // Apply inbound date codec (CODEC-001)
      if (schema) {
        result = parseQueryResultDates(schema, resource, result) as T;
      }
      
      return schema
        ? (runAfterQuery(
            plugins,
            schema,
            normalizedQuery,
            result,
          ) as Promise<T>)
        : result;
    }

    const hydrationState = await storage.getHydrationState(resource);

    // Local-first: execute against storage when table is ready
    if (hydrationState === "ready" && schema) {
      const localQuery = injectLocalCapabilityAutoFilters(query, schema);
      let result = (await executeLocalQuery(
        storage,
        schema,
        localQuery,
        schemaIndex,
        temporal,
      )) as T;
      
      // Apply inbound date codec for local query results (CODEC-001)
      result = parseQueryResultDates(schema, resource, result) as T;
      
      return schema
        ? (runAfterQuery(plugins, schema, query, result) as Promise<T>)
        : result;
    }
    
    // If table is hydrating, route to remote when available (SYNC-002, TV-SYNC-002N)
    // In local-only mode (no remote), we'd use local even if hydrating
    // But since storage is present and we're here, we have a remote, so use it
    if (hydrationState === "hydrating") {
      const response = await runRemoteQuery();
      let result = unwrapRemoteSuccess<T>(response);
      
      // Apply inbound date codec (CODEC-001)
      if (schema) {
        result = parseQueryResultDates(schema, resource, result) as T;
        result = (await overlayLocalQueryResult(
          storage,
          schema,
          query,
          result,
          schemaIndex,
          temporal,
        )) as T;
      }
      
      return schema
        ? (runAfterQuery(plugins, schema, normalizedQuery, result) as Promise<T>)
        : result;
    }
  }

  // Remote execution for: notStarted or missing resource
  const response = await runRemoteQuery();
  let result = unwrapRemoteSuccess<T>(response);
  
  // Apply inbound date codec (CODEC-001)
  if (schema && !Array.isArray(normalizedQuery)) {
    const query = normalizedQuery as Record<string, unknown>;
    const resource = query.resource as string;
    if (resource) {
      result = parseQueryResultDates(schema, resource, result) as T;
    }
  }
  
  return schema
    ? (runAfterQuery(plugins, schema, normalizedQuery, result) as Promise<T>)
    : result;
}
