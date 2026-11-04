import type { WatchErrorCode, WatchErrorInfo } from "./types.js";

/** Error thrown by `query`, `start` and `registerCollector`. */
export class WatchError extends Error {
  readonly code: WatchErrorCode | "start_failed" | "invalid_config" | "invalid_state";
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
