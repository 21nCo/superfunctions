/**
 * POST /cmsfn/publish and POST /cmsfn/unpublish: role + workflow gating, then ContentFn.
 */

import type { IncomingMessage } from "http";
import type { CmsfnEnvelope } from "cmsfn";
import { err } from "cmsfn";
import type { CmsfnWorkflowState, CmsfnWorkflowMetadata } from "cmsfn";
import { CMS_RESERVED_FIELD } from "cmsfn";
import { authorize } from "../auth/authorize.js";
import type { AuthorizeConfig } from "../auth/authorize.js";
import { canPublish } from "../publish/gates.js";
import { getDraftDoc, contentfnPublish, contentfnUnpublish } from "../publish/contentfnClient.js";

import type { CapabilityGateConfig } from "../contentfn/statusClient.js";
import { readJsonObject } from "./jsonBody.js";
export interface PublishHandlerConfig extends AuthorizeConfig, CapabilityGateConfig {
  allowedDatasets?: readonly string[];
  contentfnBaseUrl: string;
}

function getWorkflowState(doc: Record<string, unknown>): CmsfnWorkflowState | undefined {
  const cms = doc[CMS_RESERVED_FIELD] as CmsfnWorkflowMetadata | undefined;
  return cms?.state;
}

/**
 * Handle POST /cmsfn/publish — body: { dataset: string; id: string }.
 * Checks doc.publish, then workflow gate, then calls ContentFn publish.
 */
export async function handlePublish(
  config: PublishHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<unknown>> {
  const parsed = await readJsonObject(req, 64 * 1024); if (!parsed.ok) return parsed;
  const body = parsed.result;
  const dataset = body?.dataset;
  const id = body?.id;
  if (typeof dataset !== "string" || dataset.trim().length === 0) {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    return err("VALIDATION_FAILED", "id is required", { path: "id" });
  }
  const ds = dataset.trim();
  const docId = id.trim();

  if (config.allowedDatasets && !config.allowedDatasets.includes(ds)) return err("PERMISSION_DENIED", "Permission denied");
  let allowed = false;
  try { allowed = await authorize(config, req, {
    dataset: ds,
    type: "*",
    action: "doc.publish",
  }); } catch { allowed = false; }
  if (!allowed) {
    return err("PERMISSION_DENIED", "Permission denied", {});
  }

  if (config.checkCapabilities && !await config.checkCapabilities(req, ["content.docs"])) return err("CONTENTFN_UNAVAILABLE", "ContentFn document capability is unavailable");
  const contentfn = { baseUrl: config.contentfnBaseUrl };
  const draftRes = await getDraftDoc(contentfn, ds, docId);
  if (!draftRes.ok) {
    return draftRes;
  }
  const draftDoc = draftRes.result as Record<string, unknown>;
  const state = getWorkflowState(draftDoc);
  if (!canPublish(state, true)) {
    return err("PERMISSION_DENIED", "Workflow state does not allow publish", {
      state: state ?? "draft",
    });
  }

  return contentfnPublish(contentfn, ds, docId, draftRes.result._rev);
}

/**
 * Handle POST /cmsfn/unpublish — body: { dataset: string; id: string }.
 * Checks doc.unpublish then calls ContentFn unpublish.
 */
export async function handleUnpublish(
  config: PublishHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<unknown>> {
  const parsed = await readJsonObject(req, 64 * 1024); if (!parsed.ok) return parsed;
  const body = parsed.result;
  const dataset = body?.dataset;
  const id = body?.id;
  if (typeof dataset !== "string" || dataset.trim().length === 0) {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    return err("VALIDATION_FAILED", "id is required", { path: "id" });
  }
  const ds = dataset.trim();
  const docId = id.trim();

  if (config.allowedDatasets && !config.allowedDatasets.includes(ds)) return err("PERMISSION_DENIED", "Permission denied");
  let allowed = false;
  try { allowed = await authorize(config, req, {
    dataset: ds,
    type: "*",
    action: "doc.unpublish",
  }); } catch { allowed = false; }
  if (!allowed) {
    return err("PERMISSION_DENIED", "Permission denied", {});
  }

  if (config.checkCapabilities && !await config.checkCapabilities(req, ["content.docs"])) return err("CONTENTFN_UNAVAILABLE", "ContentFn document capability is unavailable");
  return contentfnUnpublish({ baseUrl: config.contentfnBaseUrl }, ds, docId);
}
