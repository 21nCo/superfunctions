// RFC 3339 date-times with an offset, parsed without Date.parse so every
// runtime agrees: Date.parse accepts forms RFC 3339 does not and rolls invalid
// calendar dates over. Precision is milliseconds; further fraction digits are
// truncated. Leap seconds (second 60) are rejected, as the schema does.

const DATE_TIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$/;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

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

/** Epoch milliseconds of an RFC 3339 date-time with an offset, or undefined when the value is not one. */
export function parseRfc3339(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = DATE_TIME.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const fraction = match[7] ?? "";
  const sign = match[8];
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return undefined;
  const milliseconds = Number(fraction.slice(0, 3).padEnd(3, "0"));
  const offset = (sign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute) * MS_PER_MINUTE;
  return daysFromCivil(year, month, day) * MS_PER_DAY + ((hour * 60 + minute) * 60 + second) * 1000 + milliseconds - offset;
}
