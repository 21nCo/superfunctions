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
  DatafnFieldSchema,
  DatafnPlugin,
  DatafnSchema,
  DatafnTemporalConfig,
  SchemaIndex,
} from "@datafn/core";
import {
  endpointIncludes,
  findRelationMatch,
  getCapabilityFields,
  hasTemporalGrouping,
  parseSortTerms,
  relationFkFieldForManyOne,
  relationTargetEndpoint,
  resolveCapabilities,
  resolveEndpointResource,
  sortRecords,
  stripNullsForNonNullableFields,
} from "@datafn/core";
import { createClientError } from "./errors.js";
import { unwrapRemoteSuccess } from "./remote/unwrap.js";
import { executeLocalQuery } from "./offline/query.js";
import { applyOptimisticMutationToStorage } from "./offline/mutate.js";
import { MemoryStorageAdapter } from "./adapters/memoryStorage.js";
import { runBeforeQuery, runAfterQuery } from "./plugins/run-hooks.js";
import { parseDateFields, parseQueryResultDates, serializeDateFields } from "./codecs/date.js";
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

function isObjectValue(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((member, index) => sameValue(member, right[index]));
  }
  if (isObjectValue(left) && isObjectValue(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every((key) => key in right && sameValue(left[key], right[key]));
  }
  return false;
}

/** The server's omit: recursive into objects and arrays, never `id` or `$relation_metadata`. */
function applyServerOmit(value: unknown, omit: readonly string[]): unknown {
  if (omit.length === 0) return value;
  if (Array.isArray(value)) return value.map((member) => applyServerOmit(member, omit));
  if (!isObjectValue(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key !== "id" && omit.includes(key)) continue;
    result[key] = key === "$relation_metadata" ? member : applyServerOmit(member, omit);
  }
  return result;
}

/** Declared fields of a resource, with the fields its capabilities add (`system`). */
function declaredFields(
  schema: DatafnSchema,
  resource: string,
): { fields: Map<string, DatafnFieldSchema>; system: Set<string> } {
  const resourceSchema = schema.resources.find((entry) => entry.name === resource);
  const fields = new Map<string, DatafnFieldSchema>();
  if (!resourceSchema) return { fields, system: new Set() };
  const capabilities = resolveCapabilities(schema.capabilities as any, resourceSchema.capabilities as any);
  const systemFields = getCapabilityFields(capabilities);
  for (const field of [...systemFields, ...resourceSchema.fields]) fields.set(field.name, field);
  return { fields, system: new Set(systemFields.map((field) => field.name)) };
}

/**
 * Whether the server's projection (materializeSelect, also used for relation
 * pages) returns `key` of `resource`: every declared field for no select or
 * `*`, a bare token, never a relation key (an id list or expansion the
 * overlay does not rebuild). Many-one foreign keys, which the server omits
 * unless named, are only changed where the server returned them.
 */
function serverProjectsField(
  schema: DatafnSchema,
  query: Record<string, unknown>,
  resource: string,
  key: string,
  remoteRow: Record<string, unknown>,
): boolean {
  if (key === "id" || key === "$relation_metadata" || findRelationMatch(schema, resource, key)) {
    return false;
  }
  const omit = Array.isArray(query.omit) ? query.omit : [];
  if (omit.includes(key)) return false;
  const select = Array.isArray(query.select) && query.select.length > 0 ? query.select : undefined;
  if (select?.includes(key)) return true;
  const declared = declaredFields(schema, resource).fields.has(key);
  if ((!declared && !(key in remoteRow)) || (select && !select.includes("*"))) return false;
  const foreignKey = (schema.relations ?? []).some((relation) =>
    relation.type === "many-one"
    && endpointIncludes(relation.from, resource)
    && relationFkFieldForManyOne(relation) === key);
  return !foreignKey || key in remoteRow;
}

/** The page row as a store row (dates encoded as stored). */
function seedRow(
  schema: DatafnSchema,
  resource: string,
  remoteRow: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return serializeDateFields(schema, resource, remoteRow);
  } catch {
    // Keep a value the date codec cannot encode as the server returned it.
    return { ...remoteRow };
  }
}

/** Single conditions of a filter's top-level conjunction. */
function filterConjuncts(filter: unknown): Record<string, unknown>[] {
  if (!isPlainRecord(filter)) return [];
  const conjuncts: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" && Array.isArray(value)) {
      for (const sub of value) conjuncts.push(...filterConjuncts(sub));
    } else {
      conjuncts.push({ [key]: value });
    }
  }
  return conjuncts;
}

