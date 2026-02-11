/**
 * Stub POST /cmsfn/publish for permission enforcement testing (TV-ROLE-DENY-001).
 * Only checks doc.publish permission; does not call ContentFn.
 */

import type { IncomingMessage } from "http";
import type { CmsfnEnvelope } from "@cmsfn/core";
import { ok, err } from "@cmsfn/core";
import { authorize } from "../auth/authorize.js";
import type { AuthorizeConfig } from "../auth/authorize.js";

export interface PublishStubConfig extends AuthorizeConfig {}

/**
 * Handle POST /cmsfn/publish — body: { dataset: string; docId?: string }.
 * Returns PERMISSION_DENIED when role denies doc.publish; ok when allowed.
 */
export async function handlePublishStub(
  config: PublishStubConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<Record<string, never>>> {
  const body = await parseJsonBody(req);
  const dataset = (body as Record<string, unknown>)?.dataset;
  if (typeof dataset !== "string" || dataset.trim().length === 0) {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }
  const allowed = await authorize(config, req, {
    dataset: dataset.trim(),
    type: "*",
    action: "doc.publish",
  });
  if (!allowed) {
    return err("PERMISSION_DENIED", "Permission denied", {});
  }
  return ok({});
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
