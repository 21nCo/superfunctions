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
  ANCESTOR_INACTIVE_FIELD,
  endpointIncludes,
  findRelationMatch,
  firstEndpoint,
  getCapabilityFields,
  evaluateFilter,
  hasTemporalGrouping,
  normalizeFilterOps,
  normalizeRelationPayload,
  parseSortTerms,
  relationFkFieldForManyOne,
  relationFkFieldForOneMany,
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
  decryptQueryRowsForE2ee,
  type DatafnE2eeConfig,
} from "./e2ee.js";
import { readRowRevision, withoutRowRevision } from "@datafn/core";
import { installServerRevisions, schemaRevisionResources } from "./sync/apply.js";

function isVersionedQuery(query: unknown): query is Record<string, unknown> {
  return typeof query === "object" && query !== null && !Array.isArray(query) &&
    (query as Record<string, unknown>).withRevisions === true;
}

/**
 * DATA-41: whether a versioned query's rows are complete rows of its own
 * resource, as the server issues revisions only for those. A relation
 * traversal returns another resource's rows (whose own fields may include an
 * application `$rev`), and a projection, grouping, aggregation, temporal or
 * shared-with-me query returns no complete row of this namespace, so none of
 * them is installed.
 */
function installsVersionedRows(query: Record<string, unknown>): boolean {
  if (query.relation !== undefined || query.temporal !== undefined) return false;
  if (query.groupBy !== undefined || query.aggregations !== undefined || hasTemporalGrouping(query)) return false;
  const select = query.select;
  if (select !== undefined && !(Array.isArray(select) && select.length === 1 && select[0] === "*")) return false;
  if (Array.isArray(query.omit) ? query.omit.length > 0 : query.omit !== undefined) return false;
  const metadata = query.metadata as Record<string, unknown> | undefined;
  return metadata?.accessMode === undefined || metadata.accessMode === "namespace";
}

/** DATA-41: client hooks for installing a versioned query's rows. */
export type VersionedQueryHooks = {
  /** Local mutations applied to storage but not yet in the changelog (debounced). */
  pendingMutations?: () => readonly unknown[];
  /** Called with the records installed per resource (re-index, refresh live queries). */
  onInstalled?: (installed: Record<string, string[]>) => Promise<void>;
};

/**
 * DATA-41: decrypts a versioned query's rows and, on a storage-backed client
 * whose table is hydrated, installs each row with its revision unless the
 * record was written locally after the query started (`writtenSince`) or a
 * pending local change touches it. The rows returned are the server's rows
 * with their `$rev`.
 */
async function finishVersionedQueryResult(
  query: unknown,
  result: unknown,
  storage: DatafnStorageAdapter | undefined,
  schema: DatafnSchema | undefined,
  e2ee: DatafnE2eeConfig | undefined,
  writtenSince: number | undefined,
  hooks: VersionedQueryHooks | undefined,
): Promise<unknown> {
  if (!isVersionedQuery(query) || typeof query.resource !== "string" || !schema) return result;
  const rows = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return result;
  const resource = query.resource;
  const decrypted = await decryptQueryRowsForE2ee(schema, e2ee, resource, rows as Array<Record<string, unknown>>);
  if (installsVersionedRows(query) && storage && (await storage.getHydrationState(resource)) === "ready") {
    const entries = decrypted.flatMap((row) => {
      const rev = readRowRevision(row);
      return rev !== undefined && typeof row.id === "string"
        ? [{ id: row.id, record: withoutRowRevision(row), rev }]
        : [];
    });
    const { installed } = await installServerRevisions(storage, resource, entries, {
      revisionResources: schemaRevisionResources(schema),
      pendingMutations: hooks?.pendingMutations,
      writtenSince,
    });
    if (installed.length > 0) await hooks?.onInstalled?.({ [resource]: installed });
  }
  return { ...(result as Record<string, unknown>), data: decrypted };
}

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

async function listPendingChanges(storage: DatafnStorageAdapter): Promise<DatafnChangelogEntry[]> {
  return storage.changelogList({ limit: ALL_CHANGELOG_ENTRIES });
}

function pendingIdsForResource(changes: readonly DatafnChangelogEntry[], resource: unknown): Set<string> {
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

/** materializeSelect's omit: recursive into objects and arrays, never `id` or `$relation_metadata`. */
function applyServerOmit(value: unknown, omit: ReadonlySet<string>): unknown {
  if (omit.size === 0) return value;
  if (Array.isArray(value)) return value.map((member) => applyServerOmit(member, omit));
  if (!isObjectValue(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key !== "id" && omit.has(key)) continue;
    result[key] = key === "$relation_metadata" ? member : applyServerOmit(member, omit);
  }
  return result;
}

/** Declared fields of a resource, with the fields its capabilities add (`system`). */
function declaredFields(schema: DatafnSchema, resource: string): { fields: Map<string, DatafnFieldSchema>; system: Set<string> } {
  const resourceSchema = schema.resources.find((entry) => entry.name === resource);
  const fields = new Map<string, DatafnFieldSchema>();
  if (!resourceSchema) return { fields, system: new Set() };
  const capabilities = resolveCapabilities(schema.capabilities as any, resourceSchema.capabilities as any);
  const systemFields = getCapabilityFields(capabilities);
  for (const field of [...systemFields, ...resourceSchema.fields]) fields.set(field.name, field);
  return { fields, system: new Set(systemFields.map((field) => field.name)) };
}

/**
 * Whether the server's projection returns `key` of `resource`: every declared
 * field for no select or `*` (`*#` and `**` on many-many and htree relation
 * pages), a bare token, and for a relation key only the scalar foreign key
 * when the token that wrote it last is bare or `*`. A key the page strips, or
 * a many-one foreign key, is only changed where the server returned it.
 */
function serverProjectsField(schema: DatafnSchema, query: Record<string, unknown>, resource: string, key: string,
  remoteRow: Record<string, unknown>, relationType: string | undefined, stripped: ReadonlySet<string>): boolean {
  if (key === "id" || key === "$relation_metadata") return false;
  if (stringTokens(query.omit).includes(key) || (stripped.has(key) && !(key in remoteRow))) return false;
  // `*#` expands many-many targets and `**` htree descendants; the server
  // ignores either on any other relation.
  const wildcard = (token: unknown): boolean =>
    (token === "*#" && relationType === "many-many") || (token === "**" && relationType === "htree");
  const tokens = Array.isArray(query.select) && query.select.length > 0
    ? query.select
      .filter((token) => !(relationType && (token === "*#" || token === "**")) || wildcard(token))
      .map((token) => wildcard(token) ? "*" : token)
    : undefined;
  const declared = declaredFields(schema, resource).fields.has(key);
  if (findRelationMatch(schema, resource, key)) {
    if (isPlainRecord(remoteRow[key]) || Array.isArray(remoteRow[key])) return false;
    let scalar = false;
    for (const token of tokens ?? ["*"]) {
      if (token === key) scalar = heldForeignKeys(schema, resource).has(key);
      else if (token === "*" && declared && key in remoteRow) scalar = true;
      else if (typeof token === "string" && token.startsWith(`${key}.`)) scalar = false;
    }
    return scalar;
  }
  if (tokens?.includes(key)) return true;
  if ((!declared && !(key in remoteRow)) || (tokens && !tokens.includes("*"))) return false;
  // The server's final omit pass strips them from relation rows, htree ones included.
  return !serverOmittedForeignKeys(schema, resource).has(key) || key in remoteRow;
}

/** The server's getFkFieldsToOmit: many-one foreign keys and polymorphic resource discriminators. */
function serverOmittedForeignKeys(schema: DatafnSchema, resource: string): Set<string> {
  const keys = new Set<string>();
  for (const relation of schema.relations ?? []) {
    if (relation.type !== "many-one" || !endpointIncludes(relation.from, resource)) continue;
    keys.add(relationFkFieldForManyOne(relation));
    if (Array.isArray(relation.to) && relation.to.length > 1) {
      keys.add(relation.fkResourceField || `${(relation.relation || "target").replace(/Id$/, "")}Resource`);
    }
  }
  return keys;
}

function stringTokens(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((token): token is string => typeof token === "string") : [];
}

/**
 * Keys materializeSelect's final omit pass strips at every depth: the query's
 * omit plus the row resource's auto-omitted keys its select does not name
 * and, on a relation page, the anchor's own pass (its select is
 * `<relation>.<token>`). A FULL_PUSHDOWN list keeps nested keys, so a plain
 * list's nested omit depends on the server's plan.
 */
function serverStrippedKeys(schema: DatafnSchema, query: Record<string, unknown>, resource: string, relationType: string | undefined): Set<string> {
  const named = stringTokens(query.select).map((token) => token.split(".")[0]);
  const keys = new Set(stringTokens(query.omit));
  for (const key of serverOmittedForeignKeys(schema, resource)) if (!named.includes(key)) keys.add(key);
  if (!relationType) return keys;
  for (const key of serverOmittedForeignKeys(schema, String(query.resource))) if (key !== query.relation) keys.add(key);
  return keys;
}

/** The page row as a store row (dates encoded as stored). */
function seedRow(schema: DatafnSchema, resource: string, remoteRow: Record<string, unknown>): Record<string, unknown> {
  try {
    // A copy: the seed is changed in place, never the server's row.
    return { ...serializeDateFields(schema, resource, remoteRow) };
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
    conjuncts.push(...(key === "$and" && Array.isArray(value) ? value.flatMap((sub) => filterConjuncts(sub)) : [{ [key]: value }]));
  }
  return conjuncts;
}

/**
 * The stored path a filter key reads on the row: `<relation>.id` of a forward
 * many-one relation is the row's own foreign key; any other path through a
 * relation reads another record, which the page cannot know (`undefined`).
 */
function leafPath(schema: DatafnSchema, resource: string, key: string): string[] | undefined {
  const [head, ...rest] = key.split(".");
  const match = rest.length > 0 ? findRelationMatch(schema, resource, head) : undefined;
  if (!match) return [head, ...rest];
  const ownKey = rest.length === 1 && rest[0] === "id" && match.relation.type === "many-one" && match.direction === "forward";
  return ownKey ? [relationFkFieldForManyOne(match.relation)] : undefined;
}

/** Whether a filter reads a top-level field in `keys`. */
function filterReads(schema: DatafnSchema, resource: string, filter: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(filter)) return filter.some((sub) => filterReads(schema, resource, sub, keys));
  if (!isPlainRecord(filter)) return false;
  return Object.entries(filter).some(([key, value]) => key.startsWith("$")
    ? filterReads(schema, resource, value, keys)
    : keys.has(leafPath(schema, resource, key)?.[0] ?? ""));
}

