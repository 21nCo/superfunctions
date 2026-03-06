/**
 * Mutation execution logic
 */

import type { DatafnSchema, DatafnPlugin } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import { randomUUID } from "crypto";
import type { IdempotencyStore, MutationResult } from "../idempotency.js";
import { type DFQLMutation, buildReplaceRecord } from "./dfql.js";
import { executeRelate, executeModifyRelation, executeUnrelate, extractJoinDeltas, extractRelationFkDeltas } from "./relations.js";
import { executeSchemaAwareMerge } from "./merge-decision.js";
import { ChangeTrackingService, recordChangeWithRetry, recordChangesWithRetry } from "../sync/change-tracking.js";
import { evaluateGuard } from "./guards.js";
import { isSearchPlugin } from "../../plugins/searchfn.js";
import type { DatafnLogger } from "../../logger.js";

/**
 * REL-011 / DI-002: Core operation execution (operation switch + change tracking).
 * Called within a transaction from the guarded path, or directly from the main path.
 * Does NOT include idempotency check/set, guard evaluation, or search index updates.
 */
async function executeMutationCore(
  mutation: DFQLMutation,
  db: Adapter,
  schema: DatafnSchema,
  namespace: string,
  effectiveMutationId: string,
  changeTracking: ChangeTrackingService,
  logger?: DatafnLogger,
): Promise<MutationResult> {
  let opResult:
    | { ok: true }
    | { ok: false; code: string; message: string; path: string };
  let resolvedRecord: Record<string, unknown> | undefined;
  // EXE-008: flag to skip change tracking when deleting a non-existent record
  let skipChangeTracking = false;

  try {
    switch (mutation.operation) {
      case "insert":
        try {
          await db.create({
            model: mutation.resource,
            data: { id: mutation.id, ...(mutation.record || {}) },
            namespace,
          });
          opResult = { ok: true };
        } catch (error: any) {
          // EXE-010: Log original error for observability
          logger?.error("Mutation insert failed", { error: String(error), operation: "insert", resource: mutation.resource });
          // EXE-005: Check error.code before message matching
          const code = error?.code;
          const msg = (error?.message || "").toLowerCase();
          if (
            code === "23505" || code === "UNIQUE_VIOLATION" || code === "ER_DUP_ENTRY" ||
            code === "SQLITE_CONSTRAINT_UNIQUE" ||
            msg.includes("unique") || msg.includes("duplicate") || msg.includes("already exists") || msg.includes("conflict")
          ) {
            opResult = { ok: false, code: "CONFLICT", message: "Record already exists", path: "id" };
          } else {
            opResult = { ok: false, code: "INTERNAL", message: error?.message || "Internal error", path: "$" };
          }
        }
        break;

      case "merge":
        {
          const mergeData = mutation.record || {};
          const strictUpdateNotFound = db.capabilities?.operations?.strictUpdateNotFound === true;
          const mergeResult = await executeSchemaAwareMerge({
            schema,
            resource: mutation.resource,
            id: mutation.id,
            delta: mergeData,
            update: async () => {
              await db.update({
                model: mutation.resource,
                where: [{ field: "id", operator: "eq", value: mutation.id }],
                data: mergeData,
                namespace,
              });
            },
            create: async (record) => {
              await db.create({
                model: mutation.resource,
                data: record,
                namespace,
              });
            },
            ...(strictUpdateNotFound
              ? {}
              : {
                  findOne: async () =>
                    db.findOne({
                      model: mutation.resource,
                      where: [{ field: "id", operator: "eq", value: mutation.id }],
                      namespace,
                    }),
                }),
          });

          if (mergeResult.ok) {
            opResult = { ok: true };
          } else {
            if (mergeResult.code === "INTERNAL") {
              logger?.error("Mutation merge failed", {
                error: String(mergeResult.error),
                operation: "merge",
                resource: mutation.resource,
              });
            }
            opResult = {
              ok: false,
              code: mergeResult.code,
              message: mergeResult.message,
              path: mergeResult.path,
            };
          }
        }
        break;

      case "replace":
        try {
          const existing = await db.findOne({
            model: mutation.resource,
            where: [{ field: "id", operator: "eq", value: mutation.id }],
            namespace,
          });
          if (!existing) {
            opResult = { ok: false, code: "NOT_FOUND", message: `Record not found: ${mutation.id}`, path: "id" };
            break;
          }
          const buildResult = buildReplaceRecord(schema, mutation.resource, existing, mutation.record || {});
          if (!buildResult.ok) {
            opResult = { ok: false, code: buildResult.code, message: buildResult.message, path: buildResult.path };
            break;
          }
          await db.update({
            model: mutation.resource,
            where: [{ field: "id", operator: "eq", value: mutation.id }],
            data: buildResult.record,
            namespace,
          });
          resolvedRecord = buildResult.record;
          opResult = { ok: true };
        } catch (e: any) {
          // EXE-010: Log original error for observability
          logger?.error("Mutation replace failed", { error: String(e), operation: "replace", resource: mutation.resource });
          opResult = { ok: false, code: "INTERNAL", message: e?.message || "Internal error", path: "$" };
        }
        break;

      case "delete": {
        // EXE-008: Check existence before change tracking (delete of non-existent is idempotent)
        const existingForDelete = await db.findOne({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });
        await db.delete({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });
        if (!existingForDelete) {
          // Record didn't exist — skip change tracking (no-op delete)
          skipChangeTracking = true;
        }
        opResult = { ok: true };
        break;
      }

      case "relate":
        try {
          opResult = await executeRelate(db, schema, mutation, namespace);
        } catch (e: any) {
          // EXE-010: Log original error for observability
          logger?.error("Mutation relate failed", { error: String(e), operation: "relate", resource: mutation.resource });
          opResult = { ok: false, code: "INTERNAL", message: e?.message || "Internal error", path: "$" };
        }
        break;

      case "modifyRelation":
        try {
          opResult = await executeModifyRelation(db, schema, mutation, namespace);
        } catch (e: any) {
          // EXE-010: Log original error for observability
          logger?.error("Mutation modifyRelation failed", { error: String(e), operation: "modifyRelation", resource: mutation.resource });
          opResult = { ok: false, code: "INTERNAL", message: e?.message || "Internal error", path: "$" };
        }
        break;

      case "unrelate":
        try {
          opResult = await executeUnrelate(db, schema, mutation, namespace);
        } catch (e: any) {
          // EXE-010: Log original error for observability
          logger?.error("Mutation unrelate failed", { error: String(e), operation: "unrelate", resource: mutation.resource });
          opResult = { ok: false, code: "INTERNAL", message: e?.message || "Internal error", path: "$" };
        }
        break;

      default:
        opResult = {
          ok: false,
          code: "DFQL_UNSUPPORTED",
          message: `Unsupported DFQL feature: mutation.operation.${(mutation as any).operation}`,
          path: "operation",
        };
    }
  } catch (error: any) {
    logger?.error("Unexpected mutation error", {
      error: String(error),
      operation: (mutation as any).operation,
      resource: mutation.resource,
    });
    opResult = { ok: false, code: "INTERNAL", message: error?.message || "Internal error", path: "$" };
  }

  const result: MutationResult = opResult.ok
    ? { ok: true, mutationId: effectiveMutationId, affectedIds: [mutation.id], errors: [], deduped: false }
    : {
        ok: false,
        mutationId: effectiveMutationId,
        affectedIds: [],
        errors: [{ code: opResult.code, message: opResult.message, path: opResult.path, retryable: false }],
        deduped: false,
      };

  // REL-011: Record change tracking using the provided changeTracking instance
  // (which uses the same db adapter as the operation — ensures atomicity when in a transaction)
  if (opResult.ok && !skipChangeTracking) {
    try {
      const isRelationMutation =
        mutation.operation === "relate" ||
        mutation.operation === "modifyRelation" ||
        mutation.operation === "unrelate";

      if (isRelationMutation) {
        const fkDeltas = extractRelationFkDeltas(mutation, schema);
        const joinDeltas = extractJoinDeltas(mutation, schema);
        const allDeltas = [...fkDeltas, ...joinDeltas];
        if (allDeltas.length > 0) {
          const seqs = await changeTracking.getNextServerSeqBatch(allDeltas.length);
          const entries = allDeltas.map((delta, i) => ({
            serverSeq: seqs[i],
            resource: delta.resource,
            id: delta.id,
            op: delta.op,
            record: delta.record,
          }));
          await recordChangesWithRetry(changeTracking, entries, 2, logger);
        }
      } else {
        const serverSeq = await changeTracking.getNextServerSeq();
        const changeOp =
          mutation.operation === "delete" ? "delete" :
          mutation.operation === "insert" ? "insert" :
          mutation.operation === "merge" ? "merge" :
          "replace";
        const changeRecord =
          mutation.operation === "delete"
            ? null
            : mutation.operation === "replace" && resolvedRecord !== undefined
              ? { id: mutation.id, ...resolvedRecord }
              : { id: mutation.id, ...(mutation.record || {}) };
        // FIX-REL-002: Use shared retry helper for change-tracking parity with push path
        await recordChangeWithRetry(changeTracking, {
          serverSeq,
          resource: mutation.resource,
          id: mutation.id,
          op: changeOp,
          record: changeRecord,
        }, 2, logger);
      }
    } catch (error) {
      logger?.error("Change tracking failed", { error: String(error), operation: "changeTracking", resource: mutation.resource });
      throw error;
    }
  }

  return result;
}

