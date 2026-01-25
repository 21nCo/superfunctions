/**
 * Time utility functions for FlowFn
 */

/**
 * Duration units
 */
export interface Duration {
  milliseconds?: number;
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
  weeks?: number;
}

/**
 * Convert duration object to milliseconds
 */
export function toMilliseconds(duration: Duration): number {
  let ms = 0;

  if (duration.milliseconds) ms += duration.milliseconds;
  if (duration.seconds) ms += duration.seconds * 1000;
  if (duration.minutes) ms += duration.minutes * 60 * 1000;
  if (duration.hours) ms += duration.hours * 60 * 60 * 1000;
  if (duration.days) ms += duration.days * 24 * 60 * 60 * 1000;
  if (duration.weeks) ms += duration.weeks * 7 * 24 * 60 * 60 * 1000;

  return ms;
}

/**
 * Convert milliseconds to duration object
 */
export function fromMilliseconds(ms: number): Duration {
  const weeks = Math.floor(ms / (7 * 24 * 60 * 60 * 1000));
  ms %= 7 * 24 * 60 * 60 * 1000;

  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  ms %= 24 * 60 * 60 * 1000;

  const hours = Math.floor(ms / (60 * 60 * 1000));
  ms %= 60 * 60 * 1000;

  const minutes = Math.floor(ms / (60 * 1000));
  ms %= 60 * 1000;

  const seconds = Math.floor(ms / 1000);
  const milliseconds = ms % 1000;

  return { weeks, days, hours, minutes, seconds, milliseconds };
}

/**
 * Format duration as human-readable string
 */
export function formatDuration(duration: Duration): string {
  const parts: string[] = [];

  if (duration.weeks) parts.push(`${duration.weeks}w`);
  if (duration.days) parts.push(`${duration.days}d`);
  if (duration.hours) parts.push(`${duration.hours}h`);
  if (duration.minutes) parts.push(`${duration.minutes}m`);
  if (duration.seconds) parts.push(`${duration.seconds}s`);
  if (duration.milliseconds) parts.push(`${duration.milliseconds}ms`);

  return parts.join(" ") || "0ms";
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep for specified duration
 */
export async function sleepDuration(duration: Duration): Promise<void> {
  return sleep(toMilliseconds(duration));
}

/**
 * Create a timeout promise
 */
export function timeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(message || `Timeout after ${ms}ms`)),
        ms
      )
    ),
  ]);
}

/**
 * Get current timestamp in milliseconds
 */
export function now(): number {
  return Date.now();
}

/**
 * Calculate delay until a specific timestamp
 */
export function delayUntil(timestamp: number): number {
  return Math.max(0, timestamp - Date.now());
}

/**
 * Check if a timestamp is in the past
 */
export function isPast(timestamp: number): boolean {
  return timestamp < Date.now();
}

/**
 * Check if a timestamp is in the future
 */
export function isFuture(timestamp: number): boolean {
  return timestamp > Date.now();
}

/**
 * Add duration to timestamp
 */
export function addDuration(timestamp: number, duration: Duration): number {
  return timestamp + toMilliseconds(duration);
}

/**
 * Parse cron-like duration string (e.g., "5m", "1h", "30s")
 */
export function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(ms|s|m|h|d|w)$/);
  if (!match) {
    throw new Error(`Invalid duration string: ${str}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "w":
      return value * 7 * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown unit: ${unit}`);
  }
}
