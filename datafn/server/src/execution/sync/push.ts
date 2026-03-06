/**
 * Push implementation - upload local mutations with change tracking
 */

import type { DatafnSchema } from "@datafn/core";
import { coerceDateFieldsToEpoch } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import type { IdempotencyStore, MutationResult } from "../idempotency.js";
import type { SequenceStore } from "./sequence-store.js";
import { ChangeTrackingService, recordChangeWithRetry } from "./change-tracking.js";
import {
  executeRelate,
  executeModifyRelation,
  executeUnrelate,
  extractJoinDeltas,
  extractRelationFkDeltas,
} from "../mutation/relations.js";
import { executeSchemaAwareMerge } from "../mutation/merge-decision.js";
import type { DatafnLogger } from "../../logger.js";

export interface PushRequest {
  clientId: string;
  mutations: Array<Record<string, unknown>>;
}

export interface PushResult {
  ok: boolean;
  applied: string[]; // mutationIds that were applied
  errors: Array<{
    mutationId: string;
    code: string;
    message: string;
    path: string;
  }>;
  cursor: string;
  cursorBefore?: string; // global seq before this push started; absent on early-exit error paths
  cursors?: Record<string, string>; // per-resource max serverSeq after this push
}

function applyDateCoercion(
  schema: DatafnSchema,
  resource: string,
  data: Record<string, unknown>,
  logger?: DatafnLogger,
): Record<string, unknown> {
  const resourceDef = schema.resources.find((r) => r.name === resource);
  if (!resourceDef || !resourceDef.fields) {
    logger?.warn("Resource not found in schema — skipping date coercion", {
      operation: "applyDateCoercion",
      resource,
    });
    return data;
  }
  return coerceDateFieldsToEpoch({ ...data }, resourceDef.fields);
}

/**
 * Execute push operation - apply mutations with change tracking
 */
