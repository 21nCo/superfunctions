import { AUDIT_RESPONSE_MAX_BYTES, AUDIT_TIMEOUT_MS, AUDIT_MAX_LIMIT, AUDIT_MAX_OFFSET, auditOffset, cursorFor, safeAuditResponse } from "./events.js";
import { err, type CmsfnWebhookDeliveryStatus } from "cmsfn";
import { contentfnRequest, isRecord } from "../contentfn/response.js";
export interface AuditWebhooksConfig { contentfnBaseUrl: string; headers?: NonNullable<RequestInit["headers"]> }
function toDelivery(value: unknown): CmsfnWebhookDeliveryStatus | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.webhookId !== "string" || typeof value.dataset !== "string" ||
    (value.url !== null && typeof value.url !== "string") || typeof value.eventId !== "string" || typeof value.timestampKnown !== "boolean" ||
    (value.timestampKnown ? typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) : value.updatedAt !== null) ||
    typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt) || value.attempt < 0 ||
    (value.status !== "pending" && value.status !== "processing" && value.status !== "delivered" && value.status !== "failed") ||
    (value.lastError !== null && typeof value.lastError !== "string")) return null;
  let url: string | null = null;
  if (typeof value.url === "string") {
    try {
      const parsed = new URL(value.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = "";
      url = parsed.href;
    } catch { return null; }
  }
  return { webhookId: value.webhookId, dataset: value.dataset, url, eventId: value.eventId,
    updatedAt: value.updatedAt as string | null, timestampKnown: value.timestampKnown, attempt: value.attempt, status: value.status,
    ...(value.lastError === null ? {} : { lastError: value.lastError }) };
}
export function contentfnAuditWebhooks(config: AuditWebhooksConfig, input: { dataset: string; limit?: number; cursor?: string | null }) {
  const offset = auditOffset(input.dataset, input.cursor, "webhooks"), limit = input.limit ?? 100;
  if (offset === null || !Number.isSafeInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) return Promise.resolve(err("VALIDATION_FAILED", "Invalid audit pagination"));
  return contentfnRequest(config.contentfnBaseUrl, "/contentfn/audit/webhooks", { dataset: input.dataset, limit, offset }, value => {
    if (!isRecord(value) || !Array.isArray(value.records) || value.records.length > limit ||
      (value.nextOffset !== null && (!Number.isSafeInteger(value.nextOffset) || value.nextOffset !== offset + limit || value.records.length !== limit || value.nextOffset > AUDIT_MAX_OFFSET))) return null;
    const deliveries: CmsfnWebhookDeliveryStatus[] = [];
    for (const raw of value.records) {
      const delivery = toDelivery(raw);
      if (!delivery || delivery.dataset !== input.dataset) return null;
      deliveries.push(delivery);
    }
    return { deliveries, nextCursor: value.nextOffset === null ? null : cursorFor(input.dataset, value.nextOffset as number, "webhooks") };
  }, { headers: config.headers, maxResponseBytes: AUDIT_RESPONSE_MAX_BYTES, timeoutMs: AUDIT_TIMEOUT_MS, redirect: "error" }).then(safeAuditResponse);
}
