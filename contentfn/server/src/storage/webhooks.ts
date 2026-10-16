import type { ContentfnDatabase as Adapter } from "./database.js";
import type { ContentfnEnvelope } from "@contentfn/core";
import { ok, err } from "@contentfn/core";
import { nowISO } from "../time/clock.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";
import { datasetExists } from "./datasets.js";

export interface WebhooksStorageConfig {
  db: Adapter;
}

function isValidUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

function generateWebhookId(): string {
  return `wh_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

export async function webhookRegister(
  config: WebhooksStorageConfig,
  input: {
    dataset: string;
    url: string;
    events: string[];
    secret?: string;
  }
): Promise<ContentfnEnvelope<{ webhookId: string }>> {
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  if (!isValidUrl(input.url)) {
    return err("VALIDATION_FAILED", "Invalid webhook URL", { path: "url" });
  }

  if (!Array.isArray(input.events) || input.events.length === 0 || input.events.some(event => !["doc.created", "doc.updated", "doc.deleted", "doc.published", "doc.unpublished", "asset.created"].includes(event))) {
    return err("VALIDATION_FAILED", "events must be a non-empty array", { path: "events" });
  }

  const webhookId = generateWebhookId();
  const now = nowISO();

  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.webhooks,
    data: {
      webhookId,
      dataset: input.dataset,
      url: input.url,
      secret: input.secret ?? null,
      events: input.events,
      createdAt: now,
    },
  });

  return ok({ webhookId });
}

export async function webhookList(
  config: WebhooksStorageConfig,
  input: { dataset: string }
): Promise<ContentfnEnvelope<{ webhooks: Array<{ webhookId: string; url: string; events: string[] }> }>> {
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const rows = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.webhooks,
    where: [{ field: "dataset", operator: "eq" as const, value: input.dataset }],
  });

  const webhooks = (rows as Array<{ webhookId: string; url: string; events: string[] }>).map((r) => ({
    webhookId: r.webhookId,
    url: r.url,
    events: r.events,
  }));

  return ok({ webhooks });
}

export async function webhookDelete(
  config: WebhooksStorageConfig,
  input: { dataset: string; webhookId: string }
): Promise<ContentfnEnvelope<Record<string, never>>> {
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const row = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.webhooks,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "webhookId", operator: "eq" as const, value: input.webhookId },
    ],
  });

  if (!row) {
    return err("WEBHOOK_NOT_FOUND", "Webhook not found", { webhookId: input.webhookId });
  }

  await config.db.deleteMany({
    model: CONTENTFN_TABLE_NAMES.webhooks,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "webhookId", operator: "eq" as const, value: input.webhookId },
    ],
  });

  return ok({});
}

/** Dataset-scoped delivery status; authorization is enforced by the API boundary. */
export async function webhookDeliveries(config: WebhooksStorageConfig, body: unknown) {
  if (!body || typeof body !== "object") return err("VALIDATION_FAILED", "Input must be an object", {});
  const input = body as Record<string, unknown>;
  if (typeof input.dataset !== "string" || typeof input.webhookId !== "string") return err("VALIDATION_FAILED", "dataset and webhookId are required", {});
  const hook = await config.db.findOne({ model: CONTENTFN_TABLE_NAMES.webhooks, where: [
    { field: "dataset", operator: "eq", value: input.dataset },
    { field: "webhookId", operator: "eq", value: input.webhookId },
  ] });
  if (!hook) return err("VALIDATION_FAILED", "Webhook not found in dataset", {});
  const deliveries = await config.db.findMany({ model: CONTENTFN_TABLE_NAMES.webhookQueue, where: [{ field: "webhookId", operator: "eq", value: input.webhookId }], orderBy: [{ field: "nextRunAt", direction: "desc" }, { field: "eventId", direction: "asc" }], limit: 100 });
  return ok({ deliveries });
}
