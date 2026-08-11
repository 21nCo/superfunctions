/**
 * Fetch ContentFn webhook delivery status.
 * Calls ContentFn POST /contentfn/audit/webhooks.
 */

import type { CmsfnWebhookDeliveryStatus } from "cmsfn";

export interface AuditWebhooksConfig {
  contentfnBaseUrl: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function toDelivery(raw: Record<string, unknown>): CmsfnWebhookDeliveryStatus {
  return {
    webhookId: (raw.webhookId as string) ?? "",
    dataset: (raw.dataset as string) ?? "",
    url: (raw.url as string) ?? "",
    eventId: (raw.eventId as string) ?? "",
    attempt: typeof raw.attempt === "number" ? raw.attempt : 0,
    status: (raw.status as "pending" | "delivered" | "failed") ?? "pending",
    lastError: raw.lastError as string | undefined,
    updatedAt: (raw.updatedAt as string) ?? "",
  };
}

/**
 * Call ContentFn POST /contentfn/audit/webhooks with { dataset, limit?, cursor? }.
 */
export async function contentfnAuditWebhooks(
  config: AuditWebhooksConfig,
  input: { dataset: string; limit?: number; cursor?: string | null }
): Promise<
  | { ok: true; result: { deliveries: CmsfnWebhookDeliveryStatus[]; nextCursor: string | null } }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
> {
  const base = normalizeBaseUrl(config.contentfnBaseUrl);
  const body: Record<string, unknown> = { dataset: input.dataset };
  if (input.limit != null) body.limit = input.limit;
  if (input.cursor != null) body.cursor = input.cursor;
  const res = await fetch(`${base}/contentfn/audit/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: (data?.error?.code ?? "INTERNAL_ERROR") as string,
        message: (data?.error?.message ?? "Request failed") as string,
        details: (data?.error?.details ?? {}) as Record<string, unknown>,
      },
    };
  }
  const deliveries = Array.isArray(data?.result?.deliveries)
    ? (data.result.deliveries as Record<string, unknown>[]).map(toDelivery)
    : [];
  const nextCursor =
    data?.result?.nextCursor !== undefined && data?.result?.nextCursor !== null
      ? String(data.result.nextCursor)
      : null;
  return { ok: true, result: { deliveries, nextCursor } };
}
