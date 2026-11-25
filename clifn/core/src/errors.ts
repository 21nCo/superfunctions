/** Code used when a thrown value carries no usable code. */
export const RUNNER_FAILED_CODE = "CLIFN_RUNNER_FAILED";

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
/** The longest string ERROR_CODE_PATTERN matches: longer codes are rejected from their length, never scanned. */
const MAX_ERROR_CODE_LENGTH = 64;
const MESSAGE_CODE_PATTERN = /^CLIFN_[A-Z0-9_]+$/;
const UNKNOWN_FAILURE_MESSAGE = "Unknown runner failure";

/**
 * Fixed descriptions for errors that carry their code as the message, as the credential store throws them
 * (`new Error("CLIFN_CREDENTIAL_STORE_BUSY")`). The classification gives the description instead of repeating the code.
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
}

export interface ClassifiedRunnerError {
  error: RunnerErrorPayload;
  exitCode: number;
}

function describeMessageCode(code: string): string {
  return Object.hasOwn(MESSAGE_CODE_DESCRIPTIONS, code)
    ? MESSAGE_CODE_DESCRIPTIONS[code]
    : UNLISTED_MESSAGE_CODE_DESCRIPTION;
}

function readExitCode(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 125 ? value : 1;
}

/** A classified error with the thrown value's `details`, read in the same pass as its other fields. */
export interface ClassifiedRunnerFailure extends ClassifiedRunnerError {
  details: unknown;
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

function readFields(error: unknown, withDetails: boolean): ThrownFields {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return {};
  }
  // Each property is read once, in this order, so a getter on the thrown value runs at most once.
  const record = error as Record<string, unknown>;
  return {
    code: readProperty(record, "code"),
    message: readProperty(record, "message"),
    ...(withDetails ? { details: readProperty(record, "details") } : {}),
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
    // Read once, so a getter cannot pass the check with one value and return another.
    const name: unknown = error instanceof Error ? error.name : undefined;
    if (isNonEmptyString(name)) {
      return name;
    }
  } catch {
    // A proxy whose traps throw has no usable name.
  }
  return UNKNOWN_FAILURE_MESSAGE;
}

/**
 * `maxMessageCodeLength` bounds which messages are matched as a code: a regular expression flattens the string it
 * scans, so a longer message (such as a rope far larger than the heap) is never scanned and stays the message.
 */
function classifyFields(
  error: unknown,
  fields: ThrownFields,
  maxMessageCodeLength = Number.POSITIVE_INFINITY
): ClassifiedRunnerError {
  const { code, message } = fields;
  let payload: RunnerErrorPayload;

  if (typeof code === "string" && code.length <= MAX_ERROR_CODE_LENGTH && ERROR_CODE_PATTERN.test(code)) {
    payload = { code, message: plainMessage(error, message) };
  } else if (
    typeof message === "string" &&
    message.length <= maxMessageCodeLength &&
    MESSAGE_CODE_PATTERN.test(message)
  ) {
    payload = { code: message, message: describeMessageCode(message) };
  } else {
    payload = { code: RUNNER_FAILED_CODE, message: plainMessage(error, message) };
  }

  return { error: payload, exitCode: readExitCode(fields.exitCode) };
}

/**
 * Classifies a thrown value into a stable error code, in order:
 * 1. a string `code` matching `^[A-Z][A-Z0-9_]{1,63}$` is used as the code;
 * 2. a `message` that is exactly `^CLIFN_[A-Z0-9_]+$` becomes the code, and the message a fixed description;
 * 3. anything else is `CLIFN_RUNNER_FAILED`.
 * The message is always a non-empty string. The exit code is an integer `exitCode` from 1 to 125, else 1.
 * Internal: not exported from the package.
 */
export function classifyRunnerError(error: unknown): ClassifiedRunnerError {
  try {
    return classifyFields(error, readFields(error, false));
  } catch {
    // A throwing getter or proxy on the thrown value must not stop the runner from reporting the failure.
    return { error: { code: RUNNER_FAILED_CODE, message: UNKNOWN_FAILURE_MESSAGE }, exitCode: 1 };
  }
}

/**
 * `classifyRunnerError` for a result document (D8): it also reads the thrown value's `details` (after `message` and
 * before `exitCode`, each once) and returns it unchanged; the document decides whether it is usable. A details
 * getter that throws leaves `details` undefined. A message longer than `maxCodeLength`, which could not be printed as
 * a code anyway, is not matched against the message-code pattern, so it is never flattened or scanned here; the
 * document then prints it, or its too-long fallback, as the message. Internal: not exported from the package.
 */
export function classifyRunnerFailure(
  error: unknown,
  maxCodeLength = Number.POSITIVE_INFINITY
): ClassifiedRunnerFailure {
  try {
    const fields = readFields(error, true);
    return { ...classifyFields(error, fields, maxCodeLength), details: fields.details };
  } catch {
    return { error: { code: RUNNER_FAILED_CODE, message: UNKNOWN_FAILURE_MESSAGE }, exitCode: 1, details: undefined };
  }
}
