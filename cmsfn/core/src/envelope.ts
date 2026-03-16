/**
 * CmsFn canonical envelope (SPEC.md).
 */

import { createErrorRegistry } from "@superfunctions/errors";
import { err as createEnvelopeError, ok as createEnvelopeSuccess, toLegacyResultEnvelope } from "@superfunctions/envelope";
import type { CmsfnError, CmsfnErrorCode } from "./errors.js";

export type CmsfnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: CmsfnError };

const cmsErrorRegistry = createErrorRegistry([
  { code: "AUTH_REQUIRED", httpStatus: 401, retryable: false },
  { code: "PERMISSION_DENIED", httpStatus: 403, retryable: false },
  { code: "VALIDATION_FAILED", httpStatus: 400, retryable: false },
  { code: "PAYLOAD_TOO_LARGE", httpStatus: 413, retryable: false },
  { code: "RATE_LIMITED", httpStatus: 429, retryable: true },
  { code: "NOT_FOUND", httpStatus: 404, retryable: false },
  { code: "CONFLICT", httpStatus: 409, retryable: false },
  { code: "PREVIEW_NOT_CONFIGURED", httpStatus: 400, retryable: false },
  { code: "CONTENTFN_UNAVAILABLE", httpStatus: 503, retryable: true },
  { code: "INTERNAL_ERROR", httpStatus: 500, retryable: true },
]);

export function ok<T>(result: T): { ok: true; result: T } {
  const canonical = createEnvelopeSuccess(result);
  return toLegacyResultEnvelope(canonical);
}

export function err<T = never>(
  code: CmsfnErrorCode,
  message: string,
  details: CmsfnError["details"] = {}
): { ok: false; error: CmsfnError } {
  const resolved = cmsErrorRegistry.resolveOrDefault(code, {
    httpStatus: 500,
    retryable: code === "INTERNAL_ERROR" || code === "CONTENTFN_UNAVAILABLE" || code === "RATE_LIMITED",
  });
  const canonical = createEnvelopeError({
    code,
    message,
    status: resolved.httpStatus,
    retryable: resolved.retryable,
    details: { ...details },
  });

  return {
    ok: false,
    error: {
      code: canonical.error.code as CmsfnErrorCode,
      message: canonical.error.message,
      details: (canonical.error.details ?? {}) as CmsfnError["details"],
    },
  };
}