/**
 * A condition with `<relation>.id` on a forward many-one relation rewritten,
 * at any depth of its boolean groups, to the row's own foreign key; the
 * stored path of every field it reads, or `undefined` for a path through
 * another record, which the page cannot know.
 */
function onRowFields(
  schema: DatafnSchema,
  resource: string,
  filter: unknown,
  paths: Array<string[] | undefined>,
): unknown {
  if (Array.isArray(filter)) return filter.map((sub) => onRowFields(schema, resource, sub, paths));
  if (!isPlainRecord(filter)) return filter;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith("$")) {
      result[key] = onRowFields(schema, resource, value, paths);
      continue;
    }
    const [head, ...rest] = key.split(".");
    const match = rest.length > 0 ? findRelationMatch(schema, resource, head) : undefined;
    if (!match) {
      paths.push([head, ...rest]);
      result[key] = value;
    } else if (
      rest.length === 1 && rest[0] === "id"
      && match.relation.type === "many-one" && match.direction === "forward"
    ) {
      const foreignKey = relationFkFieldForManyOne(match.relation);
      paths.push([foreignKey]);
      result[foreignKey] = value;
    } else {
      paths.push(undefined);
      result[key] = value;
    }
  }
  return result;
}

function hasPath(row: Record<string, unknown>, path: readonly string[]): boolean {
  let value: unknown = row;
  for (const segment of path) {
    if (!isPlainRecord(value) || !(segment in value)) return false;
    value = value[segment];
  }
  return value !== undefined;
}

/**
 * The server returned the row, so it matched before the pending writes. It
 * stops matching when a condition that reads a field the replay changed, and
 * reads only fields the server returned or the replay wrote, fails on the
 * replayed row under the local query engine.
 */
async function pendingWritesStopMatch(
  scratch: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  filters: unknown,
  seeded: Record<string, unknown>,
  current: Record<string, unknown>,
  changedKeys: ReadonlySet<string>,
): Promise<boolean> {
  for (const conjunct of filterConjuncts(filters)) {
    const paths: Array<string[] | undefined> = [];
    const condition = onRowFields(schema, resource, conjunct, paths);
    const known = paths.every((path) =>
      path !== undefined
      && (hasPath(seeded, path)
        || (changedKeys.has(path[0]) && (path.length === 1 || hasPath(current, path)))));
    if (!known || !paths.some((path) => changedKeys.has(path![0]))) continue;
    const ids = await pageMemberIds(scratch, schema, { resource, filters: condition });
    if (ids && !ids.has(current.id as string)) return true;
  }
  return false;
}

async function pageMemberIds(
  scratch: DatafnStorageAdapter,
  schema: DatafnSchema,
  membershipQuery: Record<string, unknown>,
): Promise<Set<string> | undefined> {
  try {
    const result = await executeLocalQuery(scratch, schema, membershipQuery);
    return new Set((result.data ?? []).map(rowIdOf).filter((id): id is string => id !== undefined));
  } catch {
    return undefined;
  }
}

function rowIdOf(row: unknown): string | undefined {
  const id = isPlainRecord(row) ? row.id : undefined;
  return typeof id === "string" ? id : undefined;
}

/**
 * A limited first page keeps its remote rows, order and cursor: adding local
 * rows would push remote rows past the remote nextCursor, so they would be
 * skipped. Pending local changes are replayed, in changelog order, by the
 * writer that applied them optimistically, onto a scratch store seeded with
 * the page as the server returned it (and, for a relation page, the edges the
 * server reported). A row leaves the page when the replay deletes it, removes
 * its edge, or makes a condition it can judge fail; otherwise it is the
 * remote row with the fields the replay changed. The cached local copy, which
 * already holds the pending writes, is never read.
 */
