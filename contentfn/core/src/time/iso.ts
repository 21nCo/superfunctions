/**
 * ISO 8601 UTC time helpers (server time only; no clock injection in this phase).
 */

/**
 * Returns current server time as ISO 8601 UTC string (e.g. 2026-02-07T17:27:22.000Z).
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Returns true if the string is a valid ISO 8601 date string.
 */
export function isISO8601(s: string): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}
