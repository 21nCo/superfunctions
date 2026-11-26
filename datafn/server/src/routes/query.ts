/**
 * POST /datafn/query endpoint
 *
 * FIX-SRV-005: Thin composition layer — delegates to focused modules:
 *   - query/validate.ts   — DFQL structural validation
 *   - query/batch-executor.ts — bounded concurrency
 *   - query/execute.ts    — strategy classification + execution bridge
 */

import type { DatafnSchema, DatafnPlugin } from "../core-types.js";
import type { Adapter } from "@superfunctions/db";
import type { SearchProvider } from "../search-provider.js";
import { getBodyFromContext } from "../http/json.js";
import { errorResponse, okResponse } from "../http/errors.js";
import {
  runBeforeQuery,
  runAfterQuery,
} from "../plugins/run-hooks.js";
import { buildSchemaIndex } from "../validation/index.js";
import { logRequest } from "../logging.js";
import type { DatafnLogger } from "../logger.js";
import { ExecutionTimer, type TimingEmitter } from "../middleware/timing.js";
import {
  isNamespaceOwnerActor,
  isPrivateShareableResource,
  canReadEveryField,
  withoutHiddenDeclaredFields,
  resolveAccessLevel,
  validateQueryAuthz,
} from "../validation/authz.js";
import {
  REVISION_FIELD,
  isRevisionCertified,
  issuesRevisions,
  readWithRevisionsOrPlain,
} from "../execution/revisions.js";
import { runBounded } from "./query/batch-executor.js";
import { executeSingleQuery, relationQuerySelectTokens } from "./query/execute.js";
import { validateQueryBody } from "./query/validate.js";
import { injectCapabilityAutoFilters, type QueryMetadata } from "../execution/query/pushdown.js";
import { mergeSharedWithMeRows } from "../execution/query/execute.js";
import { resolveEffectivePrincipals } from "../execution/auth/principal-resolver.js";
import {
  canonicalizePrincipalFromLegacyUserId,
  getSpv2MigrationRuntimeConfig,
} from "../execution/migration/spv2.js";
import { hasTemporalGrouping } from "@datafn/core";
import { projectFieldsPushdown } from "../execution/query/pushdown.js";
import {
  getDatafnMultiRegionRuntimeConfig,
  queryDatafnPermissionGrants,
} from "../plugins/multi-region.js";

// Re-export query helpers for direct imports from routes/query.
export { validateQuery, validateFilters } from "./query/validate.js";
export { convertFiltersToWhere } from "./query/execute.js";
export { runBounded } from "./query/batch-executor.js";

/**
 * Options for query handler (VAL-001 through VAL-005, VAL-009)
 */
export interface QueryHandlerOpts {
  maxSelectTokens?: number;
  maxFilterKeysPerLevel?: number;
  maxSortFields?: number;
  maxAggregations?: number;
  /** FIX-SRV-003: Max in-flight query concurrency for batch queries (default 20) */
  maxBatchQueryConcurrency?: number;
  allowUnknownResources?: boolean;
  debug?: boolean;
  hasSearchProviderFallback?: boolean;
}

type QueryEnvelopeMetadata = QueryMetadata;
type RequestPrincipalResolutions = Map<string, Promise<string[]>>;

/**
 * Create query validation + execution route handler
 */
/**
 * DATA-41: a query sent with `withRevisions: true` returns each complete row
 * of its own resource with its revision as `$rev`. Only a plain row read
 * qualifies: a relation traversal (rows of another resource), a projection
 * (`select` other than `*`, `omit`), grouping, aggregation or a temporal
 * clause gets none, and so does a resource whose fields the caller may not
 * all read.
 */
/**
 * DATA-41: a push's post-write read sets this key on its query context; the
 * handler records the namespace and queries it actually executed (after
 * every hook), so the push can tell the read selected the written record.
 */
export const POST_WRITE_READ_PROBE = Symbol("datafn.postWriteReadProbe");
export interface PostWriteReadProbe {
  executed?: {
    namespace: string;
    queries: ReadonlyArray<{ resource: unknown; accessMode: unknown; namespaceFilter: boolean }>;
  };
}

function isVersionedQuery(query: Record<string, unknown>, schema: DatafnSchema): boolean {
  if (query.withRevisions !== true || typeof query.resource !== "string") return false;
  if (!issuesRevisions(schema, query.resource) || !canReadEveryField(schema, query.resource)) return false;
  if (query.relation !== undefined || query.temporal !== undefined) return false;
  const select = query.select;
  if (Array.isArray(select) && !(select.length === 1 && select[0] === "*")) return false;
  if (Array.isArray(query.omit) && query.omit.length > 0) return false;
  return !query.groupBy && !query.aggregations && !hasTemporalGrouping(query);
}


