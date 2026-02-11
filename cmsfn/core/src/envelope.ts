/**
 * CmsFn canonical envelope (SPEC.md).
 */

import type { CmsfnError, CmsfnErrorCode } from "./errors.js";

export type CmsfnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: CmsfnError };

export function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result };
}

export function err<T = never>(
  code: CmsfnErrorCode,
  message: string,
  details: CmsfnError["details"] = {}
): { ok: false; error: CmsfnError } {
  return {
    ok: false,
    error: { code, message, details: { ...details } },
  };
}
