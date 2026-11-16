/**
 * Temporal range push-down.
 *
 * A DFQL `temporal` clause with a `period` or `range` is a plain bound on one
 * field: the in-memory evaluator turns it into `{ field: { $gte, $lte } }`
 * through `normalizeTemporalQuery`. Doing that conversion before the query
 * runs lets the IN_MEMORY pre-filter push the bounds, so the database returns
 * only the rows in range instead of the whole table. Temporal queries keep
 * the in-memory execution path (sorting, pagination, projection), so only the
 * set of rows loaded changes. The bounds come from the same core function, with the same
 * timezone resolution, so a lowered query matches exactly what in-memory
 * evaluation of the original clause would return.
 *
 * A clause is lowered only when the database compares the bound the way the
 * in-memory evaluator does: numeric bounds (`unix-ms` / `unix-s` storage) on a
 * field that always holds numbers (a declared, unencrypted `number` field or a
 * capability `date` field such as `createdAt`, which DataFn writes as epoch
 * milliseconds). Any other clause stays in `temporal` and is evaluated in
 * memory, unchanged. Temporal `groupBy` always runs in memory, over the rows
 * the lowered range bounds already narrowed.
 */

import type { Adapter } from "@superfunctions/db";
import {
  TIMEZONE_CHANGE_RESOURCE_NAME,
  createTimezoneResolver,
  getCapabilityFields,
  getTemporalClauses,
  normalizeTemporalQuery,
  resolveCapabilities,
  type DatafnTemporalClause,
  type DatafnTemporalConfig,
} from "@datafn/core";
import type { DatafnSchema } from "../../core-types.js";
import type { DatafnLogger } from "../../logger.js";

export interface TemporalQueryPlan {
  /** The query with every lowerable period/range clause turned into filters. */
  query: Record<string, unknown>;
  /** Temporal config for in-memory evaluation; undefined when the query has no temporal clauses. */
  config?: DatafnTemporalConfig;
  /** Fields whose period/range bounds were turned into filters. */
  lowered: string[];
}

/**
 * Whether a clause resolves its timezone through the timezone-change history.
 * Core consults the resolver only for "user" or an empty timezone; an omitted
 * timezone falls back to the configured default (UTC on the server).
 */
function usesTimezoneHistory(clause: DatafnTemporalClause): boolean {
  return typeof clause.timezone === "string" && (clause.timezone === "" || clause.timezone === "user");
}

/**
 * Temporal config for a query's clauses. The timezone-change history is read
 * from the namespace only when a clause resolves its timezone through it.
 */
export async function loadTemporalConfig(
  db: Adapter,
  namespace: string,
  clauses: readonly DatafnTemporalClause[],
  logger?: DatafnLogger,
): Promise<DatafnTemporalConfig> {
  if (!clauses.some(usesTimezoneHistory)) {
    return { timezoneResolver: createTimezoneResolver([]) };
  }
  // Without a readable history (e.g. a database without the built-in table),
  // "user" falls back to UTC, as it did before the history was read here.
  const changes = await db
    .findMany({ model: TIMEZONE_CHANGE_RESOURCE_NAME, where: [], namespace })
    .catch((error: unknown) => {
      logger?.warn("Timezone-change history unavailable; temporal \"user\" resolves to UTC", {
        error: String(error),
        operation: "temporal-timezone-history",
      });
      return [];
    });
  return { timezoneResolver: createTimezoneResolver(changes as Record<string, unknown>[]) };
}

/**
 * Whether the database compares numeric bounds on `field` exactly as the
 * in-memory evaluator does.
 */
function holdsNumbers(schema: DatafnSchema, resourceName: string, field: string): boolean {
  if (field.includes(".")) return false;
  const resource = schema.resources.find((r) => r.name === resourceName);
  if (!resource) return false;
  // Capability fields are copied into `resource.fields` by schema validation,
  // so look them up first: their `date` fields always hold epoch milliseconds.
  const capabilityFields = getCapabilityFields(
    resolveCapabilities(schema.capabilities as any, resource.capabilities as any) as any,
  ) as Array<{ name: string; type: string }>;
  const injected = capabilityFields.find((f) => f.name === field);
  if (injected) return injected.type === "date" || injected.type === "number";
  const declared = resource.fields.find((f) => f.name === field);
  return declared?.type === "number" && declared.encrypt !== true;
}

