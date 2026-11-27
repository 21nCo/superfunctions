// RFC 3339 date-times with an offset, parsed without Date.parse so every
// runtime agrees: Date.parse accepts forms RFC 3339 does not and rolls invalid
// calendar dates over.
//
// Times keep every fraction digit, so comparisons are exact at any precision,
// and every step is linear in the length of the fraction. A leap second
// (second 60) is accepted only where UTC inserted one: at 23:59:60 UTC, after
// the offset is applied, on a day in LEAP_SECOND_DAYS. A leap second sorts
// after second 59 of its minute and before the next minute's second 0, and
// elapsed time counts it as the real second it is.

import { LEAP_SECOND_DAYS } from "./leap-seconds.js";

const DATE_TIME = /^(\d{4})-(\d\d)-(\d\d)[Tt](\d\d):(\d\d):(\d\d)(?:\.(\d+))?([Zz]|[+-]\d\d:\d\d)$/;
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/;

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

/** The UTC minutes (23:59 on a day in LEAP_SECOND_DAYS) that end with second 60, oldest first. */
const LEAP_MINUTES: readonly bigint[] = LEAP_SECOND_DAYS.map((day) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return BigInt((daysFromCivil(year, month, date) + 1) * 1440 - 1);
});
const LEAP_MINUTE_SET: ReadonlySet<bigint> = new Set(LEAP_MINUTES);

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

/**
 * The exact value of a finite number's binary64 representation, such as
 * 0.299999999999999988897769753748434595763683319091796875 for 0.3: a
 * mantissa times a power of two, which always has a finite decimal expansion.
 */
function exactDecimalOf(value: number): Decimal {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const biased = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(view.getUint32(4));
  let exponent = biased === 0 ? -1074 : biased - 1075;
  if (biased !== 0) mantissa |= 1n << 52n;
  while (exponent < 0 && mantissa !== 0n && (mantissa & 1n) === 0n) {
    mantissa >>= 1n;
    exponent += 1;
  }
  const sign = high >>> 31 === 1 ? -1n : 1n;
  // m * 2^-k = m * 5^k / 10^k
  return exponent >= 0 ? { value: sign * (mantissa << BigInt(exponent)), scale: 0 } : { value: sign * mantissa * 5n ** BigInt(-exponent), scale: -exponent };
}

/** Drops trailing zeros by scanning from the end, so a long fraction costs linear time. */
function trimFraction(digits: string): string {
  let end = digits.length;
  while (end > 0 && digits.codePointAt(end - 1) === 48) end -= 1;
  return digits.slice(0, end);
}

/** The number of leap seconds inserted before a UTC minute starts. */
function leapSecondsBefore(minute: bigint): bigint {
  let count = 0n;
  for (const leap of LEAP_MINUTES) {
    if (leap >= minute) break;
    count += 1n;
  }
  return count;
}

/** Whole seconds since 1970-01-01T00:00:00Z counting every leap second, so a leap second is one second after 23:59:59. */
function elapsedSeconds(minute: bigint, second: number): bigint {
  return minute * 60n + BigInt(second) + leapSecondsBefore(minute);
}

/** The UTC minute and second of a whole number of elapsed seconds, the inverse of elapsedSeconds. */
function fromElapsedSeconds(elapsed: bigint): { minute: bigint; second: number } {
  let leaps = 0n;
  for (const leap of LEAP_MINUTES) {
    const leapSecond = leap * 60n + 60n + leaps;
    if (elapsed === leapSecond) return { minute: leap, second: 60 };
    if (elapsed < leapSecond) break;
    leaps += 1n;
  }
  const posix = elapsed - leaps;
  const minute = floorDiv(posix, 60n);
  return { minute, second: Number(posix - minute * 60n) };
}

function fromScaledSeconds(total: bigint, scale: number): Instant {
  const unit = pow10(scale);
  const minute = floorDiv(total, 60n * unit);
  const rest = total - minute * 60n * unit;
  return { minute, second: Number(rest / unit), fraction: scale === 0 ? "" : trimFraction((rest % unit).toString().padStart(scale, "0")) };
}

/** The parts of an RFC 3339 date-time with an offset on a real calendar day, before the leap-second check. */
function parseParts(value: unknown): Instant | undefined {
  if (typeof value !== "string") return undefined;
  const match = DATE_TIME.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const zone = match[8] as string;
  const zulu = zone === "Z" || zone === "z";
  const offsetHour = zulu ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zulu ? 0 : Number(zone.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) return undefined;
  const offset = (zone.startsWith("-") ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  const minutes = daysFromCivil(year, month, day) * 1440 + hour * 60 + minute - offset;
  return { minute: BigInt(minutes), second, fraction: trimFraction(match[7] ?? "") };
}

/** The instant of an RFC 3339 date-time with an offset, or undefined when the value is not one or names a leap second UTC did not insert. */
export function parseRfc3339(value: unknown): Instant | undefined {
  const parts = parseParts(value);
  return parts === undefined || (parts.second === 60 && !LEAP_MINUTE_SET.has(parts.minute)) ? undefined : parts;
}

/** True when a value is an RFC 3339 date-time with an offset in every respect except that its second 60 is not a leap second UTC inserted. */
export function isUninsertedLeapSecond(value: unknown): boolean {
  const parts = parseParts(value);
  return parts?.second === 60 && !LEAP_MINUTE_SET.has(parts.minute);
}

/**
 * The instant of a finite number of epoch milliseconds on the POSIX scale
 * (never second 60), at the exact value of the number's binary64
 * representation, any magnitude.
 */
export function fromEpochMilliseconds(milliseconds: number): Instant {
  const { value, scale } = exactDecimalOf(milliseconds);
  return fromScaledSeconds(value, scale + 3);
}

/** Negative, zero or positive as a is before, the same as or after b. */
export function compareInstants(a: Instant, b: Instant): number {
  if (a.minute !== b.minute) return a.minute < b.minute ? -1 : 1;
  if (a.second !== b.second) return a.second - b.second;
  const length = Math.max(a.fraction.length, b.fraction.length);
  const left = a.fraction.padEnd(length, "0");
  const right = b.fraction.padEnd(length, "0");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The instant a number of hours after another in elapsed time: every leap
 * second inside the interval counts as a second, exactly for the decimal
 * JavaScript prints for the hours. The hours only reach the first
 * duration-scale fraction digits, so the digits past them are carried over
 * unchanged and the cost is linear in the length of the fraction.
 */
export function addHours(instant: Instant, hours: number): Instant {
  const duration = decimalOf(hours);
  const scale = duration.scale;
  const unit = pow10(scale);
  const head = instant.fraction.slice(0, scale).padEnd(scale, "0");
  const tail = instant.fraction.slice(scale);
  const total = elapsedSeconds(instant.minute, instant.second) * unit + BigInt(head || "0") + duration.value * 3600n;
  const whole = floorDiv(total, unit);
  const digits = scale === 0 ? "" : (total - whole * unit).toString().padStart(scale, "0");
  return { ...fromElapsedSeconds(whole), fraction: trimFraction(digits + tail) };
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