/**
 * Execute a single mutation
 */
export async function executeMutation(
  mutation: DFQLMutation,
  schema: DatafnSchema,
  db: Adapter,
  idempotencyStore: IdempotencyStore,
  changeTracking: ChangeTrackingService,
  plugins: DatafnPlugin[] = [],
  namespace: string,
  logger?: DatafnLogger,
): Promise<MutationResult> {
  // clientId and mutationId are optional. When absent, skip idempotency tracking.
  // EXE-009: Use crypto.randomUUID() for unpredictable anonymous mutation IDs
  const effectiveMutationId = mutation.mutationId || randomUUID();

  // Check idempotency only when both IDs are provided
  if (mutation.clientId && mutation.mutationId) {
    const cached = await idempotencyStore.get(
      mutation.clientId,
      mutation.mutationId,
    );
    if (cached) {
      return { ...cached, deduped: true };
    }
  }

  // Validate operation
  const validOps = [
    "insert",
    "merge",
    "replace",
    "delete",
    "relate",
    "modifyRelation",
    "unrelate",
  ];
  if (!validOps.includes(mutation.operation)) {
    const result: MutationResult = {
      ok: false,
      mutationId: effectiveMutationId,
      affectedIds: [],
      errors: [
        {
          code: "DFQL_UNSUPPORTED",
          message: `Unsupported DFQL feature: mutation.operation.${mutation.operation}`,
          path: "operation",
          retryable: false,
        },
      ],
      deduped: false,
    };
    if (mutation.clientId && mutation.mutationId) {
      await idempotencyStore.set(mutation.clientId, mutation.mutationId, result);
    }
    return result;
  }

  // DI-002: Guard evaluation + operation MUST run in same transaction to prevent TOCTOU.
  // When db.transaction is available and a guard is present, wrap the guard check +
  // the entire operation + change tracking in a single transaction.
  // When called from transact.ts (db is already a tx adapter), `db.transaction` on the
  // proxy still exists, but the proxy is the same instance — nested calls are safe because
  // each call to the test mock just creates a new scope; real adapters use savepoints.
  //
  // REL-011: changeTracking.withDb(db) ensures change recording uses the same db
  // that performed the operation (tx db from transact.ts, outer db from push.ts).
  const hasGuard = !!mutation.if;
  // DI-002: Use adapter capabilities to determine transaction support.
  // capabilities.transactions.supported === false means explicitly no support (e.g. memoryAdapter).
  // If capabilities are absent/incomplete (e.g. test mocks), fall back to duck-typing.
  const hasTransaction =
    (db.capabilities?.transactions?.supported !== false) &&
    typeof db.transaction === "function";

  if (hasGuard && hasTransaction) {
    // Wrap guard evaluation + full operation + change tracking in a single transaction
    let txMutationResult: MutationResult | null = null;
    let guardFailed = false;

    try {
      await (db as any).transaction(async (txDb: Adapter) => {
        // DI-002: Re-read record inside transaction to prevent TOCTOU
        const guardResult = await evaluateGuard(
          txDb,
          mutation.resource,
          mutation.id,
          mutation.if!,
          schema,
          namespace,
        );

        if (!guardResult.match) {
          guardFailed = true;
          // Signal transaction abort (will be caught below)
          throw { __datafnGuardFailed: true };
        }

        // Execute the operation within the transaction
        txMutationResult = await executeMutationCore(
          mutation,
          txDb,
          schema,
          namespace,
          effectiveMutationId,
          changeTracking.withDb(txDb),
          logger,
        );
      });
    } catch (err: any) {
      if (err?.__datafnGuardFailed) {
        guardFailed = true;
      } else if (!txMutationResult) {
        // Transaction aborted for another reason
        txMutationResult = {
          ok: false,
          mutationId: effectiveMutationId,
          affectedIds: [],
          errors: [{ code: "INTERNAL", message: err?.message || "Transaction failed", path: "$", retryable: false }],
          deduped: false,
        };
      }
    }

    if (guardFailed) {
      const result: MutationResult = {
        ok: false,
        mutationId: effectiveMutationId,
        affectedIds: [],
        errors: [{ code: "CONFLICT", message: "Guard condition not met", path: "if", retryable: false }],
        deduped: false,
      };
      if (mutation.clientId && mutation.mutationId) {
        await idempotencyStore.set(mutation.clientId, mutation.mutationId, result);
      }
      return result;
    }

    if (txMutationResult) {
      // Run search index updates outside the transaction (fail-soft)
      if ((txMutationResult as MutationResult).ok) {
        const searchPlugin = plugins.find(isSearchPlugin);
        if (searchPlugin) {
          try {
            const op = mutation.operation === "delete" ? "delete" : "upsert";
            const record = mutation.operation === "delete"
              ? { id: mutation.id }
              : { id: mutation.id, ...(mutation.record || {}) };
            await searchPlugin.updateIndices({ resource: mutation.resource, records: [record as Record<string, unknown>], operation: op });
          } catch (e) { logger?.error("Search index update failed", { error: String(e), operation: "searchIndexUpdate", resource: mutation.resource }); }
        }
      }
      if (mutation.clientId && mutation.mutationId) {
        await idempotencyStore.set(mutation.clientId, mutation.mutationId, txMutationResult as MutationResult);
      }
      return txMutationResult as MutationResult;
    }
  } else if (hasGuard) {
    // No transaction available: evaluate guard outside transaction (TOCTOU possible but rare)
    const guardResult = await evaluateGuard(
      db,
      mutation.resource,
      mutation.id,
      mutation.if!,
      schema,
      namespace,
    );

    if (!guardResult.match) {
      const result: MutationResult = {
        ok: false,
        mutationId: effectiveMutationId,
        affectedIds: [],
        errors: [
          {
            code: "CONFLICT",
            message: "Guard condition not met",
            path: "if",
            retryable: false,
          },
        ],
        deduped: false,
      };
      if (mutation.clientId && mutation.mutationId) {
        await idempotencyStore.set(
          mutation.clientId,
          mutation.mutationId,
          result,
        );
      }
      return result;
    }
  }

  // REL-011: Execute operation + change tracking using executeMutationCore.
  // changeTracking.withDb(db) ensures the change tracking uses the same db as the
  // operation — when db is a tx adapter (from transact.ts), both are in the transaction.
  const result = await executeMutationCore(
    mutation,
    db,
    schema,
    namespace,
    effectiveMutationId,
    changeTracking.withDb(db),
    logger,
  );

  // Index Updates (outside operation scope, fail-soft)
  if (result.ok) {
    const searchPlugin = plugins.find(isSearchPlugin);
    if (searchPlugin) {
      try {
        const op = mutation.operation === "delete" ? "delete" : "upsert";
        const record =
          mutation.operation === "delete"
            ? { id: mutation.id }
            : { id: mutation.id, ...(mutation.record || {}) };
        await searchPlugin.updateIndices({
          resource: mutation.resource,
          records: [record as Record<string, unknown>],
          operation: op,
        });
      } catch (e) {
        logger?.error("Search index update failed", { error: String(e), operation: "searchIndexUpdate", resource: mutation.resource });
      }
    }
  }

  // Store for idempotency only when IDs were provided
  if (mutation.clientId && mutation.mutationId) {
    await idempotencyStore.set(mutation.clientId, mutation.mutationId, result);
  }

  return result;
}
