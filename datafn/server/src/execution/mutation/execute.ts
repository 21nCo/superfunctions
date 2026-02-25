/**
 * Mutation execution logic
 */

import type { DatafnSchema, DatafnPlugin } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import type { IdempotencyStore, MutationResult } from "../idempotency.js";
import { type DFQLMutation, buildReplaceRecord } from "./dfql.js";
import { executeRelate, executeModifyRelation, executeUnrelate, extractJoinDeltas, extractRelationFkDeltas } from "./relations.js";
import { ChangeTrackingService } from "../sync/change-tracking.js";
import { evaluateGuard } from "./guards.js";
import { isSearchPlugin } from "../../plugins/searchfn.js";

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
): Promise<MutationResult> {
  // clientId and mutationId are optional. When absent, skip idempotency tracking.
  const effectiveMutationId = mutation.mutationId || `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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

  // Evaluate if guard
  if (mutation.if) {
    const guardResult = await evaluateGuard(
      db,
      mutation.resource,
      mutation.id,
      mutation.if,
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

  // Execute operation
  let opResult:
    | { ok: true }
    | { ok: false; code: string; message: string; path: string };
  // For replace, capture the full resolved record for the changelog (FIX-A)
  let resolvedRecord: Record<string, unknown> | undefined;

  try {
    switch (mutation.operation) {
      case "insert":
        // MUT-002: Direct create without findOne pre-check
        try {
          await db.create({
            model: mutation.resource,
            data: {
              id: mutation.id,
              ...(mutation.record || {}),
            },
            namespace,
          });
          opResult = { ok: true };
        } catch (error: any) {
          const msg = (error?.message || "").toLowerCase();
          if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("already exists") || msg.includes("conflict")) {
            opResult = {
              ok: false,
              code: "CONFLICT",
              message: "Record already exists",
              path: "id",
            };
          } else {
            opResult = {
              ok: false,
              code: "INTERNAL",
              message: error?.message || "Internal error",
              path: "$",
            };
          }
        }
        break;

      case "merge":
        // MUT-001: Use db.upsert() instead of findOne + conditional create/update
        try {
          const mergeData = mutation.record || {};
          await db.upsert({
            model: mutation.resource,
            where: [{ field: "id", operator: "eq", value: mutation.id }],
            create: { id: mutation.id, ...mergeData },
            update: mergeData,
            namespace,
          });
          opResult = { ok: true };
        } catch (error) {
          opResult = {
            ok: false,
            code: "INTERNAL",
            message: "Internal error",
            path: "$",
          };
        }
        break;

      case "replace":
        // Replace semantics: MUST exist, clear unspecified fields
        try {
          const existing = await db.findOne({
            model: mutation.resource,
            where: [{ field: "id", operator: "eq", value: mutation.id }],
            namespace,
          });

          if (!existing) {
            opResult = {
              ok: false,
              code: "NOT_FOUND",
              message: `Record not found: ${mutation.id}`,
              path: "id",
            };
            break;
          }

          const buildResult = buildReplaceRecord(
            schema,
            mutation.resource,
            existing,
            mutation.record || {},
          );

          if (!buildResult.ok) {
            opResult = {
              ok: false,
              code: buildResult.code,
              message: buildResult.message,
              path: buildResult.path,
            };
            break;
          }

          // Full update
          await db.update({
            model: mutation.resource,
            where: [{ field: "id", operator: "eq", value: mutation.id }],
            data: buildResult.record,
            namespace,
          });
          // Capture the full resolved record so changelog stores the complete record (FIX-A)
          resolvedRecord = buildResult.record;
          opResult = { ok: true };
        } catch (error) {
          opResult = {
            ok: false,
            code: "INTERNAL",
            message: "Internal error",
            path: "$",
          };
        }
        break;

      case "delete":
        // Use adapter.delete
        await db.delete({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });
        opResult = { ok: true };
        break;

      case "relate":
        try {
          opResult = await executeRelate(db, schema, mutation, namespace);
        } catch (error) {
          opResult = {
            ok: false,
            code: "INTERNAL",
            message: "Internal error",
            path: "$",
          };
        }
        break;

      case "modifyRelation":
        try {
          opResult = await executeModifyRelation(db, schema, mutation, namespace);
        } catch (error) {
          opResult = {
            ok: false,
            code: "INTERNAL",
            message: "Internal error",
            path: "$",
          };
        }
        break;

      case "unrelate":
        try {
          opResult = await executeUnrelate(db, schema, mutation, namespace);
        } catch (error) {
          opResult = {
            ok: false,
            code: "INTERNAL",
            message: "Internal error",
            path: "$",
          };
        }
        break;

      default:
        opResult = {
          ok: false,
          code: "DFQL_UNSUPPORTED",
          message: `Unsupported DFQL feature: mutation.operation.${mutation.operation}`,
          path: "operation",
        };
    }
  } catch (error: any) {
    opResult = {
      ok: false,
      code: "INTERNAL",
      message: error?.message || "Internal error",
      path: "$",
    };
  }

  // Build result
  const result: MutationResult = opResult.ok
    ? {
        ok: true,
        mutationId: effectiveMutationId,
        affectedIds: [mutation.id],
        errors: [],
        deduped: false,
      }
    : {
        ok: false,
        mutationId: effectiveMutationId,
        affectedIds: [],
        errors: [
          {
            code: opResult.code,
            message: opResult.message,
            path: opResult.path,
            retryable: false,
          },
        ],
        deduped: false,
      };

  // Record change tracking for successful mutations (FIX-REL-001)
  if (opResult.ok) {
    try {
      const isRelationMutation =
        mutation.operation === "relate" ||
        mutation.operation === "modifyRelation" ||
        mutation.operation === "unrelate";

      if (isRelationMutation) {
        // Relation mutations must NOT record a primary resource upsert with only
        // { id } — that would overwrite full records on other clients.
        // Instead: record targeted FK merge deltas (many-one/one-many) and join
        // deltas (many-many). For many-many, join deltas alone are sufficient.

        // Batch allocate serverSeqs and record all relation deltas in one call (BATCH-CHG-002)
        const fkDeltas = extractRelationFkDeltas(mutation, schema);
        const joinDeltas = extractJoinDeltas(mutation, schema);
        const allDeltas = [...fkDeltas, ...joinDeltas];
        if (allDeltas.length > 0) {
          const seqs = await changeTracking.getNextServerSeqBatch(allDeltas.length);
          await changeTracking.recordChanges(
            allDeltas.map((delta, i) => ({
              serverSeq: seqs[i],
              resource: delta.resource,
              id: delta.id,
              op: delta.op,
              record: delta.record,
            }))
          );
        }
      } else {
        // Regular mutations (insert/merge/replace/delete): record primary resource change
        const serverSeq = await changeTracking.getNextServerSeq();
        // Preserve the original operation type so clients can dispatch correctly (FIX-A)
        const changeOp =
          mutation.operation === "delete" ? "delete" :
          mutation.operation === "insert" ? "insert" :
          mutation.operation === "merge" ? "merge" :
          "replace"; // only remaining op is "replace"
        // For replace, use the fully resolved record; for all others use mutation.record (FIX-A)
        const changeRecord =
          mutation.operation === "delete"
            ? null
            : mutation.operation === "replace" && resolvedRecord !== undefined
              ? { id: mutation.id, ...resolvedRecord }
              : { id: mutation.id, ...(mutation.record || {}) };
        await changeTracking.recordChange({
          serverSeq,
          resource: mutation.resource,
          id: mutation.id,
          op: changeOp,
          record: changeRecord,
        });
      }
    } catch (error) {
      // Log but don't fail the mutation if change tracking fails
      console.error("Change tracking failed:", error);
    }

    // Index Updates
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
        console.error("Search index update failed:", e);
      }
    }
  }

  // Store for idempotency only when IDs were provided
  if (mutation.clientId && mutation.mutationId) {
    await idempotencyStore.set(mutation.clientId, mutation.mutationId, result);
  }

  return result;
}