type Truth = boolean | undefined;

function allOf(parts: readonly Truth[]): Truth {
  return parts.includes(false) ? false : parts.every(Boolean) || undefined;
}

function anyOf(parts: readonly Truth[]): Truth {
  return parts.includes(true) || (parts.every((part) => part === false) ? false : undefined);
}

/**
 * Three-valued evaluation of a filter on the replayed row, one condition at
 * a time: `undefined` where a condition reads a path the page cannot settle,
 * so an $or is false only when every branch is, and an $and as soon as one
 * part is.
 */
function judgeFilter(schema: DatafnSchema, resource: string, filter: unknown,
  current: Record<string, unknown>, known: (path: readonly string[]) => boolean): Truth {
  if (!isPlainRecord(filter)) return undefined;
  const parts: Truth[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or") {
      if (!Array.isArray(value)) return undefined;
      const branches = value.map((sub) => judgeFilter(schema, resource, sub, current, known));
      parts.push(key === "$and" ? allOf(branches) : anyOf(branches));
      continue;
    }
    const path = key.startsWith("$") ? undefined : leafPath(schema, resource, key);
    if (!path || !known(path)) {
      parts.push(undefined);
      continue;
    }
    // The server reads an array value as $in (normalizeFieldFilter).
    const condition = Array.isArray(value) ? { $in: value } : value;
    try {
      parts.push(evaluateFilter(current, normalizeFilterOps({ [path.join(".")]: condition }), { resource }));
    } catch {
      // A condition the evaluator cannot read is unknown.
      parts.push(undefined);
    }
  }
  return allOf(parts);
}

/**
 * Whether the replayed row settles `path`: it holds a value there, a written
 * null or scalar ends it, or the member is absent from a value held whole
 * (returned, or written whole). A member missing below a merge onto an
 * unreturned value, or one the server strips at every depth, is unknown
 * unless the replay wrote a value containing it whole.
 */
function writtenPathKnown(current: Record<string, unknown>, path: readonly string[], whole: boolean, hidden: ReadonlySet<unknown>, rewritten: WholeKeys): boolean {
  let value: unknown = current;
  for (const [index, segment] of path.entries()) {
    if (!isPlainRecord(value)) return true;
    if (!(segment in value)) {
      const rewrote = rewritten === true
        || path.slice(0, index).some((_, end) => rewritten.has(JSON.stringify(path.slice(0, end + 1))));
      return !(index > 0 && hidden.has(segment) && !rewrote) && (index !== 1 || whole);
    }
    value = value[segment];
  }
  return true;
}

function hasPath(row: Record<string, unknown>, path: readonly string[]): boolean {
  let value: unknown = row;
  for (const segment of path) {
    if (!isPlainRecord(value) || !(segment in value)) return false;
    value = value[segment];
  }
  return value !== undefined;
}

/** Top-level keys whose replayed value the page holds whole; `true` for all. */
type WholeKeys = Set<string> | true;

/**
 * The server returned the row, so each top-level condition matched; the row
 * stops matching when one reading a changed field is false after the replay.
 * A row written whole also settles the declared fields the page hid, except
 * readonly and capability fields, which the server's replace keeps.
 */
function pendingWritesStopMatch(schema: DatafnSchema, resource: string, filters: unknown, seeded: Record<string, unknown>, current: Record<string, unknown>,
  changedKeys: ReadonlySet<string>, wholeKeys: WholeKeys, hidden: ReadonlySet<unknown>, unknownKeys: ReadonlySet<string> = new Set(), rewritten: WholeKeys = new Set()): boolean {
  const settled = new Set(changedKeys);
  if (wholeKeys === true) {
    const { fields, system } = declaredFields(schema, resource);
    for (const [key, field] of fields) {
      if (!(key in seeded) && !field.readonly && !system.has(key)) settled.add(key);
    }
  }
  const known = (path: readonly string[]): boolean =>
    !unknownKeys.has(path[0])
    && (hasPath(seeded, path)
    || (settled.has(path[0])
      && writtenPathKnown(current, path, wholeKeys === true || wholeKeys.has(path[0]), hidden, rewritten)));
  return filterConjuncts(filters).some((conjunct) =>
    filterReads(schema, resource, conjunct, settled)
    && judgeFilter(schema, resource, conjunct, current, known) === false);
}

