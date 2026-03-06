/**
 * POST /datafn/query endpoint
 *
 * FIX-SRV-005: Thin composition layer — delegates to focused modules:
 *   - query/validate.ts   — DFQL structural validation
 *   - query/batch-executor.ts — bounded concurrency
 *   - query/execute.ts    — strategy classification + execution bridge
 */

import type { DatafnSchema, DatafnPlugin } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import { getBodyFromContext } from "../http/json.js";
import { errorResponse, okResponse } from "../http/errors.js";
import {
  runBeforeQuery,
  runAfterQuery,
  hasSearchPlugin,
} from "../plugins/run-hooks.js";
import { buildSchemaIndex } from "../validation/index.js";
import { logRequest } from "../logging.js";
import type { DatafnLogger } from "../logger.js";
import { ExecutionTimer, type TimingEmitter } from "../middleware/timing.js";
import { validateQueryAuthz } from "../validation/authz.js";
import { runBounded } from "./query/batch-executor.js";
import { executeSingleQuery } from "./query/execute.js";
import { validateQueryBody } from "./query/validate.js";

// Re-export for backward compatibility
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
}

/**
 * Create query validation + execution route handler
 */
export function createQueryHandler(
  validatedSchema: DatafnSchema,
  maxLimit: number,
  db?: Adapter,
  plugins: DatafnPlugin[] = [],
  extractNamespace: (ctx: any) => Promise<string>,
  timingEmitter?: TimingEmitter | null,
  handlerOpts?: QueryHandlerOpts,
  logger?: DatafnLogger,
) {
  // Build schema index once for efficient validation
  const schemaIndex = buildSchemaIndex(validatedSchema);

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
        const hookCtx = { plugins, schema: validatedSchema };
        const beforeHookResult = await runBeforeQuery(body, hookCtx, plugins);
        if (!beforeHookResult.ok) {
          return errorResponse(beforeHookResult.error as any);
        }
        // Use potentially transformed query from hooks
        const transformedBody = beforeHookResult.query;

        // Validate queries against schema using validation module
        const validationResult = validateQueryBody(transformedBody, schemaIndex, {
          maxLimit,
          hasSearchPlugin: hasSearchPlugin(plugins),
          maxSelectTokens: handlerOpts?.maxSelectTokens,
          maxFilterKeysPerLevel: handlerOpts?.maxFilterKeysPerLevel,
          maxSortFields: handlerOpts?.maxSortFields,
          maxAggregations: handlerOpts?.maxAggregations,
          debug: handlerOpts?.debug,
        });
        if (!validationResult.ok) {
          // VAL-009: In production (debug: false), strip field/schema details from messages
          const debug = handlerOpts?.debug ?? true;
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
          const authzResult = validateQueryAuthz(query, validatedSchema, {
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

          timer?.startPhase("plan");
          // FIX-SRV-003: Bounded concurrency — queue excess queries instead of rejecting
          const concurrency = handlerOpts?.maxBatchQueryConcurrency ?? 20;
          const queryTasks = transformedQueries.map((q) => () => {
              const queryStart = Date.now();
              const query = q as Record<string, unknown>;
              return executeSingleQuery(
                query,
                validatedSchema,
                db,
                namespace,
                plugins,
                logger,
                timer,
              ).then((result) => {
                queryDurations.push(Date.now() - queryStart);
                return result;
              });
          });
          const results = await runBounded(queryTasks, concurrency);

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
                if (query.groupBy) {
                    return { groups: [], nextCursor: null };
                }
                return { data: [], nextCursor: null };
            })
            : (() => {
                const query = transformedQueries[0] as Record<string, unknown>;
                if (query.groupBy) {
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
