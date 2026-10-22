/**
 * CmsFn role endpoints: POST list, upsert, delete.
 * Deterministic validation errors; envelope responses.
 */

import type { IncomingMessage } from "http";
import { err, type CmsfnEnvelope } from "cmsfn";
import { readJsonObject } from "./jsonBody.js";
import { rolesList, rolesUpsert, rolesDelete } from "../storage/roles.js";
import type { RolesStorageConfig } from "../storage/roles.js";

export interface RolesHandlerConfig extends RolesStorageConfig {
  /** Must explicitly return true to allow role management; missing or failed authorization denies access. */
  authorizeRoles?: (req: IncomingMessage) => Promise<boolean>;
}

/** Role management requests are bounded independently of content uploads. */
export const ROLE_BODY_MAX_BYTES = 64 * 1024;

async function readAuthorizedBody(
  config: RolesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<Record<string, unknown>>> {
  // Do not attach readers or construct a body stream before authorization.
  try {
    if (!config.authorizeRoles || await config.authorizeRoles(req) !== true) {
      return err("PERMISSION_DENIED", "Permission denied");
    }
  } catch {
    return err("PERMISSION_DENIED", "Permission denied");
  }

  return readJsonObject(req, ROLE_BODY_MAX_BYTES);
}

/**
 * POST /cmsfn/roles/list — body: { dataset: string }.
 */
export async function handleRolesList(
  config: RolesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<{ roles: import("cmsfn").CmsfnRole[] }>> {
  const parsed = await readAuthorizedBody(config, req);
  if (!parsed.ok) return parsed;
  const body = parsed.result;
  const dataset = body?.dataset;
  if (typeof dataset !== "string" || dataset.trim().length === 0) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  }
  return rolesList(config, { dataset: dataset.trim() });
}

/**
 * POST /cmsfn/roles/upsert — body: { role: CmsfnRole }.
 */
export async function handleRolesUpsert(
  config: RolesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<{ role: import("cmsfn").CmsfnRole }>> {
  const parsed = await readAuthorizedBody(config, req);
  if (!parsed.ok) return parsed;
  const body = parsed.result;
  const role = body?.role;
  if (role == null) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "role is required", details: { path: "role" } } };
  }
  return rolesUpsert(config, { role: role as import("cmsfn").CmsfnRole });
}

/**
 * POST /cmsfn/roles/delete — body: { roleId: string }.
 * TV-ENV-ERR-001: roleId "" → VALIDATION_FAILED, path roleId.
 */
export async function handleRolesDelete(
  config: RolesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<Record<string, never>>> {
  const parsed = await readAuthorizedBody(config, req);
  if (!parsed.ok) return parsed;
  const body = parsed.result;
  const roleId = body?.roleId;
  if (roleId === undefined || roleId === null) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "roleId is required", details: { path: "roleId" } } };
  }
  // Storage returns "Invalid roleId" for empty string (TV-ENV-ERR-001)
  return rolesDelete(config, { roleId: String(roleId).trim() });
}
