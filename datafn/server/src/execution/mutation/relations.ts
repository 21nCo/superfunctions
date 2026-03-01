/**
 * Relation mutation operations (relate, modifyRelation, unrelate)
 */

import type { DatafnSchema, DatafnRelationSchema } from "@datafn/core";
import { getJoinStoreKey, getJoinTableName, type NormalizedRelation, normalizeRelationPayload } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import type { DFQLMutation } from "./dfql.js";

// NormalizedRelation and normalizeRelationPayload are imported from @datafn/core above.
export type { NormalizedRelation };
export { normalizeRelationPayload };

/**
 * Find relation definition (forward-only — intentional for mutation executor).
 */
function findRelation(
  schema: DatafnSchema,
  resource: string,
  relationName: string,
): DatafnRelationSchema | undefined {
  return schema.relations?.find(
    (r) => r.from === resource && r.relation === relationName,
  );
}

/**
 * Execute relate operation
 */
export async function executeRelate(
  adapter: Adapter,
  schema: DatafnSchema,
  mutation: DFQLMutation,
  namespace: string,
): Promise<{ ok: true; affectedIds: string[] } | { ok: false; code: string; message: string; path: string }> {
  if (!mutation.relations) {
    return { ok: true, affectedIds: [mutation.id] };
  }

  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const relation = findRelation(schema, mutation.resource, relName);
    if (!relation) {
      return {
        ok: false,
        code: "DFQL_UNKNOWN_RELATION",
        message: `Unknown relation: ${relName}`,
        path: `relations.${relName}`,
      };
    }

    const items = normalizeRelationPayload(payload);

    // Batch validate targets exist (REL-OPT-001)
    if (items.length > 0) {
      const targetIds = items.map(i => i.toId);
      const existingTargets = await adapter.findMany({
        model: relation.to,
        where: [{ field: "id", operator: "in", value: targetIds }],
        namespace,
      });
      const existingTargetIds = new Set(existingTargets.map((t: any) => t.id));
      const missingId = targetIds.find(id => !existingTargetIds.has(id));
      if (missingId !== undefined) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: `Related record not found: ${missingId}`,
          path: `relations.${relName}`,
        };
      }
    }

    if (relation.type === "many-one") {
      // Update FK on source record (mutation.id)
      // Expect single target
      if (items.length !== 1) {
        return {
          ok: false,
          code: "DFQL_INVALID",
          message: "many-one relation expects single target",
          path: `relations.${relName}`,
        };
      }
      const fkField = relation.fkField || `${relName}Id`; // Default convention or schema
      // We assume adapter update handles simple field update
      await adapter.update({
        model: mutation.resource,
        where: [{ field: "id", operator: "eq", value: mutation.id }],
        data: { [fkField]: items[0].toId },
        namespace,
      });
    } else if (relation.type === "one-many") {
      // Update FK on target records (to point to mutation.id)
      const fkField = relation.fkField || relation.inverse || `${relation.from}Id`; // Inverse side FK
      // PER-004: Batch update when adapter supports it and there are multiple items
      if (items.length > 1 && adapter.capabilities.operations.batch) {
        const targetIds = items.map(i => i.toId);
        await adapter.updateMany({
          model: relation.to,
          where: [{ field: "id", operator: "in", value: targetIds }],
          data: { [fkField]: mutation.id },
          namespace,
        });
      } else {
        for (const item of items) {
          await adapter.update({
            model: relation.to,
            where: [{ field: "id", operator: "eq", value: item.toId }],
            data: { [fkField]: mutation.id },
            namespace,
          });
        }
      }
    } else if (relation.type === "many-many") {
      const tableName = getJoinTableName(mutation.resource, relName, relation.joinTable);
      const fromCol = relation.joinColumns?.from || "from";
      const toCol = relation.joinColumns?.to || "to";

      // Use upsert per join item instead of findOne + conditional create/update (REL-OPT-002)
      // Target the `id` column (PK) for conflict detection, not (from, to) which may lack a unique constraint.
      // The composite id `${from}:${to}` guarantees the same uniqueness semantics.
      for (const item of items) {
        const compositeId = `${mutation.id}:${item.toId}`;
        await adapter.upsert({
          model: tableName,
          where: [
            { field: "id", operator: "eq", value: compositeId },
          ],
          create: {
            id: compositeId,
            [fromCol]: mutation.id,
            [toCol]: item.toId,
            ...item.metadata,
          },
          update: Object.keys(item.metadata).length > 0 ? item.metadata : {},
          namespace,
          conflictTarget: "id",
        });
      }
    }
  }

  return { ok: true, affectedIds: [mutation.id] };
}

