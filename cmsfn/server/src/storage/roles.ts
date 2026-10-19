/**
 * CmsFn role storage via @superfunctions/db adapter.
 * Table: cmsfn_roles (id, name, rules JSON).
 * Roles are global; list(dataset) returns all roles in deterministic order (by id).
 */

import type { Adapter } from "@superfunctions/db";
import { cmsfnStorageAdapter } from "./schema.js";
import type { CmsfnEnvelope } from "cmsfn";
import type { CmsfnRole } from "cmsfn";
import { ok, err, validateCmsfnRole } from "cmsfn";

export const CMSFN_ROLES_TABLE = "cmsfn_roles";

export interface RolesStorageConfig {
  db: Adapter;
}

function validateRoleId(roleId: string): { ok: true; id: string } | { ok: false; message: string } {
  const trimmed = typeof roleId === "string" ? roleId.trim() : "";
  if (typeof trimmed !== "string" || trimmed.length === 0) {
    return { ok: false, message: "Invalid roleId" };
  }
  return { ok: true, id: trimmed };
}

/**
 * List all roles for a dataset. Returns all roles in deterministic order (by id).
 * Dataset is accepted for API compatibility; filtering by rule scope is not required in this phase.
 */
export async function rolesList(
  config: RolesStorageConfig,
  input: { dataset: string }
): Promise<CmsfnEnvelope<{ roles: CmsfnRole[] }>> {
  if (typeof input.dataset !== "string" || input.dataset.trim().length === 0) {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }
  const rows = await cmsfnStorageAdapter(config.db).findMany({
    model: CMSFN_ROLES_TABLE,
    where: [],
    orderBy: [{ field: "id", direction: "asc" }],
  });
  const roles: CmsfnRole[] = (rows as Array<{ id: string; name: string; rules: unknown }>).map((row) => ({
    id: row.id,
    name: row.name,
    rules: Array.isArray(row.rules) ? (row.rules as CmsfnRole["rules"]) : [],
  }));
  return ok({ roles });
}

/**
 * Upsert a role by id.
 */
export async function rolesUpsert(
  config: RolesStorageConfig,
  input: { role: CmsfnRole }
): Promise<CmsfnEnvelope<{ role: CmsfnRole }>> {
  const v = validateCmsfnRole(input.role);
  if (!v.ok) {
    return err("VALIDATION_FAILED", v.message, v.path ? { path: v.path } : {});
  }
  const { role } = v;
  const existing = await cmsfnStorageAdapter(config.db).findOne({
    model: CMSFN_ROLES_TABLE,
    where: [{ field: "id", operator: "eq", value: role.id }],
  });
  const row = { id: role.id, name: role.name, rules: role.rules };
  if (existing) {
    await cmsfnStorageAdapter(config.db).update({
      model: CMSFN_ROLES_TABLE,
      where: [{ field: "id", operator: "eq", value: role.id }],
      data: row,
    });
  } else {
    await cmsfnStorageAdapter(config.db).create({
      model: CMSFN_ROLES_TABLE,
      data: row,
    });
  }
  return ok({ role });
}

/**
 * Delete a role by id.
 */
export async function rolesDelete(
  config: RolesStorageConfig,
  input: { roleId: string }
): Promise<CmsfnEnvelope<Record<string, never>>> {
  const v = validateRoleId(input.roleId);
  if (!v.ok) {
    return err("VALIDATION_FAILED", v.message, { path: "roleId" });
  }
  await cmsfnStorageAdapter(config.db).delete({
    model: CMSFN_ROLES_TABLE,
    where: [{ field: "id", operator: "eq", value: v.id }],
  });
  return ok({});
}

/**
 * Load a single role by id (for auth evaluation).
 */
export async function roleById(
  config: RolesStorageConfig,
  roleId: string
): Promise<CmsfnRole | null> {
  const row = await cmsfnStorageAdapter(config.db).findOne({
    model: CMSFN_ROLES_TABLE,
    where: [{ field: "id", operator: "eq", value: roleId }],
  });
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    name: String(r.name),
    rules: Array.isArray(r.rules) ? (r.rules as CmsfnRole["rules"]) : [],
  };
}
