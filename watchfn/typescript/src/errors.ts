import type { WatchErrorCode, WatchErrorInfo } from "./types.js";

/** Error thrown by `query`, `start` and `registerCollector`. */
export class WatchError extends Error {
  readonly code: WatchErrorCode;
  readonly issues?: string[];

  constructor(code: WatchError["code"], message: string, options?: { issues?: string[]; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WatchError";
    this.code = code;
    if (options?.issues) this.issues = options.issues;
  }
}

export function errorInfo(code: WatchErrorCode, message: string, issues?: string[]): WatchErrorInfo {
  return issues && issues.length > 0 ? { code, message, issues } : { code, message };
}

/** Longest error description copied into a receipt or a `WatchError` message. */
const MAX_DESCRIPTION_LENGTH = 500;

/** Runs a read that may throw (a getter, a proxy trap, a hostile `toString`) and returns undefined if it does. */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function errorMessage(value: unknown): string | undefined {
  if (attempt(() => value instanceof Error) !== true) return undefined;
  const message = attempt(() => (value as Error).message);
  return typeof message === "string" ? message : "";
}

/**
 * Describes any thrown value without throwing: an `Error`'s message plus the
 * message of its direct cause (drivers wrapped by ORMs often carry one), or
 * `String(value)` for anything else. Values that cannot be read or converted,
 * such as null-prototype objects, throwing getters or a throwing
 * `Symbol.toPrimitive`, get a fixed description.
 */
export function describeError(error: unknown): string {
  let description: string;
  const message = errorMessage(error);
  if (message !== undefined) {
    const cause = errorMessage(attempt(() => (error as Error).cause));
    description = message || "error without a message";
    if (cause && !description.includes(cause)) description = `${description}: ${cause}`;
  } else {
    const text = attempt(() => String(error));
    description = typeof text === "string" && text.length > 0 ? text : "a value that could not be described was thrown";
  }
  return description.length > MAX_DESCRIPTION_LENGTH ? `${description.slice(0, MAX_DESCRIPTION_LENGTH)}…` : description;
}

/**
 * Observes a value a caller-supplied callback returned. If it is a thenable that
 * rejects (or its `then` cannot be read or called), `onRejected` receives the
 * reason, so an async callback never causes an unhandled rejection.
 */
export function observeResult(result: unknown, onRejected: (reason: unknown) => void): void {
  if (result === null || (typeof result !== "object" && typeof result !== "function")) return;
  // A fresh promise resolved with the value reads and calls its `then` and turns any throw
  // into a rejection. Unlike Promise.resolve, it never reads a promise's `constructor`.
  new Promise<unknown>((resolve) => resolve(result)).then(undefined, (reason: unknown) => {
    try {
      onRejected(reason);
    } catch {
      // The rejection handler is the last stop; it must not create another unhandled rejection.
    }
  });
}
