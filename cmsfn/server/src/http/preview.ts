/**
 * POST /cmsfn/preview/token — mint short-lived preview token (dataset + docIds bound).
 */

import type { IncomingMessage } from "http";
import type { CmsfnEnvelope, CmsfnPreviewTokenResult } from "cmsfn";
import { ok, err } from "cmsfn";
import { authorize } from "../auth/authorize.js";
import type { AuthorizeConfig } from "../auth/authorize.js";
import { mintPreviewToken } from "../preview/tokens.js";

import type { CapabilityGateConfig } from "../contentfn/statusClient.js";
import { readJsonObject } from "./jsonBody.js";
export interface PreviewTokenHandlerConfig extends AuthorizeConfig, CapabilityGateConfig {
  allowedDatasets?: readonly string[];
  /** When false or unset, return PREVIEW_NOT_CONFIGURED. */
  previewEnabled?: boolean;
  /** Secret for signing tokens; required when preview enabled. */
  previewSecret?: string;
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
  if (!config.previewEnabled || !config.previewSecret) {
    return err("PREVIEW_NOT_CONFIGURED", "Preview is not configured", {});
  }

  const parsed = await readJsonObject(req, 64 * 1024); if (!parsed.ok) return parsed;
  const body = parsed.result;
  const dataset = body?.dataset;
  if (typeof dataset !== "string" || dataset.trim().length === 0) {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }
  const ds = dataset.trim();

  let docIds: string[];
  if (Array.isArray(body?.docIds) && body.docIds.every((id: unknown) => typeof id === "string")) {
    docIds = (body.docIds as string[]).map((id) => String(id).trim()).filter(Boolean);
  } else if (typeof body?.docId === "string" && body.docId.trim().length > 0) {
    docIds = [body.docId.trim()];
  } else {
    docIds = [];
  }

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
  const result = mintPreviewToken(
    { secret: config.previewSecret, ttlSec: config.ttlSec },
    ds,
    docIds
  );
  return ok(result);
}
