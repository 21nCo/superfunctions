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

export interface PublishHandlerConfig extends AuthorizeConfig {
  contentfnBaseUrl: string;
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
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
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

  const allowed = await authorize(config, req, {
    dataset: ds,
    type: "*",
    action: "doc.publish",
  });
  if (!allowed) {
    return err("PERMISSION_DENIED", "Permission denied", {});
  }

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

  return contentfnPublish(contentfn, ds, docId);
}

/**
 * Handle POST /cmsfn/unpublish — body: { dataset: string; id: string }.
 * Checks doc.unpublish then calls ContentFn unpublish.
 */
export async function handleUnpublish(
  config: PublishHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<unknown>> {
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
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

  const allowed = await authorize(config, req, {
    dataset: ds,
    type: "*",
    action: "doc.unpublish",
  });
  if (!allowed) {
    return err("PERMISSION_DENIED", "Permission denied", {});
  }

  return contentfnUnpublish({ baseUrl: config.contentfnBaseUrl }, ds, docId);
}
