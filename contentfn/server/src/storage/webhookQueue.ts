import { auditDestinationUrl } from "./webhookAudit.js";
import { documentStorageId } from "./documentIdentity.js";
import type { ContentfnDatabase as Adapter } from "./database.js";
import { nowISO } from "../time/clock.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";

export interface WebhookQueueConfig {
  db: Adapter;
  maxAttempts?: number;
  leaseUntil?: string;
}

export interface WebhookQueueEntry {
  eventId: string;
  webhookId: string;
  attempt: number;
  nextRunAt: string;
  status: "pending" | "processing" | "delivered" | "failed";
  lastError: string | null;
}

export async function enqueueWebhookDelivery(
  config: WebhookQueueConfig,
  input: {
    eventId: string;
    webhookId: string;
  }
): Promise<void> {
  const now = nowISO();
  const event = await config.db.findOne<{ dataset: string }>({ model: CONTENTFN_TABLE_NAMES.events, where: [{ field: "eventId", operator: "eq", value: input.eventId }] });
  const hook = await config.db.findOne<{ dataset: string; url: string }>({ model: CONTENTFN_TABLE_NAMES.webhooks, where: [{ field: "webhookId", operator: "eq", value: input.webhookId }] });
  if (!event || !hook || event.dataset !== hook.dataset) throw new Error("Webhook delivery provenance is unavailable");
  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.webhookQueue,
    data: {
      id: documentStorageId(input.eventId, input.webhookId),
      eventId: input.eventId,
      webhookId: input.webhookId,
      attempt: 0,
      nextRunAt: now,
      status: "pending",
      lastError: null,
      dataset: event.dataset, destinationUrl: auditDestinationUrl(hook.url),
      updatedAt: now, timestampKnown: true, auditMetadataVersion: 1,
    },
  });
}

export async function fetchDueEntries(
  config: WebhookQueueConfig
): Promise<WebhookQueueEntry[]> {
  const now = nowISO();
  const rows = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.webhookQueue,
    where: [
      { field: "status", operator: "in" as const, value: ["pending", "processing"] },
    ],
  });

  return (rows as WebhookQueueEntry[]).filter((r) => Date.parse(r.nextRunAt) <= Date.parse(now));
}

export async function markDelivered(
  config: WebhookQueueConfig,
  eventId: string,
  webhookId: string
): Promise<void> {
  await config.db.updateMany({
    model: CONTENTFN_TABLE_NAMES.webhookQueue,
    where: [
      { field: "eventId", operator: "eq", value: eventId },
      { field: "webhookId", operator: "eq", value: webhookId },
      ...(config.leaseUntil ? [{ field: "nextRunAt", operator: "eq" as const, value: config.leaseUntil }, { field: "status", operator: "eq" as const, value: "processing" }] : []),
    ],
    data: { updatedAt: nowISO(), timestampKnown: true, status: "delivered", lastError: null },
  });
}

const MAX_RETRIES = 5;

/** A crashed worker may have reserved the final attempt without recording its result. */
export async function failExhaustedDelivery(config: WebhookQueueConfig, entry: WebhookQueueEntry): Promise<boolean | undefined> {
  if (entry.attempt < (config.maxAttempts ?? MAX_RETRIES)) return undefined;
  const count = await config.db.updateMany({ model: CONTENTFN_TABLE_NAMES.webhookQueue, where: [
    { field: "eventId", operator: "eq", value: entry.eventId },
    { field: "webhookId", operator: "eq", value: entry.webhookId },
    { field: "status", operator: "eq", value: entry.status },
    { field: "attempt", operator: "eq", value: entry.attempt },
    { field: "nextRunAt", operator: "eq", value: entry.nextRunAt },
  ], data: { updatedAt: nowISO(), timestampKnown: true, status: "failed", lastError: "Attempt limit reached; the last delivery outcome may be unknown" } });
  return count === 1;
}

export function computeBackoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 60_000);
}

export async function markFailed(
  config: WebhookQueueConfig,
  eventId: string,
  webhookId: string,
  attempt: number,
  errorMsg: string
): Promise<void> {
  const nextAttempt = attempt + 1;
  const isFinal = nextAttempt >= (config.maxAttempts ?? MAX_RETRIES);
  const backoffMs = computeBackoffMs(nextAttempt);
  const nextRunAt = new Date(Date.now() + backoffMs).toISOString().replace(/\.\d{3}Z$/, "Z");

  await config.db.updateMany({
    model: CONTENTFN_TABLE_NAMES.webhookQueue,
    where: [
      { field: "eventId", operator: "eq", value: eventId },
      { field: "webhookId", operator: "eq", value: webhookId },
      ...(config.leaseUntil ? [{ field: "nextRunAt", operator: "eq" as const, value: config.leaseUntil }, { field: "status", operator: "eq" as const, value: "processing" }] : []),
    ],
    data: { updatedAt: nowISO(), timestampKnown: true, attempt: nextAttempt, nextRunAt, status: isFinal ? "failed" : "pending", lastError: errorMsg },
  });
}

/** Compare-and-swap lease permits crash recovery without overlapping active workers. */
export async function claimDelivery(config: WebhookQueueConfig, entry: WebhookQueueEntry, leaseUntil: string): Promise<boolean> {
  const count = await config.db.updateMany({ model: CONTENTFN_TABLE_NAMES.webhookQueue, where: [
    { field: "eventId", operator: "eq", value: entry.eventId },
    { field: "webhookId", operator: "eq", value: entry.webhookId },
    { field: "status", operator: "eq", value: entry.status },
    { field: "attempt", operator: "eq", value: entry.attempt },
    { field: "nextRunAt", operator: "eq", value: entry.nextRunAt },
  ], data: { updatedAt: nowISO(), timestampKnown: true, status: "processing", nextRunAt: leaseUntil, attempt: entry.attempt + 1 } });
  return count === 1;
}

/** Missing resources are terminal, but no network send must be represented as delivered. */
export async function failUnavailableDelivery(
  config: WebhookQueueConfig & { leaseUntil: string }, eventId: string, webhookId: string,
  resource: "configuration" | "event",
): Promise<boolean> {
  const count = await config.db.updateMany({ model: CONTENTFN_TABLE_NAMES.webhookQueue, where: [
    { field: "eventId", operator: "eq", value: eventId },
    { field: "webhookId", operator: "eq", value: webhookId },
    { field: "nextRunAt", operator: "eq", value: config.leaseUntil },
    { field: "status", operator: "eq", value: "processing" },
  ], data: { status: "failed", updatedAt: nowISO(), timestampKnown: true,
    lastError: `Webhook ${resource} is unavailable; delivery was not attempted` } });
  return count === 1;
}
