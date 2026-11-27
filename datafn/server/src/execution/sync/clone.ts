/**
 * Clone implementation - full data sync with change tracking
 */

import type { DatafnErrorCode, DatafnRelationSchema, DatafnSchema } from "../../core-types.js";
import { getJoinStoreKey, getRelationJoinTableName } from "@datafn/core";
import type { Adapter, WhereClause } from "@superfunctions/db";
import type { SequenceStore } from "./sequence-store.js";
import { ChangeTrackingService } from "./change-tracking.js";
import {
  isRevisionCertified,
  issuesRevisions,
  readWithRevisionsOrPlain,
  withoutUncertifiedRevision,
} from "../revisions.js";
import type { DatafnLogger } from "../../logger.js";
import {
  canReadEveryField,
  withoutUnreadableFields,
  isNamespaceOwnerActor,
  isPrivateShareableResource,
  resolveAccessLevel,
} from "../../validation/authz.js";
import { resourceIdMatches } from "./resource-id.js";

export interface CloneRequest {
  clientId: string;
  tables?: string[]; // Optional: specific tables to clone
  page?: {
    table: string;
    afterId: string | null;
    limit: number;
  };
  includeJoins?: boolean;
  actorId?: string;
}

export interface CloneResult {
  ok: boolean;
  data: Record<string, Array<Record<string, unknown>>>;
  cursors: Record<string, string>;
  joins?: Record<string, Array<Record<string, unknown>>>;
  next?: Record<string, string | null>;
  /** SCA-002: true when auto-pagination was triggered because total > maxCloneRecords */
  paginated?: boolean;
  error?: {
    code: DatafnErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** An access check on a join row's endpoint failed; the clone must fail too. */
class JoinVisibilityError extends Error {
  constructor(readonly reason: unknown) {
    super("Clone: join endpoint access check failed");
  }
}

/**
 * Ids per `in` lookup when loading the join rows of returned records. Kept
 * under D1's 100 bound parameters per query, leaving room for the namespace.
 */
const JOIN_LOOKUP_CHUNK = 90;

/**
 * Most id lookup queries one page may spend on join rows. A page needing more
 * (large pages, many relations) reads each join table once and filters it,
 * so the queries per request stay bounded (D1 limits queries per invocation).
 */
const JOIN_LOOKUP_BUDGET = 16;

/**
 * Execute clone operation - return full dataset with cursors
 */
export async function executeClone(
  request: CloneRequest,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  sequenceStore?: SequenceStore,
  maxCloneRecords: number = 10_000,
  logger?: DatafnLogger,
): Promise<CloneResult> {
  // Validate clientId
  if (!request.clientId || typeof request.clientId !== "string") {
    return {
      ok: false,
      data: {},
      cursors: {},
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: clientId must be string",
        details: { path: "clientId" },
      },
    };
  }

  const data: Record<string, Array<Record<string, unknown>>> = {};
  const cursors: Record<string, string> = {};
  const next: Record<string, string | null> = {};
  let joins: Record<string, Array<Record<string, unknown>>> | undefined;
  let cappedClone = false;
  // Tables whose every row was read and filtered for this actor, so a record
  // missing from the result is hidden from (or absent for) the actor.
  const fullyLoadedTables = new Set<string>();
  // Access decisions made while filtering rows (visible and hidden), reused
  // when checking join endpoints so no record is resolved twice.
  const accessDecisions = new Map<string, boolean>();
  const accessKey = (resource: string, id: string) => `${resource}\u0000${id}`;
  // Tables whose count failed (read as 0), so a full read may still be cut.
  const countFailedTables = new Set<string>();

  // Determine which tables to clone
  const tablesToClone = request.tables || schema.resources.map((r) => r.name);
  const actorId = request.actorId;

  const filterActorVisibleRows = async (
    resource: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> => {
    if (!isPrivateShareableResource(schema, resource)) {
      return rows;
    }
    if (!actorId) {
      return [];
    }
    // The namespace owner sees every row; skip the per-row access lookup.
    if (isNamespaceOwnerActor(actorId, namespace)) {
      return rows;
    }
    const visible: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const recordId = typeof row.id === "string" ? row.id : null;
      if (!recordId) {
        continue;
      }
      const level = await resolveAccessLevel(
        db,
        schema,
        resource,
        recordId,
        actorId,
        namespace,
      );
      if (level) {
        visible.push(row);
      }
      accessDecisions.set(accessKey(resource, recordId), !!level);
    }
    return visible;
  };

  // Check for isRemoteOnly tables
  for (const tableName of tablesToClone) {
    const resource = schema.resources.find((r) => r.name === tableName);

    if (!resource) {
      return {
        ok: false,
        data: {},
        cursors: {},
        error: {
          code: "DFQL_UNKNOWN_RESOURCE",
          message: `Unknown resource: ${tableName}`,
          details: { path: "tables" },
        },
      };
    }

    // Check for isRemoteOnly flag
    if ((resource as any).isRemoteOnly) {
      return {
        ok: false,
        data: {},
        cursors: {},
        error: {
          code: "DFQL_INVALID",
          message: `Invalid DFQL: remote-only table cannot be cloned: ${tableName}`,
          details: { path: "tables" },
        },
      };
    }
  }

  // Create change tracking service with user/tenant namespace and optional sequence store
  const changeTracking = new ChangeTrackingService(db, namespace, sequenceStore);

  /**
   * DATA-41: reads a table's rows and, when revisions are on, their revisions
   * in one snapshot, attaching each row's revision as `$rev`. Revisions are
   * optional: if their setup or read fails, the rows are read again without
   * them, so only a failure of the row read reaches the catch below. A stored
   * `$rev` the server did not pair with its row is not returned, and a row
   * the caller may not read in full gets none.
   */
  const readCloneRows = async (
    table: string,
    read: (readDb: Adapter) => Promise<Array<Record<string, unknown>>>,
  ): Promise<Array<Record<string, unknown>>> => {
    if (!issuesRevisions(schema, table)) return read(db);
    // A row the caller may not read in full gets no revision, and its
    // unreadable fields are withheld as pull withholds them (in every clone
    // mode, the plain fallback included).
    const rows = await readWithRevisionsOrPlain(db, namespace, table, read, () => read(db), (r) => r, (row) =>
      canReadEveryField(schema, table, row),
    );
    return rows.map((row) => {
      const returned = withoutUncertifiedRevision(row);
      if (isRevisionCertified(returned) || canReadEveryField(schema, table, returned)) return returned;
      return withoutUnreadableFields(schema, table, returned);
    });
  };

  // Handle paginated clone if page parameter is provided
  if (request.page) {
    const { table, afterId, limit } = request.page;

    // Validate page table is in requested tables
    if (!tablesToClone.includes(table)) {
      return {
        ok: false,
        data: {},
        cursors: {},
        error: {
          code: "DFQL_INVALID",
          message: `Invalid DFQL: page.table must be in tables list: ${table}`,
          details: { path: "page.table" },
        },
      };
    }

    // Enforce maximum page size (default 1000)
    const effectiveLimit = Math.min(limit, 1000);

    try {
      // The cursor is read before the rows: a write landing between the two
      // is then replayed by the next pull instead of being skipped.
      const latestSeq = await changeTracking.getLatestServerSeq({
        resource: table,
      });

      // Build where clause for afterId pagination
      const where: WhereClause[] = afterId
        ? [{ field: "id", operator: "gt", value: afterId }]
        : [];

      const records = await readCloneRows(table, (readDb) =>
        readDb.findMany({
          model: table,
          where,
          orderBy: [{ field: "id", direction: "asc" }],
          limit: effectiveLimit,
          namespace,
        }),
      );
      data[table] = await filterActorVisibleRows(table, records);

      // Compute next marker
      if (records.length === effectiveLimit) {
        // More pages exist
        const lastRecord = records[records.length - 1];
        next[table] = lastRecord.id as string;
      } else {
        // This was the last page
        next[table] = null;
      }

      cursors[table] = String(latestSeq);
    } catch (error) {
      logger?.warn("Clone: paginated fetch failed", { error: String(error), resource: table, operation: "clone-paginate" });
      // On adapter error, return empty data for this table
      data[table] = [];
      cursors[table] = "0";
      next[table] = null;
    }

    // For paginated clone of other tables in the list (if any), return empty arrays
    for (const tableName of tablesToClone) {
      if (tableName !== table && !data[tableName]) {
        data[tableName] = [];
        const latestSeq = await changeTracking.getLatestServerSeq({
          resource: tableName,
        });
        cursors[tableName] = String(latestSeq);
      }
    }
  } else {
    // SCA-002: Count total records first to decide if auto-pagination is needed
    let totalCount = 0;
    const tableCounts: Record<string, number> = {};
    for (const tableName of tablesToClone) {
      try {
        if (typeof db.count === "function") {
          tableCounts[tableName] = await db.count({ model: tableName, where: [], namespace });
        } else {
          const recs = await db.findMany({ model: tableName, where: [], namespace });
          tableCounts[tableName] = recs.length;
        }
        totalCount += tableCounts[tableName];
      } catch (error) {
        logger?.warn("Clone: table count failed", { error: String(error), resource: tableName, operation: "clone-count" });
        tableCounts[tableName] = 0;
        countFailedTables.add(tableName);
      }
    }

    let paginated = false;

    if (totalCount > maxCloneRecords) {
      // SCA-002: Auto-paginate — return first maxCloneRecords records across tables
      paginated = true;
      let remaining = maxCloneRecords;

      for (const tableName of tablesToClone) {
        try {
          // Cursor before rows, so a concurrent write is replayed by a pull.
          const latestSeq = await changeTracking.getLatestServerSeq({ resource: tableName });
          if (remaining <= 0) {
            data[tableName] = [];
            // Deferred: continue later if it has rows, or may have (count failed).
            next[tableName] =
              tableCounts[tableName] > 0 || countFailedTables.has(tableName) ? "" : null;
          } else {
            const readLimit = remaining;
            const records = await readCloneRows(tableName, (readDb) =>
              readDb.findMany({
                model: tableName,
                where: [],
                orderBy: [{ field: "id", direction: "asc" }],
                limit: readLimit,
                namespace,
              }),
            );
            data[tableName] = await filterActorVisibleRows(tableName, records);
            remaining -= records.length;

            // Set next cursor if more records exist (or may exist: a table
            // whose count failed and whose read hit the cap)
            if (
              records.length < tableCounts[tableName] ||
              (countFailedTables.has(tableName) && records.length >= readLimit)
            ) {
              const lastRecord = records[records.length - 1];
              next[tableName] = lastRecord?.id as string ?? null;
            } else {
              next[tableName] = null;
              // Every row was read: a read cut short by the cap (including one
              // whose count failed) takes the branch above instead.
              fullyLoadedTables.add(tableName);
            }
          }

          cursors[tableName] = String(latestSeq);
        } catch (error) {
          logger?.warn("Clone: auto-paginate fetch failed", { error: String(error), resource: tableName, operation: "clone-paginate" });
          data[tableName] = [];
          cursors[tableName] = "0";
          next[tableName] = null;
        }
      }
    } else {
      // Non-paginated: get all records for each table, sorted by id
      for (const tableName of tablesToClone) {
        try {
          // Cursor before rows, so a concurrent write is replayed by a pull.
          const latestSeq = await changeTracking.getLatestServerSeq({ resource: tableName });
          const records = await readCloneRows(tableName, (readDb) =>
            readDb.findMany({
              model: tableName,
              where: [],
              orderBy: [{ field: "id", direction: "asc" }],
              namespace,
            }),
          );
          data[tableName] = await filterActorVisibleRows(tableName, records);
          fullyLoadedTables.add(tableName);

          cursors[tableName] = String(latestSeq);
        } catch (error) {
          logger?.warn("Clone: fetch failed", { error: String(error), resource: tableName, operation: "clone-fetch" });
          data[tableName] = [];
          cursors[tableName] = "0";
        }
      }
    }

    // SCA-002: the capped result still carries the join rows of the records
    // it returned (see below), then is flagged as paginated.
    cappedClone = paginated;
  }

  // Include join rows if requested (SYNC-001, SYNC-006)
  if (request.includeJoins && schema.relations) {
    joins = {};

    // Visibility of a join row's endpoints for this actor. The namespace
    // owner sees everything; records returned by this clone are visible;
    // any other private record is resolved (and cached) individually.
    const actorIsOwner = isNamespaceOwnerActor(actorId, namespace);
    const returnedIds = new Map<string, Set<string>>();
    for (const [table, rows] of Object.entries(data)) {
      returnedIds.set(
        table,
        new Set(rows.map((row) => row.id).filter((id): id is string => typeof id === "string")),
      );
    }
    const endpointAccess = new Map<string, boolean>();
    const isEndpointVisible = async (resource: string, id: unknown): Promise<boolean> => {
      if (actorIsOwner || !isPrivateShareableResource(schema, resource)) return true;
      if (typeof id !== "string" || !actorId) return false;
      if (returnedIds.get(resource)?.has(id)) return true;
      const decided = accessDecisions.get(accessKey(resource, id));
      if (decided !== undefined) return decided;
      // Every row of this table was already checked; a missing id isn't visible.
      if (fullyLoadedTables.has(resource)) return false;
      const key = `${resource}\u0000${id}`;
      let visible = endpointAccess.get(key);
      if (visible === undefined) {
        try {
          visible = !!(await resolveAccessLevel(db, schema, resource, id, actorId, namespace));
        } catch (error) {
          // Fail the clone rather than return it without these join rows.
          throw new JoinVisibilityError(error);
        }
        endpointAccess.set(key, visible);
      }
      return visible;
    };

    // Paginated and capped clones scope join rows to the records they returned.
    let scopedIds: Map<string, Set<string>> | undefined;
    if (request.page || cappedClone) {
      scopedIds = new Map();
      for (const [table, rows] of Object.entries(data)) {
        const ids = new Set(
          rows.map((row) => row.id).filter((id): id is string => typeof id === "string"),
        );
        if (ids.size > 0) scopedIds.set(table, ids);
      }
    }

    // A single-table page looks its join rows up by id while that fits the
    // lookup budget. Otherwise each join table is read once and filtered: for
    // a capped clone, and for a page covering several tables, the table and
    // cursor reads already spend a query per table, so id lookups could push
    // the request past the per-invocation query limit.
    let useIdLookups = false;
    if (scopedIds && request.page && tablesToClone.length === 1) {
      let lookups = 0;
      for (const relation of schema.relations) {
        if (relation.type !== "many-many") continue;
        const froms = Array.isArray(relation.from) ? relation.from : [relation.from];
        const tos = Array.isArray(relation.to) ? relation.to : [relation.to];
        for (const side of [froms, tos]) {
          let ids = 0;
          for (const resource of side) ids += scopedIds.get(resource)?.size ?? 0;
          lookups += Math.ceil(ids / JOIN_LOOKUP_CHUNK);
        }
      }
      useIdLookups = lookups <= JOIN_LOOKUP_BUDGET;
    }

    for (const relation of schema.relations) {
      // Skip relations that aren't many-many (no join rows)
      if (relation.type !== "many-many") continue;

      const froms = Array.isArray(relation.from) ? relation.from : [relation.from];
      const tos = Array.isArray(relation.to) ? relation.to : [relation.to];
      const joinTableName = getRelationJoinTableName(relation, froms[0]);
      const fromCol = relation.joinColumns?.from || "from";
      const toCol = relation.joinColumns?.to || "to";

      // A paginated or capped clone returns only the join rows of the records
      // it returned: rows whose from-side record was returned (for a from
      // resource) or whose to-side record was (for a to resource). Every row
      // then reaches the client with the records it links, instead of the
      // whole join table on every page.
      const fromScopes = scopedIds
        ? froms.filter((resource) => scopedIds.has(resource))
        : [];
      const toScopes = scopedIds ? tos.filter((resource) => scopedIds.has(resource)) : [];
      if (scopedIds && fromScopes.length === 0 && toScopes.length === 0) {
        continue;
      }

      try {
        let joinRecords: Array<Record<string, unknown>>;
        // A page within the lookup budget looks its join rows up by id. A
        // capped clone (up to maxCloneRecords records) or a page over budget
        // reads the join table once and filters below, keeping the query
        // count bounded (D1 limits queries per invocation).
        if (scopedIds && useIdLookups) {
          const byId = new Map<unknown, Record<string, unknown>>();
          const lookups = new Map<string, Set<string>>();
          const addLookup = (column: string, resources: string[]) => {
            const ids = lookups.get(column) ?? new Set<string>();
            for (const resource of resources) {
              for (const id of scopedIds.get(resource)!) ids.add(id);
            }
            if (ids.size > 0) lookups.set(column, ids);
          };
          addLookup(fromCol, fromScopes);
          addLookup(toCol, toScopes);
          for (const [column, ids] of lookups) {
            const values = [...ids];
            for (let i = 0; i < values.length; i += JOIN_LOOKUP_CHUNK) {
              const rows = await db.findMany({
                model: joinTableName,
                where: [
                  { field: column, operator: "in", value: values.slice(i, i + JOIN_LOOKUP_CHUNK) },
                ],
                namespace,
              });
              for (const row of rows) byId.set(row.id, row);
            }
          }
          joinRecords = [...byId.values()].sort((a, b) => {
            const left = String(a.id ?? "");
            const right = String(b.id ?? "");
            return left < right ? -1 : left > right ? 1 : 0;
          });
        } else {
          joinRecords = await db.findMany({
            model: joinTableName,
            where: [],
            orderBy: [{ field: "id", direction: "asc" }],
            namespace,
          });
        }

        const normalizedRows = joinRecords.map((row) =>
          normalizeJoinCloneRow(row, fromCol, toCol),
        );

        for (const from of froms) {
          for (const to of tos) {
            const joinStoreKey = getJoinStoreKey(from, relation.relation!, to);
            const candidateRows = normalizedRows.filter(
              (row) =>
                shouldIncludeJoinRowForStore(row, relation, schema, from, to) &&
                (!scopedIds ||
                  (typeof row.from === "string" && !!scopedIds.get(from)?.has(row.from)) ||
                  (typeof row.to === "string" && !!scopedIds.get(to)?.has(row.to))),
            );
            // A join row names both records it links: emit it only when the
            // actor may see each private endpoint.
            const rowsForStore: Array<Record<string, unknown>> = [];
            for (const row of candidateRows) {
              if (
                (await isEndpointVisible(from, row.from)) &&
                (await isEndpointVisible(to, row.to))
              ) {
                rowsForStore.push(row);
              }
            }
            if (rowsForStore.length > 0) {
              joins[joinStoreKey] = rowsForStore;
            }
          }
        }
      } catch (error) {
        if (error instanceof JoinVisibilityError) {
          throw error.reason;
        }
        logger?.warn("Clone: join table fetch failed", { error: String(error), operation: "clone-joins" });
        // Join table might not exist or be queryable; skip gracefully
        continue;
      }
    }
  }

  return {
    ok: true,
    data,
    cursors,
    joins,
    next: Object.keys(next).length > 0 ? next : undefined,
    ...(cappedClone ? { paginated: true } : {}),
  };
}

function normalizeJoinCloneRow(
  row: Record<string, unknown>,
  fromCol: string,
  toCol: string,
): Record<string, unknown> {
  const normalized = { ...row };
  if (fromCol !== "from") {
    normalized.from = normalized[fromCol];
    delete normalized[fromCol];
  }
  if (toCol !== "to") {
    normalized.to = normalized[toCol];
    delete normalized[toCol];
  }
  return normalized;
}

function shouldIncludeJoinRowForStore(
  row: Record<string, unknown>,
  relation: DatafnRelationSchema,
  schema: DatafnSchema,
  from: string,
  to: string,
): boolean {
  const froms = Array.isArray(relation.from) ? relation.from : [relation.from];
  const tos = Array.isArray(relation.to) ? relation.to : [relation.to];
  if (typeof row.fromResource === "string" && row.fromResource !== from) {
    return false;
  }
  if (typeof row.toResource === "string" && row.toResource !== to) {
    return false;
  }
  const fromValue = typeof row.from === "string" ? row.from : undefined;
  const toValue = typeof row.to === "string" ? row.to : undefined;

  const fromMatches =
    froms.length === 1 ||
    !fromValue ||
    resourceIdMatches(schema, froms, from, fromValue);
  const toMatches =
    tos.length === 1 ||
    !toValue ||
    resourceIdMatches(schema, tos, to, toValue);
  return fromMatches && toMatches;
}
