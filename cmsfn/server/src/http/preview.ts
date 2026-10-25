import type { OperationContext } from '../logging/logger.js';
/**
 * POST /cmsfn/preview/token — mint short-lived preview token (dataset + docIds bound).
 */

import type { IncomingMessage } from "http";
import type { CmsfnEnvelope, CmsfnPreviewTokenResult } from "cmsfn";
import { ok, err } from "cmsfn";
import { authorize } from "../auth/authorize.js";
import type { AuthorizeConfig } from "../auth/authorize.js";
import { mintPreviewToken, validPreviewConfig } from "../preview/tokens.js";

import type { CapabilityGateConfig } from "../contentfn/statusClient.js";
import { readJsonObject } from "./jsonBody.js";
export interface PreviewTokenHandlerConfig extends AuthorizeConfig, CapabilityGateConfig {
  logContext?: OperationContext;
  allowedDatasets?: readonly string[];
  /** When false or unset, return PREVIEW_NOT_CONFIGURED. */
  previewEnabled?: boolean;
  /** Secret for signing tokens; required when preview enabled. */
  previewSecret?: string;
  previewOrigin?: string;
  ttlSec?: number;
}

/**
 * Handle POST /cmsfn/preview/token.
 * Body: { dataset: string; docId?: string; docIds?: string[] }.
 * Accepts docId (single) or docIds (array); normalizes to docIds.
 */
export async function handlePreviewToken(
  config: PreviewTokenHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<CmsfnPreviewTokenResult>> {
  if (!config.previewEnabled || !config.previewSecret || !config.previewOrigin || !validPreviewConfig({ secret: config.previewSecret, audience: config.previewOrigin, ttlSec: config.ttlSec })) {
    return err("PREVIEW_NOT_CONFIGURED", "Preview is not configured", {});
  }

  const parsed = await readJsonObject(req, 64 * 1024); if (!parsed.ok) return parsed;
  const body = parsed.result;
  const dataset = body?.dataset;
  if (typeof dataset !== "string" || dataset.trim().length === 0) {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }
  const ds = dataset.trim();

  const rawIds: unknown = body.docIds === undefined ? [body.docId] : body.docIds;
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 100 || !rawIds.every((id): id is string => typeof id === 'string' && !!id && id !== 'drafts.')) return err('VALIDATION_FAILED', 'One to 100 document IDs are required', { path: 'docIds' });
  const docIds = rawIds;

  if (config.allowedDatasets && !config.allowedDatasets.includes(ds)) return err("PERMISSION_DENIED", "Permission denied");
  let allowed = false;
  try { allowed = await authorize(config, req, {
    dataset: ds,
    type: "*",
    action: "doc.read",
  }); } catch { allowed = false; }
  if (!allowed) {
    return err("PERMISSION_DENIED", "Permission denied", {});
  }

  if (config.checkCapabilities && !await config.checkCapabilities(req, ["content.docs", "content.realtime"])) return err("CONTENTFN_UNAVAILABLE", "ContentFn preview capabilities are unavailable");
  if (config.logContext) { config.logContext.dataset = ds; config.logContext.documentCount = docIds.length; }
  const result = mintPreviewToken(
    { secret: config.previewSecret, audience: config.previewOrigin, ttlSec: config.ttlSec },
    ds,
    docIds
  );
  return ok(result);
}
