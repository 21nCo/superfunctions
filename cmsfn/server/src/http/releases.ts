/**
 * POST /cmsfn/releases/create, list, add, publish.
 * create/list/add require release.manage; publish requires release.manage and per-doc doc.publish + workflow.
 */

import type { IncomingMessage } from "http";
import { err, type CmsfnEnvelope } from "cmsfn";
import { readJsonObject } from "./jsonBody.js";
import { createRelease, listReleases, addDocToRelease } from "../storage/releases.js";
import type { ReleasesStorageConfig } from "../storage/releases.js";
import { publishRelease } from "../releases/publishRelease.js";
import { authorize } from "../auth/authorize.js";
import type { AuthorizeConfig } from "../auth/authorize.js";

import type { CapabilityGateConfig } from "../contentfn/statusClient.js";
export interface ReleasesHandlerConfig extends AuthorizeConfig, CapabilityGateConfig {
  releasesStorage: ReleasesStorageConfig;
  contentfnBaseUrl: string;
  /** Server-configured dataset names; role grants cannot enable another dataset. */
  allowedDatasets?: readonly string[];
  /** Optional: if provided and returns false, respond PERMISSION_DENIED for create/list/add/publish. */
  authorizeReleases?: (req: IncomingMessage) => Promise<boolean>;
}

export const RELEASE_BODY_MAX_BYTES = 64 * 1024;

async function readAuthorizedBody(
  config: ReleasesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<Record<string, unknown>>> {
  // Missing identity configuration and an explicit outer veto need no body read.
  try {
    if (!config.getRolesForSubject || (config.authorizeReleases && await config.authorizeReleases(req) !== true)) {
      return err("PERMISSION_DENIED", "Permission denied");
    }
  } catch {
    return err("PERMISSION_DENIED", "Permission denied");
  }
  const parsed = await readJsonObject(req, RELEASE_BODY_MAX_BYTES);
  if (!parsed.ok) return parsed;
  const dataset = typeof parsed.result.dataset === "string" ? parsed.result.dataset.trim() : "";
  if (!dataset) return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  try {
    if ((config.allowedDatasets && !config.allowedDatasets.includes(dataset)) ||
      !await authorize(config, req, { dataset, type: "*", action: "release.manage" })) {
      return err("PERMISSION_DENIED", "Permission denied");
    }
  } catch {
    return err("PERMISSION_DENIED", "Permission denied");
  }
  return parsed;
}

/**
 * POST /cmsfn/releases/create — body: { dataset, name, publishAt? }.
 */
export async function handleReleasesCreate(
  config: ReleasesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<{ releaseId: string }>> {
  const parsed = await readAuthorizedBody(config, req);
  if (!parsed.ok) return parsed;
  const body = parsed.result;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const publishAt = body?.publishAt;
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  if (!name) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "name is required", details: { path: "name" } } };
  }
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
  const parsed = await readAuthorizedBody(config, req);
  if (!parsed.ok) return parsed;
  const body = parsed.result;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  return listReleases(config.releasesStorage, { dataset });
}

/**
 * POST /cmsfn/releases/add — body: { dataset, releaseId, docId }.
 */
export async function handleReleasesAdd(
  config: ReleasesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<Record<string, never>>> {
  const parsed = await readAuthorizedBody(config, req);
  if (!parsed.ok) return parsed;
  const body = parsed.result;
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
  return addDocToRelease(config.releasesStorage, { dataset, releaseId, docId });
}

/**
 * POST /cmsfn/releases/publish — body: { dataset, releaseId }.
 */
export async function handleReleasesPublish(
  config: ReleasesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<import("cmsfn").CmsfnReleasePublishResult>> {
  const parsed = await readAuthorizedBody(config, req);
  if (!parsed.ok) return parsed;
  const body = parsed.result;
  const dataset = typeof body?.dataset === "string" ? body.dataset.trim() : "";
  const releaseId = typeof body?.releaseId === "string" ? body.releaseId.trim() : "";
  if (!dataset) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  if (!releaseId) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "releaseId is required", details: { path: "releaseId" } } };
  }
  if (config.checkCapabilities && !await config.checkCapabilities(req, ["content.docs"])) return err("CONTENTFN_UNAVAILABLE", "ContentFn document capability is unavailable");
  return publishRelease(
    {
      getRolesForSubject: async (request) => {
        try { return await config.getRolesForSubject!(request); } catch { return []; }
      },
      contentfnBaseUrl: config.contentfnBaseUrl,
      releasesStorage: config.releasesStorage,
    },
    req,
    { dataset, releaseId }
  );
}
