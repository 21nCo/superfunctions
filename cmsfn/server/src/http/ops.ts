/**
 * POST /cmsfn/ops/export and POST /cmsfn/ops/import.
 * Dataset isolation: only allow datasets in allowedDatasets.
 * Permission: audit.read (documented).
 */

import type { IncomingMessage } from "http";
import type { CmsfnEnvelope } from "cmsfn";
import { authorize } from "../auth/authorize.js";
import type { AuthorizeConfig } from "../auth/authorize.js";
import { contentfnExport } from "../ops/export.js";
import { contentfnImport } from "../ops/import.js";

export interface OpsHandlerConfig extends AuthorizeConfig {
  contentfnBaseUrl: string;
  /** Allowed dataset names (from config.datasets). Import/export only for these. */
  allowedDatasets: string[];
  /** Optional: if provided and returns false, respond PERMISSION_DENIED. */
  authorizeOps?: (req: IncomingMessage) => Promise<boolean>;
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
  config: OpsHandlerConfig,
  req: IncomingMessage,
  dataset: string
): Promise<CmsfnEnvelope<never> | null> {
  if (config.authorizeOps) {
    const allowed = await config.authorizeOps(req);
    if (!allowed) return { ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } };
  }
  if (config.getRolesForSubject && dataset) {
    const allowed = await authorize(config, req, { dataset, type: "*", action: "audit.read" });
    if (!allowed) return { ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } };
  }
  return null;
}

/**
 * POST /cmsfn/ops/export — body: { dataset }.
 */
export async function handleOpsExport(
  config: OpsHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<{ artifact: unknown }>> {
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  if (!allowedDataset(dataset, config.allowedDatasets)) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "Dataset not allowed", details: { path: "dataset" } } };
  }
  const deny = await requireAuditRead(config, req, dataset);
  if (deny) return deny;
  const result = await contentfnExport({ contentfnBaseUrl: config.contentfnBaseUrl }, dataset);
  if (result.ok) {
    return { ok: true, result: { artifact: result.result.artifact } };
  }
  return {
    ok: false,
    error: {
      code: result.error.code,
      message: result.error.message,
      details: result.error.details,
    },
  };
}

/**
 * POST /cmsfn/ops/import — body: { dataset, artifact }.
 */
export async function handleOpsImport(
  config: OpsHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<Record<string, never>>> {
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  const artifact = body?.artifact;
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  if (artifact === undefined || artifact === null) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "artifact is required", details: { path: "artifact" } } };
  }
  if (!allowedDataset(dataset, config.allowedDatasets)) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "Dataset not allowed", details: { path: "dataset" } } };
  }
  const deny = await requireAuditRead(config, req, dataset);
  if (deny) return deny;
  const result = await contentfnImport(
    { contentfnBaseUrl: config.contentfnBaseUrl },
    { dataset, artifact }
  );
  if (result.ok) {
    return { ok: true, result: {} };
  }
  return {
    ok: false,
    error: {
      code: result.error.code,
      message: result.error.message,
      details: result.error.details,
    },
  };
}