/**
 * Execute modifyRelation operation
 */
export async function executeModifyRelation(
  adapter: Adapter,
  schema: DatafnSchema,
  mutation: DFQLMutation,
  namespace: string,
): Promise<{ ok: true; affectedIds: string[] } | { ok: false; code: string; message: string; path: string }> {
  if (!mutation.relations) {
    return { ok: true, affectedIds: [mutation.id] };
  }

  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const relation = findRelation(schema, mutation.resource, relName);
    if (!relation) {
        return {
          ok: false,
          code: "DFQL_UNKNOWN_RELATION",
          message: `Unknown relation: ${relName}`,
          path: `relations.${relName}`,
        };
    }

    if (relation.type !== "many-many") {
         return {
          ok: false,
          code: "DFQL_UNSUPPORTED",
          message: `modifyRelation only supported for many-many relations`,
          path: `relations.${relName}`,
        };
    }

    const items = normalizeRelationPayload(payload);
    const tableName = getJoinTableName(mutation.resource, relName, relation.joinTable);
    const fromCol = relation.joinColumns?.from || "from";
    const toCol = relation.joinColumns?.to || "to";

    for (const item of items) {
      // DI-001: Atomic findOne + update to prevent TOCTOU race.
      // Wrap in transaction when adapter supports it; otherwise execute sequentially.
      const performModify = async (adp: typeof adapter): Promise<"ok" | "not_found"> => {
        const existing = await adp.findOne({
          model: tableName,
          where: [
            { field: fromCol, operator: "eq", value: mutation.id },
            { field: toCol, operator: "eq", value: item.toId },
          ],
          namespace,
        });
        if (!existing) return "not_found";
        await adp.update({
          model: tableName,
          where: [
            { field: fromCol, operator: "eq", value: mutation.id },
            { field: toCol, operator: "eq", value: item.toId },
          ],
          data: item.metadata,
          namespace,
        });
        return "ok";
      };

      let itemResult: "ok" | "not_found";
      // DI-001: capabilities.transactions.supported === false means explicitly no support (e.g. memoryAdapter).
      // If capabilities are absent/incomplete (test mocks), fall back to duck-typing.
      if ((adapter.capabilities?.transactions?.supported !== false) && typeof adapter.transaction === "function") {
        let txOutcome: "ok" | "not_found" = "ok";
        await adapter.transaction(async (txAdp: typeof adapter) => {
          txOutcome = await performModify(txAdp as any);
        });
        itemResult = txOutcome;
      } else {
        itemResult = await performModify(adapter);
      }

      if (itemResult === "not_found") {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: `Relation not found between ${mutation.id} and ${item.toId}`,
          path: `relations.${relName}`,
        };
      }
    }
  }
  return { ok: true, affectedIds: [mutation.id] };
}

/**
 * Minimal mutation shape needed for change-delta helpers
 */
interface RelationMutationInput {
  operation: string;
  resource: string;
  id: string;
  relations?: Record<string, unknown>;
}

/**
 * Extract join deltas for a relation mutation (many-many only).
 * Returns array of { resource, id, op, record } for join store changes.
 * Used by change-tracking in both push.ts and execute.ts.
 */
export function extractJoinDeltas(
  mutation: RelationMutationInput,
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
    const joinStoreKey = getJoinStoreKey(mutation.resource, relName, relation.to as string);

    for (const item of items) {
      const compositeId = `${mutation.id}:${item.toId}`;

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
          record: {
            from: mutation.id,
            to: item.toId,
          },
        });
      }
    }
  }

  return deltas;
}

/**
 * Extract FK change deltas for relation mutations on non-many-many relations.
 *
 * - many-one relate:   merge on source resource with FK = target id
 * - many-one unrelate: merge on source resource with FK = null
 * - one-many relate:   merge on each target resource with FK = source id
 * - one-many unrelate: merge on each target resource with FK = null
 * - many-many / modifyRelation: returns empty (join deltas handle propagation)
 *
 * Used by change-tracking in both push.ts and execute.ts to avoid recording a
 * spurious { op: "upsert", record: { id } } entry for the primary resource,
 * which would overwrite full records on other clients (FIX-REL-001).
 */
