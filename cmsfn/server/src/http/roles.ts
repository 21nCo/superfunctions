/**
 * CmsFn role endpoints: POST list, upsert, delete.
 * Deterministic validation errors; envelope responses.
 */

import type { IncomingMessage } from "http";
import { err, type CmsfnEnvelope } from "cmsfn";
import { createRouteContext, PayloadTooLargeError } from "@superfunctions/http";
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

  try {
    // Returning this iterator leaves the socket alive so an oversized request
    // can receive its error envelope. The shared parser owns byte accounting.
    const iterator = req.iterator({ destroyOnReturn: false });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const item = await iterator.next();
        if (item.done) controller.close();
        else controller.enqueue(typeof item.value === "string" ? Buffer.from(item.value) : item.value);
      },
      async cancel() { await iterator.return?.(); },
    }, { highWaterMark: 0 });
    const headers = new Headers();
    if (req.headers["content-length"] !== undefined) {
      headers.set("content-length", req.headers["content-length"]);
    }
    const request = new Request("http://cmsfn.local/roles", {
      method: "POST", headers, body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const body: unknown = await createRouteContext(request, {}, { maxBodyBytes: ROLE_BODY_MAX_BYTES }).json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return err("VALIDATION_FAILED", "Request body must be a JSON object");
    }
    return { ok: true, result: body as Record<string, unknown> };
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return err("PAYLOAD_TOO_LARGE", "Role request exceeds 65536 bytes");
    }
    return err("VALIDATION_FAILED", "Invalid JSON request body");
  }
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
