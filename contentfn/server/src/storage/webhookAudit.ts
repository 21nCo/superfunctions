import { err, ok, type ContentfnEnvelope, type WebhookAuditRecord } from "@contentfn/core";
import { wrapWithSchema, type Adapter } from "@superfunctions/db";
import type { ContentfnDatabase } from "./database.js";
import { CONTENTFN_TABLE_NAMES as TABLES, getContentfnSchema } from "./schema.js";

/** Audit never exposes URL credentials, query tokens, or fragments. Delivery keeps its original URL. */
export function auditDestinationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.href;
  } catch { return null; }
}

/** Legacy/custom worker errors are untrusted data, not safe audit metadata. */
export function auditDeliveryError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const safe = [
    "Webhook request failed",
    "Attempt limit reached; the last delivery outcome may be unknown",
    "Webhook configuration is unavailable; delivery was not attempted",
    "Webhook event is unavailable; delivery was not attempted",
  ];
  return typeof value === "string" && ((value.length === 8 && /^HTTP [1-5][0-9]{2}$/.test(value)) || safe.includes(value))
    ? value : "Webhook delivery failed";
}

interface QueueRow {
  id: string; eventId: string; webhookId: string; attempt: number;
  status: WebhookAuditRecord["status"]; lastError: string | null;
  dataset: string | null; destinationUrl: string | null; updatedAt: string | null;
  timestampKnown: boolean | null; auditMetadataVersion: number | null;
}

/** Bounded, restartable schema4 data migration. Stop legacy writers before the first call.
 * A cursor is progress only, never evidence of completeness: unresolved rows remain gated.
 * Concurrent schema4 writes retain their timestamps. Each page commits atomically.
 */
export async function backfillWebhookAudit(
  config: { db: Adapter; jsonStorage?: "native" | "json-text" },
  input: { legacyWritersStopped: true; limit?: number; afterId?: string },
): Promise<{ nextId: string | null; migrated: number; unresolvedIds: string[]; ready: boolean }> {
  if (input.legacyWritersStopped !== true) throw new TypeError("Stop all legacy ContentFn writers before backfill");
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || (input.afterId !== undefined && (typeof input.afterId !== "string" || input.afterId.length > 4096))) throw new TypeError("Invalid migration page");
  const db = wrapWithSchema(config.db, getContentfnSchema({ jsonStorage: config.jsonStorage }));
  return db.transaction(async tx => {
    const rows = await tx.findMany<QueueRow>({ model: TABLES.webhookQueue,
      where: [{ field: "auditMetadataVersion", operator: "eq", value: null }, ...(input.afterId === undefined ? [] : [{ field: "id", operator: "gt" as const, value: input.afterId }])],
      orderBy: [{ field: "id", direction: "asc" }], limit: limit + 1,
    });
    let migrated = 0;
    const unresolvedIds: string[] = [];
    for (const row of rows.slice(0, limit)) {
      const event = await tx.findOne<{ dataset: string }>({ model: TABLES.events, where: [{ field: "eventId", operator: "eq", value: row.eventId }] });
      const hook = await tx.findOne<{ dataset: string; url: string }>({ model: TABLES.webhooks, where: [{ field: "webhookId", operator: "eq", value: row.webhookId }] });
      const dataset = event?.dataset ?? hook?.dataset;
      if (!dataset || (event && hook && event.dataset !== hook.dataset)) { unresolvedIds.push(row.id); continue; }
      // Preserve known transitions; an unknown legacy time stays null, never nextRunAt.
      migrated += await tx.updateMany({ model: TABLES.webhookQueue, where: [
        { field: "id", operator: "eq", value: row.id },
        { field: "auditMetadataVersion", operator: "eq", value: null },
        { field: "updatedAt", operator: "eq", value: row.updatedAt ?? null },
      ], data: { dataset, destinationUrl: hook ? auditDestinationUrl(hook.url) : null,
        updatedAt: row.timestampKnown === true ? row.updatedAt : null,
        timestampKnown: row.timestampKnown === true, auditMetadataVersion: 1 } });
    }
    const remaining = await tx.findMany({ model: TABLES.webhookQueue, where: [{ field: "auditMetadataVersion", operator: "eq", value: null }], limit: 1 });
    return { migrated, unresolvedIds, nextId: rows.length > limit ? rows[limit - 1].id : null, ready: remaining.length === 0 };
  });
}

export async function queryWebhookAudit(
  config: { db: ContentfnDatabase; webhookAuditWriterSchemaVersion?: 4 }, input: unknown,
): Promise<ContentfnEnvelope<{ records: WebhookAuditRecord[]; nextOffset: number | null }>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return err("VALIDATION_FAILED", "Input must be an object", {});
  const value = input as Record<string, unknown>;
  const limit = value.limit ?? 100, offset = value.offset ?? 0;
  if (typeof value.dataset !== "string" || !value.dataset || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - 1001) return err("VALIDATION_FAILED", "dataset and valid bounded pagination are required", {});
  if (config.webhookAuditWriterSchemaVersion !== 4) return err("STORAGE_ERROR", "Webhook audit requires schema4 deployment acknowledgement", { reason: "WEBHOOK_AUDIT_NOT_READY" });
  // Unknown provenance may belong to any dataset, so no dataset is reported complete yet.
  const incomplete = await config.db.findMany({ model: TABLES.webhookQueue, where: [{ field: "auditMetadataVersion", operator: "eq", value: null }], limit: 1 });
  if (incomplete.length) return err("STORAGE_ERROR", "Webhook audit backfill is incomplete", { reason: "WEBHOOK_AUDIT_NOT_READY" });
  const rows = await config.db.findMany<QueueRow>({ model: TABLES.webhookQueue,
    where: [{ field: "dataset", operator: "eq", value: value.dataset }],
    orderBy: [{ field: "timestampKnown", direction: "desc" }, { field: "updatedAt", direction: "desc" }, { field: "id", direction: "asc" }], limit: limit + 1, offset,
  });
  return ok({ records: rows.slice(0, limit).map(row => ({
    id: row.id, dataset: value.dataset as string, eventId: row.eventId, webhookId: row.webhookId,
    url: row.destinationUrl === null ? null : auditDestinationUrl(row.destinationUrl),
    attempt: row.attempt, status: row.status, lastError: auditDeliveryError(row.lastError),
    updatedAt: row.timestampKnown === true ? row.updatedAt : null, timestampKnown: row.timestampKnown === true,
  })), nextOffset: rows.length > limit ? offset + limit : null });
}
