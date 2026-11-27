// ISO 8601 calendar date, or date-time with optional seconds, fraction and
// zone. A date alone is UTC midnight. A date-time without a zone keeps the
// reading FileFn always gave the stored value: local time for grants (read
// with Date.parse) and UTC for share links (compared as UTC ISO strings).
// A zone offset may be written with or without its colon (+05:30, +0530).
// Values FileFn stores now carry an explicit UTC zone.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parses an ISO 8601 date or date-time to epoch milliseconds, or null when the
 * value is not one (including formats `Date.parse` would accept, such as
 * `12/31/2099` or RFC 2822 dates, and impossible dates such as `2030-02-31`).
 */
export function parseIsoInstant(value: unknown, zoneless: 'local' | 'utc' = 'local'): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hourText, minute = '00', second = '00', fraction = '', zone] = match;
  const hour = hourText ?? '00';
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
  let instant = utc;
  if (!zone && hourText !== undefined && zoneless === 'local') {
    instant = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), ms).getTime();
  } else if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMinutes = Number(zone.slice(-2));
    if (zoneHours > 23 || zoneMinutes > 59) return null;
    instant = utc - sign * (zoneHours * 60 + zoneMinutes) * 60_000;
  }
  // The stored form is UTC ISO with a four-digit year; an instant outside
  // years 0001-9999 in UTC could not be read back.
  const utcYear = new Date(instant).getUTCFullYear();
  return utcYear >= 1 && utcYear <= 9999 ? instant : null;
}

/**
 * Whether a grant's or share link's `expiresAt` has passed. A value that is
 * not an ISO 8601 date-time counts as expired: access must never outlive its
 * intended end because its date was malformed.
 */
export function isGrantExpired(expiresAt: string | null | undefined, zoneless: 'local' | 'utc' = 'local'): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') {
    return false;
  }
  const expiresAtMs = parseIsoInstant(expiresAt, zoneless);
  return expiresAtMs === null || expiresAtMs <= Date.now();
}
