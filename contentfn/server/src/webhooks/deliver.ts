import type { ContentfnDatabase as Adapter } from "../storage/database.js";
import { CONTENTFN_TABLE_NAMES } from "../storage/schema.js";
import type { ContentfnEvent } from "../storage/events.js";
import {
  fetchDueEntries,
  claimDelivery,
  markDelivered,
  markFailed,
} from "../storage/webhookQueue.js";
import { computeWebhookSignature } from "./sign.js";

export interface DeliveryConfig {
  db: Adapter;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  logger?: import("../logging/logger.js").ContentfnLogger;
}

export interface WebhookPayload {
  eventId: string;
  dataset: string;
  type: string;
  timestamp: string;
  actor?: { subject: string };
  document?: { _id: string; _type?: string; _rev?: string };
  diff?: { changedPaths: string[] };
}

function buildPayload(event: ContentfnEvent): WebhookPayload {
  const payload: WebhookPayload = {
    eventId: event.eventId,
    dataset: event.dataset,
    type: event.type,
    timestamp: event.timestamp,
  };
  if (event.actor) {
    payload.actor = event.actor;
  }
  if (event.docId) {
    payload.document = { _id: event.docId };
    if (event.rev) {
      payload.document._rev = event.rev;
    }
  }
  if (event.changedPaths && event.changedPaths.length > 0) {
    payload.diff = { changedPaths: event.changedPaths };
  }
  return payload;
}

export async function enqueueForEvent(
  config: { db: Adapter },
  event: ContentfnEvent
): Promise<void> {
  const webhookRows = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.webhooks,
    where: [{ field: "dataset", operator: "eq" as const, value: event.dataset }],
  });

  for (const row of webhookRows as Array<{
    webhookId: string;
    events: string[];
  }>) {
    if (row.events.includes(event.type)) {
      const { enqueueWebhookDelivery } = await import("../storage/webhookQueue.js");
      await enqueueWebhookDelivery(
        { db: config.db },
        { eventId: event.eventId, webhookId: row.webhookId }
      );
    }
  }
}

export async function processWebhookQueue(config: DeliveryConfig): Promise<{
  delivered: number;
  failed: number;
}> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const dueEntries = await fetchDueEntries({ db: config.db });
  let delivered = 0;
  let failed = 0;

  for (const entry of dueEntries) {
    const leaseUntil = new Date(Date.now() + (config.timeoutMs ?? 10_000) + 5000).toISOString();
    if (!await claimDelivery({ db: config.db }, entry, leaseUntil)) continue;
    const webhookRow = await config.db.findOne({
      model: CONTENTFN_TABLE_NAMES.webhooks,
      where: [{ field: "webhookId", operator: "eq" as const, value: entry.webhookId }],
    });

    if (!webhookRow) {
      await markDelivered({ db: config.db, leaseUntil }, entry.eventId, entry.webhookId);
      continue;
    }

    const wh = webhookRow as { url: string; secret: string | null };

    const eventRow = await config.db.findOne({
      model: CONTENTFN_TABLE_NAMES.events,
      where: [{ field: "eventId", operator: "eq" as const, value: entry.eventId }],
    });

    if (!eventRow) {
      await markDelivered({ db: config.db, leaseUntil }, entry.eventId, entry.webhookId);
      continue;
    }

    const event = eventRow as ContentfnEvent;
    const payload = buildPayload(event);
    if (payload.document && event.rev) {
      const snapshot = await config.db.findOne({ model: CONTENTFN_TABLE_NAMES.revisions, where: [
        { field: "dataset", operator: "eq", value: event.dataset },
        { field: "rev", operator: "eq", value: event.rev },
      ] });
      const document = snapshot?.docJson as Record<string, unknown> | undefined;
      if (typeof document?._type === "string") payload.document._type = document._type;
    }
    const bodyStr = JSON.stringify(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (wh.secret) {
      headers["X-ContentFn-Signature"] = computeWebhookSignature(bodyStr, wh.secret);
    }

    try { config.logger?.logMutation({ action: "webhooks.delivery_attempt", dataset: event.dataset }); } catch { /* Observability must not prevent delivery. */ }
    try {
      const response = await fetchFn(wh.url, {
        method: "POST",
        headers,
        body: bodyStr,
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      });

      await response.body?.cancel();
      if (response.ok) {
        await markDelivered({ db: config.db, leaseUntil }, entry.eventId, entry.webhookId);
        delivered++;
      } else {
        const errMsg = `HTTP ${response.status}`;
        try { config.logger?.logWebhookFailure({ dataset: event.dataset, webhookUrl: new URL(wh.url).origin, error: errMsg }); } catch {}
        await markFailed(
          { db: config.db, maxAttempts: config.maxAttempts, leaseUntil },
          entry.eventId,
          entry.webhookId,
          entry.attempt,
          errMsg
        );
        failed++;
      }
    } catch (error) {
      const errMsg = "Webhook request failed";
      try { config.logger?.logWebhookFailure({ dataset: event.dataset, webhookUrl: new URL(wh.url).origin, error: errMsg }); } catch {}
      await markFailed(
        { db: config.db, maxAttempts: config.maxAttempts, leaseUntil },
        entry.eventId,
        entry.webhookId,
        entry.attempt,
        errMsg
      );
      failed++;
    }
  }

  return { delivered, failed };
}
