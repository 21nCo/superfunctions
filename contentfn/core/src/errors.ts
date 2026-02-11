/**
 * ContentFn canonical error codes and error shape (SPEC.md).
 */

export type ContentfnErrorCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "DATASET_NOT_FOUND"
  | "DATASET_ALREADY_EXISTS"
  | "SCHEMA_NOT_FOUND"
  | "SCHEMA_INVALID"
  | "SCHEMA_VERSION_CONFLICT"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_ALREADY_EXISTS"
  | "REV_CONFLICT"
  | "PATCH_INVALID"
  | "QUERY_INVALID"
  | "QUERY_TOO_COMPLEX"
  | "ASSET_NOT_FOUND"
  | "ASSET_UPLOAD_FAILED"
  | "WEBHOOK_NOT_FOUND"
  | "WEBHOOK_DELIVERY_FAILED"
  | "REALTIME_NOT_AVAILABLE"
  | "STORAGE_ERROR"
  | "INTERNAL_ERROR";

export interface ContentfnError {
  code: ContentfnErrorCode;
  message: string;
  details: {
    path?: string;
    id?: string;
    dataset?: string;
    type?: string;
    expectedRev?: string;
    actualRev?: string;
    [key: string]: unknown;
  };
}

export type ContentfnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: ContentfnError };

export function ok<T>(result: T): ContentfnEnvelope<T> {
  return { ok: true, result };
}

export function err<T = never>(
  code: ContentfnErrorCode,
  message: string,
  details: ContentfnError["details"] = {}
): ContentfnEnvelope<T> {
  return {
    ok: false,
    error: { code, message, details: { ...details } },
  };
}
