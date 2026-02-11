/**
 * Push implementation - upload local mutations with change tracking
 */

import type { DatafnSchema } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import type { IdempotencyStore, MutationResult } from "../idempotency.js";
import type { SequenceStore } from "./sequence-store.js";
import { ChangeTrackingService } from "./change-tracking.js";
import { buildSchemaIndex, validatePushMutations } from "../../validation/index.js";
import {
  executeRelate,
  executeModifyRelation,
  executeUnrelate,
  normalizeRelationPayload,
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
}

/**
 * Helper to find relation definition in schema
 */
function findRelation(
  schema: DatafnSchema,
  resource: string,
  relationName: string,
) {
  return schema.relations?.find(
    (r) => r.from === resource && r.relation === relationName,
  );
}

/**
 * Extract join deltas for a relation mutation
 * Returns array of { resource, id, op, record } where:
 * - resource = join store key (e.g., "join_node_properties_property")
 * - id = composite key "${from}::${to}"
 * - op = "upsert" | "delete"
 * - record = { from, to, ...metadata } or null
 */
function extractJoinDeltas(
  mutation: any,
  schema: DatafnSchema,
): Array<{
  resource: string;
  id: string;
  op: "upsert" | "delete";
  record: Record<string, unknown> | null;
}> {
  const deltas: Array<{
    resource: string;
    id: string;
    op: "upsert" | "delete";
    record: Record<string, unknown> | null;
  }> = [];

  if (!mutation.relations) {
    return deltas;
  }

  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const relation = findRelation(schema, mutation.resource, relName);
    if (!relation) {
      continue;
    }

    // Only many-many relations produce join deltas
    if (relation.type !== "many-many") {
      continue;
    }

    const items = normalizeRelationPayload(payload);
    const joinStoreKey = `join_${mutation.resource}_${relName}_${relation.to}`;

    for (const item of items) {
      const compositeId = `${mutation.id}::${item.toId}`;

      if (mutation.operation === "relate" || mutation.operation === "modifyRelation") {
        deltas.push({
          resource: joinStoreKey,
          id: compositeId,
          op: "upsert",
          record: {
            from: mutation.id,
            to: item.toId,
            ...item.metadata,
          },
        });
      } else if (mutation.operation === "unrelate") {
        deltas.push({
          resource: joinStoreKey,
          id: compositeId,
          op: "delete",
          record: null,
        });
      }
    }
  }

  return deltas;
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
  let latestSeq = 0;

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
          await db.create({
            model: mut.resource,
            data: {
              id: mut.id,
              ...(mut.record || {}),
            },
            namespace,
          });
          opResult = { ok: true };
          break;

        case "merge":
        case "replace":
          // Use upsert semantics: first check if record exists
          try {
            const existing = await db.findOne({
              model: mut.resource,
              where: [{ field: "id", operator: "eq", value: mut.id }],
              namespace,
            });

            if (existing) {
              // Record exists, update it
              await db.update({
                model: mut.resource,
                where: [{ field: "id", operator: "eq", value: mut.id }],
                data: mut.record || {},
                namespace,
              });
            } else {
              // Record doesn't exist, create it
              await db.create({
                model: mut.resource,
                data: {
                  id: mut.id,
                  ...(mut.record || {}),
                },
                namespace,
              });
            }
            opResult = { ok: true };
          } catch (innerError) {
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

      // Record change tracking for the primary resource
      try {
        const serverSeq = await changeTracking.getNextServerSeq();
        latestSeq = Math.max(latestSeq, serverSeq);
        
        await changeTracking.recordChange({
          serverSeq,
          resource: mut.resource,
          id: mut.id,
          op: mut.operation === "delete" ? "delete" : "upsert",
          record:
            mut.operation === "delete"
              ? null
              : { id: mut.id, ...(mut.record || {}) },
        });

        // Record join deltas for relation operations
        if (
          mut.operation === "relate" ||
          mut.operation === "modifyRelation" ||
          mut.operation === "unrelate"
        ) {
          const joinDeltas = extractJoinDeltas(mut, schema);
          for (const delta of joinDeltas) {
            // Each join delta gets its own serverSeq for deterministic ordering
            const joinSeq = await changeTracking.getNextServerSeq();
            latestSeq = Math.max(latestSeq, joinSeq);

            await changeTracking.recordChange({
              serverSeq: joinSeq,
              resource: delta.resource,
              id: delta.id,
              op: delta.op,
              record: delta.record,
            });
          }
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

  return {
    ok: true,
    applied,
    errors,
    cursor: String(latestSeq),
  };
}
