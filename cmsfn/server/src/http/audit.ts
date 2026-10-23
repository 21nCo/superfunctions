/** Authorized, bounded audit routes. Browser credentials are never forwarded implicitly. */
import type { IncomingMessage } from "http";
import { err, type CmsfnEnvelope } from "cmsfn";
import { authorize, type AuthorizeConfig } from "../auth/authorize.js";
import { contentfnAuditEvents, AUDIT_MAX_LIMIT } from "../audit/events.js";
import { contentfnAuditWebhooks } from "../audit/webhooks.js";
import { readJsonObject } from "./jsonBody.js";

import type { CapabilityGateConfig } from "../contentfn/statusClient.js";
export interface AuditHandlerConfig extends AuthorizeConfig, CapabilityGateConfig {
  contentfnBaseUrl: string;
  allowedDatasets: string[];
  authorizeAudit?: (req: IncomingMessage) => Promise<boolean>;
  /** Server-owned upstream identity/credentials; receives the authorized request. */
  contentfnAuditHeaders?: (req: IncomingMessage) => NonNullable<RequestInit["headers"]> | Promise<NonNullable<RequestInit["headers"]>>;
}
export const AUDIT_BODY_MAX_BYTES = 64 * 1024;
type AuditInput = { dataset: string; limit?: number; cursor?: string | null };

async function readAuthorizedInput(config: AuditHandlerConfig, req: IncomingMessage): Promise<CmsfnEnvelope<AuditInput>> {
  try {
    if (!config.getRolesForSubject || (config.authorizeAudit && await config.authorizeAudit(req) !== true)) return err("PERMISSION_DENIED", "Permission denied");
  } catch { return err("PERMISSION_DENIED", "Permission denied"); }
  const parsed = await readJsonObject(req, AUDIT_BODY_MAX_BYTES);
  if (!parsed.ok) return parsed;
  const body = parsed.result;
  const dataset = typeof body.dataset === "string" ? body.dataset.trim() : "";
  if (!dataset) return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  try {
    if (!config.allowedDatasets.includes(dataset) || !await authorize(config, req, { dataset, type: "*", action: "audit.read" })) return err("PERMISSION_DENIED", "Permission denied");
  } catch { return err("PERMISSION_DENIED", "Permission denied"); }
  if (body.limit !== undefined && (typeof body.limit !== "number" || !Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > AUDIT_MAX_LIMIT)) return err("VALIDATION_FAILED", "Invalid audit limit", { path: "limit" });
  if (body.cursor !== undefined && body.cursor !== null && (typeof body.cursor !== "string" || body.cursor.length > 2048)) return err("VALIDATION_FAILED", "Invalid audit cursor", { path: "cursor" });
  return { ok: true, result: { dataset, ...(body.limit === undefined ? {} : { limit: body.limit as number }), ...(body.cursor === undefined ? {} : { cursor: body.cursor as string | null }) } };
}

export async function handleAuditEvents(config: AuditHandlerConfig, req: IncomingMessage): Promise<CmsfnEnvelope<{ events: import("cmsfn").CmsfnAuditEvent[]; nextCursor: string | null }>> {
  const input = await readAuthorizedInput(config, req);
  if (!input.ok) return input;
  try {
    if (config.checkCapabilities && !await config.checkCapabilities(req, ["content.audit"])) return err("CONTENTFN_UNAVAILABLE", "ContentFn audit capability is unavailable");
    const headers = await config.contentfnAuditHeaders?.(req);
    return await contentfnAuditEvents({ contentfnBaseUrl: config.contentfnBaseUrl, headers }, input.result);
  } catch { return err("CONTENTFN_UNAVAILABLE", "ContentFn audit request could not be configured"); }
}

/** Authorized dataset-wide delivery metadata from ContentFn schema4. */
export async function handleAuditWebhooks(config: AuditHandlerConfig, req: IncomingMessage): Promise<CmsfnEnvelope<{ deliveries: import("cmsfn").CmsfnWebhookDeliveryStatus[]; nextCursor: string | null }>> {
  const input = await readAuthorizedInput(config, req);
  if (!input.ok) return input;
  try {
    if (config.checkCapabilities && !await config.checkCapabilities(req, ["content.audit", "content.webhooks"])) return err("CONTENTFN_UNAVAILABLE", "ContentFn webhook audit capabilities are unavailable");
    const headers = await config.contentfnAuditHeaders?.(req);
    return await contentfnAuditWebhooks({ contentfnBaseUrl: config.contentfnBaseUrl, headers }, input.result);
  } catch { return err("CONTENTFN_UNAVAILABLE", "ContentFn audit request could not be configured"); }
}