/** Changed values decoded as the page returns them; unproven paths and undecodable values keep the server's. */
function decodeChangedKeys(schema: DatafnSchema, resource: string, current: Record<string, unknown>,
  changedKeys: ReadonlySet<string>, unproven: ReadonlySet<string>): { patch: Record<string, unknown>; undecodable: Set<string> } {
  const undecodable = new Set<string>(unproven);
  const patch: Record<string, unknown> = {};
  for (const key of changedKeys) {
    if (current[key] === undefined || undecodable.has(key)) continue;
    try {
      Object.assign(patch, parseDateFields(schema, resource, { [key]: current[key] }));
    } catch {
      undecodable.add(key);
    }
  }
  return { patch, undecodable };
}

async function pageMemberIds(scratch: DatafnStorageAdapter, schema: DatafnSchema, membershipQuery: Record<string, unknown>): Promise<Set<string> | undefined> {
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
 * The page row after the replay, or null when it leaves the page. A relation
 * page's filters are its anchor's, so targets meet only capability auto-filters.
 */
async function replayedPageRow(scratch: DatafnStorageAdapter, schema: DatafnSchema, query: Record<string, unknown>, id: string, page: PageRow,
  relationType: string | undefined, nestedOmit: NestedOmit): Promise<Record<string, unknown> | null> {
  const current = await scratch.getRecord(page.resource, id);
  if (!current) return null;
  const unproven = unwrittenPathKeys(schema, page, current);
  // Ancestor inactivity comes from records the scratch store does not hold;
  // a cleared declared field is the server's null column.
  let normalized = false;
  if (!sameValue(page.seeded[ANCESTOR_INACTIVE_FIELD], current[ANCESTOR_INACTIVE_FIELD])) {
    if (page.seeded[ANCESTOR_INACTIVE_FIELD] === undefined) delete current[ANCESTOR_INACTIVE_FIELD];
    else current[ANCESTOR_INACTIVE_FIELD] = page.seeded[ANCESTOR_INACTIVE_FIELD];
    normalized = true;
  }
  const { fields } = declaredFields(schema, page.resource);
  for (const key of fields.keys()) {
    if (key in page.seeded && current[key] === undefined) {
      current[key] = null;
      normalized = true;
    }
  }
  if (normalized) await scratch.upsertRecord(page.resource, current);
  // Ancestor inactivity was normalized to the seed above.
  const changedKeys = changedKeysOf(page.seeded, current);
  if (changedKeys.size === 0) return page.row;
  const filters = injectLocalCapabilityAutoFilters(
    { resource: page.resource, metadata: query.metadata, ...(relationType ? {} : { filters: query.filters }) },
    schema,
  ).filters;
  const stripped = serverStrippedKeys(schema, query, page.resource, relationType);
  const { patch, undecodable } = decodeChangedKeys(schema, page.resource, current, changedKeys, unproven);
  if (pendingWritesStopMatch(
    schema, page.resource, filters, page.seeded, current, changedKeys, page.wholeKeys, stripped, undecodable,
    page.rewritten,
  )) {
    return null;
  }
  const shownKeys = [...changedKeys].filter((key) =>
    serverProjectsField(schema, query, page.resource, key, page.row, relationType, stripped));
  if (shownKeys.length === 0) return page.row;
  const decoded = stripNullsForNonNullableFields(
    patch,
    schema.resources.find((entry) => entry.name === page.resource),
  );
  const shown: Record<string, unknown> = { ...page.row };
  for (const key of shownKeys) {
    if (undecodable.has(key)) continue;
    if (!(key in decoded)) {
      delete shown[key];
      continue;
    }
    // An undecided mask that would change the value keeps the server's.
    const masked = applyServerOmit(decoded[key], stripped);
    if (nestedOmit === "kept") shown[key] = decoded[key];
    else if (nestedOmit === "stripped" || sameValue(masked, decoded[key])) shown[key] = masked;
  }
  return shown;
}

/** Whether the server's plan strips omitted keys from nested values. */
type NestedOmit = "kept" | "stripped" | "unknown";

/**
 * A relation page, a search or temporal read, or a select naming a relation
 * or nested token takes materializeSelect's mask; a stripped key nested in any returned row shows a
 * plain list's plan kept them (FULL_PUSHDOWN). Otherwise the page cannot tell.
 */
function nestedOmitOf(schema: DatafnSchema, query: Record<string, unknown>, remoteData: readonly unknown[], relation: boolean): NestedOmit {
  const resource = String(query.resource);
  if (relation || query.search || "temporal" in query || stringTokens(query.select).some((token) => token.includes(".")
    || findRelationMatch(schema, resource, token.split(/[*#]/)[0]))) return "stripped";
  const stripped = serverStrippedKeys(schema, query, resource, undefined);
  return remoteData.some((row) => isPlainRecord(row) && Object.entries(row).some(([key, value]) =>
    key !== "$relation_metadata" && !sameValue(applyServerOmit(value, stripped), value)))
    ? "kept"
    : "unknown";
}

const STATE_OPERATIONS = new Set(["trash", "restore", "archive", "unarchive"]);

/** Foreign keys a record of `resource` holds. */
function heldForeignKeys(schema: DatafnSchema, resource: string): Set<string> {
  const keys = new Set<string>();
  for (const relation of schema.relations ?? []) {
    if (relation.type === "many-one" && endpointIncludes(relation.from, resource)) {
      keys.add(relationFkFieldForManyOne(relation));
    } else if (relation.type === "one-many" && endpointIncludes(relation.to, resource)) {
      keys.add(relationFkFieldForOneMany(relation));
    }
  }
  return keys;
}

/**
 * The server's replace (buildReplaceRecord) of `before` by a replace or insert
 * payload. Only the timestamps and audit capabilities (`system`) keep
 * createdAt and createdBy and stamp updatedAt and updatedBy; a plain field of
 * the same name follows the ordinary rules.
 */
function serverReplacedRecord(fields: ReadonlyMap<string, DatafnFieldSchema>, system: ReadonlySet<string>, before: Record<string, unknown>,
  written: Record<string, unknown>, record: Record<string, unknown>): Record<string, unknown> {
  // Undeclared columns are outside the replace; the writer's stamps stay.
  const result: Record<string, unknown> = { ...written };
  for (const key of Object.keys(before)) {
    if (!fields.has(key) && !(key in record)) result[key] = before[key];
  }
  for (const [key, field] of fields) {
    if (key === "id") continue;
    const capability = system.has(key);
    if (capability && (key === "updatedAt" || key === "updatedBy")) continue;
    if ((capability && (key === "createdAt" || key === "createdBy")) || field.readonly) {
      if (before[key] === undefined) delete result[key];
      else result[key] = before[key];
    } else {
      result[key] = key in record
        ? (key in written ? written[key] : record[key])
        : (field.default === undefined ? null : structuredClone(field.default));
      if (field.required && (result[key] === undefined || (result[key] === null && !field.nullable))) {
        // buildReplaceRecord rejects the whole replace.
        throw new Error(`Required field missing: ${key}`);
      }
    }
  }
  result.id = before.id;
  return result;
}

/**
 * Apply one pending entry with the offline writer as the server sees it: a
 * malformed relation payload skips it, a state change never revives a deleted
 * record, a merge keeps readonly fields, a replace follows buildReplaceRecord.
 */
async function replayPendingEntry(scratch: DatafnStorageAdapter, schema: DatafnSchema, change: DatafnChangelogEntry): Promise<boolean> {
  const mutation = sentMutation(schema, change.mutation);
  const { resource, id, operation } = mutation;
  if (mutation.relations !== undefined) {
    if (!isPlainRecord(mutation.relations)) return false;
    for (const [name, payload] of Object.entries(mutation.relations)) if (rejectedMetadata(schema, resource, name, payload)) return false;
  }
  const before = typeof resource === "string" && typeof id === "string" ? await scratch.getRecord(resource, id) : null;
  if (STATE_OPERATIONS.has(operation as string) && !before) return false;
  await applyOptimisticMutationToStorage(scratch, schema, mutation, change.timestampMs, change.actorId ?? change.clientId);
  if (!before || !["insert", "replace", "merge"].includes(operation as string)) return true;
  const after = await scratch.getRecord(resource as string, id as string);
  if (!after) return true;
  const { fields, system } = declaredFields(schema, resource as string);
  if (operation !== "merge") {
    const record = isPlainRecord(mutation.record) ? mutation.record : {};
    await scratch.upsertRecord(resource as string, serverReplacedRecord(fields, system, before, after, record));
    return true;
  }
  let restored = false;
  for (const [key, field] of fields) {
    if (!field.readonly || system.has(key) || sameValue(before[key], after[key])) continue;
    if (before[key] === undefined) delete after[key];
    else after[key] = before[key];
    restored = true;
  }
  if (restored) await scratch.upsertRecord(resource as string, after);
  return true;
}

type PageRow = {
  resource: string;
  row: Record<string, unknown>;
  seeded: Record<string, unknown>;
  wholeKeys: WholeKeys;
  /** Segment tuples the replay itself wrote whole; `true` for all. */
  rewritten: WholeKeys;
  /** Htree paths the server holds for the record, while the replay holds them too. */
  knownPaths?: Map<string, unknown>;
};

/** The scratch store, journaling record and join-row writes so a rejected entry is undone whole. */
function journaled(scratch: MemoryStorageAdapter, undo: Array<() => Promise<void>>, deleted: string[]): DatafnStorageAdapter {
  const saveRecord = async (resource: string, id: unknown): Promise<void> => {
    if (typeof id !== "string") return;
    const prior = await scratch.getRecord(resource, id);
    const saved = prior ? structuredClone(prior) : null;
    undo.push(() => saved ? scratch.upsertRecord(resource, saved) : scratch.deleteRecord(resource, id));
  };
  const saveJoin = async (relationKey: string, from: unknown, to: unknown): Promise<void> => {
    const prior = (await scratch.listJoinRows(relationKey)).find((row) => row.from === from && row.to === to);
    const saved = prior ? structuredClone(prior) : undefined;
    undo.push(() => saved
      ? scratch.upsertJoinRow(relationKey, saved)
      : scratch.deleteJoinRow(relationKey, String(from), String(to)));
  };
  const writes: Record<string, (...args: any[]) => Promise<void>> = {
    upsertRecord: (resource: string, record: Record<string, unknown>) => saveRecord(resource, record?.id),
    deleteRecord: (resource: string, id: string) => { deleted.push(JSON.stringify([resource, id])); return saveRecord(resource, id); },
    mergeRecord: (resource: string, id: string) => saveRecord(resource, id),
    upsertJoinRow: (key: string, row: Record<string, unknown>) => saveJoin(key, row?.from, row?.to),
    deleteJoinRow: (key: string, from: string, to: string) => saveJoin(key, from, to),
    setJoinRows: async (key: string, rows: Array<Record<string, unknown>>) => {
      for (const row of rows) await saveJoin(key, row?.from, row?.to);
    },
  };
  return new Proxy(scratch, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const save = typeof property === "string" ? writes[property] : undefined;
      if (!save) return value.bind(target);
      return async (...args: unknown[]) => {
        await save(...args);
        return value.apply(target, args);
      };
    },
  });
}

/** A mutation as `/push` receives it: `$ref` items under a forward name keep only that name's last declared metadata, at any depth, and JSON drops undefined keys. */
function sentMutation(schema: DatafnSchema, mutation: Record<string, unknown>): Record<string, unknown> {
  const { resource, relations } = mutation;
  if (typeof resource !== "string" || !isPlainRecord(relations)) return mutation;
  return { ...mutation, relations: Object.fromEntries(Object.entries(relations).map(([name, payload]) => {
    const kept = schema.relations?.filter((relation) => relation.relation === name && endpointIncludes(relation.from, resource)).at(-1);
    const strip = (item: unknown): unknown => Array.isArray(item) ? item.map(strip) : !isPlainRecord(item) || typeof item.$ref !== "string" ? item
      : Object.fromEntries(Object.entries(item).filter(([key, value]) => value !== undefined && (key === "$ref" || !kept || kept.metadata?.some((entry) => entry.name === key))));
    return [name, strip(payload)];
  })) };
}

/** Whether the server's mutation validator rejects a sent relation payload: an object item (a nested array too) with a key besides `$ref` and the matched relation's metadata. */
function rejectedMetadata(schema: DatafnSchema, resource: unknown, name: string, payload: unknown): boolean {
  const match = typeof resource === "string" ? findRelationMatch(schema, resource, name) : undefined;
  if (!match) return false;
  const { type, from, to, metadata } = match.relation;
  const many = (end: unknown, key: string): string[] => (type === "many-many" && Array.isArray(end) && end.length > 1 ? [key] : []);
  const allowed = new Set(["$ref", ...(metadata ?? []).map((entry) => entry.name), ...many(from, "fromResource"), ...many(to, "toResource")]);
  return (Array.isArray(payload) ? payload : [payload]).some((item) => typeof item === "object" && item !== null && Object.keys(item).some((key) => !allowed.has(key)));
}

const STATE_FIELDS = ["isArchived", "trashedAt"];
const inactiveBy = (record: Record<string, unknown>, field: string): boolean => field === "isArchived" ? record.isArchived === true : (record.trashedAt ?? null) !== null;
/**
 * Note the archived or trashed fields an applied entry decides: all for an insert or replace (the push adds writable defaults) or a
 * record it deletes (later writes create; by cascade, only if no record it deletes was linked by a `guessed` key); a state operation's; else those it writes.
 */
function noteStateEvidence(evidence: Map<string, Set<string>>, guessed: ReadonlyMap<string, string[]>, mutation: Record<string, unknown>, deleted: readonly string[]): void {
  const { resource, id, operation, record } = mutation;
  const key = JSON.stringify([resource, id]);
  const fields = ["insert", "replace", "delete"].includes(operation as string) ? STATE_FIELDS
    : STATE_OPERATIONS.has(operation as string) ? [/^(trash|restore)$/.test(operation as string) ? "trashedAt" : "isArchived"]
      : STATE_FIELDS.filter((field) => isPlainRecord(record) && field in record);
  const linked = deleted.every((gone) => gone === key || !guessed.get(gone)?.length); // every hop of the cascade the server holds
  for (const gone of deleted) if (gone === key || linked) evidence.set(gone, new Set(STATE_FIELDS));
  evidence.set(key, new Set([...evidence.get(key) ?? [], ...fields]));
}

/** Note the set fields a merge-create filled itself, links and discriminators included (the server keeps its own record's), that no later merge sent. */
async function noteGuessedKeys(scratch: DatafnStorageAdapter, schema: DatafnSchema, guessed: Map<string, string[]>, mutation: Record<string, unknown>, existed: boolean): Promise<void> {
  const { resource, id, operation, record } = mutation;
  if (!["merge", "insert", "replace"].includes(operation as string) || typeof resource !== "string" || typeof id !== "string") return;
  const after = operation === "merge" && !existed ? await scratch.getRecord(resource, id) : null;
  const own = new Set(["id", ANCESTOR_INACTIVE_FIELD, ...STATE_FIELDS, ...declaredFields(schema, resource).system]);
  const keys = after ? Object.keys(after).filter((key) => !own.has(key) && after[key] != null) : guessed.get(JSON.stringify([resource, id])) ?? [];
  guessed.set(JSON.stringify([resource, id]), operation === "merge" ? keys.filter((key) => !isPlainRecord(record) || record[key] === undefined) : []); // JSON drops undefined
}

/** Htree paths a merge, replace or insert sets as given, or a replace resets (declared writable only, as buildReplaceRecord). */
function notePathWrites(schema: DatafnSchema, target: PageRow, mutation: Record<string, unknown>, after: Record<string, unknown> | null): void {
  if (!["merge", "replace", "insert"].includes(mutation.operation as string)) return;
  const record = isPlainRecord(mutation.record) ? mutation.record : {};
  const { fields, system } = declaredFields(schema, target.resource);
  for (const pathField of htreePathFields(schema, target.resource)) {
    if (fields.get(pathField)?.readonly || system.has(pathField)) continue;
    if (pathField in record || (mutation.operation !== "merge" && fields.has(pathField))) {
      (target.knownPaths ??= new Map()).set(pathField, pathField in record ? record[pathField] : after?.[pathField] ?? null);
    }
  }
}

/** A relinked record's path, known only to end in its new parent's id. */
class RelinkTail { constructor(readonly parentId: string) {} }
type Relink = [id: string, pathField: string, relation: NonNullable<DatafnSchema["relations"]>[number], tree: Endpoint, from?: string, to?: string];
type Endpoint = NonNullable<DatafnSchema["relations"]>[number]["from"];

/** What an htree relate or unrelate moves (`parent`: the record; `children`: the targets, as the writer normalizes them). */
function htreeRelinks(schema: DatafnSchema, mutation: Record<string, unknown>): Relink[] | undefined {
  const { resource, relations } = mutation;
  if (!["relate", "unrelate"].includes(mutation.operation as string) || typeof resource !== "string") return undefined;
  const moved = new Map<string, Relink>();
  for (const [name, payload] of Object.entries(isPlainRecord(relations) ? relations : {})) {
    const match = findRelationMatch(schema, resource, name);
    if (match?.relation.type !== "htree") continue;
    const items = normalizeRelationPayload(payload).map((item) => item.toId);
    const tree = firstEndpoint(match.direction === "inverse" ? match.relation.from : match.relation.to); // the writer's treeResource
    for (const id of match.direction === "inverse" ? items.slice(0, 1).map(() => mutation.id) : items) {
      const pathField = htreePathField(match.relation);
      if (typeof id === "string") moved.set(JSON.stringify([id, pathField, tree]), [id, pathField, match.relation, tree]);
    }
  }
  return [...moved.values()];
}

/** A known path after the server's cascade moves `id` from its held `old` path to its held `now` path; undefined when unknown. */
function cascadedPath(path: string, id: string, old: { path: string | null } | undefined, now: { path: string | null } | undefined): string | undefined {
  const from = joinPath(old?.path ?? "", id);
  if (!old || !now) return undefined;
  return pathExtends(path, from) ? joinPath(now.path ?? "", id) + path.slice(from.length) : path;
}

/**
 * Rewrite known paths listing a moved record (of the same resource, as the server's cascade) if its old (`prior`) and new
 * paths are held, else forget them; a tail goes once the cascade's prefix can reach into its last segment.
 */
async function cascadeMovedPaths(scratch: DatafnStorageAdapter, pages: ReadonlyArray<[string, PageRow]>, moved: readonly Relink[],
  prior: ReadonlyMap<Relink, [PageRow, Record<string, unknown> | null]>, tracked: (tree: Endpoint, id: string) => PageRow | undefined): Promise<void> {
  for (const [pageId, page] of pages) {
    for (const [pathField, path] of page.knownPaths ?? []) {
      const tree = moved.filter(([, field, , endpoint]) => field === pathField && endpointIncludes(endpoint, page.resource));
      const listed = tree.filter(([id]) => typeof path === "string" && pathLists(path, id));
      if (listed.length === 0 || tree.some(([id]) => id === pageId)) continue;
      const [id] = listed[0];
      const [before, record] = prior.get(listed[0]) ?? [];
      const mover = tracked(page.resource, id);
      const now = mover && heldHtreePath(mover, pathField, await scratch.getRecord(mover.resource, id));
      const next = listed.length === 1 ? cascadedPath(path as string, id, before && heldHtreePath(before, pathField, record), now) : undefined;
      if (next === undefined) page.knownPaths?.delete(pathField);
      else page.knownPaths?.set(pathField, next);
    }
  }
}

/** Whether a move's cascade in the page's tree can rewrite a tail ending in `parentId`: a separator-prefix of it ends in `-<mover>`, agreeing with the mover's held old prefix, unless that equals its held new one. */
function rewritesTail([id, field, , tree, from, to]: Relink, page: PageRow, pathField: string, parentId: string): boolean {
  if (field !== pathField || !endpointIncludes(tree, page.resource) || (from !== undefined && from === to)) return false;
  for (let at = parentId.indexOf(`-${id}`); at >= 0; at = parentId.indexOf(`-${id}`, at + 1)) {
    const cut = parentId.slice(0, at + id.length + 1);
    if (`${parentId}-`[cut.length] === "-" && (from === undefined || from === cut || from.endsWith(`-${cut}`))) return true;
  }
  return false;
}

/** The page records a relink moves, as held before it; each mover's old prefix (`from`) when held and no other move of the entry can shift it. */
async function snapshotMovers(scratch: DatafnStorageAdapter, moved: Relink[], tracked: (tree: Endpoint, id: string) => PageRow | undefined): Promise<Map<Relink, [PageRow, Record<string, unknown> | null]>> {
  const prior = new Map<Relink, [PageRow, Record<string, unknown> | null]>();
  for (const relink of moved) {
    const page = tracked(relink[3], relink[0]);
    const record = page ? await scratch.getRecord(page.resource, relink[0]) : null;
    if (!page) continue;
    prior.set(relink, [{ ...page, knownPaths: new Map(page.knownPaths) }, record]);
    const held = heldHtreePath(page, relink[1], record)?.path;
    if (held !== undefined && !moved.some((other) => other !== relink && pathLists(held ?? "", other[0]))) relink[4] = joinPath(held ?? "", relink[0]);
  }
  return prior;
}

/** Forget the relink tails held before an entry (`held`) whose last segment one of its moves can rewrite (a lone move's held new prefix is known). */
async function forgetRewrittenTails(scratch: DatafnStorageAdapter, pages: ReadonlyArray<[string, PageRow]>, moved: Relink[], held: ReadonlySet<unknown>,
  tracked: (tree: Endpoint, id: string) => PageRow | undefined): Promise<void> {
  const now = moved.length === 1 ? tracked(moved[0][3], moved[0][0]) : undefined;
  const path = now && heldHtreePath(now, moved[0][1], await scratch.getRecord(now.resource, moved[0][0]));
  if (path) moved[0][5] = joinPath(path.path ?? "", moved[0][0]);
  for (const [, page] of pages) {
    for (const [pathField, tail] of page.knownPaths ?? []) {
      if (tail instanceof RelinkTail && held.has(tail) && moved.some((relink) => rewritesTail(relink, page, pathField, tail.parentId))) page.knownPaths?.delete(pathField);
    }
  }
}

/** Record the path a relink gave a page record under a held parent (not in a polymorphic tree), else its last segment. */
async function noteRelinkedPaths(scratch: DatafnStorageAdapter, moved: readonly Relink[], tracked: (tree: Endpoint, id: string) => PageRow | undefined): Promise<void> {
  for (const [index, [id, pathField, relation, tree]] of moved.entries()) {
    const page = tracked(tree, id);
    const current = page && await scratch.getRecord(page.resource, id);
    const to = relation.to as unknown;
    if (!page || !current || (Array.isArray(to) && to.length > 1)) continue;
    const { fkField, foreignKey, inverse } = relation as { fkField?: string; foreignKey?: string; inverse?: string };
    const parentId = current[fkField || foreignKey || inverse || "parentId"]; // the writer's htreeFkField
    const parent = typeof parentId === "string" ? tracked(tree, parentId) : undefined;
    const held = parent && heldHtreePath(parent, pathField, await scratch.getRecord(parent.resource, parentId as string));
    if (held && current[pathField] === joinPath(held.path ?? "", parentId as string)) {
      (page.knownPaths ??= new Map()).set(pathField, current[pathField]);
    } else if (typeof parentId === "string" && !moved.slice(index + 1).some((later) => rewritesTail(later, page, pathField, parentId))) {
      (page.knownPaths ??= new Map()).set(pathField, new RelinkTail(parentId)); // a later move in the entry can rewrite it
    }
  }
}

/** What an entry writes whole: top-level keys, or JSON segment tuples (`members`; keys hold dots); `true`: all. */
function nextWhole(whole: WholeKeys, mutation: Record<string, unknown>, existed: boolean, members: boolean): WholeKeys {
  if (!existed || mutation.operation === "insert" || mutation.operation === "replace") return true;
  if (whole === true || mutation.operation !== "merge" || !isPlainRecord(mutation.record)) return whole;
  const next = new Set(whole);
  for (const [key, value] of Object.entries(mutation.record)) {
    if (!isPlainRecord(value)) next.add(members ? JSON.stringify([key]) : key);
    else if (members) for (const member of Object.keys(value)) next.add(JSON.stringify([key, member]));
  }
  return next;
}

function htreePathField(relation: { pathField?: string }): string { return relation.pathField || "parentPath"; }

/** Path fields of the htree relations whose tree holds `resource`. */
function htreePathFields(schema: DatafnSchema, resource: string): string[] {
  return (schema.relations ?? [])
    .filter((relation) => relation.type === "htree" && endpointIncludes(relation.from, resource))
    .map(htreePathField);
}

function joinPath(path: string, id: string): string { return path ? `${path}-${id}` : id; }

/** Whether `path` lists `id` (ids may themselves contain the separator). */
function pathLists(path: string, id: string): boolean { return `-${path}-`.includes(`-${id}-`); }

/** Prefixes of `path` that end in `id` at a separator. */
function anchorPrefixes(path: string, id: string): string[] {
  const prefixes: string[] = [];
  const padded = `-${path}-`;
  for (let at = padded.indexOf(`-${id}-`); at >= 0; at = padded.indexOf(`-${id}-`, at + 1)) {
    prefixes.push(path.slice(0, at + id.length));
  }
  return prefixes;
}

/** Whether `path` is `prefix` or lies below it. */
function pathExtends(path: string, prefix: string): boolean { return path === prefix || path.startsWith(`${prefix}-`); }

/**
 * The htree path the server holds for a replayed record: a known one the
 * replay still holds, or the empty path, which only the server's value or a
 * detach gives. Any other path needs ancestry only the server knows.
 */
function heldHtreePath(page: PageRow, pathField: string, current: Record<string, unknown> | null | undefined): { path: string | null } | undefined {
  if (!current) return undefined;
  if (current[pathField] === "") return { path: "" };
  const value = page.knownPaths?.get(pathField);
  if (!page.knownPaths?.has(pathField) || (typeof value !== "string" && value !== null)) return undefined;
  return sameValue(value, current[pathField] ?? null) ? { path: value } : undefined;
}

/** The htree paths the server returned for a record. */
function returnedPaths(schema: DatafnSchema, resource: string, row: Record<string, unknown>): Map<string, unknown> {
  return new Map(htreePathFields(schema, resource)
    .filter((pathField) => typeof row[pathField] === "string")
    .map((pathField) => [pathField, row[pathField]]));
}

/** Htree path fields of a replayed record the page keeps as the server returned them. */
function unwrittenPathKeys(schema: DatafnSchema, page: PageRow, current: Record<string, unknown>): Set<string> {
  return new Set(htreePathFields(schema, page.resource)
    .filter((pathField) => !heldHtreePath(page, pathField, current)));
}

/** Whether the last of `*` and `**` is `**` (descendants, not direct children). */
function selectsDescendants(query: Record<string, unknown>): boolean {
  return stringTokens(query.select).filter((token) => token === "*" || token === "**").at(-1) === "**";
}

/**
 * Seed a relation page's reported membership in the writer's form: for htree,
 * the anchor alone, with the path a children page's returned paths fix (all
 * are its child path, or lie below it; ids may hold the separator, so only a
 * prefix all agree on counts); otherwise one relate of every row onto it.
 */
async function seedRelationPage(scratch: DatafnStorageAdapter, schema: DatafnSchema, query: Record<string, unknown>,
  match: NonNullable<ReturnType<typeof findRelationMatch>>, pageRows: ReadonlyMap<string, PageRow>): Promise<Record<string, unknown>> {
  const resource = query.resource as string;
  const anchorId = query.id as string;
  if (match.relation.type === "htree") {
    const pathField = htreePathField(match.relation);
    const paths = [...pageRows.values()].map((page) => page.row[pathField]);
    const agreed = (prefix: string): boolean => paths.every((path) => typeof path === "string"
      && (selectsDescendants(query) ? pathExtends(path, prefix) : path === prefix));
    const prefixes = match.direction === "inverse" ? [] : anchorPrefixes(String(paths[0]), anchorId).filter(agreed);
    const anchor: Record<string, unknown> = { id: anchorId };
    if (prefixes.length === 1) anchor[pathField] = prefixes[0].slice(0, Math.max(prefixes[0].length - anchorId.length - 1, 0));
    await scratch.upsertRecord(resource, anchor);
    return anchor;
  }
  const anchor = (await scratch.getRecord(resource, anchorId)) ?? { id: anchorId };
  await scratch.upsertRecord(resource, anchor);
  await applyOptimisticMutationToStorage(scratch, schema, {
    resource,
    id: anchorId,
    operation: "relate",
    relations: { [query.relation as string]: [...pageRows.keys()] },
  }, 0);
  return (await scratch.getRecord(resource, anchorId)) ?? anchor;
}

/**
 * Rows of an htree relation page a pending write proves gone, judged by path
 * as the server does, from paths it certainly holds: an ancestor page lists
 * the ids of the anchor's path, a children page the rows at (or below) its
 * child path; a direct child leaves if no anchor path ends in its relink tail.
 * An inheriting page drops a row the replay marks ancestor-inactive (after a
 * relink, only via a non-htree edge to a parent an entry archived). Else it stays.
 */
async function htreeRowsGone(scratch: DatafnStorageAdapter, schema: DatafnSchema, match: NonNullable<ReturnType<typeof findRelationMatch>>,
  query: Record<string, unknown>, pageRows: ReadonlyMap<string, PageRow>, anchor: PageRow,
  /** After a relink: whether the server returned, or an applied entry decided, a record's archived or trashed field. */
  stateWritten: ((resource: string, id: string, field: string) => boolean) | undefined): Promise<Set<string>> {
  const anchorId = query.id as string;
  const pathField = htreePathField(match.relation);
  const anchorRecord = await scratch.getRecord(anchor.resource, anchorId);
  const anchorHeld = heldHtreePath(anchor, pathField, anchorRecord);
  if (match.direction === "inverse") {
    return new Set([...pageRows.keys()].filter((id) => anchorHeld && (anchorHeld.path === null || !pathLists(anchorHeld.path, id))));
  }
  // The server skips an anchor without a path (hasHtreePath).
  const wildcardOnly = !Array.isArray(query.select)
    || query.select.every((token) => token === "*" || token === "**");
  if (anchorHeld?.path === null && wildcardOnly) return new Set(pageRows.keys());
  const metadata = isPlainRecord(query.metadata) ? query.metadata : {};
  const inheriting = match.relation.inheritsInactive === true && metadata.includeAncestorInactive !== true;
  const prefix = typeof anchorHeld?.path === "string" ? joinPath(anchorHeld.path, anchorId) : undefined;
  const deep = selectsDescendants(query);
  const endsIn = (path: string, id: string): boolean => path === id || path.endsWith(`-${id}`);
  // An empty path (a root) is under no anchor; with the anchor's own path
  // unknown, its child path still ends in its id.
  const holds = (held: string): boolean => prefix !== undefined
    ? (deep ? pathExtends(held, prefix) : held === prefix)
    : (deep ? pathLists(held, anchorId) : endsIn(held, anchorId));
  const fits = (tail: string): boolean => prefix !== undefined ? endsIn(prefix, tail) : endsIn(tail, anchorId) || endsIn(anchorId, tail);
  const gone = new Set<string>();
  for (const [id, page] of pageRows) {
    const current = await scratch.getRecord(page.resource, id);
    if (!current) continue;
    // A relink can leave a guessed path the writer's cascade marks by.
    const path = heldHtreePath(page, pathField, current)?.path;
    const tail = page.knownPaths?.get(pathField);
    const inactive = page.seeded[ANCESTOR_INACTIVE_FIELD] !== true && current[ANCESTOR_INACTIVE_FIELD] === true;
    if (inheriting && inactive && (!stateWritten || path !== undefined || await inactiveOffTree(scratch, schema, page.resource, current, stateWritten))) {
      gone.add(id);
      continue;
    }
    const tailGone = !deep && tail instanceof RelinkTail && !fits(tail.parentId);
    if (path === undefined ? tailGone : !(path && holds(path))) gone.add(id);
  }
  return gone;
}

/** Whether a parent an inheriting many-one or one-many edge names is archived or trashed by a field returned or decided (scratch defaults and inheritance prove nothing). */
async function inactiveOffTree(scratch: DatafnStorageAdapter, schema: DatafnSchema, resource: string, record: Record<string, unknown>,
  stateWritten: (resource: string, id: string, field: string) => boolean): Promise<boolean> {
  for (const relation of schema.relations ?? []) {
    if (relation.inheritsInactive !== true || (relation.type !== "many-one" && relation.type !== "one-many")) continue;
    const [dependent, endpoint, fk] = relation.type === "many-one" ? [relation.from, relation.to, relationFkFieldForManyOne(relation)]
      : [relation.to, relation.from, relationFkFieldForOneMany(relation)];
    const parentId = endpointIncludes(dependent, resource) ? record[fk] : undefined;
    const parentResource = typeof parentId === "string" && parentId ? resolveEndpointResource(endpoint, parentId, schema) ?? firstEndpoint(endpoint) : "";
    const parent = parentResource && await scratch.getRecord(parentResource, parentId as string);
    if (parent && STATE_FIELDS.some((field) => inactiveBy(parent, field) && stateWritten(parentResource, parentId as string, field))) return true;
  }
  return false;
}

/** Keys whose replayed value differs from the seed, ancestor inactivity aside. */
function changedKeysOf(seeded: Record<string, unknown>, current: Record<string, unknown>): Set<string> {
  return new Set(
    [...Object.keys(seeded), ...Object.keys(current)]
      .filter((key) => key !== ANCESTOR_INACTIVE_FIELD && !sameValue(seeded[key], current[key])),
  );
}

/**
 * A limited first page keeps its remote rows, order and cursor (local rows
 * would push remote ones past nextCursor). Pending changes are replayed in
 * changelog order by the optimistic writer onto a scratch store seeded with
 * the page and its reported membership, each rejected entry rolled back
 * whole. A row leaves when the replay deletes it, unlinks it or makes a
 * condition false, else shows the fields it changed; a relation page empties
 * when its anchor goes or fails the filters. The cached row is never read.
 */
async function overlayPendingRowsOnLimitedPage(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
  remoteResult: unknown,
): Promise<unknown> {
  const remoteData = queryResultRows(remoteResult);
  if (!remoteData) return remoteResult;
  const changes = await listPendingChanges(storage).catch(() => undefined);
  if (!changes?.length) return remoteResult;

  const queryResource = query.resource as string;
  const isRelationPage = typeof query.relation === "string" && typeof query.id === "string";
  const match = isRelationPage ? findRelationMatch(schema, queryResource, query.relation as string) : undefined;
  if (isRelationPage && !match) return remoteResult;
  const rowResource = (id: string): string | undefined =>
    match ? resolveEndpointResource(relationTargetEndpoint(match.relation, match.direction), id, schema) : queryResource;
  const edgeQuery = { resource: queryResource, id: query.id, relation: query.relation, metadata: query.metadata };

  const scratch = new MemoryStorageAdapter(schema.resources.map((entry) => entry.name));
  const pageRows = new Map<string, PageRow>();
  let anchor: PageRow | undefined;
  let linkedBefore: Set<string> | undefined;
  try {
    for (const row of remoteData) {
      const id = rowIdOf(row);
      const resource = id === undefined ? undefined : rowResource(id);
      if (id === undefined || !resource || !isPlainRecord(row) || pageRows.has(id)) continue;
      const seeded = seedRow(schema, resource, row);
      await scratch.upsertRecord(resource, seeded);
      pageRows.set(id, {
        resource, row, seeded, wholeKeys: new Set(Object.keys(seeded)), rewritten: new Set(),
        knownPaths: returnedPaths(schema, resource, seeded),
      });
    }
    if (pageRows.size === 0) return remoteResult;
    if (match) {
      const seeded = await seedRelationPage(scratch, schema, query, match, pageRows);
      anchor = {
        resource: queryResource, row: seeded, seeded, wholeKeys: new Set(), rewritten: new Set(),
        knownPaths: returnedPaths(schema, queryResource, seeded),
      };
      if (match.relation.type !== "htree") linkedBefore = await pageMemberIds(scratch, schema, edgeQuery);
    }
    for (const [id, page] of pageRows) {
      page.seeded = (await scratch.getRecord(page.resource, id)) ?? page.seeded;
    }
  } catch {
    return remoteResult;
  }

  const tracked = (mutation: Record<string, unknown>): PageRow | undefined => {
    if (anchor && mutation.resource === queryResource && mutation.id === query.id) return anchor;
    const page = typeof mutation.id === "string" ? pageRows.get(mutation.id) : undefined;
    return page?.resource === mutation.resource ? page : undefined;
  };
  const trackedAt = (tree: Endpoint, id: string): PageRow | undefined =>
    [anchor && id === query.id ? anchor : undefined, pageRows.get(id)].find((page) => page && endpointIncludes(tree, page.resource));
  const stateWritten = new Map<string, Set<string>>(); // archived or trashed fields an applied entry decided, by record
  const guessed = new Map<string, string[]>(); // foreign keys a merge-create defaulted, by record
  let relinked = false;
  for (const change of changes) {
    const undo: Array<() => Promise<void>> = [];
    try {
      const target = tracked(change.mutation);
      // A relink's moved records, with the paths held before it.
      const moved = htreeRelinks(schema, change.mutation);
      const prior = await snapshotMovers(scratch, moved ?? [], trackedAt);
      const { resource: written, id: writtenId } = change.mutation;
      const existed = typeof written === "string" && typeof writtenId === "string" && Boolean(await scratch.getRecord(written, writtenId));
      const deleted: string[] = []; // records the entry deletes, cascades included: a later write creates them
      const applied = await replayPendingEntry(journaled(scratch, undo, deleted), schema, change);
      if (target && applied) {
        target.wholeKeys = nextWhole(target.wholeKeys, change.mutation, existed, false);
        target.rewritten = nextWhole(target.rewritten, change.mutation, existed, true);
        if (!existed) target.knownPaths?.clear(); // a recreated record holds no earlier path
        notePathWrites(schema, target, change.mutation, await scratch.getRecord(target.resource, change.mutation.id as string));
      }
      // The server's cascade can rewrite paths below a moved record, and the
      // writer cannot follow it through records the page does not hold.
      if (applied && moved?.length) {
        relinked = true;
        const pages = [...pageRows, ...(anchor ? [[query.id as string, anchor] as [string, PageRow]] : [])];
        const held = new Set(pages.flatMap(([, page]) => [...page.knownPaths?.values() ?? []]));
        for (const [id, pathField, , tree] of moved) trackedAt(tree, id)?.knownPaths?.delete(pathField);
        await noteRelinkedPaths(scratch, moved, trackedAt);
        await forgetRewrittenTails(scratch, pages, moved, held, trackedAt);
        await cascadeMovedPaths(scratch, pages, moved, prior, trackedAt);
      }
      if (applied) noteStateEvidence(stateWritten, guessed, change.mutation, deleted);
      if (applied) await noteGuessedKeys(scratch, schema, guessed, change.mutation, existed);
    } catch {
      // An entry the writer rejects changes nothing on the page.
      for (const step of undo.reverse()) await step().catch(() => undefined);
    }
  }
  if (anchor && !(await anchorStillMatches(scratch, schema, query, anchor))) {
    return Array.isArray(remoteResult) ? [] : { ...(remoteResult as Record<string, unknown>), data: [] };
  }
  const unlinked = new Set<string>();
  if (match?.relation.type === "htree" && anchor) {
    // A returned row's state is the server's; any later state write is in `stateWritten`.
    const backed = (resource: string, id: string, field: string): boolean => Boolean(stateWritten.get(JSON.stringify([resource, id]))?.has(field)) || pageRows.get(id)?.resource === resource;
    for (const id of await htreeRowsGone(scratch, schema, match, query, pageRows, anchor, relinked ? backed : undefined)) unlinked.add(id);
  } else if (linkedBefore) {
    const linkedAfter = await pageMemberIds(scratch, schema, edgeQuery);
    for (const id of linkedBefore) if (linkedAfter && !linkedAfter.has(id)) unlinked.add(id);
  }
  const nestedOmit = nestedOmitOf(schema, query, remoteData, Boolean(match));
  const data: unknown[] = [];
  let changed = false;
  for (const row of remoteData) {
    const id = rowIdOf(row);
    const page = id === undefined ? undefined : pageRows.get(id);
    if (id === undefined || !page || row !== page.row) {
      data.push(row);
      continue;
    }
    let shown: Record<string, unknown> | null = page.row;
    try {
      shown = unlinked.has(id)
        ? null
        : await replayedPageRow(scratch, schema, query, id, page, match?.relation.type, nestedOmit);
    } catch {
      // A row the overlay cannot read stays as the server returned it.
    }
    if (shown !== page.row) changed = true;
    if (shown) data.push(shown);
  }
  if (!changed) return remoteResult;
  return Array.isArray(remoteResult)
    ? data
    : { ...(remoteResult as Record<string, unknown>), data };
}

/**
 * The server reads a relation page through its anchor, queried with the
 * page's filters and metadata: no anchor, or an anchor a pending write makes
 * fail them, is an empty page.
 */
async function anchorStillMatches(
  scratch: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
  anchor: PageRow,
): Promise<boolean> {
  try {
    const current = await scratch.getRecord(anchor.resource, query.id as string);
    if (!current) return false;
    const changedKeys = changedKeysOf(anchor.seeded, current);
    const { undecodable } = decodeChangedKeys(
      schema, anchor.resource, current, changedKeys,
      unwrittenPathKeys(schema, anchor, current),
    );
    const filters = injectLocalCapabilityAutoFilters(
      { resource: anchor.resource, metadata: query.metadata, filters: query.filters },
      schema,
    ).filters;
    return !pendingWritesStopMatch(
      schema, anchor.resource, filters, anchor.seeded, current,
      changedKeys, anchor.wholeKeys, new Set(), undecodable, anchor.rewritten,
    );
  } catch {
    return true;
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
  versionedQueryHooks?: VersionedQueryHooks,
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

  // DATA-41: a versioned query always reads the server, also on a hydrated
  // storage-backed client, and returns the server's rows with their `$rev`.
  const queries = Array.isArray(normalizedQuery) ? normalizedQuery : [normalizedQuery];
  if (queries.some(isVersionedQuery)) {
    // A record written locally after this stamp keeps its newer state.
    const writtenSince = await storage?.revisionWriteStamp?.();
    const response = await runRemoteQuery();
    const raw = unwrapRemoteSuccess<unknown>(response);
    const rawResults = Array.isArray(normalizedQuery) ? (raw as unknown[]) : [raw];
    const finished = await Promise.all(
      queries.map(async (entry, i) => {
        const done = await finishVersionedQueryResult(
          entry, rawResults[i], storage, schema, e2ee, writtenSince, versionedQueryHooks,
        );
        const resource = (entry as { resource?: unknown } | null)?.resource;
        return schema && typeof resource === "string"
          ? parseQueryResultDates(schema, resource, done)
          : done;
      }),
    );
    const result = (Array.isArray(normalizedQuery) ? finished : finished[0]) as T | T[];
    return schema
      ? (runAfterQuery(plugins, schema, normalizedQuery, result) as Promise<T | T[]>)
      : result;
  }

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
