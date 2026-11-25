// RFC 3339 date-times with an offset, parsed without Date.parse so every
// runtime agrees: Date.parse accepts forms RFC 3339 does not and rolls invalid
// calendar dates over.
//
// Times keep every fraction digit, so comparisons are exact at any precision,
// and every step is linear in the length of the fraction. A leap second
// (second 60) is accepted only where UTC can insert one: at 23:59:60 UTC, after
// the offset is applied, on the last day of a month. The package keeps no table
// of the leap seconds that actually happened. A leap second sorts after second
// 59 of its minute and before the next minute's second 0. Elapsed time counts on
// the POSIX scale, where second 60 is the same second as the next minute's
// second 0.

const DATE_TIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$/;
const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/;

const MINUTES_PER_DAY = 1440n;
const FIRST_DAY = daysFromCivil(0, 1, 1);
const LAST_DAY = daysFromCivil(9999, 12, 31);

/** A point in time: a UTC minute, a second within it (60 for a leap second) and the exact fraction of that second. */
export interface Instant {
  /** Whole UTC minutes since 1970-01-01T00:00Z. */
  readonly minute: bigint;
  /** 0 to 60. */
  readonly second: number;
  /** Fraction-of-a-second digits without trailing zeros; empty for a whole second. */
  readonly fraction: string;
}

/** An exact decimal: value / 10^scale. */
interface Decimal {
  value: bigint;
  scale: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days from 1970-01-01 to a proleptic Gregorian date (H. Hinnant's days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The proleptic Gregorian date of a day count from 1970-01-01 (H. Hinnant's civil_from_days). */
function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Floor division of bigints, rounding towards negative infinity. */
function floorDiv(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  return dividend % divisor !== 0n && dividend < 0n !== divisor < 0n ? quotient - 1n : quotient;
}

/** The exact decimal JavaScript prints for a finite number, such as 0.1 for 0.1. */
function decimalOf(value: number): Decimal {
  const match = DECIMAL.exec(String(value)) as RegExpExecArray;
  const fraction = match[3] ?? "";
  const scale = fraction.length - Number(match[4] ?? 0);
  const digits = BigInt(`${match[1]}${match[2]}${fraction}`);
  return scale >= 0 ? { value: digits, scale } : { value: digits * pow10(-scale), scale: 0 };
}

/** Drops trailing zeros by scanning from the end, so a long fraction costs linear time. */
function trimFraction(digits: string): string {
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === 48) end -= 1;
  return digits.slice(0, end);
}

/** True when a UTC minute is 23:59 on the last day of a month, the only minute UTC can end with second 60. */
function isLeapSecondMinute(minutes: number): boolean {
  const next = minutes + 1;
  return next % 1440 === 0 && civilFromDays(next / 1440)[2] === 1;
}

function fromScaledSeconds(total: bigint, scale: number): Instant {
  const unit = pow10(scale);
  const minute = floorDiv(total, 60n * unit);
  const rest = total - minute * 60n * unit;
  return { minute, second: Number(rest / unit), fraction: scale === 0 ? "" : trimFraction((rest % unit).toString().padStart(scale, "0")) };
}

/** The instant of an RFC 3339 date-time with an offset, or undefined when the value is not one. */
export function parseRfc3339(value: unknown): Instant | undefined {
  if (typeof value !== "string") return undefined;
  const match = DATE_TIME.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const sign = match[8];
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) return undefined;
  const offset = (sign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  const minutes = daysFromCivil(year, month, day) * 1440 + hour * 60 + minute - offset;
  if (second === 60 && !isLeapSecondMinute(minutes)) return undefined;
  return { minute: BigInt(minutes), second, fraction: trimFraction(match[7] ?? "") };
}

/** The instant of a finite number of epoch milliseconds, keeping any fraction of a millisecond. */
export function fromEpochMilliseconds(milliseconds: number): Instant {
  const { value, scale } = decimalOf(milliseconds);
  return fromScaledSeconds(value, scale + 3);
}

/** Negative, zero or positive as a is before, the same as or after b. */
export function compareInstants(a: Instant, b: Instant): number {
  if (a.minute !== b.minute) return a.minute < b.minute ? -1 : 1;
  if (a.second !== b.second) return a.second - b.second;
  const length = Math.max(a.fraction.length, b.fraction.length);
  const left = a.fraction.padEnd(length, "0");
  const right = b.fraction.padEnd(length, "0");
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * The instant a number of hours after another on the POSIX scale (second 60
 * counts as the next minute's second 0), exactly for the decimal JavaScript
 * prints for the hours. The hours only reach the first duration-scale fraction
 * digits, so the digits past them are carried over unchanged and the cost is
 * linear in the length of the fraction.
 */
export function addHours(instant: Instant, hours: number): Instant {
  const duration = decimalOf(hours);
  const scale = duration.scale;
  const head = instant.fraction.slice(0, scale).padEnd(scale, "0");
  const tail = instant.fraction.slice(scale);
  const total = (instant.minute * 60n + BigInt(instant.second)) * pow10(scale) + BigInt(head || "0") + duration.value * 3600n;
  const unit = pow10(scale);
  const minute = floorDiv(total, 60n * unit);
  const rest = total - minute * 60n * unit;
  const digits = scale === 0 ? "" : (rest % unit).toString().padStart(scale, "0");
  return { minute, second: Number(rest / unit), fraction: trimFraction(digits + tail) };
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

/** An RFC 3339 UTC date-time with at least millisecond digits, or undefined outside years 0000 to 9999. */
export function formatInstant(instant: Instant): string | undefined {
  const days = floorDiv(instant.minute, MINUTES_PER_DAY);
  if (days < BigInt(FIRST_DAY) || days > BigInt(LAST_DAY)) return undefined;
  const minuteOfDay = Number(instant.minute - days * MINUTES_PER_DAY);
  const [year, month, day] = civilFromDays(Number(days));
  const fraction = instant.fraction.padEnd(3, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(Math.floor(minuteOfDay / 60), 2)}:${pad(minuteOfDay % 60, 2)}:${pad(instant.second, 2)}.${fraction}Z`;
}
