/**
 * CompFn error codes and envelope types (API-002).
 */

export type CompfnErrorCode =
  | "CONTROL_NOT_FOUND"
  | "FRAMEWORK_NOT_FOUND"
  | "EVIDENCE_NOT_FOUND"
  | "CHECK_NOT_FOUND"
  | "VALIDATION_FAILED"
  | "ADAPTER_NOT_FOUND"
  | "ADAPTER_ERROR"
  | "STORAGE_ERROR"
  | "EXPORT_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED";

export interface CompfnError {
  code: CompfnErrorCode;
  message: string;
  details: {
    path?: string;
    id?: string;
    controlId?: string;
    frameworkId?: string;
    [key: string]: unknown;
  };
}

export type CompfnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: CompfnError };
