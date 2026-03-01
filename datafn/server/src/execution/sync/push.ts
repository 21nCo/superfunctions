/**
 * Push implementation - upload local mutations with change tracking
 */

import type { DatafnSchema } from "@datafn/core";
import { coerceDateFieldsToEpoch } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import type { IdempotencyStore, MutationResult } from "../idempotency.js";
import type { SequenceStore } from "./sequence-store.js";
import { ChangeTrackingService } from "./change-tracking.js";
import {
  executeRelate,
  executeModifyRelation,
  executeUnrelate,
  extractJoinDeltas,
  extractRelationFkDeltas,
} from "../mutation/relations.js";
import type { DatafnLogger } from "../../logger.js";

export interface PushRequest {
  clientId: string;
  mutations: Array<Record<string, unknown>>;
}

/**
 * REL-002: Retry recordChange with exponential backoff (50ms, 100ms).
 * On final failure, throws so the mutation is treated as failed.
 */
async function recordChangeWithRetry(
  changeTracking: ChangeTrackingService,
  params: Parameters<ChangeTrackingService["recordChange"]>[0],
  maxRetries = 2,
): Promise<void> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      await changeTracking.recordChange(params);
      return;
    } catch (e) {
      if (i === maxRetries) throw e;
      await new Promise(r => setTimeout(r, 50 * (i + 1))); // 50ms, 100ms
    }
  }
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

  // Pending change entries for a mutation that executed successfully
  type PendingChange = {
    resource: string;
    id: string;
    op: "insert" | "merge" | "replace" | "upsert" | "delete";
    record: Record<string, unknown> | null;
  };
  type MutationWork = { mut: any; changes: PendingChange[] };

  // ---- Phase 1: Execute mutations, collect pending changes (no seq allocation) ----
  const pendingWork: MutationWork[] = [];
  // Local dedup: track mutations processed in this batch (clientId:mutationId → ok)
  const batchLocalSeen = new Map<string, boolean>();

  for (const mutation of request.mutations) {
    const mut = mutation as any;

    // Validate required fields
    if (!mut.clientId || !mut.mutationId) {
      errors.push({
        mutationId: mut.mutationId || "",
        code: "DFQL_INVALID",
        message: "Invalid DFQL: missing clientId or mutationId",
        path: "$",
      });
      continue;
    }

    const batchKey = `${mut.clientId}:${mut.mutationId}`;

    // Intra-batch dedup: if we've already processed this mutationId in this batch
    if (batchLocalSeen.has(batchKey)) {
      if (batchLocalSeen.get(batchKey)) {
        applied.push(mut.mutationId);
      }
      continue;
    }

    // Cross-batch dedup: check idempotency store
    const cached = await idempotencyStore.get(mut.clientId, mut.mutationId);
    if (cached) {
      if (cached.ok) {
        applied.push(mut.mutationId);
      } else {
        if (cached.errors && cached.errors.length > 0) {
          errors.push({
            mutationId: mut.mutationId,
            code: cached.errors[0].code,
            message: cached.errors[0].message,
            path: cached.errors[0].path || "$",
          });
        }
      }
      batchLocalSeen.set(batchKey, cached.ok);
      continue;
    }

    // Execute operation using Adapter
    let opResult:
      | { ok: true }
      | { ok: false; code: string; message: string; path: string };

    try {
      switch (mut.operation) {
        case "insert":
          {
            const coercedData = applyDateCoercion(
              schema,
              mut.resource,
              mut.record || {},
              logger,
            );
            await db.create({
              model: mut.resource,
              data: {
                id: mut.id,
                ...coercedData,
              },
              namespace,
            });
            opResult = { ok: true };
          }
          break;

        case "merge":
        case "replace":
          // MUT-003: Use db.upsert() instead of findOne + conditional create/update
          try {
            const coercedData = applyDateCoercion(
              schema,
              mut.resource,
              mut.record || {},
              logger,
            );

            await db.upsert({
              model: mut.resource,
              where: [{ field: "id", operator: "eq", value: mut.id }],
              create: { id: mut.id, ...coercedData },
              update: coercedData,
              namespace,
            });
            opResult = { ok: true };
          } catch (innerError) {
            logger?.error("Push operation failed", {
              error: String(innerError),
              operation: mut.operation,
              resource: mut.resource,
              id: mut.id,
            });
            opResult = {
              ok: false,
              code: "INTERNAL",
              message: "Internal error",
              path: "$",
            };
          }
          break;

        case "delete":
          await db.delete({
            model: mut.resource,
            where: [{ field: "id", operator: "eq", value: mut.id }],
            namespace,
          });
          opResult = { ok: true };
          break;

        case "relate":
          {
            const result = await executeRelate(db, schema, mut, namespace);
            if (result.ok) {
              opResult = { ok: true };
            } else {
              opResult = {
                ok: false,
                code: result.code,
                message: result.message,
                path: result.path,
              };
            }
          }
          break;

        case "modifyRelation":
          {
            const result = await executeModifyRelation(db, schema, mut, namespace);
            if (result.ok) {
              opResult = { ok: true };
            } else {
              opResult = {
                ok: false,
                code: result.code,
                message: result.message,
                path: result.path,
              };
            }
          }
          break;

        case "unrelate":
          {
            const result = await executeUnrelate(db, schema, mut, namespace);
            if (result.ok) {
              opResult = { ok: true };
            } else {
              opResult = {
                ok: false,
                code: result.code,
                message: result.message,
                path: result.path,
              };
            }
          }
          break;

        default:
          opResult = {
            ok: false,
            code: "DFQL_UNSUPPORTED",
            message: `Unsupported DFQL feature: mutation.operation.${mut.operation}`,
            path: "operation",
          };
      }
    } catch (error) {
      logger?.error("Push operation failed", {
        error: String(error),
        operation: mut.operation,
        resource: mut.resource,
        id: mut.id,
      });
      opResult = {
        ok: false,
        code: "INTERNAL",
        message: "Internal error",
        path: "$",
      };
    }

    if (opResult.ok) {
      // Collect change entries WITHOUT allocating sequences yet (PER-001)
      const isRelationMutation =
        mut.operation === "relate" ||
        mut.operation === "modifyRelation" ||
        mut.operation === "unrelate";

      const changes: PendingChange[] = [];
      if (isRelationMutation) {
        // Relation mutations: FK deltas and join deltas
        const fkDeltas = extractRelationFkDeltas(mut, schema);
        for (const delta of fkDeltas) {
          changes.push({
            resource: delta.resource,
            id: delta.id,
            op: delta.op,
            record: delta.record,
          });
        }
        const joinDeltas = extractJoinDeltas(mut, schema);
        for (const delta of joinDeltas) {
          changes.push({
            resource: delta.resource,
            id: delta.id,
            op: delta.op as "upsert" | "delete",
            record: delta.record,
          });
        }
      } else {
        // Regular mutations: single change entry
        const changeRecord =
          mut.operation === "delete"
            ? null
            : {
                id: mut.id,
                ...applyDateCoercion(schema, mut.resource, mut.record || {}, logger),
              };
        const changeOp =
          mut.operation === "delete" ? "delete" :
          mut.operation === "insert" ? "insert" :
          mut.operation === "merge" ? "merge" :
          "replace"; // only remaining op is "replace"
        changes.push({
          resource: mut.resource,
          id: mut.id,
          op: changeOp as "insert" | "merge" | "replace" | "delete",
          record: changeRecord,
        });
      }
      pendingWork.push({ mut, changes });
      batchLocalSeen.set(batchKey, true);
    } else {
      // Execution failed — store immediately in idempotency (enables intra-batch dedup)
      errors.push({
        mutationId: mut.mutationId,
        code: opResult.code,
        message: opResult.message,
        path: opResult.path,
      });
      const failResult: MutationResult = {
        ok: false,
        mutationId: mut.mutationId,
        affectedIds: [],
        errors: [{ ...opResult, retryable: false }],
        deduped: false,
      };
      await idempotencyStore.set(mut.clientId, mut.mutationId, failResult);
      batchLocalSeen.set(batchKey, false);
    }
  }

  // ---- Phase 2: Batch allocate all serverSeqs in ONE call (PER-001) ----
  const totalSeqs = pendingWork.reduce((sum, w) => sum + w.changes.length, 0);
  const seqBatch: number[] = totalSeqs > 0
    ? await changeTracking.getNextServerSeqBatch(totalSeqs)
    : [];

  // ---- Phase 3: Record changes and finalize idempotency results ----
  let seqIdx = 0;
  for (const { mut, changes } of pendingWork) {
    // REL-002: Record change tracking with retry — failure propagates as mutation error
    let changeTrackingFailed = false;
    try {
      for (const change of changes) {
        const seq = seqBatch[seqIdx++];
        latestSeq = Math.max(latestSeq, seq);
        resourceSeqs[change.resource] = Math.max(resourceSeqs[change.resource] || 0, seq);
        // Individual entry retry (REL-002)
        await recordChangeWithRetry(changeTracking, {
          serverSeq: seq,
          resource: change.resource,
          id: change.id,
          op: change.op,
          record: change.record,
        });
      }
    } catch (error) {
      logger?.error("Change tracking failed in push after retries", {
        error: String(error),
        operation: "push.changeTracking",
      });
      changeTrackingFailed = true;
    }

    if (changeTrackingFailed) {
      // REL-002: Mutation goes to errors, not applied
      errors.push({
        mutationId: mut.mutationId,
        code: "INTERNAL",
        message: "Change tracking failed",
        path: "$",
      });
      const result: MutationResult = {
        ok: false,
        mutationId: mut.mutationId,
        affectedIds: [],
        errors: [{ ok: false, code: "INTERNAL", message: "Change tracking failed", path: "$", retryable: true }],
        deduped: false,
      };
      await idempotencyStore.set(mut.clientId, mut.mutationId, result);
    } else {
      applied.push(mut.mutationId);
      const result: MutationResult = {
        ok: true,
        mutationId: mut.mutationId,
        affectedIds: [mut.id],
        errors: [],
        deduped: false,
      };
      await idempotencyStore.set(mut.clientId, mut.mutationId, result);
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
