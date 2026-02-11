import type { Adapter } from "@superfunctions/db";
import { nowISO } from "../time/clock.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";

export interface WebhookQueueConfig {
  db: Adapter;
}

export interface WebhookQueueEntry {
  eventId: string;
  webhookId: string;
  attempt: number;
  nextRunAt: string;
  status: "pending" | "delivered" | "failed";
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
  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.webhookQueue,
    data: {
      eventId: input.eventId,
      webhookId: input.webhookId,
      attempt: 0,
      nextRunAt: now,
      status: "pending",
      lastError: null,
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
      { field: "status", operator: "eq", value: "pending" },
    ],
  });

  return (rows as WebhookQueueEntry[]).filter((r) => r.nextRunAt <= now);
}

export async function markDelivered(
  config: WebhookQueueConfig,
  eventId: string,
  webhookId: string
): Promise<void> {
  await config.db.deleteMany({
    model: CONTENTFN_TABLE_NAMES.webhookQueue,
    where: [
      { field: "eventId", operator: "eq", value: eventId },
      { field: "webhookId", operator: "eq", value: webhookId },
    ],
  });
  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.webhookQueue,
    data: {
      eventId,
      webhookId,
      attempt: 0,
      nextRunAt: nowISO(),
      status: "delivered",
      lastError: null,
    },
  });
}

const MAX_RETRIES = 5;

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
  const isFinal = nextAttempt >= MAX_RETRIES;
  const backoffMs = computeBackoffMs(nextAttempt);
  const nextRunAt = new Date(Date.now() + backoffMs).toISOString().replace(/\.\d{3}Z$/, "Z");

  await config.db.deleteMany({
    model: CONTENTFN_TABLE_NAMES.webhookQueue,
    where: [
      { field: "eventId", operator: "eq", value: eventId },
      { field: "webhookId", operator: "eq", value: webhookId },
    ],
  });
  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.webhookQueue,
    data: {
      eventId,
      webhookId,
      attempt: nextAttempt,
      nextRunAt,
      status: isFinal ? "failed" : "pending",
      lastError: errorMsg,
    },
  });
}
