import { createHash } from "node:crypto";
import type { Adapter } from "@superfunctions/db";
import type { ContentfnEnvelope } from "@contentfn/core";
import { err } from "@contentfn/core";
import { atomicMutation, type ContentfnDatabase } from "./database.js";

export const IDEMPOTENCY_TABLE = "contentfn_idempotency";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
export async function executeIdempotent(
  db: Adapter, key: string, action: string, input: Record<string, unknown>,
  operation: (db: ContentfnDatabase) => Promise<ContentfnEnvelope<unknown>>,
  onReplay?: () => void,
  publishSubject?: string,
): Promise<ContentfnEnvelope<unknown>> {
  if (!key || key.length > 200) return err("VALIDATION_FAILED", "Idempotency-Key must contain 1 to 200 characters", {});
  const dataset = typeof input.dataset === "string" ? input.dataset : "";
  const id = createHash("sha256").update(JSON.stringify([dataset, key])).digest("hex");
  const requestHash = createHash("sha256").update(JSON.stringify(action === "docs.publish" && publishSubject !== undefined ? [action, canonical(input), { contract: "publish-v1", subject: publishSubject ?? null }] : [action, canonical(input)])).digest("hex");
  const where = [{ field: "id", operator: "eq" as const, value: id }];
  const replay = (row: Record<string, unknown>) => row.requestHash === requestHash ? row.responseJson as ContentfnEnvelope<unknown> : err("VALIDATION_FAILED", "Idempotency key was already used for different input", {});
  const result = await atomicMutation(db, async transaction => {
    const existing = await transaction.findOne({ model: IDEMPOTENCY_TABLE, where });
    if (existing) { onReplay?.(); return replay(existing); }
    const response = await operation(transaction);
    if (!response.ok) return response;
    await transaction.create({ model: IDEMPOTENCY_TABLE, data: { id, dataset, requestHash, responseJson: response, createdAt: new Date().toISOString() } });
    return response;
  });
  // A concurrent transaction can win the unique-key race; read its committed result.
  if (!result.ok && result.error.code === "STORAGE_ERROR") {
    const winner = await db.findOne({ model: IDEMPOTENCY_TABLE, where });
    if (winner) { onReplay?.(); return replay(winner); }
  }
  return result;
}