export function extractRelationFkDeltas(
  mutation: RelationMutationInput,
  schema: DatafnSchema,
): Array<{
  resource: string;
  id: string;
  op: "merge";
  record: Record<string, unknown>;
}> {
  const deltas: Array<{
    resource: string;
    id: string;
    op: "merge";
    record: Record<string, unknown>;
  }> = [];

  if (!mutation.relations) {
    return deltas;
  }

  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const relation = findRelation(schema, mutation.resource, relName);
    if (!relation) {
      continue;
    }

    // many-many: join deltas handle propagation; no FK on primary resource changes
    // modifyRelation: only applies to many-many, so also skip
    if (relation.type === "many-many" || mutation.operation === "modifyRelation") {
      continue;
    }

    const items = normalizeRelationPayload(payload);

    if (relation.type === "many-one") {
      // FK lives on the source record (mutation.resource)
      const fkField = relation.fkField || `${relName}Id`;
      const fkValue = mutation.operation === "unrelate" ? null : (items[0]?.toId ?? null);
      deltas.push({
        resource: mutation.resource,
        id: mutation.id,
        op: "merge",
        record: { id: mutation.id, [fkField]: fkValue },
      });
    } else if (relation.type === "one-many") {
      // FK lives on each target record (relation.to)
      const fkField =
        relation.fkField ||
        (relation.inverse as string | undefined) ||
        `${relation.from}Id`;
      const fkValue = mutation.operation === "unrelate" ? null : mutation.id;
      for (const item of items) {
        deltas.push({
          resource: relation.to as string,
          id: item.toId,
          op: "merge",
          record: { id: item.toId, [fkField]: fkValue },
        });
      }
    }
  }

  return deltas;
}

/**
 * Execute unrelate operation
 */
export async function executeUnrelate(
    adapter: Adapter,
    schema: DatafnSchema,
    mutation: DFQLMutation,
    namespace: string,
  ): Promise<{ ok: true; affectedIds: string[] } | { ok: false; code: string; message: string; path: string }> {
    if (!mutation.relations) {
      return { ok: true, affectedIds: [mutation.id] };
    }
  
    for (const [relName, payload] of Object.entries(mutation.relations)) {
      const relation = findRelation(schema, mutation.resource, relName);
      if (!relation) {
         return {
            ok: false,
            code: "DFQL_UNKNOWN_RELATION",
            message: `Unknown relation: ${relName}`,
            path: `relations.${relName}`,
          };
      }
  
      const items = normalizeRelationPayload(payload);
  
      if (relation.type === "many-one") {
        // Clear FK on source
        const fkField = relation.fkField || `${relName}Id`;
        await adapter.update({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          data: { [fkField]: null },
          namespace,
        });
      } else if (relation.type === "one-many") {
        // Clear FK on target
        const fkField = relation.fkField || relation.inverse || `${relation.from}Id`;
        // PER-004: Batch update when adapter supports it and there are multiple items
        if (items.length > 1 && adapter.capabilities.operations.batch) {
          const targetIds = items.map(i => i.toId);
          await adapter.updateMany({
            model: relation.to,
            where: [{ field: "id", operator: "in", value: targetIds }],
            data: { [fkField]: null },
            namespace,
          });
        } else {
          for (const item of items) {
            await adapter.update({
              model: relation.to,
              where: [{ field: "id", operator: "eq", value: item.toId }],
              data: { [fkField]: null },
              namespace,
            });
          }
        }
      } else if (relation.type === "many-many") {
        const tableName = getJoinTableName(mutation.resource, relName, relation.joinTable);
        const fromCol = relation.joinColumns?.from || "from";
        const toCol = relation.joinColumns?.to || "to";

        // PER-004: Batch delete when adapter supports it and there are multiple items
        if (items.length > 1 && adapter.capabilities.operations.batch) {
          const toIds = items.map(i => i.toId);
          await adapter.deleteMany({
            model: tableName,
            where: [
              { field: fromCol, operator: "eq", value: mutation.id },
              { field: toCol, operator: "in", value: toIds },
            ],
            namespace,
          });
        } else {
          for (const item of items) {
            await adapter.delete({
              model: tableName,
              where: [
                { field: fromCol, operator: "eq", value: mutation.id },
                { field: toCol, operator: "eq", value: item.toId },
              ],
              namespace,
            });
          }
        }
      }
    }
  
    return { ok: true, affectedIds: [mutation.id] };
  }
