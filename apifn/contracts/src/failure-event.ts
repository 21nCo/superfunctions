// Client-failure event envelope (apifn.client-failure/v1). Runtime-neutral:
// this module must not import @apifn/core so SDKs can validate events in
// browsers and edge runtimes before reporting them.

import { canonicalJson, snapshotPlainData } from "./canonical.js";
import { containsCredentialIdentifier, containsCredentialValue, isCredentialKey, pointerSegment, sanitizeReport } from "./credentials.js";
import { API_ID_PATTERN, NAME_PATTERN, OPERATION_ID_PATTERN, TARGET_PATTERN, VERSION_PATTERN } from "./manifest.js";
import { RELEASE_ID_PATTERN } from "./release.js";

export const CLIENT_FAILURE_EVENT_VERSION = "apifn.client-failure/v1" as const;

/** Limits are UTF-8 byte counts; the JSON Schema expresses them in characters. */
export const CLIENT_FAILURE_LIMITS = {
  maxEventBytes: 8192,
  maxMessageBytes: 1024,
  maxAttributes: 32,
  maxAttributeKeyBytes: 64,
  maxAttributeValueBytes: 256,
} as const;

export const CLIENT_FAILURE_KINDS = ["network", "timeout", "http", "decode", "validation", "aborted", "unknown"] as const;
export type ClientFailureKind = (typeof CLIENT_FAILURE_KINDS)[number];

export interface ClientFailureEvent {
  schemaVersion: typeof CLIENT_FAILURE_EVENT_VERSION;
  eventId: string;
  /** RFC 3339 UTC timestamp. */
  occurredAt: string;
  api: { id: string; version: string };
  operation: { id: string; name?: string; method?: string; pathTemplate?: string };
  release: {
    releaseId: string;
    catalogDigest?: string;
    sdk?: { target: string; package: string; version: string };
  };
  failure: {
    kind: ClientFailureKind;
    httpStatus?: number;
    errorCode?: string;
    message?: string;
    retryable?: boolean;
    attempt?: number;
  };
  runtime?: { name: string; version?: string };
  correlation?: { requestId?: string; traceId?: string };
  attributes?: Record<string, string | number | boolean>;
}

export type FailureEventIssueCode =
  | "REQUIRED"
  | "TYPE"
  | "UNKNOWN_FIELD"
  | "CREDENTIAL_KEY"
  | "CREDENTIAL_VALUE"
  | "TOO_LONG"
  | "PATTERN"
  | "OUT_OF_RANGE"
  | "TOO_MANY"
  | "TOO_LARGE";

export interface FailureEventIssue {
  path: string;
  code: FailureEventIssueCode;
  message: string;
}

export type ValidateFailureEventResult =
  | { ok: true; event: ClientFailureEvent }
  | { ok: false; issues: FailureEventIssue[] };

type Field =
  | {
      type: "string";
      maxBytes: number;
      pattern?: RegExp;
      values?: readonly string[];
      /** Semantic check after the pattern, such as a real calendar date. */
      valid?: { test: (value: string) => boolean; message: string };
      required?: boolean;
    }
  | { type: "integer"; min: number; max: number; required?: boolean }
  | { type: "boolean"; required?: boolean }
  | { type: "object"; fields: Record<string, Field>; required?: boolean };

const text = (maxBytes: number, pattern?: RegExp, required = false): Field => ({ type: "string", maxBytes, pattern, required });
const PRINTABLE = /^[\x21-\x7e]+$/;
/**
 * RFC 3339 UTC timestamp with in-range fields; the published schema shares
 * this pattern, and the validator also rejects dates such as February 30.
 */
export const OCCURRED_AT_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(?:\.\d{1,9})?Z$/;

/** True for an RFC 3339 UTC timestamp naming a real date and time (leap second allowed). */
function isCalendarTimestamp(value: string): boolean {
  const parts = OCCURRED_AT_PATTERN.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days && hour < 24 && minute < 60 && second <= 60;
}

