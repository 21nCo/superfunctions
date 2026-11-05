import type { WatchErrorCode, WatchErrorInfo } from "./types.js";

/** Error thrown by `query`, `start` and `registerCollector`. */
export class WatchError extends Error {
  readonly code: WatchErrorCode;
  readonly issues?: string[];

  constructor(code: WatchError["code"], message: string, options?: { issues?: string[]; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WatchError";
    this.code = code;
    if (options?.issues) this.issues = limitIssues(options.issues);
  }
}

export function errorInfo(code: WatchErrorCode, message: string, issues?: string[]): WatchErrorInfo {
  return issues && issues.length > 0 ? { code, message, issues: limitIssues(issues) } : { code, message };
}

/** Longest error description copied into a receipt or a `WatchError` message. */
const MAX_DESCRIPTION_LENGTH = 500;
/** Issues listed in one receipt or `WatchError`; the rest are counted in one more issue. */
export const MAX_ISSUES = 20;
/** Longest single issue, in UTF-16 units plus one ellipsis. */
export const MAX_ISSUE_LENGTH = 300;

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** The first `max` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
function head(text: string, max: number): string {
  return text.slice(0, max > 0 && isHigh(text.charCodeAt(max - 1)) ? max - 1 : max);
}

/** The last `max` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
function tail(text: string, max: number): string {
  const start = text.length - max;
  return text.slice(isLow(text.charCodeAt(start)) ? start + 1 : start);
}

/** Cuts `text` to at most `max` UTF-16 units plus "…", keeping surrogate pairs whole. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${head(text, max)}…` : text;
}

/**
 * Bounds the issues a receipt or `WatchError` carries: each is cut in the middle
 * to {@link MAX_ISSUE_LENGTH} so its path start and its reason both remain, and
 * beyond {@link MAX_ISSUES} + 1 issues the first {@link MAX_ISSUES} are kept and
 * one more counts the rest. Limiting an already limited list changes nothing.
 */
export function limitIssues(issues: readonly string[]): string[] {
  const half = Math.floor(MAX_ISSUE_LENGTH / 2);
  const listed = issues.length > MAX_ISSUES + 1 ? MAX_ISSUES : issues.length;
  const kept = issues
    .slice(0, listed)
    .map((issue) => (issue.length > MAX_ISSUE_LENGTH ? `${head(issue, half)}…${tail(issue, MAX_ISSUE_LENGTH - half)}` : issue));
  if (listed < issues.length) kept.push(`${issues.length - listed} more issues`);
  return kept;
}

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
  return clip(description, MAX_DESCRIPTION_LENGTH);
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
