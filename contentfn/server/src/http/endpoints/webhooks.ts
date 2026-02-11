import type { ContentfnEnvelope } from "@contentfn/core";
import { err } from "@contentfn/core";
import { webhookRegister, webhookList, webhookDelete } from "../../storage/webhooks.js";
import type { WebhooksStorageConfig } from "../../storage/webhooks.js";

export interface WebhooksEndpointsConfig extends WebhooksStorageConfig {}

export async function handleWebhooksRegister(
  config: WebhooksEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<{ webhookId: string }>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string") {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }
  if (typeof b.url !== "string") {
    return err("VALIDATION_FAILED", "url is required", { path: "url" });
  }
  if (!Array.isArray(b.events)) {
    return err("VALIDATION_FAILED", "events must be an array", { path: "events" });
  }

  return webhookRegister(config, {
    dataset: b.dataset,
    url: b.url,
    events: b.events as string[],
    secret: typeof b.secret === "string" ? b.secret : undefined,
  });
}

export async function handleWebhooksList(
  config: WebhooksEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<{ webhooks: Array<{ webhookId: string; url: string; events: string[] }> }>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string") {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }

  return webhookList(config, { dataset: b.dataset });
}

export async function handleWebhooksDelete(
  config: WebhooksEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<Record<string, never>>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string") {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }
  if (typeof b.webhookId !== "string") {
    return err("VALIDATION_FAILED", "webhookId is required", { path: "webhookId" });
  }

  return webhookDelete(config, { dataset: b.dataset, webhookId: b.webhookId });
}
