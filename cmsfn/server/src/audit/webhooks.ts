import type { CmsfnWebhookDeliveryStatus } from "cmsfn";
import { contentfnRequest, isRecord } from "../contentfn/response.js";
export interface AuditWebhooksConfig { contentfnBaseUrl: string }
function toDelivery(value: unknown): CmsfnWebhookDeliveryStatus | null {
  if (!isRecord(value) || typeof value.webhookId !== "string" || typeof value.dataset !== "string" ||
    typeof value.url !== "string" || typeof value.eventId !== "string" || typeof value.updatedAt !== "string" ||
    typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt) || value.attempt < 0 ||
    (value.status !== "pending" && value.status !== "delivered" && value.status !== "failed") ||
    (value.lastError !== undefined && typeof value.lastError !== "string")) return null;
  return { webhookId: value.webhookId, dataset: value.dataset, url: value.url, eventId: value.eventId,
    updatedAt: value.updatedAt, attempt: value.attempt, status: value.status,
    ...(value.lastError === undefined ? {} : { lastError: value.lastError }) };
}
export function contentfnAuditWebhooks(config: AuditWebhooksConfig, input: { dataset: string; limit?: number; cursor?: string | null }) {
  return contentfnRequest(config.contentfnBaseUrl, "/contentfn/audit/webhooks", { ...input }, value => {
    if (!isRecord(value) || !Array.isArray(value.deliveries) ||
      (value.nextCursor !== null && typeof value.nextCursor !== "string")) return null;
    const deliveries: CmsfnWebhookDeliveryStatus[] = [];
    for (const raw of value.deliveries) {
      const delivery = toDelivery(raw);
      if (!delivery || delivery.dataset !== input.dataset) return null;
      deliveries.push(delivery);
    }
    return { deliveries, nextCursor: value.nextCursor };
  });
}