const EVENT_FIELDS: Record<string, Field> = {
  schemaVersion: { type: "string", maxBytes: 64, values: [CLIENT_FAILURE_EVENT_VERSION], required: true },
  eventId: text(64, /^[A-Za-z0-9_-]{8,64}$/, true),
  occurredAt: {
    type: "string",
    maxBytes: 35,
    pattern: OCCURRED_AT_PATTERN,
    valid: { test: isCalendarTimestamp, message: "must be a real calendar date and time" },
    required: true,
  },
  api: { type: "object", required: true, fields: { id: text(128, API_ID_PATTERN, true), version: text(64, VERSION_PATTERN, true) } },
  operation: {
    type: "object",
    required: true,
    fields: {
      id: text(128, OPERATION_ID_PATTERN, true),
      name: text(128, NAME_PATTERN),
      method: { type: "string", maxBytes: 7, values: ["get", "put", "post", "delete", "options", "head", "patch", "trace"] },
      pathTemplate: text(512, /^\/[^?#\s]*$/),
    },
  },
  release: {
    type: "object",
    required: true,
    fields: {
      releaseId: text(128, RELEASE_ID_PATTERN, true),
      catalogDigest: text(71, /^sha256:[0-9a-f]{64}$/),
      sdk: {
        type: "object",
        fields: { target: text(32, TARGET_PATTERN, true), package: text(214, PRINTABLE, true), version: text(64, VERSION_PATTERN, true) },
      },
    },
  },
  failure: {
    type: "object",
    required: true,
    fields: {
      kind: { type: "string", maxBytes: 16, values: CLIENT_FAILURE_KINDS, required: true },
      httpStatus: { type: "integer", min: 100, max: 599 },
      errorCode: text(128, /^[A-Za-z0-9_.:-]+$/),
      message: text(CLIENT_FAILURE_LIMITS.maxMessageBytes),
      retryable: { type: "boolean" },
      attempt: { type: "integer", min: 1, max: 100 },
    },
  },
  runtime: { type: "object", fields: { name: text(64, PRINTABLE, true), version: text(64, PRINTABLE) } },
  correlation: { type: "object", fields: { requestId: text(128, PRINTABLE), traceId: text(128, PRINTABLE) } },
};

const ATTRIBUTE_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;

/** Plain JSON objects only: arrays, Maps, Dates and class instances are type errors, never thrown. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkString(value: string, path: string, maxBytes: number, issues: FailureEventIssue[]): boolean {
  if (byteLength(value) > maxBytes) {
    issues.push({ path, code: "TOO_LONG", message: `${path} exceeds ${maxBytes} UTF-8 bytes.` });
    return false;
  }
  if (containsCredentialValue(value)) {
    issues.push({ path, code: "CREDENTIAL_VALUE", message: `${path} contains a credential-like value; strip tokens and secrets before reporting.` });
    return false;
  }
  return true;
}

function checkField(value: unknown, field: Field, path: string, issues: FailureEventIssue[]): void {
  if (field.type === "object") {
    if (!isRecord(value)) {
      issues.push({ path, code: "TYPE", message: `${path} must be an object.` });
      return;
    }
    checkObject(value, field.fields, path, issues);
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean") issues.push({ path, code: "TYPE", message: `${path} must be a boolean.` });
  } else if (field.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      issues.push({ path, code: "TYPE", message: `${path} must be an integer.` });
    } else if (value < field.min || value > field.max) {
      issues.push({ path, code: "OUT_OF_RANGE", message: `${path} must be between ${field.min} and ${field.max}.` });
    }
  } else if (typeof value !== "string") {
    issues.push({ path, code: "TYPE", message: `${path} must be a string.` });
  } else if (value.length === 0) {
    issues.push({ path, code: "PATTERN", message: `${path} must not be empty.` });
  } else if (checkString(value, path, field.maxBytes, issues)) {
    if (field.values && !field.values.includes(value)) {
      issues.push({ path, code: "PATTERN", message: `${path} must be one of ${field.values.join(", ")}.` });
    } else if (field.pattern && !field.pattern.test(value)) {
      issues.push({ path, code: "PATTERN", message: `${path} must match ${field.pattern.source}.` });
    } else if (field.valid && !field.valid.test(value)) {
      issues.push({ path, code: "PATTERN", message: `${path} ${field.valid.message}.` });
    }
  }
}

/** Own-property lookup, so keys such as "constructor" never resolve through Object.prototype. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function checkObject(value: Record<string, unknown>, fields: Record<string, Field>, path: string, issues: FailureEventIssue[]): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${pointerSegment(key)}`;
    const field = own(fields, key);
    if (field) {
      if (child !== undefined) checkField(child, field, childPath, issues);
    } else if (isCredentialKey(key) || containsCredentialIdentifier(key)) {
      issues.push({ path: childPath, code: "CREDENTIAL_KEY", message: `${childPath} is a credential-bearing field and is never accepted.` });
    } else {
      issues.push({ path: childPath, code: "UNKNOWN_FIELD", message: `${childPath} is not part of ${CLIENT_FAILURE_EVENT_VERSION}.` });
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    if (field.required && own(value, key) === undefined) {
      issues.push({ path: `${path}/${key}`, code: "REQUIRED", message: `${path}/${key} is required.` });
    }
  }
}

function checkAttributes(value: unknown, issues: FailureEventIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path: "/attributes", code: "TYPE", message: "/attributes must be an object." });
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > CLIENT_FAILURE_LIMITS.maxAttributes) {
    issues.push({ path: "/attributes", code: "TOO_MANY", message: `/attributes allows at most ${CLIENT_FAILURE_LIMITS.maxAttributes} entries.` });
  }
  for (const [key, child] of entries) {
    const path = `/attributes/${pointerSegment(key)}`;
    if (isCredentialKey(key) || containsCredentialIdentifier(key)) {
      issues.push({ path, code: "CREDENTIAL_KEY", message: `${path} is a credential-bearing key and is never accepted.` });
    } else if (!ATTRIBUTE_KEY.test(key)) {
      issues.push({ path, code: "PATTERN", message: `Attribute keys must match ${ATTRIBUTE_KEY.source}.` });
    } else if (typeof child === "string") {
      checkString(child, path, CLIENT_FAILURE_LIMITS.maxAttributeValueBytes, issues);
    } else if (!(typeof child === "boolean" || (typeof child === "number" && Number.isFinite(child)))) {
      issues.push({ path, code: "TYPE", message: `${path} must be a string, finite number or boolean.` });
    }
  }
}

/**
 * Validates a client-failure event. Unknown fields, credential-bearing keys,
 * credential-like values and oversize fields are rejected rather than
 * trimmed, so a reporter can never persist a secret by accident. The input is
 * read once into a plain-data snapshot; that snapshot is what gets validated
 * and returned, so getters cannot change a value after it was checked.
 * Reading stops at maxEventBytes (TOO_LARGE), so cost and the issue list are
 * bounded by the event size limit, not by the input.
 */
export function validateClientFailureEvent(input: unknown): ValidateFailureEventResult {
  let result: ValidateFailureEventResult;
  try {
    result = validate(input);
  } catch {
    // Only reading exotic input (a throwing getter or proxy trap) gets here.
    return { ok: false, issues: [{ path: "", code: "TYPE", message: "A client-failure event must be plain JSON data." }] };
  }
  if (result.ok) return result;
  // Issue paths and messages quote keys from the input, which may themselves be credentials.
  return {
    ok: false,
    issues: result.issues.map((issue) => {
      const { pointer, message } = sanitizeReport(issue.path, issue.message);
      return { ...issue, path: pointer, message };
    }),
  };
}

function validate(input: unknown): ValidateFailureEventResult {
  // The size bound comes first: reading stops once the event exceeds maxEventBytes, before any key or value is scanned.
  const { value: snapshot, problems } = snapshotPlainData(input, { maxBytes: CLIENT_FAILURE_LIMITS.maxEventBytes });
  if (problems.length > 0) {
    return {
      ok: false,
      issues: problems.map(({ pointer, reason, limit }) => ({ path: pointer, code: limit ? ("TOO_LARGE" as const) : ("TYPE" as const), message: `${pointer || "The event"} ${reason}.` })),
    };
  }
  if (!isRecord(snapshot)) {
    return { ok: false, issues: [{ path: "", code: "TYPE", message: "A client-failure event must be a plain object." }] };
  }
  const issues: FailureEventIssue[] = [];
  const rest = Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "attributes"));
  checkObject(rest, EVENT_FIELDS, "", issues);
  const attributes = own(snapshot, "attributes");
  if (attributes !== undefined) checkAttributes(attributes, issues);
  if (issues.length === 0) {
    const serialized = canonicalJson(snapshot);
    if (byteLength(serialized) > CLIENT_FAILURE_LIMITS.maxEventBytes) {
      issues.push({ path: "", code: "TOO_LARGE", message: `Event exceeds ${CLIENT_FAILURE_LIMITS.maxEventBytes} UTF-8 bytes when serialized.` });
    } else {
      return { ok: true, event: JSON.parse(serialized) as ClientFailureEvent };
    }
  }
  return { ok: false, issues };
}
