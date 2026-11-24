// ISO 8601 calendar date, or date-time with optional seconds, fraction and
// zone. A date-time without a zone is read as UTC (as the Python server does).
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Parses an ISO 8601 date or date-time to epoch milliseconds, or null when the
 * value is not one (including formats `Date.parse` would accept, such as
 * `12/31/2099` or RFC 2822 dates, and impossible dates such as `2030-02-31`).
 */
export function parseIsoInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone] = match;
  const ms = Number((fraction + '000').slice(1, 4) || '0');
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), ms);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== Number(year) ||
    check.getUTCMonth() !== Number(month) - 1 ||
    check.getUTCDate() !== Number(day) ||
    check.getUTCHours() !== Number(hour) ||
    check.getUTCMinutes() !== Number(minute) ||
    check.getUTCSeconds() !== Number(second)
  ) {
    return null;
  }
  if (!zone || zone === 'Z') return utc;
  const sign = zone[0] === '-' ? -1 : 1;
  const zoneHours = Number(zone.slice(1, 3));
  const zoneMinutes = Number(zone.slice(4, 6));
  if (zoneHours > 23 || zoneMinutes > 59) return null;
  return utc - sign * (zoneHours * 60 + zoneMinutes) * 60_000;
}

/**
 * Whether a grant's or share link's `expiresAt` has passed. A value that is
 * not an ISO 8601 date-time counts as expired: access must never outlive its
 * intended end because its date was malformed.
 */
export function isGrantExpired(expiresAt: string | null | undefined): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') {
    return false;
  }
  const expiresAtMs = parseIsoInstant(expiresAt);
  return expiresAtMs === null || expiresAtMs <= Date.now();
}