export async function executePush(
  request: PushRequest,
  schema: DatafnSchema,
  db: Adapter,
  idempotencyStore: IdempotencyStore,
  namespace: string,
  sequenceStore?: SequenceStore,
  onChange?: (seq: number, namespace: string) => void,
  logger?: DatafnLogger,
): Promise<PushResult> {
  // Validate clientId at request level - this is a critical error
  if (!request.clientId || typeof request.clientId !== "string") {
    // Return error structure that handler will convert to error response
    return {
      ok: false,
      applied: [],
      errors: [
        {
          mutationId: "",
          code: "DFQL_INVALID",
          message: "Invalid DFQL: clientId must be string",
          path: "clientId",
        },
      ],
      cursor: "0",
    };
  }

  // Validate all mutations have matching clientId (SERVER-SYNC-CLIENTID-001)
  for (let i = 0; i < request.mutations.length; i++) {
    const mutation = request.mutations[i] as any;
    if (mutation.clientId && mutation.clientId !== request.clientId) {
      return {
        ok: false,
        applied: [],
        errors: [
          {
            mutationId: mutation.mutationId || "",
            code: "DFQL_INVALID",
            message: `Invalid DFQL: push.mutations[${i}].clientId must equal request.clientId`,
            path: `mutations[${i}].clientId`,
          },
        ],
        cursor: "0",
      };
    }
  }

  const applied: string[] = [];
  const errors: Array<{
    mutationId: string;
    code: string;
    message: string;
    path: string;
  }> = [];

  // Create change tracking service with user/tenant namespace and optional sequence store
  const changeTracking = new ChangeTrackingService(db, namespace, sequenceStore, onChange);
  // Capture the global sequence counter BEFORE any mutations are processed so the client
  // can determine whether foreign changes exist (cursorBefore == localCursor → no foreign changes)
  const cursorBeforeSeq = await changeTracking.getCurrentServerSeq();
  let latestSeq = 0;
  // Track per-resource max serverSeq so the client can advance per-table cursors (FIX-B)
  const resourceSeqs: Record<string, number> = {};

  // FIX-REL-011: Detect transaction support for atomic mutation units
  const hasTransaction =
    (db.capabilities?.transactions?.supported !== false) &&
    typeof db.transaction === "function";
  if (!hasTransaction) {
    logger?.warn("Push operating in non-atomic mode (adapter does not support transactions)", {
      operation: "push",
      namespace,
    });
  }

  // Pending change entries for a mutation that executed successfully
  type PendingChange = {
    resource: string;
    id: string;
    op: "insert" | "merge" | "replace" | "upsert" | "delete";
    record: Record<string, unknown> | null;
  };

  // Local dedup: track mutations processed in this batch (clientId:mutationId → ok)
  const batchLocalSeen = new Map<string, boolean>();

  /**
   * Execute a single push mutation's DB operation against a given adapter.
   */
  async function executeMutationOp(
    mut: any,
    targetDb: Adapter,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string; path: string }> {
    switch (mut.operation) {
      case "insert": {
        const coercedData = applyDateCoercion(schema, mut.resource, mut.record || {}, logger);
        await targetDb.create({ model: mut.resource, data: { id: mut.id, ...coercedData }, namespace });
        return { ok: true };
      }
      case "merge": {
        const coercedData = applyDateCoercion(schema, mut.resource, mut.record || {}, logger);
        const strictUpdateNotFound = targetDb.capabilities?.operations?.strictUpdateNotFound === true;
        const mergeResult = await executeSchemaAwareMerge({
          schema, resource: mut.resource, id: mut.id, delta: coercedData,
          update: async () => {
            await targetDb.update({ model: mut.resource, where: [{ field: "id", operator: "eq", value: mut.id }], data: coercedData, namespace });
          },
          create: async (record) => {
            await targetDb.create({ model: mut.resource, data: record, namespace });
          },
          ...(strictUpdateNotFound ? {} : {
            findOne: async () => targetDb.findOne({ model: mut.resource, where: [{ field: "id", operator: "eq", value: mut.id }], namespace }),
          }),
        });
        if (mergeResult.ok) return { ok: true };
        if (mergeResult.code === "NOT_FOUND") return { ok: false, code: "NOT_FOUND", message: `Record not found: ${mut.id}`, path: "id" };
        logger?.error("Push merge failed", { error: String(mergeResult.error), operation: mut.operation, resource: mut.resource, id: mut.id });
        return { ok: false, code: "INTERNAL", message: "Internal error", path: "$" };
      }
      case "replace": {
        const coercedData = applyDateCoercion(schema, mut.resource, mut.record || {}, logger);
        await targetDb.upsert({ model: mut.resource, where: [{ field: "id", operator: "eq", value: mut.id }], create: { id: mut.id, ...coercedData }, update: coercedData, namespace, conflictTarget: "id" });
        return { ok: true };
      }
      case "delete":
        await targetDb.delete({ model: mut.resource, where: [{ field: "id", operator: "eq", value: mut.id }], namespace });
        return { ok: true };
      case "relate": {
        const result = await executeRelate(targetDb, schema, mut, namespace);
        return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message, path: result.path };
      }
      case "modifyRelation": {
        const result = await executeModifyRelation(targetDb, schema, mut, namespace);
        return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message, path: result.path };
      }
      case "unrelate": {
        const result = await executeUnrelate(targetDb, schema, mut, namespace);
        return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message, path: result.path };
      }
      default:
        return { ok: false, code: "DFQL_UNSUPPORTED", message: `Unsupported DFQL feature: mutation.operation.${mut.operation}`, path: "operation" };
    }
  }

  /**
   * Build pending change entries for a successful mutation.
   */
  function buildChangeEntries(mut: any): PendingChange[] {
    const isRelationMutation = mut.operation === "relate" || mut.operation === "modifyRelation" || mut.operation === "unrelate";
    const changes: PendingChange[] = [];
    if (isRelationMutation) {
      for (const delta of extractRelationFkDeltas(mut, schema)) {
        changes.push({ resource: delta.resource, id: delta.id, op: delta.op, record: delta.record });
      }
      for (const delta of extractJoinDeltas(mut, schema)) {
        changes.push({ resource: delta.resource, id: delta.id, op: delta.op as "upsert" | "delete", record: delta.record });
      }
    } else {
      const changeRecord = mut.operation === "delete" ? null : { id: mut.id, ...applyDateCoercion(schema, mut.resource, mut.record || {}, logger) };
      const changeOp = mut.operation === "delete" ? "delete" : mut.operation === "insert" ? "insert" : mut.operation === "merge" ? "merge" : "replace";
      changes.push({ resource: mut.resource, id: mut.id, op: changeOp as "insert" | "merge" | "replace" | "delete", record: changeRecord });
    }
    return changes;
  }

  /**
   * Record a mutation as failed in errors list and idempotency store.
   */
  async function recordMutationFailure(mut: any, code: string, message: string, path: string) {
    errors.push({ mutationId: mut.mutationId, code, message, path });
    const failResult: MutationResult = {
      ok: false, mutationId: mut.mutationId, affectedIds: [],
      errors: [{ code, message, path, retryable: code === "INTERNAL" }], deduped: false,
    };
    await idempotencyStore.set(mut.clientId, mut.mutationId, failResult);
    batchLocalSeen.set(`${mut.clientId}:${mut.mutationId}`, false);
  }

  /**
   * Record a mutation as successfully applied.
   */
  async function recordMutationSuccess(mut: any) {
    applied.push(mut.mutationId);
    const result: MutationResult = {
      ok: true, mutationId: mut.mutationId, affectedIds: [mut.id], errors: [], deduped: false,
    };
    await idempotencyStore.set(mut.clientId, mut.mutationId, result);
    batchLocalSeen.set(`${mut.clientId}:${mut.mutationId}`, true);
  }

  // ---- Process each mutation ----
  for (const mutation of request.mutations) {
    const mut = mutation as any;

    // Validate required fields
    if (!mut.clientId || !mut.mutationId) {
      errors.push({ mutationId: mut.mutationId || "", code: "DFQL_INVALID", message: "Invalid DFQL: missing clientId or mutationId", path: "$" });
      continue;
    }

    const batchKey = `${mut.clientId}:${mut.mutationId}`;

    // Intra-batch dedup
    if (batchLocalSeen.has(batchKey)) {
      if (batchLocalSeen.get(batchKey)) applied.push(mut.mutationId);
      continue;
    }

    // Cross-batch dedup
    const cached = await idempotencyStore.get(mut.clientId, mut.mutationId);
    if (cached) {
      if (cached.ok) {
        applied.push(mut.mutationId);
      } else if (cached.errors?.length) {
        errors.push({ mutationId: mut.mutationId, code: cached.errors[0].code, message: cached.errors[0].message, path: cached.errors[0].path || "$" });
      }
      batchLocalSeen.set(batchKey, cached.ok);
      continue;
    }

    // FIX-REL-011: When transactions are supported, wrap operation + change tracking atomically
    if (hasTransaction) {
      let mutationSucceeded = false;
      try {
        await (db as any).transaction(async (txDb: Adapter) => {
          // Execute operation inside transaction
          const opResult = await executeMutationOp(mut, txDb);
          if (!opResult.ok) {
            // Signal failure without aborting transaction (we handle it below)
            throw { __opFailed: true, ...opResult };
          }

          // Build and record changes inside the same transaction
          const changes = buildChangeEntries(mut);
          const txChangeTracking = changeTracking.withDb(txDb);
          for (const change of changes) {
            const seq = await changeTracking.getNextServerSeq();
            latestSeq = Math.max(latestSeq, seq);
            resourceSeqs[change.resource] = Math.max(resourceSeqs[change.resource] || 0, seq);
            // FIX-REL-002: retry within transaction
            await recordChangeWithRetry(txChangeTracking, {
              serverSeq: seq, resource: change.resource, id: change.id, op: change.op, record: change.record,
            }, 2, logger);
          }
        });
        mutationSucceeded = true;
      } catch (err: any) {
        if (err?.__opFailed) {
          await recordMutationFailure(mut, err.code, err.message, err.path);
        } else {
          logger?.error("Push atomic mutation failed", { error: String(err), operation: "push.transaction", resource: mut.resource });
          await recordMutationFailure(mut, "INTERNAL", "Change tracking failed", "$");
        }
      }

      if (mutationSucceeded) {
        await recordMutationSuccess(mut);
      }
    } else {
      // Non-transaction path: execute operation, then record changes separately (best-effort)
      let opResult: { ok: true } | { ok: false; code: string; message: string; path: string };
      try {
        opResult = await executeMutationOp(mut, db);
      } catch (error) {
        logger?.error("Push operation failed", { error: String(error), operation: mut.operation, resource: mut.resource, id: mut.id });
        opResult = { ok: false, code: "INTERNAL", message: "Internal error", path: "$" };
      }

      if (opResult.ok) {
        // Record changes (non-atomic — best-effort with retry)
        const changes = buildChangeEntries(mut);
        let changeTrackingFailed = false;
        try {
          for (const change of changes) {
            const seq = await changeTracking.getNextServerSeq();
            latestSeq = Math.max(latestSeq, seq);
            resourceSeqs[change.resource] = Math.max(resourceSeqs[change.resource] || 0, seq);
            await recordChangeWithRetry(changeTracking, {
              serverSeq: seq, resource: change.resource, id: change.id, op: change.op, record: change.record,
            }, 2, logger);
          }
        } catch (error) {
          logger?.error("Change tracking failed in push after retries", { error: String(error), operation: "push.changeTracking" });
          changeTrackingFailed = true;
        }

        if (changeTrackingFailed) {
          await recordMutationFailure(mut, "INTERNAL", "Change tracking failed", "$");
        } else {
          await recordMutationSuccess(mut);
        }
      } else {
        await recordMutationFailure(mut, opResult.code, opResult.message, opResult.path);
      }
    }
  }

  // Retrieve latest cursor if not updated during loop (e.g. all deduped or empty)
  if (latestSeq === 0) {
    latestSeq = await changeTracking.getCurrentServerSeq();
  }

  // Build per-resource cursors map for client to advance per-table cursors (FIX-B)
  const cursors: Record<string, string> = {};
  for (const [resource, seq] of Object.entries(resourceSeqs)) {
    cursors[resource] = String(seq);
  }

  return {
    ok: true,
    applied,
    errors,
    cursor: String(latestSeq),
    cursorBefore: String(cursorBeforeSeq),
    cursors,
  };
}
