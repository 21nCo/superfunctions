/**
 * POST /cmsfn/audit/events and POST /cmsfn/audit/webhooks.
 * Permission: audit.read. Dataset isolation via allowedDatasets.
 */

import type { IncomingMessage } from "http";
import type { CmsfnEnvelope } from "@cmsfn/core";
import { authorize } from "../auth/authorize.js";
import type { AuthorizeConfig } from "../auth/authorize.js";
import { contentfnAuditEvents } from "../audit/events.js";
import { contentfnAuditWebhooks } from "../audit/webhooks.js";

export interface AuditHandlerConfig extends AuthorizeConfig {
  contentfnBaseUrl: string;
  allowedDatasets: string[];
  authorizeAudit?: (req: IncomingMessage) => Promise<boolean>;
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function allowedDataset(dataset: string, allowed: string[]): boolean {
  const set = new Set(allowed.map((d) => d.trim()));
  return typeof dataset === "string" && dataset.trim().length > 0 && set.has(dataset.trim());
}

async function requireAuditRead(
  config: AuditHandlerConfig,
  req: IncomingMessage,
  dataset: string
): Promise<CmsfnEnvelope<never> | null> {
  if (config.authorizeAudit) {
    const allowed = await config.authorizeAudit(req);
    if (!allowed) return { ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } };
  }
  if (config.getRolesForSubject && dataset) {
    const allowed = await authorize(config, req, { dataset, type: "*", action: "audit.read" });
    if (!allowed) return { ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } };
  }
  return null;
}

/**
 * POST /cmsfn/audit/events — body: { dataset, limit?, cursor? }.
 */
export async function handleAuditEvents(
  config: AuditHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<{ events: import("@cmsfn/core").CmsfnAuditEvent[]; nextCursor: string | null }>> {
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  const limit = typeof body?.limit === "number" ? body.limit : undefined;
  const cursor = body?.cursor !== undefined && body?.cursor !== null ? String(body.cursor) : null;
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  if (!allowedDataset(dataset, config.allowedDatasets)) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "Dataset not allowed", details: { path: "dataset" } } };
  }
  const deny = await requireAuditRead(config, req, dataset);
  if (deny) return deny;
  const result = await contentfnAuditEvents(
    { contentfnBaseUrl: config.contentfnBaseUrl },
    { dataset, limit, cursor }
  );
  if (result.ok) return { ok: true, result: result.result };
  return {
    ok: false,
    error: { code: result.error.code, message: result.error.message, details: result.error.details },
  };
}

/**
 * POST /cmsfn/audit/webhooks — body: { dataset, limit?, cursor? }.
 */
export async function handleAuditWebhooks(
  config: AuditHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<{ deliveries: import("@cmsfn/core").CmsfnWebhookDeliveryStatus[]; nextCursor: string | null }>> {
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  const limit = typeof body?.limit === "number" ? body.limit : undefined;
  const cursor = body?.cursor !== undefined && body?.cursor !== null ? String(body.cursor) : null;
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  if (!allowedDataset(dataset, config.allowedDatasets)) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "Dataset not allowed", details: { path: "dataset" } } };
  }
  const deny = await requireAuditRead(config, req, dataset);
  if (deny) return deny;
  const result = await contentfnAuditWebhooks(
    { contentfnBaseUrl: config.contentfnBaseUrl },
    { dataset, limit, cursor }
  );
  if (result.ok) return { ok: true, result: result.result };
  return {
    ok: false,
    error: { code: result.error.code, message: result.error.message, details: result.error.details },
  };
}
