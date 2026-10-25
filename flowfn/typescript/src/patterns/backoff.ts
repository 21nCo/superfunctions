import type { BackoffOptions } from "../queue/types.js";

export function validateBackoff(options: BackoffOptions): void {
  if (!["fixed", "exponential", "custom"].includes(options.type))
    throw new Error("Unknown backoff type");
  if (!Number.isFinite(options.delay) || options.delay < 0)
    throw new Error("Backoff delay must be finite and nonnegative");
  if (options.maxDelay !== undefined && (!Number.isFinite(options.maxDelay) || options.maxDelay < 0))
    throw new Error("Backoff maxDelay must be finite and nonnegative");
  if (options.type === "custom" && (typeof options.strategy !== "string" || !options.strategy.trim()))
    throw new Error("Custom backoff requires a strategy name");
}

export function calculateBackoff(
  attemptsMade: number,
  options: BackoffOptions,
  custom?: () => number,
): number {
  validateBackoff(options);
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1)
    throw new Error("Backoff attemptsMade must be a positive integer");
  let delay: number;
  if (options.type === "custom") {
    if (!custom) throw new Error(`Missing backoff strategy: ${options.strategy}`);
    delay = custom();
    if (!Number.isFinite(delay) || delay < 0)
      throw new Error("Custom backoff must return a finite nonnegative delay");
  } else {
    delay = options.type === "fixed" ? options.delay : options.delay === 0 ? 0 : options.delay * 2 ** (attemptsMade - 1);
  }
  delay = Math.min(delay, options.maxDelay ?? Number.MAX_SAFE_INTEGER);
  return delay;
}
