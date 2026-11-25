import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// An independent leap-second reference: IANA's leap-seconds.list, pinned in
// test/reference, read with its own SHA-1 integrity check, and the arithmetic
// written separately from src/ (Date.UTC and TAI - UTC offsets instead of the
// package's calendar code, leap-minute table and elapsed-second count).

export const REFERENCE_FILE = new URL("./reference/leap-seconds.list", import.meta.url);
export const REFERENCE_SOURCE = {
  name: "IANA tzdb 2026f leap-seconds.list",
  url: "https://data.iana.org/time-zones/data/leap-seconds.list",
} as const;

/** Seconds from 1900-01-01 (NTP) to 1970-01-01 (Unix). */
const NTP_TO_UNIX = 2_208_988_800;
const NS = 1_000_000_000n;

export interface LeapEntry {
  /** Unix seconds when this TAI - UTC offset takes effect. */
  unix: number;
  /** TAI - UTC in seconds from then on. */
  dtai: number;
}

export interface LeapList {
  updatedNtp: number;
  expiresNtp: number;
  hash: string;
  computedHash: string;
  fileSha256: string;
  entries: LeapEntry[];
}

export function readLeapList(): LeapList {
  const bytes = readFileSync(REFERENCE_FILE);
  const text = bytes.toString("utf8");
  let updated = "";
  let expires = "";
  let hash = "";
  let data = "";
  const entries: LeapEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#$")) updated = line.slice(2).trim();
    else if (line.startsWith("#@")) expires = line.slice(2).trim();
    else if (line.startsWith("#h")) hash = line.slice(2).trim().split(/\s+/).join("");
    else if (/^[0-9]/.test(line)) {
      const [ntp, dtai] = line.split(/\s+/) as [string, string];
      data += ntp + dtai;
      entries.push({ unix: Number(ntp) - NTP_TO_UNIX, dtai: Number(dtai) });
    }
  }
  // The list's own integrity hash: SHA-1 of the update time, the expiry time
  // and each data line's NTP time and offset, as digits.
  const computedHash = createHash("sha1").update(updated + expires + data).digest("hex");
  return { updatedNtp: Number(updated), expiresNtp: Number(expires), hash, computedHash, fileSha256: createHash("sha256").update(bytes).digest("hex"), entries };
}

export function ntpToIso(ntp: number): string {
  return new Date((ntp - NTP_TO_UNIX) * 1000).toISOString();
}

/** The UTC days that ended with an inserted second: the day before each entry whose offset grew by one. */
export function insertionDays(list: LeapList): string[] {
  return list.entries.slice(1).flatMap((entry, index) => {
    const step = entry.dtai - (list.entries[index] as LeapEntry).dtai;
    if (step !== 1) throw new Error(`unexpected TAI - UTC step ${step} at ${entry.unix}`);
    return [new Date((entry.unix - 86_400) * 1000).toISOString().slice(0, 10)];
  });
}

function dtaiAt(list: LeapList, unix: number): number {
  let dtai = (list.entries[0] as LeapEntry).dtai;
  for (const entry of list.entries) if (entry.unix <= unix) dtai = entry.dtai;
  return dtai;
}

const DATE_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/;

/**
 * TAI nanoseconds since 1970-01-01T00:00:10 TAI-ish (Unix seconds plus
 * TAI - UTC) of an RFC 3339 date-time from 1972 on with at most nine fraction
 * digits, or undefined when it names second 60 where UTC inserted none.
 */
export function referenceTai(list: LeapList, value: string): bigint | undefined {
  const match = DATE_TIME.exec(value);
  if (!match) throw new Error(`reference cannot read ${value}`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const offset = (match[8] === "-" ? -1 : 1) * (Number(match[9] ?? 0) * 60 + Number(match[10] ?? 0));
  const minuteUnix = Date.UTC(year, month - 1, day, hour, minute) / 1000 - offset * 60;
  const fraction = BigInt((match[7] ?? "").padEnd(9, "0"));
  if (second === 60) {
    const index = list.entries.findIndex((entry) => entry.unix === minuteUnix + 60);
    if (index <= 0) return undefined;
    // The inserted second follows 23:59:59 at the offset still in force.
    return BigInt(minuteUnix + 60 + (list.entries[index - 1] as LeapEntry).dtai) * NS + fraction;
  }
  const unix = minuteUnix + second;
  return BigInt(unix + dtaiAt(list, unix)) * NS + fraction;
}

/** TAI nanoseconds of a POSIX epoch-milliseconds value given as exact nanoseconds; never an inserted second. */
export function referenceTaiOfPosixNs(list: LeapList, posixNs: bigint): bigint {
  const seconds = posixNs >= 0n ? posixNs / NS : -((-posixNs + NS - 1n) / NS);
  return posixNs + BigInt(dtaiAt(list, Number(seconds))) * NS;
}

function fractionText(nanoseconds: bigint): string {
  return nanoseconds.toString().padStart(9, "0").replace(/0+$/, "").padEnd(3, "0");
}

/** The RFC 3339 UTC form (at least three fraction digits) of a TAI nanosecond count from referenceTai. */
export function referenceUtc(list: LeapList, tai: bigint): string {
  const seconds = tai / NS;
  const fraction = tai - seconds * NS;
  const whole = Number(seconds);
  for (let index = 1; index < list.entries.length; index += 1) {
    const entry = list.entries[index] as LeapEntry;
    if (whole === entry.unix + (list.entries[index - 1] as LeapEntry).dtai) {
      return `${new Date((entry.unix - 1) * 1000).toISOString().slice(0, 17)}60.${fractionText(fraction)}Z`;
    }
  }
  let unix = whole - (list.entries[0] as LeapEntry).dtai;
  for (const entry of list.entries) if (whole - entry.dtai >= entry.unix) unix = whole - entry.dtai;
  return `${new Date(unix * 1000).toISOString().slice(0, 20)}${fractionText(fraction)}Z`;
}

/** Nanoseconds in a decimal number of hours, such as "0.0005" (1.8 s). */
export function hoursToNs(hours: string): bigint {
  const [whole, fraction = ""] = hours.split(".") as [string, string?];
  return (BigInt(whole + fraction) * 3600n * NS) / 10n ** BigInt(fraction.length);
}

/**
 * The exact value of a number as an RFC 3339 UTC date-time of that many epoch
 * milliseconds, from Number.prototype.toFixed(100), which ECMAScript defines
 * as the exact decimal for magnitudes below 1e21 (a binary64 value at these
 * magnitudes has fewer than 100 fraction digits).
 */
export function referenceExactMilliseconds(value: number): string {
  const text = value.toFixed(100);
  const negative = text.startsWith("-");
  const [whole, fraction] = (negative ? text.slice(1) : text).split(".") as [string, string];
  const scaled = BigInt(whole + fraction) * (negative ? -1n : 1n);
  const unit = 10n ** 100n;
  const floor = scaled >= 0n ? scaled / unit : -((-scaled + unit - 1n) / unit);
  const rest = (scaled - floor * unit).toString().padStart(100, "0").replace(/0+$/, "");
  const iso = new Date(Number(floor)).toISOString();
  return `${iso.slice(0, 23)}${rest}Z`;
}
