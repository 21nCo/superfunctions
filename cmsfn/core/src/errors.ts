/**
 * CmsFn canonical error codes and error shape (SPEC.md).
 */

export type CmsfnErrorCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PREVIEW_NOT_CONFIGURED"
  | "CONTENTFN_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface CmsfnError {
  code: CmsfnErrorCode;
  message: string;
  details: { path?: string; id?: string; dataset?: string; [k: string]: unknown };
}