/**
 * The `$gte`/`$lte` filter the in-memory evaluator would apply for a
 * period/range clause, or undefined when the database cannot apply it with
 * identical results.
 */
function lowerRangeClause(
  clause: DatafnTemporalClause,
  resource: string,
  schema: DatafnSchema,
  config: DatafnTemporalConfig,
): Record<string, unknown> | undefined {
  const storage = clause.storage ?? "unix-ms";
  if (storage !== "unix-ms" && storage !== "unix-s") return undefined;
  if (!holdsNumbers(schema, resource, clause.field)) return undefined;

  const { groupBy: _groupBy, ...rangeOnly } = clause;
  const normalized = normalizeTemporalQuery(
    { resource, temporal: rangeOnly } as Record<string, unknown>,
    config,
  );
  const filters = normalized.filters as Record<string, unknown> | undefined;
  const bounds = filters?.[clause.field] as { $gte?: unknown; $lte?: unknown } | undefined;
  if (!bounds || Object.keys(filters!).length !== 1) return undefined;
  const { $gte: start, $lte: end } = bounds;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  // In memory, `null >= start && null <= end` holds when the range contains
  // 0 (null compares as 0); SQL never matches NULL, so such a range stays in
  // memory.
  if (start <= 0 && end >= 0) return undefined;
  return filters;
}

function mergeFilters(
  filters: unknown,
  generated: Record<string, unknown>[],
): Record<string, unknown> {
  const existing =
    typeof filters === "object" && filters !== null && !Array.isArray(filters)
      ? (filters as Record<string, unknown>)
      : undefined;
  if (!existing || Object.keys(existing).length === 0) {
    return generated.length === 1 ? generated[0] : { $and: generated };
  }
  // Keep the existing keys at the top level: the pre-filter pushes them key
  // by key, but would push an `$and` entry only if all of it were pushable.
  const existingAnd = Array.isArray(existing.$and) ? (existing.$and as unknown[]) : [];
  return { ...existing, $and: [...existingAnd, ...generated] };
}

/**
 * Turn the query's lowerable period/range clauses into field filters.
 * Clauses that cannot be lowered, and every temporal groupBy, stay in
 * `temporal` for in-memory evaluation.
 */
export function lowerTemporalRanges(
  query: Record<string, unknown>,
  schema: DatafnSchema,
  config: DatafnTemporalConfig,
): { query: Record<string, unknown>; lowered: string[] } {
  const clauses = getTemporalClauses(query);
  const resource = query.resource;
  if (clauses.length === 0 || typeof resource !== "string") {
    return { query, lowered: [] };
  }

  const generated: Record<string, unknown>[] = [];
  const retained: DatafnTemporalClause[] = [];
  const lowered: string[] = [];
  for (const clause of clauses) {
    if (!clause.period && !clause.range) {
      retained.push(clause);
      continue;
    }
    const filter = lowerRangeClause(clause, resource, schema, config);
    if (!filter) {
      retained.push(clause);
      continue;
    }
    generated.push(filter);
    lowered.push(clause.field);
    if (clause.groupBy) {
      // The bound is now a filter; keep only the grouping. Dropping the
      // period also keeps a period without `at` from being resolved again
      // against a later clock.
      const { period: _period, range: _range, ...grouping } = clause;
      retained.push(grouping);
    }
  }

  if (generated.length === 0) {
    return { query, lowered };
  }

  const next: Record<string, unknown> = {
    ...query,
    filters: mergeFilters(query.filters, generated),
  };
  if (retained.length > 0) {
    next.temporal = retained.length === 1 ? retained[0] : retained;
  } else {
    delete next.temporal;
  }
  return { query: next, lowered };
}

/**
 * Resolve the query's temporal config and lower its period/range clauses.
 * Queries without temporal clauses are returned unchanged and read nothing.
 */
export async function planTemporalQuery(
  query: Record<string, unknown>,
  schema: DatafnSchema,
  db: Adapter,
  timezoneNamespace: string,
  logger?: DatafnLogger,
): Promise<TemporalQueryPlan> {
  const clauses = getTemporalClauses(query);
  if (clauses.length === 0) {
    return { query, lowered: [] };
  }
  const config = await loadTemporalConfig(db, timezoneNamespace, clauses, logger);
  const { query: lowered, lowered: fields } = lowerTemporalRanges(query, schema, config);
  return { query: lowered, config, lowered: fields };
}
