import { createDocumentBudget, resolveJsonMember, type DocumentBudget } from "./json-value.js";

/** Code used when a thrown value carries no usable code (D8). */
export const RUNNER_FAILED_CODE = "CLIFN_RUNNER_FAILED";

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const MESSAGE_CODE_PATTERN = /^CLIFN_[A-Z0-9_]+$/;
const UNKNOWN_FAILURE_MESSAGE = "Unknown runner failure";

/**
 * Fixed descriptions for errors that carry their code as the message, as the credential store throws them
 * (`new Error("CLIFN_CREDENTIAL_STORE_BUSY")`). The document prints the description instead of repeating the code.
 */
const MESSAGE_CODE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  CLIFN_CREDENTIAL_STORE_BUSY: "The credential store is locked by another writer; try again when it has finished.",
  CLIFN_CREDENTIAL_SYMLINK: "The credentials file is a symbolic link, so it was not used.",
  CLIFN_INVALID_PROFILE_NAME: "The credential profile name is not valid.",
});

const UNLISTED_MESSAGE_CODE_DESCRIPTION = "The operation failed.";

export interface RunnerErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export interface MappedRunnerError {
  error: RunnerErrorPayload;
  exitCode: number;
}

function describeMessageCode(code: string): string {
  return Object.hasOwn(MESSAGE_CODE_DESCRIPTIONS, code)
    ? MESSAGE_CODE_DESCRIPTIONS[code]
    : UNLISTED_MESSAGE_CODE_DESCRIPTION;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readExitCode(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 125 ? value : 1;
}

interface ThrownFields {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  exitCode?: unknown;
}

function readProperty(record: Record<string, unknown>, key: keyof ThrownFields): unknown {
  try {
    return record[key];
  } catch {
    // A throwing getter or proxy trap leaves this field unusable; the others still count.
    return undefined;
  }
}

function readFields(error: unknown): ThrownFields {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return {};
  }
  // Each property is read once, so a getter on the thrown value runs at most once.
  const record = error as Record<string, unknown>;
  return {
    code: readProperty(record, "code"),
    message: readProperty(record, "message"),
    details: readProperty(record, "details"),
    exitCode: readProperty(record, "exitCode"),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function plainMessage(error: unknown, message: unknown): string {
  if (isNonEmptyString(message)) {
    return message;
  }
  if (isNonEmptyString(error)) {
    return error;
  }
  try {
    if (error instanceof Error && isNonEmptyString(error.name)) {
      return error.name;
    }
  } catch {
    // A proxy whose traps throw has no usable name.
  }
  return UNKNOWN_FAILURE_MESSAGE;
}

/**
 * Resolves plain-object details to the redacted JSON value the document prints: sensitive keys are redacted on the
 * resolved value, so a `toJSON` cannot bring a redacted field back. Details that cannot be read or serialized, that
 * do not fit the document's budget, or that do not resolve to an object are omitted, and what they spent of the
 * budget is restored; the code, message and exit code still stand.
 */
function documentDetails(details: unknown, budget: DocumentBudget): Record<string, unknown> | undefined {
  const bytesLeft = budget.bytesLeft;
  try {
    const resolved = isPlainObject(details) ? resolveJsonMember("details", details, { budget, redact: true }) : undefined;
    if (isPlainObject(resolved)) {
      return resolved;
    }
  } catch {
    // Omitted below.
  }
  budget.bytesLeft = bytesLeft;
  return undefined;
}

function mapFields(error: unknown, fields: ThrownFields, budget: DocumentBudget): MappedRunnerError {
  const { code, message, details } = fields;
  let payload: RunnerErrorPayload;

  if (typeof code === "string" && ERROR_CODE_PATTERN.test(code)) {
    payload = { code, message: plainMessage(error, message) };
  } else if (typeof message === "string" && MESSAGE_CODE_PATTERN.test(message)) {
    payload = { code: message, message: describeMessageCode(message) };
  } else {
    payload = { code: RUNNER_FAILED_CODE, message: plainMessage(error, message) };
  }

  const usableDetails = documentDetails(details, budget);
  if (usableDetails !== undefined) {
    payload.details = usableDetails;
  }

  return { error: payload, exitCode: readExitCode(fields.exitCode) };
}

/**
 * Maps a thrown value to the error member of a result document (D8), in order:
 * 1. a string `code` matching `^[A-Z][A-Z0-9_]{1,63}$` is used as the code;
 * 2. a `message` that is exactly `^CLIFN_[A-Z0-9_]+$` becomes the code, and the message a fixed description;
 * 3. anything else is `CLIFN_RUNNER_FAILED`.
 * `details` is kept only when it is a plain object that resolves to a JSON object within `budget`, and is redacted
 * as it is resolved. The message is always a non-empty string. The exit code is an integer `exitCode` from 1 to 125,
 * else 1.
 */
export function mapRunnerError(error: unknown, budget: DocumentBudget = createDocumentBudget()): MappedRunnerError {
  try {
    return mapFields(error, readFields(error), budget);
  } catch {
    // A throwing getter or proxy on the thrown value must not stop the runner from reporting the failure.
    return { error: { code: RUNNER_FAILED_CODE, message: UNKNOWN_FAILURE_MESSAGE }, exitCode: 1 };
  }
}
