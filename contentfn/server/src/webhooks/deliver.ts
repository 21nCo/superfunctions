import type { Adapter } from "@superfunctions/db";
import { CONTENTFN_TABLE_NAMES } from "../storage/schema.js";
import type { ContentfnEvent } from "../storage/events.js";
import {
  fetchDueEntries,
  markDelivered,
  markFailed,
} from "../storage/webhookQueue.js";
import { computeWebhookSignature } from "./sign.js";

export interface DeliveryConfig {
  db: Adapter;
  fetch?: typeof globalThis.fetch;
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
    const webhookRow = await config.db.findOne({
      model: CONTENTFN_TABLE_NAMES.webhooks,
      where: [{ field: "webhookId", operator: "eq" as const, value: entry.webhookId }],
    });

    if (!webhookRow) {
      await markDelivered({ db: config.db }, entry.eventId, entry.webhookId);
      continue;
    }

    const wh = webhookRow as { url: string; secret: string | null };

    const eventRow = await config.db.findOne({
      model: CONTENTFN_TABLE_NAMES.events,
      where: [{ field: "eventId", operator: "eq" as const, value: entry.eventId }],
    });

    if (!eventRow) {
      await markDelivered({ db: config.db }, entry.eventId, entry.webhookId);
      continue;
    }

    const event = eventRow as ContentfnEvent;
    const payload = buildPayload(event);
    const bodyStr = JSON.stringify(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (wh.secret) {
      headers["X-ContentFn-Signature"] = computeWebhookSignature(bodyStr, wh.secret);
    }

    try {
      const response = await fetchFn(wh.url, {
        method: "POST",
        headers,
        body: bodyStr,
      });

      if (response.ok) {
        await markDelivered({ db: config.db }, entry.eventId, entry.webhookId);
        delivered++;
      } else {
        const errMsg = `HTTP ${response.status}`;
        await markFailed(
          { db: config.db },
          entry.eventId,
          entry.webhookId,
          entry.attempt,
          errMsg
        );
        failed++;
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await markFailed(
        { db: config.db },
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
