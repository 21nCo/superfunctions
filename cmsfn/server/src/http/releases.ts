/**
 * POST /cmsfn/releases/create, list, add, publish.
 * create/list/add require release.manage; publish requires release.manage and per-doc doc.publish + workflow.
 */

import type { IncomingMessage } from "http";
import type { CmsfnEnvelope } from "cmsfn";
import { createRelease, listReleases, addDocToRelease, getRelease } from "../storage/releases.js";
import type { ReleasesStorageConfig } from "../storage/releases.js";
import { publishRelease } from "../releases/publishRelease.js";
import { authorize } from "../auth/authorize.js";
import type { AuthorizeConfig } from "../auth/authorize.js";

export interface ReleasesHandlerConfig extends AuthorizeConfig {
  releasesStorage: ReleasesStorageConfig;
  contentfnBaseUrl: string;
  /** Optional: if provided and returns false, respond PERMISSION_DENIED for create/list/add/publish. */
  authorizeReleases?: (req: IncomingMessage) => Promise<boolean>;
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

async function requireReleaseManage(
  config: ReleasesHandlerConfig,
  req: IncomingMessage,
  dataset: string
): Promise<CmsfnEnvelope<never> | null> {
  if (config.authorizeReleases) {
    const allowed = await config.authorizeReleases(req);
    if (!allowed) return { ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } };
  }
  if (config.getRolesForSubject && dataset) {
    const allowed = await authorize(config, req, { dataset, type: "*", action: "release.manage" });
    if (!allowed) return { ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } };
  }
  return null;
}

/**
 * POST /cmsfn/releases/create — body: { dataset, name, publishAt? }.
 */
export async function handleReleasesCreate(
  config: ReleasesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<{ releaseId: string }>> {
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const publishAt = body?.publishAt;
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  if (!name) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "name is required", details: { path: "name" } } };
  }
  const deny = await requireReleaseManage(config, req, dataset);
  if (deny) return deny;
  return createRelease(config.releasesStorage, {
    dataset,
    name,
    publishAt: publishAt === undefined || publishAt === null ? null : (publishAt as string),
  });
}

/**
 * POST /cmsfn/releases/list — body: { dataset }.
 */
export async function handleReleasesList(
  config: ReleasesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<{ releases: import("cmsfn").CmsfnRelease[] }>> {
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  const deny = await requireReleaseManage(config, req, dataset);
  if (deny) return deny;
  return listReleases(config.releasesStorage, { dataset });
}

/**
 * POST /cmsfn/releases/add — body: { dataset, releaseId, docId }.
 */
export async function handleReleasesAdd(
  config: ReleasesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<Record<string, never>>> {
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  const releaseId = typeof body?.releaseId === "string" ? body.releaseId.trim() : "";
  const docId = typeof body?.docId === "string" ? body.docId.trim() : "";
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  if (!releaseId) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "releaseId is required", details: { path: "releaseId" } } };
  }
  if (!docId) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "docId is required", details: { path: "docId" } } };
  }
  const deny = await requireReleaseManage(config, req, dataset);
  if (deny) return deny;
  return addDocToRelease(config.releasesStorage, { dataset, releaseId, docId });
}

/**
 * POST /cmsfn/releases/publish — body: { dataset, releaseId }.
 */
export async function handleReleasesPublish(
  config: ReleasesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<import("cmsfn").CmsfnReleasePublishResult>> {
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  const releaseId = typeof body?.releaseId === "string" ? body.releaseId.trim() : "";
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  if (!releaseId) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "releaseId is required", details: { path: "releaseId" } } };
  }
  const deny = await requireReleaseManage(config, req, dataset);
  if (deny) return deny;
  return publishRelease(
    {
      getRolesForSubject: config.getRolesForSubject,
      contentfnBaseUrl: config.contentfnBaseUrl,
      releasesStorage: config.releasesStorage,
    },
    req,
    { dataset, releaseId }
  );
}
