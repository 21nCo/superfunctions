/**
 * Deterministic permission evaluation: role rules + dataset/type/action → allow/deny.
 * When multiple rules match, outcome is deterministic: allow if any matching rule permits.
 */

import type { CmsfnRole, CmsfnRoleRule, CmsfnAction } from "./types.js";
import { validateCmsfnRole, isCmsfnAction } from "./validate.js";
import type { CmsfnPermissionInput } from "./types.js";

function ruleMatches(
  rule: CmsfnRoleRule,
  dataset: string,
  type: string,
  action: CmsfnAction
): boolean {
  const datasetMatch =
    rule.datasets === "*" || rule.datasets.includes(dataset);
  const typeMatch = rule.types === "*" || rule.types.includes(type);
  const actionMatch =
    rule.actions === "*" || rule.actions.includes(action);
  return datasetMatch && typeMatch && actionMatch;
}

/**
 * Returns true if the role permits the given dataset/type/action.
 * Deterministic: rules are evaluated in array order; allow if any rule matches.
 */
export function evaluatePermission(
  role: CmsfnRole,
  input: CmsfnPermissionInput
): boolean {
  const validated = validateCmsfnRole(role);
  if (!validated.ok || !input || typeof input.dataset !== "string" || !input.dataset.trim()
    || typeof input.type !== "string" || !input.type.trim() || !isCmsfnAction(input.action)) return false;
  const { dataset, type, action } = input;
  for (const rule of validated.role.rules) {
    if (ruleMatches(rule, dataset, type, action)) {
      return true;
    }
  }
  return false;
}

/**
 * Same as evaluatePermission but for multiple roles (e.g. user has many roles).
 * Allow if any role permits. Order of roles is significant for determinism:
 * we iterate in the order given and allow on first permitting role.
 */
export function evaluatePermissions(
  roles: CmsfnRole[],
  input: CmsfnPermissionInput
): boolean {
  if (!Array.isArray(roles)) return false;
  for (const role of roles) {
    if (evaluatePermission(role, input)) {
      return true;
    }
  }
  return false;
}
