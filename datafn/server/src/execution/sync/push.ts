/**
 * Push implementation - upload local mutations with change tracking
 */

import type { DatafnSchema } from "@datafn/core";
import { coerceDateFieldsToEpoch } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import type { IdempotencyStore, MutationResult } from "../idempotency.js";
import type { SequenceStore } from "./sequence-store.js";
import { ChangeTrackingService } from "./change-tracking.js";
import { buildSchemaIndex, validatePushMutations } from "../../validation/index.js";
import {
  executeRelate,
  executeModifyRelation,
  executeUnrelate,
  extractJoinDeltas,
  extractRelationFkDeltas,
} from "../mutation/relations.js";

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
): Record<string, unknown> {
  const resourceDef = schema.resources.find((r) => r.name === resource);
  if (!resourceDef || !resourceDef.fields) {
    console.warn(
      `applyDateCoercion: resource "${resource}" not found in schema — skipping date coercion. ` +
        `Known resources: ${schema.resources.map((r) => r.name).join(", ")}`,
    );
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
  onChange?: (seq: number) => void,
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

  // Schema-bounded validation of all mutations before execution
  const schemaIndex = buildSchemaIndex(schema);
  const validationResult = validatePushMutations(request.mutations, schemaIndex);
  if (!validationResult.valid) {
    return {
      ok: false,
      applied: [],
      errors: validationResult.errors.map((err) => ({
        mutationId: "",
        code: err.code,
        message: err.message,
        path: err.path,
      })),
      cursor: "0",
    };
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

  // Process each mutation
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

    // Check idempotency
    const cached = await idempotencyStore.get(mut.clientId, mut.mutationId);
    if (cached) {
      // Already applied
      if (cached.ok) {
        applied.push(mut.mutationId);
      } else {
        // Return cached error
        if (cached.errors && cached.errors.length > 0) {
          errors.push({
            mutationId: mut.mutationId,
            code: cached.errors[0].code,
            message: cached.errors[0].message,
            path: cached.errors[0].path || "$",
          });
        }
      }
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
            console.error(
              `Push operation failed [${mut.operation}] for resource "${mut.resource}", id "${mut.id}":`,
              innerError
            );
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
      console.error(
        `Push operation failed [${mut.operation}] for resource "${mut.resource}", id "${mut.id}":`,
        error
      );
      opResult = {
        ok: false,
        code: "INTERNAL",
        message: "Internal error",
        path: "$",
      };
    }

    // Store result and update lists
    if (opResult.ok) {
      applied.push(mut.mutationId);

      // Record change tracking (FIX-REL-001)
      try {
        const isRelationMutation =
          mut.operation === "relate" ||
          mut.operation === "modifyRelation" ||
          mut.operation === "unrelate";

        if (isRelationMutation) {
          // Relation mutations must NOT record a primary resource upsert with only
          // { id } — that would overwrite full records on other clients.
          // Instead: record targeted FK merge deltas (many-one/one-many) and join
          // deltas (many-many). For many-many, join deltas alone are sufficient.

          // FK merge deltas for many-one and one-many relations
          const fkDeltas = extractRelationFkDeltas(mut, schema);
          for (const delta of fkDeltas) {
            const fkSeq = await changeTracking.getNextServerSeq();
            latestSeq = Math.max(latestSeq, fkSeq);
            resourceSeqs[delta.resource] = Math.max(resourceSeqs[delta.resource] || 0, fkSeq);
            await changeTracking.recordChange({
              serverSeq: fkSeq,
              resource: delta.resource,
              id: delta.id,
              op: delta.op,
              record: delta.record,
            });
          }

          // Join deltas for many-many relations
          const joinDeltas = extractJoinDeltas(mut, schema);
          for (const delta of joinDeltas) {
            const joinSeq = await changeTracking.getNextServerSeq();
            latestSeq = Math.max(latestSeq, joinSeq);
            resourceSeqs[delta.resource] = Math.max(resourceSeqs[delta.resource] || 0, joinSeq);
            await changeTracking.recordChange({
              serverSeq: joinSeq,
              resource: delta.resource,
              id: delta.id,
              op: delta.op,
              record: delta.record,
            });
          }
        } else {
          // Regular mutations (insert/merge/replace/delete): record primary resource change
          const serverSeq = await changeTracking.getNextServerSeq();
          latestSeq = Math.max(latestSeq, serverSeq);
          resourceSeqs[mut.resource] = Math.max(resourceSeqs[mut.resource] || 0, serverSeq);

          // Coerce date fields in the change record
          const changeRecord =
            mut.operation === "delete"
              ? null
              : {
                  id: mut.id,
                  ...applyDateCoercion(schema, mut.resource, mut.record || {}),
                };

          const changeOp =
            mut.operation === "delete" ? "delete" :
            mut.operation === "insert" ? "insert" :
            mut.operation === "merge" ? "merge" :
            "replace"; // only remaining op is "replace"

          await changeTracking.recordChange({
            serverSeq,
            resource: mut.resource,
            id: mut.id,
            op: changeOp,
            record: changeRecord,
          });
        }
      } catch (error) {
        console.error("Change tracking failed in push:", error);
      }

      const result: MutationResult = {
        ok: true,
        mutationId: mut.mutationId,
        affectedIds: [mut.id],
        errors: [],
        deduped: false,
      };
      await idempotencyStore.set(mut.clientId, mut.mutationId, result);
    } else {
      errors.push({
        mutationId: mut.mutationId,
        code: opResult.code,
        message: opResult.message,
        path: opResult.path,
      });
      const result: MutationResult = {
        ok: false,
        mutationId: mut.mutationId,
        affectedIds: [],
        errors: [{ ...opResult, retryable: false }],
        deduped: false,
      };
      await idempotencyStore.set(mut.clientId, mut.mutationId, result);
    }
  }

  // Retrieve latest cursor if not updated during loop (e.g. deduped or empty)
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