async function overlayPendingRowsOnLimitedPage(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
  remoteResult: unknown,
): Promise<unknown> {
  const remoteData = queryResultRows(remoteResult);
  if (!remoteData) return remoteResult;
  let changes: DatafnChangelogEntry[];
  try {
    changes = await listPendingChanges(storage);
  } catch {
    return remoteResult;
  }
  if (changes.length === 0) return remoteResult;

  const queryResource = query.resource as string;
  const isRelationPage = typeof query.relation === "string" && typeof query.id === "string";
  const match = isRelationPage
    ? findRelationMatch(schema, queryResource, query.relation as string)
    : undefined;
  if (isRelationPage && !match) return remoteResult;
  const rowResource = (id: string): string | undefined =>
    match
      ? resolveEndpointResource(relationTargetEndpoint(match.relation, match.direction), id, schema)
      : queryResource;
  const edgeQuery = {
    resource: queryResource,
    id: query.id,
    relation: query.relation,
    metadata: query.metadata,
  };

  const scratch = new MemoryStorageAdapter(schema.resources.map((entry) => entry.name));
  const pageRows = new Map<string, { resource: string; row: Record<string, unknown>; seeded: Record<string, unknown> }>();
  let linkedBefore: Set<string> | undefined;
  try {
    for (const row of remoteData) {
      const id = rowIdOf(row);
      const resource = id === undefined ? undefined : rowResource(id);
      if (id === undefined || !resource || !isPlainRecord(row) || pageRows.has(id)) continue;
      const seeded = seedRow(schema, resource, row);
      await scratch.upsertRecord(resource, seeded);
      pageRows.set(id, { resource, row, seeded });
    }
    if (pageRows.size === 0) return remoteResult;
    if (match) {
      // The edges the server reported, written in the writer's own form.
      await scratch.upsertRecord(queryResource, { id: query.id });
      await applyOptimisticMutationToStorage(scratch, schema, {
        resource: queryResource,
        id: query.id,
        operation: "relate",
        relations: { [query.relation as string]: [...pageRows.keys()] },
      }, 0);
      linkedBefore = await pageMemberIds(scratch, schema, edgeQuery);
    }
    for (const [id, page] of pageRows) {
      page.seeded = (await scratch.getRecord(page.resource, id)) ?? page.seeded;
    }
  } catch {
    return remoteResult;
  }

  for (const change of changes) {
    try {
      await applyOptimisticMutationToStorage(
        scratch,
        schema,
        change.mutation,
        change.timestampMs,
        change.actorId ?? change.clientId,
      );
    } catch {
      // An entry the writer cannot apply changes nothing else on the page.
    }
  }
  const linkedAfter = match ? await pageMemberIds(scratch, schema, edgeQuery) : undefined;
  const omit = Array.isArray(query.omit)
    ? query.omit.filter((key): key is string => typeof key === "string")
    : [];

  const data: unknown[] = [];
  let changed = false;
  for (const row of remoteData) {
    const id = rowIdOf(row);
    const page = id === undefined ? undefined : pageRows.get(id);
    if (id === undefined || !page || row !== page.row) {
      data.push(row);
      continue;
    }
    const current = await scratch.getRecord(page.resource, id);
    const unlinked = linkedBefore?.has(id) === true && linkedAfter !== undefined && !linkedAfter.has(id);
    if (!current || unlinked) {
      changed = true;
      continue;
    }
    // Clients never write a declared readonly field; the server keeps it.
    const { fields, system } = declaredFields(schema, page.resource);
    let restored = false;
    for (const [key, field] of fields) {
      if (field.readonly && !system.has(key) && !sameValue(page.seeded[key], current[key])) {
        if (page.seeded[key] === undefined) delete current[key];
        else current[key] = page.seeded[key];
        restored = true;
      }
    }
    if (restored) await scratch.upsertRecord(page.resource, current);
    const changedKeys = new Set(
      [...Object.keys(page.seeded), ...Object.keys(current)]
        .filter((key) => !sameValue(page.seeded[key], current[key])),
    );
    if (changedKeys.size === 0) {
      data.push(row);
      continue;
    }
    const filters = injectLocalCapabilityAutoFilters(
      { resource: page.resource, metadata: query.metadata, filters: query.filters },
      schema,
    ).filters;
    if (await pendingWritesStopMatch(scratch, schema, page.resource, filters, page.seeded, current, changedKeys)) {
      changed = true;
      continue;
    }
    const patch: Record<string, unknown> = {};
    const shownKeys = [...changedKeys].filter((key) =>
      serverProjectsField(schema, query, page.resource, key, page.row));
    for (const key of shownKeys) {
      // A cleared declared field reads as the server's null column.
      if (current[key] !== undefined) patch[key] = current[key];
      else if (fields.has(key)) patch[key] = null;
    }
    const decoded = stripNullsForNonNullableFields(
      parseDateFields(schema, page.resource, patch),
      schema.resources.find((entry) => entry.name === page.resource),
    );
    const shown: Record<string, unknown> = { ...page.row };
    for (const key of shownKeys) {
      if (key in decoded) shown[key] = applyServerOmit(decoded[key], omit);
      else delete shown[key];
    }
    changed ||= shownKeys.length > 0;
    data.push(shown);
  }
  if (!changed) return remoteResult;
  return Array.isArray(remoteResult)
    ? data
    : { ...(remoteResult as Record<string, unknown>), data };
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