export function createQueryHandler(
  validatedSchema: DatafnSchema,
  maxLimit: number,
  extractNamespace: (ctx: any) => Promise<string>,
  extractActorId: ((ctx: any) => Promise<string | undefined>) | undefined,
  db?: Adapter,
  plugins: DatafnPlugin[] = [],
  searchProvider?: SearchProvider,
  timingEmitter?: TimingEmitter | null,
  handlerOpts?: QueryHandlerOpts,
  logger?: DatafnLogger,
  /** Unwrapped adapter used only to discover grants in explicitly requested source namespaces. */
  crossNamespaceDb?: Adapter,
) {
  const multiRegionRuntime = getDatafnMultiRegionRuntimeConfig(plugins);
  // Build schema index once for efficient validation
  const schemaIndex = buildSchemaIndex(validatedSchema);

  const getPermissionsTable = (resource: string) => `__datafn_permissions_${resource}`;
  const globalPermissionsTable = "__datafn_permissions_global";
  const principalMembershipsTable = "__datafn_principal_memberships";
  const principalHierarchyTable = "__datafn_principal_hierarchy";

  const resolveShareableAccessIds = async (
    resource: string,
    namespace: string,
    actorId: string | undefined,
    cache: RequestPrincipalResolutions,
    // DATA-41: a versioned query resolves access on its revision snapshot.
    accessDb: Adapter | undefined = db,
  ): Promise<{ shareableAccessIds: string[]; hasShareableScopeAccess?: boolean } | undefined> => {
    if (!accessDb || !isPrivateShareableResource(validatedSchema, resource)) {
      return undefined;
    }
    const db = accessDb;
    if (!actorId) {
      return { shareableAccessIds: [] };
    }
    // The namespace owner can read every record in it (the same rule as
    // resolveAccessLevel): no id list, so no owned-row read and no `id IN`
    // filter, which for a large namespace exceeds bound-parameter limits and
    // hides owned rows whose createdBy is unset.
    if (isNamespaceOwnerActor(actorId, namespace)) {
      return { shareableAccessIds: [], hasShareableScopeAccess: true };
    }

    const ids = new Set<string>();
    const readMode = getSpv2MigrationRuntimeConfig().readMode;

    const ownedRows = await db.findMany({
      model: resource,
      where: [{ field: "createdBy", operator: "eq", value: actorId }],
      namespace,
    });
    for (const row of ownedRows) {
      if (typeof row.id === "string") {
        ids.add(row.id);
      }
    }

    if (readMode !== "v2") {
      const actorPrincipal = canonicalizePrincipalFromLegacyUserId(actorId);
      const legacySubjects = new Set<string>([actorId, actorPrincipal]);
      for (const legacySubject of legacySubjects) {
        try {
          const permissionRows = await db.findMany({
            model: getPermissionsTable(resource),
            where: [{ field: "userId", operator: "eq", value: legacySubject }],
            namespace,
          });
          for (const row of permissionRows) {
            if (typeof row.resourceId === "string") {
              ids.add(row.resourceId);
            }
          }
        } catch {
          // Legacy table may not exist in SPV2-only deployments.
        }
      }
    }

    if (readMode !== "v1") {
      const principals = await resolveActorPrincipals(namespace, actorId, cache, db);
      let hasScopeGrant = false;
      for (const principalId of principals) {
        const permissionRows = await db.findMany({
          model: globalPermissionsTable,
          where: [
            { field: "resourceType", operator: "eq", value: resource },
            { field: "resourceNs", operator: "eq", value: namespace },
            { field: "principalId", operator: "eq", value: principalId },
          ],
          namespace,
        });
        for (const row of permissionRows) {
          const grant = row as Record<string, unknown>;
          if (!isGrantActive(grant)) {
            continue;
          }
          if (grant.resourceId === null || grant.grantKind === "scope") {
            hasScopeGrant = true;
            continue;
          }
          if (typeof grant.resourceId === "string") {
            ids.add(grant.resourceId);
          }
        }
      }

      if (hasScopeGrant) {
        return {
          shareableAccessIds: [...ids].sort((a, b) => a.localeCompare(b)),
          hasShareableScopeAccess: true,
        };
      }
    }

    return {
      shareableAccessIds: [...ids].sort((a, b) => a.localeCompare(b)),
    };
  };

  const mergeFilters = (
    existingFilters: Record<string, unknown> | undefined,
    nextFilter: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (!existingFilters || Object.keys(existingFilters).length === 0) {
      return nextFilter;
    }
    if (
      Array.isArray(existingFilters.$and) &&
      Object.keys(existingFilters).length === 1
    ) {
      return {
        $and: [...(existingFilters.$and as Record<string, unknown>[]), nextFilter],
      };
    }
    return {
      $and: [existingFilters, nextFilter],
    };
  };

  const isGrantActive = (row: Record<string, unknown>): boolean =>
    row.revokedAt === undefined || row.revokedAt === null;

  const normalizePermissionGrantRow = (
    row: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...row,
    resourceType: row.resourceType ?? row.resource_type,
    resourceNs: row.resourceNs ?? row.resource_ns,
    resourceId: row.resourceId ?? row.resource_id,
    principalId: row.principalId ?? row.principal_id,
    grantKind: row.grantKind ?? row.grant_kind,
    sourceRef: row.sourceRef ?? row.source_ref,
    grantedBy: row.grantedBy ?? row.granted_by,
    grantedAt: row.grantedAt ?? row.granted_at,
    revokedAt: row.revokedAt ?? row.revoked_at,
    resourceRegion: row.resourceRegion ?? row.resource_region,
  });

  const resolveActorPrincipals = async (
    namespace: string,
    actorId: string,
    cache: RequestPrincipalResolutions,
    principalDb: Adapter | undefined = db,
  ): Promise<string[]> => {
    if (!principalDb) {
      return [];
    }
    const db = principalDb;
    const key = JSON.stringify([namespace, actorId]);
    const cached = cache.get(key);
    if (cached) return cached;

    const resolution = resolveEffectivePrincipals({
      namespace,
      actorId,
      store: {
        getDirectMemberships: async ({ namespace: actorNamespace, actorId: actor }) => {
          const rows = await db.findMany({
            model: principalMembershipsTable,
            where: [{ field: "actorId", operator: "eq", value: actor }],
            namespace: actorNamespace,
          });
          return rows
            .filter((row) => isGrantActive(row as Record<string, unknown>))
            .map((row) => (typeof row.principalId === "string" ? row.principalId : ""))
            .filter((principalId) => principalId.length > 0);
        },
        getHierarchyParents: async ({ namespace: actorNamespace, principalIds }) => {
          const edges: Array<{ principalId: string; parentPrincipalId: string }> = [];
          for (const principalId of principalIds) {
            const rows = await db.findMany({
              model: principalHierarchyTable,
              where: [{ field: "principalId", operator: "eq", value: principalId }],
              namespace: actorNamespace,
            });
            for (const row of rows) {
              const candidate = row as Record<string, unknown>;
              if (!isGrantActive(candidate)) {
                continue;
              }
              if (
                typeof candidate.principalId === "string" &&
                typeof candidate.parentPrincipalId === "string"
              ) {
                edges.push({
                  principalId: candidate.principalId,
                  parentPrincipalId: candidate.parentPrincipalId,
                });
              }
            }
          }
          return edges;
        },
      },
    }).then(({ effectivePrincipals }) => effectivePrincipals);
    cache.set(key, resolution);
    return resolution;
  };

  const resolveSharedWithMeNamespaceAccess = async (
    resource: string,
    namespace: string,
    actorId: string | undefined,
    metadata: QueryEnvelopeMetadata | undefined,
    cache: RequestPrincipalResolutions,
  ): Promise<Map<string, { scope: boolean; recordIds: Set<string> }>> => {
    const access = new Map<string, { scope: boolean; recordIds: Set<string> }>();
    if (!db || !actorId) {
      return access;
    }

    const namespaceFilterSet =
      Array.isArray(metadata?.namespaceFilter) && metadata.namespaceFilter.length > 0
        ? new Set(metadata.namespaceFilter.filter((value) => typeof value === "string"))
        : undefined;

    const principals = await resolveActorPrincipals(namespace, actorId, cache);
    const readPermissionRows = async (
      principalId: string,
    ): Promise<Record<string, unknown>[]> => {
      const directoryRows = await queryDatafnPermissionGrants({
        principalId,
        resourceType: resource,
      }, multiRegionRuntime);
      const rows: Record<string, unknown>[] = directoryRows
        .filter((grant) => grant.resourceRegion === multiRegionRuntime?.regionId)
        .map((grant) => ({
          id: grant.id,
          resourceType: grant.resourceType,
          resourceNs: grant.resourceNs,
          resourceId: grant.resourceId,
          principalId: grant.principalId,
          level: grant.level,
          grantKind: grant.grantKind,
          sourceRef: grant.sourceRef,
          grantedBy: grant.grantedBy,
          grantedAt: grant.grantedAt,
          revokedAt: grant.revokedAt,
          resourceRegion: grant.resourceRegion,
        }));
      if (rows.length > 0) {
        return rows;
      }
      try {
        rows.push(
          ...(
            await db.internal.findMany(globalPermissionsTable, [
              { field: "resourceType", op: "eq", value: resource },
              { field: "principalId", op: "eq", value: principalId },
            ])
          ).map((row) => normalizePermissionGrantRow(row)),
        );
      } catch {
      }
      try {
        rows.push(
          ...(
            await db.internal.findMany(globalPermissionsTable, [
              { field: "resource_type", op: "eq", value: resource },
              { field: "principal_id", op: "eq", value: principalId },
            ])
          ).map((row) => normalizePermissionGrantRow(row)),
        );
      } catch {
      }
      const permissionDb = crossNamespaceDb ?? db;
      const candidateNamespaces = namespaceFilterSet ?? new Set([namespace]);
      for (const sourceNamespace of candidateNamespaces) {
        rows.push(
          ...(
            await permissionDb.findMany({
              model: globalPermissionsTable,
              where: [
                { field: "resourceType", operator: "eq", value: resource },
                { field: "principalId", operator: "eq", value: principalId },
                { field: "resourceNs", operator: "eq", value: sourceNamespace },
              ],
              namespace: sourceNamespace,
            })
          ).map((row) => normalizePermissionGrantRow(row as Record<string, unknown>)),
        );
      }
      return multiRegionRuntime
        ? rows.filter(
            (row) =>
              row.resourceRegion === undefined ||
              row.resourceRegion === null ||
              row.resourceRegion === multiRegionRuntime.regionId,
          )
        : rows;
    };
    const seenGrantIds = new Set<string>();
    for (const principalId of principals) {
      const rows = await readPermissionRows(principalId);

      for (const row of rows) {
        const grant = row as Record<string, unknown>;
        if (
          typeof grant.__ns === "string" &&
          typeof grant.resourceNs === "string" &&
          grant.__ns !== grant.resourceNs
        ) {
          continue;
        }
        const grantId =
          typeof grant.id === "string"
            ? grant.id
            : `${String(grant.resourceType)}:${String(grant.resourceNs)}:${String(grant.resourceId ?? "*")}:${String(grant.principalId)}`;
        if (seenGrantIds.has(grantId)) {
          continue;
        }
        seenGrantIds.add(grantId);
        if (!isGrantActive(grant)) {
          continue;
        }
        if (typeof grant.resourceNs !== "string" || grant.resourceNs.length === 0) {
          continue;
        }
        if (namespaceFilterSet && !namespaceFilterSet.has(grant.resourceNs)) {
          continue;
        }

        const entry = access.get(grant.resourceNs) ?? {
          scope: false,
          recordIds: new Set<string>(),
        };
        const grantKind =
          typeof grant.grantKind === "string" ? grant.grantKind : "record";
        const isScopeGrant = grantKind === "scope" || grant.resourceId === null;
        if (isScopeGrant) {
          entry.scope = true;
        } else if (typeof grant.resourceId === "string") {
          entry.recordIds.add(grant.resourceId);
        }
        access.set(grant.resourceNs, entry);
      }
    }

    return access;
  };

  const executeSharedWithMeQuery = async (
    query: Record<string, unknown>,
    metadata: QueryEnvelopeMetadata | undefined,
    namespace: string,
    actorId: string | undefined,
    timer: ExecutionTimer | null | undefined,
    cache: RequestPrincipalResolutions,
  ): Promise<unknown> => {
    if (query.groupBy) {
      return { groups: [], nextCursor: null };
    }
    const namespaceAccess = await resolveSharedWithMeNamespaceAccess(
      String(query.resource),
      namespace,
      actorId,
      metadata,
      cache,
    );

    if (namespaceAccess.size === 0) {
      return {
        data: [],
        nextCursor: null,
        ...(query.count === true ? { count: 0 } : {}),
      };
    }

    const perNamespaceRows: Array<{ namespace: string; data: Record<string, unknown>[] }> = [];
    const namespaces = Array.from(namespaceAccess.keys()).sort((a, b) => a.localeCompare(b));

    for (const sourceNamespace of namespaces) {
      const access = namespaceAccess.get(sourceNamespace);
      if (!access) {
        continue;
      }
      if (!access.scope && access.recordIds.size === 0) {
        continue;
      }

      const existingFilters =
        query.filters &&
        typeof query.filters === "object" &&
        !Array.isArray(query.filters)
          ? (query.filters as Record<string, unknown>)
          : undefined;

      const idFilter =
        access.scope
          ? undefined
          : { id: { $in: Array.from(access.recordIds).sort((a, b) => a.localeCompare(b)) } };
      const queryWithScopeFilters = {
        ...query,
        ...(idFilter ? { filters: mergeFilters(existingFilters, idFilter) } : {}),
        metadata: {
          ...(metadata ?? {}),
          accessMode: "sharedWithMe",
          namespaceFilter: undefined,
          shareableAccessIds: undefined,
        } satisfies QueryEnvelopeMetadata,
      };

      const queryWithAutoFilters = injectCapabilityAutoFilters(
        queryWithScopeFilters as any,
        validatedSchema,
      );
      const result = await executeSingleQuery(
        queryWithAutoFilters as unknown as Record<string, unknown>,
        validatedSchema,
        db as Adapter,
        sourceNamespace,
        actorId,
        searchProvider,
        logger,
        timer,
        multiRegionRuntime,
        // Timezone "user" means the viewer's timezone history, not the owner's.
        { timezoneNamespace: namespace, allowUnknownResources: handlerOpts?.allowUnknownResources === true },
      );
      if (
        result &&
        typeof result === "object" &&
        "data" in (result as Record<string, unknown>) &&
        Array.isArray((result as Record<string, unknown>).data)
      ) {
        perNamespaceRows.push({
          namespace: sourceNamespace,
          data: (result as { data: Record<string, unknown>[] }).data,
        });
      }
    }

    return mergeSharedWithMeRows(perNamespaceRows, query as any);
  };

  const listPermissionsForInspection = async (
    resource: string,
    recordId: string,
    namespace: string,
  ): Promise<Record<string, unknown>[]> => {
    if (!db) {
      return [];
    }

    const grantKindOrder: Record<string, number> = {
      record: 0,
      scope: 1,
      relation_inherited: 2,
    };

    const globalRows = await db.findMany({
      model: globalPermissionsTable,
      where: [
        { field: "resourceType", operator: "eq", value: resource },
        { field: "resourceNs", operator: "eq", value: namespace },
      ],
      namespace,
    });
    const activeGlobalRows = globalRows
      .map((row) => row as Record<string, unknown>)
      .filter((row) => isGrantActive(row))
      .filter(
        (row) =>
          row.resourceId === null ||
          row.resourceId === recordId ||
          row.grantKind === "scope",
      );

    const normalizedGlobalRows = activeGlobalRows.map((row) => {
      const principalId =
        typeof row.principalId === "string"
          ? row.principalId
          : typeof row.userId === "string"
            ? row.userId
            : "";
      const grantKind =
        typeof row.grantKind === "string"
          ? row.grantKind
          : row.resourceId === null
            ? "scope"
            : "record";
      return {
        principalId,
        userId: principalId,
        level: row.level,
        grantKind,
        sourceRef: row.sourceRef ?? null,
        grantedBy: row.grantedBy ?? null,
        grantedAt: row.grantedAt ?? null,
      } as Record<string, unknown>;
    });

    const outputRows =
      normalizedGlobalRows.length > 0
        ? normalizedGlobalRows
        : (
            await db.findMany({
              model: getPermissionsTable(resource),
              where: [{ field: "resourceId", operator: "eq", value: recordId }],
              namespace,
            })
          ).map((row) => {
            const principalId =
              typeof row.userId === "string"
                ? row.userId
                : typeof row.principalId === "string"
                  ? row.principalId
                  : "";
            return {
              principalId,
              userId: principalId,
              level: row.level,
              grantKind: "record",
              sourceRef: null,
              grantedBy: row.grantedBy ?? null,
              grantedAt: row.grantedAt ?? null,
            } as Record<string, unknown>;
          });

    return outputRows.sort((a, b) => {
      const aGrant = typeof a.grantKind === "string" ? a.grantKind : "";
      const bGrant = typeof b.grantKind === "string" ? b.grantKind : "";
      const grantCompare =
        (grantKindOrder[aGrant] ?? Number.MAX_SAFE_INTEGER) -
        (grantKindOrder[bGrant] ?? Number.MAX_SAFE_INTEGER);
      if (grantCompare !== 0) {
        return grantCompare;
      }
      const principalCompare = String(a.principalId ?? "").localeCompare(
        String(b.principalId ?? ""),
      );
      if (principalCompare !== 0) {
        return principalCompare;
      }
      return String(a.level ?? "").localeCompare(String(b.level ?? ""));
    });
  };

    return async (req: Request, ctx?: { parsedBody?: unknown }): Promise<Response> => {
      const startTime = Date.now();
      let resource: string | undefined;
      const timer = timingEmitter ? new ExecutionTimer() : null;
      // SRV-006: Per-query durations (populated inside if(db) block)
      const queryDurations: number[] = [];

      try {
        timer?.startPhase("validate");
        // Get body from context (pre-parsed by withAuth) or parse from request
        const parseResult = await getBodyFromContext(req, ctx);
        if (!parseResult.ok) {
          return errorResponse(parseResult.error);
        }
        const body = parseResult.data;

        // Check if it's object or array
        if (typeof body !== "object" || body === null) {
          return errorResponse({
            code: "DFQL_INVALID",
            message: "Invalid DFQL: expected object or array",
            details: { path: "$" },
          });
        }

        const q = body as Record<string, unknown>;
        resource = typeof q.resource === "string" ? q.resource : undefined;

        // Run beforeQuery hooks
        const hookCtx = { plugins, schema: validatedSchema, context: ctx };
        const beforeHookResult = await runBeforeQuery(body, hookCtx, plugins);
        if (!beforeHookResult.ok) {
          return errorResponse(
            beforeHookResult.error as any,
            beforeHookResult.error.code === "FORBIDDEN" ? 403 : 400,
          );
        }
        // Use potentially transformed query from hooks
        const transformedBody = beforeHookResult.query;

        // Validate queries against schema using validation module
        const validationResult = validateQueryBody(transformedBody, schemaIndex, {
          maxLimit,
          hasSearchProvider: !!searchProvider || !!handlerOpts?.hasSearchProviderFallback,
          maxSelectTokens: handlerOpts?.maxSelectTokens,
          maxFilterKeysPerLevel: handlerOpts?.maxFilterKeysPerLevel,
          maxSortFields: handlerOpts?.maxSortFields,
          maxAggregations: handlerOpts?.maxAggregations,
          debug: handlerOpts?.debug,
        });
        if (!validationResult.ok) {
          // VAL-009: In production (debug: false), strip field/schema details from messages
          const debug = handlerOpts?.debug ?? false;
          const message = debug ? validationResult.error.message : "Validation error";
          return errorResponse({
            code: validationResult.error.code,
            message,
            details: { path: validationResult.error.path, ...(validationResult.error.details || {}) },
          });
        }

        const { isBatch, queries: transformedQueries } = validationResult.result;

        // PHASE_11: Enforce read permissions for each query (VAL-001: deny-by-default)
        for (let i = 0; i < transformedQueries.length; i++) {
          const query = transformedQueries[i] as Record<string, unknown>;
          const metadata =
            query.metadata &&
            typeof query.metadata === "object" &&
            !Array.isArray(query.metadata)
              ? (query.metadata as QueryEnvelopeMetadata)
              : undefined;
          if (metadata?.accessMode !== undefined) {
            if (
              metadata.accessMode !== "namespace" &&
              metadata.accessMode !== "sharedWithMe"
            ) {
              return errorResponse(
                {
                  code: "DFQL_INVALID",
                  message:
                    "Invalid DFQL: metadata.accessMode must be one of [namespace, sharedWithMe]",
                  details: {
                    path: isBatch
                      ? `[${i}].metadata.accessMode`
                      : "metadata.accessMode",
                  },
                },
                400,
              );
            }
          }
          if (metadata?.namespaceFilter !== undefined) {
            if (!Array.isArray(metadata.namespaceFilter)) {
              return errorResponse(
                {
                  code: "DFQL_INVALID",
                  message: "Invalid DFQL: metadata.namespaceFilter must be array",
                  details: {
                    path: isBatch
                      ? `[${i}].metadata.namespaceFilter`
                      : "metadata.namespaceFilter",
                  },
                },
                400,
              );
            }
            if (metadata.accessMode !== "sharedWithMe") {
              return errorResponse(
                {
                  code: "DFQL_INVALID",
                  message:
                    'Invalid DFQL: metadata.namespaceFilter requires metadata.accessMode="sharedWithMe"',
                  details: {
                    path: isBatch
                      ? `[${i}].metadata.namespaceFilter`
                      : "metadata.namespaceFilter",
                  },
                },
                400,
              );
            }
            for (let idx = 0; idx < metadata.namespaceFilter.length; idx++) {
              const namespaceFilterValue = metadata.namespaceFilter[idx];
              if (
                typeof namespaceFilterValue !== "string" ||
                namespaceFilterValue.trim().length === 0
              ) {
                return errorResponse(
                  {
                    code: "DFQL_INVALID",
                    message:
                      "Invalid DFQL: metadata.namespaceFilter entries must be non-empty strings",
                    details: {
                      path: isBatch
                        ? `[${i}].metadata.namespaceFilter[${idx}]`
                        : `metadata.namespaceFilter[${idx}]`,
                    },
                  },
                  400,
                );
              }
            }
          }
          const authzQuery = typeof query.relation === "string" && typeof query.id === "string"
            ? { ...query, select: relationQuerySelectTokens(query.relation, query.select) }
            : query;
          const authzResult = validateQueryAuthz(authzQuery, validatedSchema, {
            allowUnknownResources: handlerOpts?.allowUnknownResources,
            debug: handlerOpts?.debug,
          });
          if (!authzResult.ok) {
            return errorResponse({
              code: authzResult.code,
              message: authzResult.message,
              details: { path: isBatch ? `[${i}].${authzResult.path}` : authzResult.path },
            }, 403);
          }
        }

        // Execute queries
        if (db) {
          const namespace = await extractNamespace(ctx);
          const readProbe = (ctx as Record<symbol, PostWriteReadProbe | undefined> | undefined)?.[POST_WRITE_READ_PROBE];
          // Copied now: a later hook may change the query objects.
          if (readProbe) {
            readProbe.executed = {
              namespace,
              queries: transformedQueries.map((q) => {
                const query = q as { resource?: unknown; metadata?: { accessMode?: unknown; namespaceFilter?: unknown } };
                return {
                  resource: query.resource,
                  accessMode: query.metadata?.accessMode,
                  namespaceFilter: query.metadata?.namespaceFilter !== undefined,
                };
              }),
            };
          }
          const actorId = extractActorId ? await extractActorId(ctx) : undefined;
          // Membership and hierarchy are written by the host, outside this
          // handler, so a cache kept on the handler would survive revocation.
          // One cache per request still dedupes lookups inside a batch.
          const principalResolverCache: RequestPrincipalResolutions = new Map();

          timer?.startPhase("plan");
          // FIX-SRV-003: Bounded concurrency — queue excess queries instead of rejecting
          const concurrency = handlerOpts?.maxBatchQueryConcurrency ?? 20;
          const queryTasks = transformedQueries.map((q) => () => {
              const queryStart = Date.now();
              const query = q as Record<string, unknown>;
              const metadata =
                query.metadata &&
                typeof query.metadata === "object" &&
                !Array.isArray(query.metadata)
                  ? (query.metadata as QueryEnvelopeMetadata)
                  : undefined;
              const accessMode =
                metadata?.accessMode === "sharedWithMe" ? "sharedWithMe" : "namespace";
              if (query.operation === "getPermissions") {
                return (async () => {
                  if (typeof query.id !== "string") {
                    throw new Error("Invalid DFQL: id must be string");
                  }
                  const accessLevel = await resolveAccessLevel(
                    db,
                    validatedSchema,
                    String(query.resource),
                    query.id,
                    actorId,
                    namespace,
                  );
                  if (accessLevel !== "owner") {
                    throw new Error("FORBIDDEN:getPermissions");
                  }
                  return listPermissionsForInspection(
                    String(query.resource),
                    query.id,
                    namespace,
                  );
                })().then((result) => {
                  queryDurations.push(Date.now() - queryStart);
                  return result;
                });
              }

              if (accessMode === "sharedWithMe") {
                return executeSharedWithMeQuery(
                  query,
                  metadata,
                  namespace,
                  actorId,
                  timer,
                  principalResolverCache,
                ).then((result) => {
                  queryDurations.push(Date.now() - queryStart);
                  // DATA-41: shared rows come from other namespaces, whose
                  // revisions a client cannot pair with its own records, so
                  // they get none; a versioned read still never returns a
                  // field the read policy withholds.
                  if (query.withRevisions === true && query.relation === undefined && typeof query.resource === "string") {
                    const rows = (result as { data?: unknown })?.data;
                    if (Array.isArray(rows)) {
                      rows.forEach((row, index) => {
                        rows[index] = withoutHiddenDeclaredFields(validatedSchema, String(query.resource), row);
                      });
                    }
                  }
                  return result;
                });
              }

              // Access fields are the server's to set: a client-supplied
              // hasShareableScopeAccess or shareableAccessIds must never
              // widen or replace the access filter.
              const {
                shareableAccessIds: _clientAccessIds,
                hasShareableScopeAccess: _clientScopeAccess,
                ...clientMetadata
              } = (metadata ?? {}) as QueryEnvelopeMetadata;
              const run = async (
                readDb: Adapter,
                projectRecords = true,
                accessDb: Adapter = readDb,
                cache: RequestPrincipalResolutions = principalResolverCache,
              ) => {
                const shareableAccess = await resolveShareableAccessIds(
                  String(query.resource),
                  namespace,
                  actorId,
                  cache,
                  accessDb,
                );
                const queryWithMetadata = {
                  ...query,
                  metadata: {
                    ...clientMetadata,
                    ...(shareableAccess ?? {}),
                  } satisfies QueryEnvelopeMetadata,
                };
                const queryWithAutoFilters = injectCapabilityAutoFilters(
                  queryWithMetadata as any,
                  validatedSchema,
                );
                return executeSingleQuery(
                  queryWithAutoFilters as unknown as Record<string, unknown>,
                  validatedSchema,
                  readDb,
                  namespace,
                  actorId,
                  searchProvider,
                  logger,
                  timer,
                  multiRegionRuntime,
                  { allowUnknownResources: handlerOpts?.allowUnknownResources === true, projectRecords },
                );
              };
              return (async () => {
                const rowsOf = (result: unknown) => {
                  const rows = (result as { data?: unknown })?.data;
                  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : undefined;
                };
                const resourceName = String(query.resource);
                if (!isVersionedQuery(query, validatedSchema)) {
                  if (query.withRevisions !== true || query.relation !== undefined) return run(db);
                  // DATA-41: a query sent with `withRevisions` that does not
                  // qualify returns no revision, and never a field of its
                  // resource that the read policy withholds. Only declared
                  // fields are removed, so aggregation aliases survive.
                  return run(db).then((result) => {
                    const rows = rowsOf(result);
                    rows?.forEach((row, index) => {
                      rows[index] = withoutHiddenDeclaredFields(validatedSchema, resourceName, row);
                    });
                    return result;
                  });
                }
                // DATA-41: the query itself, including its row-level access
                // (owned rows, grants and principal memberships of a private
                // shareable resource, resolved without the request's cache),
                // runs inside the revision snapshot and returns its stored
                // rows unprojected (as clone returns them), so each row it
                // selected is paired with the revision read in that same
                // snapshot. A row the server did not pair with a revision (an
                // unreadable field, a tombstone, no verified pairing, or a
                // stored legacy `$rev` value) is returned as the plain query
                // projects it, without `$rev`. If revision setup or any read
                // inside the snapshot fails (thrown, or swallowed by a
                // push-down or in-memory fallback, which on PostgreSQL aborts
                // the transaction), the query is run again outside it,
                // without revisions, and with access resolved afresh too: an
                // earlier query of the batch may have cached a membership
                // revoked since.
                const readable = (row: Record<string, unknown>) =>
                  canReadEveryField(validatedSchema, resourceName, row);
                const select = Array.isArray(query.select) ? (query.select as string[]) : undefined;
                let plain = false;
                return readWithRevisionsOrPlain(
                  db,
                  namespace,
                  resourceName,
                  (readDb) => run(readDb, false, readDb, new Map()),
                  () => {
                    plain = true;
                    return run(db, true, db, new Map());
                  },
                  rowsOf,
                  readable,
                ).then((result) => {
                  if (plain) return result;
                  const rows = rowsOf(result);
                  rows?.forEach((row, index) => {
                    if (!isRevisionCertified(row)) {
                      const projected = projectFieldsPushdown(row, resourceName, validatedSchema, select, undefined);
                      delete projected[REVISION_FIELD];
                      rows[index] = projected;
                    }
                  });
                  return result;
                });
              })().then((result) => {
                queryDurations.push(Date.now() - queryStart);
                return result;
              });
          });
          let results: unknown[];
          try {
            results = await runBounded(queryTasks, concurrency);
          } catch (error) {
            if (error instanceof Error && error.message === "FORBIDDEN:getPermissions") {
              return errorResponse({
                code: "FORBIDDEN",
                message: "Authorization denied",
                details: { path: "operation" },
              }, 403);
            }
            if (error instanceof Error && error.message === "Invalid DFQL: id must be string") {
              return errorResponse({
                code: "DFQL_INVALID",
                message: "Invalid DFQL: id must be string",
                details: { path: "id" },
              });
            }
            throw error;
          }

          timer?.startPhase("materialize");
          let result = isBatch ? results : results[0];

          // Run afterQuery hooks (fail-open)
          result = await runAfterQuery(transformedBody, result, hookCtx, plugins);

          if (timingEmitter && timer) {
            timingEmitter(timer.build("/datafn/query", resource, "query"));
          }

          return okResponse(result);
        } else {
          // Phase 01: Return empty results if no DB provided
          const emptyResult = isBatch
            ? transformedQueries.map((q) => {
                const query = q as Record<string, unknown>;
                if (query.groupBy || hasTemporalGrouping(query)) {
                    return { groups: [], nextCursor: null };
                }
                return { data: [], nextCursor: null };
            })
            : (() => {
                const query = transformedQueries[0] as Record<string, unknown>;
                if (query.groupBy || hasTemporalGrouping(query)) {
                    return { groups: [], nextCursor: null };
                }
                return { data: [], nextCursor: null };
            })();
          return okResponse(emptyResult);
        }
      } catch (error) {
        logger?.error("Query execution failed", { error: String(error), operation: "query" });
        return errorResponse({
            code: "INTERNAL",
            message: "Internal error",
            details: { path: "$" }
        });
      } finally {
          logRequest({
              timestamp: new Date().toISOString(),
              endpoint: "/datafn/query",
              resource: resource,
              operation: "query",
              duration_ms: Date.now() - startTime,
              // SRV-006: Include per-query timings when available
              ...(queryDurations.length > 0 ? { queryDurations } : {}),
          }, logger);
      }
    };}
