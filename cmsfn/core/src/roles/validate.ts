import type { CmsfnAction, CmsfnRole, CmsfnRoleRule } from "./types.js";

const actions: Record<CmsfnAction, true> = {
  "schema.read": true, "doc.read": true, "doc.create": true,
  "doc.patch": true, "doc.publish": true, "doc.unpublish": true,
  "doc.delete": true, "asset.upload": true, "asset.read": true,
  "webhook.read": true, "audit.read": true, "release.manage": true,
};
export function isCmsfnAction(value: unknown): value is CmsfnAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(actions, value);
}
function object(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function owns(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}
function selector(value: unknown): value is string[] | "*" {
  if (value === "*") return true;
  if (!Array.isArray(value)) return false;
  for (const entry of value) if (typeof entry !== "string" || !entry.trim()) return false;
  return true;
}

type RoleValidation = { ok: true; role: CmsfnRole } | { ok: false; message: string; path: string };

/** Validate untrusted JSON or deployment-supplied roles and copy only contract fields. */
export function validateCmsfnRole(value: unknown): RoleValidation {
  const invalid = (message: string, path: string): RoleValidation => ({ ok: false, message, path });
  try {
    if (!object(value) || !owns(value, ["id", "name", "rules"])) return invalid("Role must be an object", "role");
    if (typeof value.id !== "string" || !value.id.trim()) return invalid("Invalid roleId", "role.id");
    if (typeof value.name !== "string" || !value.name.trim()) return invalid("Role name is required", "role.name");
    if (!Array.isArray(value.rules)) return invalid("Role rules must be an array", "role.rules");
    const rules: CmsfnRoleRule[] = [];
    for (let i = 0; i < value.rules.length; i++) {
      const rule: unknown = value.rules[i];
      const path = `role.rules[${i}]`;
      if (!object(rule) || !owns(rule, ["datasets", "types", "actions"])) return invalid("Invalid rule", path);
      if (!selector(rule.datasets)) return invalid("Rule datasets must be '*' or nonempty strings", `${path}.datasets`);
      if (!selector(rule.types)) return invalid("Rule types must be '*' or nonempty strings", `${path}.types`);
      if (rule.actions !== "*") {
        if (!Array.isArray(rule.actions)) return invalid("Rule actions must be '*' or supported actions", `${path}.actions`);
        for (let j = 0; j < rule.actions.length; j++) {
          if (!isCmsfnAction(rule.actions[j])) return invalid("Unknown rule action", `${path}.actions[${j}]`);
        }
      }
      rules.push({
        datasets: rule.datasets === "*" ? "*" : [...rule.datasets],
        types: rule.types === "*" ? "*" : [...rule.types],
        actions: rule.actions === "*" ? "*" : [...rule.actions] as CmsfnAction[],
      });
    }
    return { ok: true, role: { id: value.id.trim(), name: value.name.trim(), rules } };
  } catch {
    return invalid("Invalid role", "role");
  }
}
