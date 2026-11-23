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
 * Whether the server's projection returns `key` of `resource`: every declared
 * field for no select or `*` (`*#` and `**` on many-many and htree relation
 * pages), a bare token, and for a relation key only the scalar foreign key
 * when the token that wrote it last is bare or `*`. A key the page strips, or
 * a many-one foreign key, is only changed where the server returned it.
 */
function serverProjectsField(
  schema: DatafnSchema,
  query: Record<string, unknown>,
  resource: string,
  key: string,
  remoteRow: Record<string, unknown>,
  relationType: string | undefined,
  stripped: ReadonlySet<string>,
): boolean {
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

const PUSHDOWN_OPS = new Set("eq ne gt gte lt lte in like ilike is_null is_not_null is_not_empty".split(" "));

/**
 * Whether classifyQuery certainly gives a plain list FULL_PUSHDOWN (top-level
 * omit only): no search, grouping, temporal, relation or nested select token,
 * `$or`, dotted, relation or quantified key, operator the filter compiler cannot
 * push (`$is_not_empty` on scalar fields only), object operand (whose `in` lists the
 * planner counts), over 30,000 `$in` values or private shareable resource (access filter).
 */
function serverPushesDown(schema: DatafnSchema, query: Record<string, unknown>): boolean {
  const resource = String(query.resource);
  const resourceSchema = schema.resources.find((entry) => entry.name === resource);
  if (!resourceSchema || "temporal" in query || query.search || query.groupBy || query.having) return false;
  if (resolveCapabilities(schema.capabilities as any, resourceSchema.capabilities as any)
    .some((entry) => isPlainRecord(entry) && (entry.shareable as any)?.default === "private")) return false;
  if (stringTokens(query.select).some((token) => token !== "*"
    && (token.includes(".") || findRelationMatch(schema, resource, token.replace(/[*#]+$/, ""))))) return false;
  let values = 0;
  const pushes = (filter: unknown): boolean => isPlainRecord(filter) && Object.entries(filter).every(([key, value]) => {
    if (key === "$and") return Array.isArray(value) && value.every(pushes);
    if (key.startsWith("$") || key.includes(".") || findRelationMatch(schema, resource, key)) return false;
    const ops = Array.isArray(value) ? { in: value } : isPlainRecord(value) ? value : { eq: value };
    const scalar = /^(string|number|boolean)$/.test(String(declaredFields(schema, resource).fields.get(key)?.type));
    return Object.entries(ops).every(([op, operand]) => {
      if (Array.isArray(operand)) values += operand.length;
      const name = op.replace(/^\$/, "");
      return !isPlainRecord(operand) && PUSHDOWN_OPS.has(name) && (scalar || name !== "is_not_empty");
    });
  });
  return (query.filters === undefined || query.filters === null || pushes(query.filters)) && values <= 30_000;
}

/**
 * Keys materializeSelect's final omit pass strips at every depth: the query's
 * omit plus the row resource's auto-omitted keys its select does not name
 * and, on a relation page, the anchor's own pass (its select is
 * `<relation>.<token>`). A FULL_PUSHDOWN list keeps nested keys.
 */
function serverStrippedKeys(
  schema: DatafnSchema,
  query: Record<string, unknown>,
  resource: string,
  relationType: string | undefined,
): Set<string> {
  const named = stringTokens(query.select).map((token) => token.split(".")[0]);
  const keys = new Set(stringTokens(query.omit));
  for (const key of serverOmittedForeignKeys(schema, resource)) if (!named.includes(key)) keys.add(key);
  if (!relationType) return keys;
  for (const key of serverOmittedForeignKeys(schema, String(query.resource))) if (key !== query.relation) keys.add(key);
  return keys;
}

/** The page row as a store row (dates encoded as stored). */
function seedRow(
  schema: DatafnSchema,
  resource: string,
  remoteRow: Record<string, unknown>,
): Record<string, unknown> {
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
    if (key === "$and" && Array.isArray(value)) {
      for (const sub of value) conjuncts.push(...filterConjuncts(sub));
    } else {
      conjuncts.push({ [key]: value });
    }
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
  if (
    rest.length === 1 && rest[0] === "id"
    && match.relation.type === "many-one" && match.direction === "forward"
  ) {
    return [relationFkFieldForManyOne(match.relation)];
  }
  return undefined;
}

/** Whether a filter reads a top-level field in `keys`. */
function filterReads(
  schema: DatafnSchema,
  resource: string,
  filter: unknown,
  keys: ReadonlySet<string>,
): boolean {
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
function judgeFilter(
  schema: DatafnSchema,
  resource: string,
  filter: unknown,
  current: Record<string, unknown>,
  known: (path: readonly string[]) => boolean,
): Truth {
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
function writtenPathKnown(
  current: Record<string, unknown>,
  path: readonly string[],
  whole: boolean,
  hidden: ReadonlySet<unknown>,
  rewritten: WholeKeys,
): boolean {
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
function pendingWritesStopMatch(
  schema: DatafnSchema,
  resource: string,
  filters: unknown,
  seeded: Record<string, unknown>,
  current: Record<string, unknown>,
  changedKeys: ReadonlySet<string>,
  wholeKeys: WholeKeys,
  hidden: ReadonlySet<unknown>,
  unknownKeys: ReadonlySet<string> = new Set(),
  rewritten: WholeKeys = new Set(),
): boolean {
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
function decodeChangedKeys(
  schema: DatafnSchema,
  resource: string,
  current: Record<string, unknown>,
  changedKeys: ReadonlySet<string>,
  unproven: ReadonlySet<string>,
): { patch: Record<string, unknown>; undecodable: Set<string> } {
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
 * The page row after the replay, or null when it leaves the page. A relation
 * page's filters are its anchor's, so targets meet only capability auto-filters.
 */
async function replayedPageRow(
  scratch: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
  id: string,
  page: PageRow,
  relationType: string | undefined,
  chains: ReadonlySet<string>,
): Promise<Record<string, unknown> | null> {
  const current = await scratch.getRecord(page.resource, id);
  if (!current) return null;
  const unproven = await unprovenPathKeys(scratch, schema, page, current, chains);
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
  const pushdown = !relationType && serverPushesDown(schema, query);
  for (const key of shownKeys) {
    if (undecodable.has(key)) continue;
    if (key in decoded) shown[key] = pushdown ? decoded[key] : applyServerOmit(decoded[key], stripped);
    else delete shown[key];
  }
  return shown;
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
function serverReplacedRecord(
  fields: ReadonlyMap<string, DatafnFieldSchema>,
  system: ReadonlySet<string>,
  before: Record<string, unknown>,
  written: Record<string, unknown>,
  record: Record<string, unknown>,
): Record<string, unknown> {
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
async function replayPendingEntry(
  scratch: DatafnStorageAdapter,
  schema: DatafnSchema,
  change: DatafnChangelogEntry,
): Promise<boolean> {
  const { mutation } = change;
  const { resource, id, operation } = mutation;
  if (mutation.relations !== undefined) {
    if (!isPlainRecord(mutation.relations)) return false;
    for (const payload of Object.values(mutation.relations)) normalizeRelationPayload(payload);
  }
  const before = typeof resource === "string" && typeof id === "string"
    ? await scratch.getRecord(resource, id)
    : null;
  if (STATE_OPERATIONS.has(operation as string) && !before) return false;
  await applyOptimisticMutationToStorage(
    scratch,
    schema,
    mutation,
    change.timestampMs,
    change.actorId ?? change.clientId,
  );
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
  /** Htree paths a pending merge, replace or insert wrote explicitly. */
  explicitPaths?: Map<string, unknown>;
};

/** The scratch store, journaling record and join-row writes so a rejected entry is undone whole. */
function journaled(
  scratch: MemoryStorageAdapter,
  undo: Array<() => Promise<void>>,
): DatafnStorageAdapter {
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
    deleteRecord: (resource: string, id: string) => saveRecord(resource, id),
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

/**
 * Htree paths a pending merge, replace or insert of a tracked row sets as
 * given; a relate or unrelate leaves the writer to rebuild them.
 */
function notePathWrites(schema: DatafnSchema, target: PageRow, mutation: Record<string, unknown>): void {
  for (const pathField of htreePathFields(schema, target.resource)) {
    if (["merge", "replace", "insert"].includes(mutation.operation as string)) {
      const record = isPlainRecord(mutation.record) ? mutation.record : {};
      if (pathField in record) (target.explicitPaths ??= new Map()).set(pathField, record[pathField]);
    } else if (mutation.operation === "relate" || mutation.operation === "unrelate") {
      target.explicitPaths?.delete(pathField);
    }
  }
}

/**
 * What a pending entry writes whole: top-level keys, or (`members`) JSON
 * segment tuples, since a key may hold a dot, with a merge setting an
 * object's members one level deep; `true` for all.
 */
function nextWhole(
  whole: WholeKeys,
  mutation: Record<string, unknown>,
  existed: boolean,
  members: boolean,
): WholeKeys {
  if (!existed || mutation.operation === "insert" || mutation.operation === "replace") return true;
  if (whole === true || mutation.operation !== "merge" || !isPlainRecord(mutation.record)) return whole;
  const next = new Set(whole);
  for (const [key, value] of Object.entries(mutation.record)) {
    if (!isPlainRecord(value)) next.add(members ? JSON.stringify([key]) : key);
    else if (members) for (const member of Object.keys(value)) next.add(JSON.stringify([key, member]));
  }
  return next;
}

function htreePathField(relation: { pathField?: string }): string {
  return relation.pathField || "parentPath";
}

/** A path no record matches: ancestry the page does not show. */
const UNKNOWN_HTREE_PATH = "\u0000unknown";

/** Path fields of the htree relations whose tree holds `resource`. */
function htreePathFields(schema: DatafnSchema, resource: string): string[] {
  return (schema.relations ?? [])
    .filter((relation) => relation.type === "htree" && endpointIncludes(relation.from, resource))
    .map(htreePathField);
}

function joinPath(path: string, id: string): string {
  return path ? `${path}-${id}` : id;
}

/** Whether `path` lists `id` (ids may themselves contain the separator). */
function pathLists(path: string, id: string): boolean {
  return `-${path}-`.includes(`-${id}-`);
}

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
function pathExtends(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}-`);
}

/**
 * Whether an htree path value is real: cleared or empty (written as given),
 * or extending a known chain (a returned path, or a root the scratch store
 * holds). The writer builds a path on an off-page parent as if it were a
 * root; one through a row whose path was not returned holds UNKNOWN_HTREE_PATH.
 */
async function provenHtreePath(
  scratch: DatafnStorageAdapter,
  resource: string,
  pathField: string,
  value: unknown,
  chains: ReadonlySet<string>,
): Promise<boolean> {
  if (typeof value !== "string") return true;
  if (value.includes(UNKNOWN_HTREE_PATH)) return false;
  if (value === "" || [...chains].some((chain) => pathExtends(value, chain))) return true;
  return (await scratch.listRecords(resource)).some((record) =>
    record[pathField] === "" && typeof record.id === "string" && pathExtends(value, record.id));
}

/** Htree path fields of a replayed record whose value is not proven. */
async function unprovenPathKeys(
  scratch: DatafnStorageAdapter,
  schema: DatafnSchema,
  page: PageRow,
  current: Record<string, unknown>,
  chains: ReadonlySet<string>,
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const pathField of htreePathFields(schema, page.resource)) {
    const explicit = page.explicitPaths?.has(pathField) && sameValue(page.explicitPaths.get(pathField), current[pathField]);
    if (!explicit && !(await provenHtreePath(scratch, page.resource, pathField, current[pathField], chains))) {
      keys.add(pathField);
    }
  }
  return keys;
}

/**
 * Seed a relation page's reported membership in the writer's form: for htree,
 * the anchor path the returned paths prove (an ancestor page's deepest chain,
 * unknown-tailed when truncated; a children page's agreed prefix), else
 * unknown; otherwise one relate of every row onto the anchor.
 */
async function seedRelationPage(
  scratch: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
  match: NonNullable<ReturnType<typeof findRelationMatch>>,
  pageRows: ReadonlyMap<string, PageRow>,
  truncated: boolean,
): Promise<Record<string, unknown>> {
  const resource = query.resource as string;
  const anchorId = query.id as string;
  if (match.relation.type === "htree") {
    const pathField = htreePathField(match.relation);
    const returned = [...pageRows].flatMap(([id, page]) =>
      typeof page.row[pathField] === "string" ? [{ id, path: page.row[pathField] as string }] : []);
    let anchorPath = UNKNOWN_HTREE_PATH;
    if (match.direction === "inverse") {
      const deepest = [...returned].sort((left, right) => right.path.length - left.path.length)[0];
      const chain = deepest ? joinPath(deepest.path, deepest.id) : undefined;
      if (chain && returned.every(({ id }) => pathLists(chain, id))) {
        anchorPath = returned.length === pageRows.size && !truncated ? chain : `${chain}-${UNKNOWN_HTREE_PATH}`;
      }
    } else {
      // Every returned path is the anchor's child prefix (or, with `**`, lies
      // below it); ids may hold the separator, so use only an agreed prefix.
      const deep = stringTokens(query.select).filter((token) => token === "*" || token === "**").at(-1) === "**";
      const prefixes = returned.length === 0 ? [] : anchorPrefixes(returned[0].path, anchorId)
        .filter((prefix) => returned.every(({ path }) => deep ? pathExtends(path, prefix) : path === prefix));
      if (prefixes.length === 1) {
        anchorPath = prefixes[0] === anchorId ? "" : prefixes[0].slice(0, prefixes[0].length - anchorId.length - 1);
      }
    }
    const anchor = { id: anchorId, [pathField]: anchorPath };
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
 * Rows of an htree relation page the replay proves gone, judged by path as
 * the server does. An ancestor page lists the anchor's known path (none once
 * a write clears it); a row it placed there leaves when that path no longer
 * lists it. Children pages (descendants when the last of `*` and `**` is
 * `**`) follow htreeMayHold; an inheriting one drops a row the replay marks
 * ancestor-inactive (only a record it holds can).
 */
async function htreeRowsGone(
  scratch: DatafnStorageAdapter,
  match: NonNullable<ReturnType<typeof findRelationMatch>>,
  query: Record<string, unknown>,
  pageRows: ReadonlyMap<string, PageRow>,
  anchor: PageRow,
  chains: ReadonlySet<string>,
): Promise<Set<string>> {
  const gone = new Set<string>();
  const resource = query.resource as string;
  const anchorId = query.id as string;
  const pathField = htreePathField(match.relation);
  const anchorRecord = await scratch.getRecord(resource, anchorId);
  const anchorPath = anchorRecord?.[pathField];
  // The seed's path is the prefix the returned paths agree on.
  const anchorProven = typeof anchorPath === "string"
    && ((anchor.explicitPaths?.has(pathField) && anchor.explicitPaths.get(pathField) === anchorPath)
      || (anchorPath === anchor.seeded[pathField] && !anchorPath.includes(UNKNOWN_HTREE_PATH))
      || (await provenHtreePath(scratch, resource, pathField, anchorPath, chains)));
  if (match.direction === "inverse") {
    // The seed holds a string path, so a missing one is a write's clear.
    if (anchorRecord && (anchorPath === null || anchorPath === undefined)) return new Set(pageRows.keys());
    if (typeof anchorPath !== "string") return gone;
    const cut = anchorPath.indexOf(UNKNOWN_HTREE_PATH);
    const known = cut < 0 ? anchorPath : anchorPath.slice(0, Math.max(cut - 1, 0));
    if (cut === 0 || !(cut < 0 ? anchorProven : await provenHtreePath(scratch, resource, pathField, known, chains))) {
      return gone;
    }
    for (const [id, page] of pageRows) {
      if (!pathLists(known, id) && (cut < 0 || typeof page.row[pathField] === "string")) gone.add(id);
    }
    return gone;
  }
  const wildcardOnly = !Array.isArray(query.select)
    || query.select.every((token) => token === "*" || token === "**");
  if (anchorRecord && wildcardOnly && (anchorPath === null || anchorPath === undefined)) {
    return new Set(pageRows.keys());
  }
  const metadata = isPlainRecord(query.metadata) ? query.metadata : {};
  const inheriting = match.relation.inheritsInactive === true && metadata.includeAncestorInactive !== true;
  const deep = stringTokens(query.select).filter((token) => token === "*" || token === "**").at(-1) === "**";
  const prefix = anchorProven ? joinPath(anchorPath, anchorId) : undefined;
  const anchorChild = joinPath(String(anchorPath ?? ""), anchorId);
  for (const [id, page] of pageRows) {
    const current = await scratch.getRecord(page.resource, id);
    if (!current) continue;
    if (inheriting && page.seeded[ANCESTOR_INACTIVE_FIELD] !== true && current[ANCESTOR_INACTIVE_FIELD] === true) {
      gone.add(id);
      continue;
    }
    const path = current[pathField];
    // An unknown, unknown-tailed or malformed path decides nothing.
    if (typeof path === "string" ? path.endsWith(UNKNOWN_HTREE_PATH) : path !== null && path !== undefined) continue;
    const explicit = page.explicitPaths?.has(pathField) && sameValue(page.explicitPaths.get(pathField), path);
    // The writer rebuilds a path on the scratch path of the record it hangs the
    // row under: a rebuilt child extends the anchor's, or, built on an off-page
    // record, is a tail its unknown ancestry can complete to the known prefix.
    if (!deep && !explicit && !sameValue(path, page.seeded[pathField])) {
      const tail = prefix !== undefined && typeof path === "string"
        && !(await provenHtreePath(scratch, page.resource, pathField, path, chains));
      if (tail ? prefix !== path && !prefix.endsWith(`-${path}`) : path !== anchorChild) gone.add(id);
    } else if (explicit || (await provenHtreePath(scratch, page.resource, pathField, path, chains))) {
      if (!htreeMayHold(String(path ?? ""), anchorId, deep, prefix)) gone.add(id);
    }
  }
  return gone;
}

/**
 * Whether the server, comparing whole paths, can still list a row whose
 * known path is `path` on the anchor's children page (`deep`: anywhere below
 * it); `prefix` is the anchor's child path when its own path is proven.
 */
function htreeMayHold(path: string, anchor: string, deep: boolean, prefix?: string): boolean {
  if (deep) return prefix === undefined ? pathLists(path, anchor) : pathExtends(path, prefix);
  return prefix === undefined ? path === anchor || path.endsWith(`-${anchor}`) : path === prefix;
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
  const edgeQuery = { resource: queryResource, id: query.id, relation: query.relation, metadata: query.metadata };

  const scratch = new MemoryStorageAdapter(schema.resources.map((entry) => entry.name));
  const pageRows = new Map<string, PageRow>();
  const chains = new Set<string>();
  let anchor: PageRow | undefined;
  let linkedBefore: Set<string> | undefined;
  try {
    for (const row of remoteData) {
      const id = rowIdOf(row);
      const resource = id === undefined ? undefined : rowResource(id);
      if (id === undefined || !resource || !isPlainRecord(row) || pageRows.has(id)) continue;
      const seeded = seedRow(schema, resource, row);
      for (const pathField of htreePathFields(schema, resource)) {
        if (typeof seeded[pathField] === "string") {
          // The server's path, and the row's own chain, are real.
          if (seeded[pathField]) chains.add(seeded[pathField] as string);
          chains.add(joinPath(seeded[pathField] as string, id));
        } else {
          seeded[pathField] = UNKNOWN_HTREE_PATH;
        }
      }
      await scratch.upsertRecord(resource, seeded);
      pageRows.set(id, { resource, row, seeded, wholeKeys: new Set(Object.keys(seeded)), rewritten: new Set() });
    }
    if (pageRows.size === 0) return remoteResult;
    if (match) {
      const truncated = typeof query.limit === "number" && remoteData.length >= query.limit;
      const seeded = await seedRelationPage(scratch, schema, query, match, pageRows, truncated);
      anchor = { resource: queryResource, row: seeded, seeded, wholeKeys: new Set(), rewritten: new Set() };
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
  for (const change of changes) {
    const undo: Array<() => Promise<void>> = [];
    try {
      const target = tracked(change.mutation);
      const existed = target
        ? Boolean(await scratch.getRecord(target.resource, change.mutation.id as string))
        : false;
      const applied = await replayPendingEntry(journaled(scratch, undo), schema, change);
      if (target && applied) {
        target.wholeKeys = nextWhole(target.wholeKeys, change.mutation, existed, false);
        target.rewritten = nextWhole(target.rewritten, change.mutation, existed, true);
        notePathWrites(schema, target, change.mutation);
      }
    } catch {
      // An entry the writer rejects changes nothing on the page.
      for (const step of undo.reverse()) await step().catch(() => undefined);
    }
  }
  if (anchor && !(await anchorStillMatches(scratch, schema, query, anchor, chains))) {
    return Array.isArray(remoteResult) ? [] : { ...(remoteResult as Record<string, unknown>), data: [] };
  }
  const unlinked = new Set<string>();
  if (match?.relation.type === "htree" && anchor) {
    for (const id of await htreeRowsGone(scratch, match, query, pageRows, anchor, chains)) unlinked.add(id);
  } else if (linkedBefore) {
    const linkedAfter = await pageMemberIds(scratch, schema, edgeQuery);
    for (const id of linkedBefore) if (linkedAfter && !linkedAfter.has(id)) unlinked.add(id);
  }
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
        : await replayedPageRow(scratch, schema, query, id, page, match?.relation.type, chains);
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
  chains: ReadonlySet<string>,
): Promise<boolean> {
  try {
    const current = await scratch.getRecord(anchor.resource, query.id as string);
    if (!current) return false;
    const changedKeys = changedKeysOf(anchor.seeded, current);
    const { undecodable } = decodeChangedKeys(
      schema, anchor.resource, current, changedKeys,
      await unprovenPathKeys(scratch, schema, anchor, current, chains),
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
