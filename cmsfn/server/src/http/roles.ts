/**
 * CmsFn role endpoints: POST list, upsert, delete.
 * Deterministic validation errors; envelope responses.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { CmsfnEnvelope } from "@cmsfn/core";
import { rolesList, rolesUpsert, rolesDelete } from "../storage/roles.js";
import type { RolesStorageConfig } from "../storage/roles.js";

export interface RolesHandlerConfig extends RolesStorageConfig {
  /** Optional: if provided and returns false, respond PERMISSION_DENIED. */
  authorizeRoles?: (req: IncomingMessage) => Promise<boolean>;
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
    return null;
  }
}

/**
 * POST /cmsfn/roles/list — body: { dataset: string }.
 */
export async function handleRolesList(
  config: RolesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<{ roles: import("@cmsfn/core").CmsfnRole[] }>> {
  if (config.authorizeRoles) {
    const allowed = await config.authorizeRoles(req);
    if (!allowed) {
      return { ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } };
    }
  }
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
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
): Promise<CmsfnEnvelope<{ role: import("@cmsfn/core").CmsfnRole }>> {
  if (config.authorizeRoles) {
    const allowed = await config.authorizeRoles(req);
    if (!allowed) {
      return { ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } };
    }
  }
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
  const role = body?.role;
  if (role == null) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "role is required", details: { path: "role" } } };
  }
  return rolesUpsert(config, { role: role as import("@cmsfn/core").CmsfnRole });
}

/**
 * POST /cmsfn/roles/delete — body: { roleId: string }.
 * TV-ENV-ERR-001: roleId "" → VALIDATION_FAILED, path roleId.
 */
export async function handleRolesDelete(
  config: RolesHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<Record<string, never>>> {
  if (config.authorizeRoles) {
    const allowed = await config.authorizeRoles(req);
    if (!allowed) {
      return { ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } };
    }
  }
  const body = (await parseJsonBody(req)) as Record<string, unknown>;
  const roleId = body?.roleId;
  if (roleId === undefined || roleId === null) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "roleId is required", details: { path: "roleId" } } };
  }
  // Storage returns "Invalid roleId" for empty string (TV-ENV-ERR-001)
  return rolesDelete(config, { roleId: String(roleId).trim() });
}
