/**
 * Authorization: identify subject, load roles, evaluate permission deterministically.
 * Deployment-defined: getRolesForSubject(req) supplies roles for the current request.
 */

import type { IncomingMessage } from "http";
import type { CmsfnRole, CmsfnAction } from "@cmsfn/core";
import { evaluatePermissions } from "@cmsfn/core";

export interface AuthorizeConfig {
  /**
   * Return roles for the current request (deployment-defined).
   * If not provided, permission check is skipped (caller may treat as allow or deny).
   */
  getRolesForSubject?: (req: IncomingMessage) => Promise<CmsfnRole[]>;
}

/**
 * Check if the request's subject has permission for the given dataset/type/action.
 * Returns true if allowed, false if denied.
 * When getRolesForSubject is not configured, returns false (deny by default for protected paths).
 */
export async function authorize(
  config: AuthorizeConfig,
  req: IncomingMessage,
  input: { dataset: string; type: string; action: CmsfnAction }
): Promise<boolean> {
  const getRoles = config.getRolesForSubject;
  if (!getRoles) {
    return false;
  }
  const roles = await getRoles(req);
  return evaluatePermissions(roles, {
    dataset: input.dataset,
    type: input.type,
    action: input.action,
  });
}
