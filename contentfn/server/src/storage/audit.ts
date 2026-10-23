import { randomUUID } from "node:crypto";
import { err, ok, type ContentfnEnvelope } from "@contentfn/core";
import type { ContentfnDatabase } from "./database.js";

export const AUDIT_TABLE = "contentfn_audit";
import type { AuditRecord } from "@contentfn/core";
export type { AuditRecord, AuditQuery } from "@contentfn/core";

/** Called inside the mutation transaction. Never persist input bodies or credentials. */
export async function appendAudit(db: ContentfnDatabase, action: string, input: Record<string, unknown>, result: unknown, subject?: string): Promise<void> {
  const output = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const ids: unknown[] = [input.dataset];
  if (action.startsWith("docs.")) ids.push(output._id ?? input.id);
  if (action === "docs.schedule") ids.push(output.scheduleId);
  if (action === "assets.upload") ids.push(output.assetId);
  if (action === "webhooks.register") ids.push(output.webhookId);
  if (action === "webhooks.delete") ids.push(input.webhookId);
  await db.create({ model: AUDIT_TABLE, data: {
    id: randomUUID(), dataset: String(input.dataset ?? ""), action,
    actor: subject === undefined ? null : { subject },
    targetIds: [...new Set(ids.filter((value): value is string => typeof value === "string"))],
    timestamp: new Date().toISOString(),
  } });
}

export async function queryAudit(config: { db: ContentfnDatabase }, input: unknown): Promise<ContentfnEnvelope<{ records: AuditRecord[]; nextOffset: number | null }>> {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value.dataset !== "string" || !value.dataset || (value.action !== undefined && typeof value.action !== "string")) return err("VALIDATION_FAILED", "dataset and an optional action string are required", {});
  const limit = value.limit ?? 100, offset = value.offset ?? 0;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 1000 || !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > Number.MAX_SAFE_INTEGER - 1001) return err("VALIDATION_FAILED", "limit must be 1 to 1000 and offset a nonnegative safe integer", {});
  const rows = await config.db.findMany({ model: AUDIT_TABLE,
    where: [{ field: "dataset", operator: "eq", value: value.dataset }, ...(value.action === undefined ? [] : [{ field: "action", operator: "eq" as const, value: value.action }])],
    orderBy: [{ field: "timestamp", direction: "asc" }, { field: "id", direction: "asc" }],
    limit: (limit as number) + 1, offset: offset as number,
  });
  return ok({ records: rows.slice(0, limit as number) as unknown as AuditRecord[], nextOffset: rows.length > (limit as number) ? (offset as number) + (limit as number) : null });
}
