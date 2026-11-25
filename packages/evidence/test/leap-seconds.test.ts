import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkEvidenceCrossValues, validateEvidenceRecord } from "../src/index.js";
import type { EvidenceFailure, ValidateEvidenceRecordOptions } from "../src/index.js";
import { LEAP_SECOND_DAYS, LEAP_SECOND_LIST_EXPIRES } from "../src/leap-seconds.js";
import { cases, records, setAt, validateWithSchema } from "./fixtures.js";
import {
  REFERENCE_SOURCE,
  hoursToNs,
  insertionDays,
  ntpToIso,
  readLeapList,
  referenceExactMilliseconds,
  referenceTai,
  referenceTaiOfPosixNs,
  referenceUtc,
} from "./reference.js";

// Compares the package's leap-second results with an independent reference
// (IANA's leap-seconds.list, pinned in test/reference) and records the
// reference version and every expected and actual result in
// test/reference/leap-second-comparison.json. The test fails when a result
// differs from the reference or from that recorded report. To refresh the
// report after a deliberate change, run:
//   UPDATE_LEAP_SECOND_REPORT=1 npx vitest run test/leap-seconds.test.ts

const REPORT = new URL("./reference/leap-second-comparison.json", import.meta.url);
const list = readLeapList();
const options = cases.options;

type Row = { expected: unknown; actual: unknown };

function record(set: Record<string, unknown>): object {
  const value = structuredClone(records.minimal) as object;
  for (const [pointer, member] of Object.entries(set)) setAt(value, pointer, member);
  return value;
}

function failures(value: object, overrides: Partial<ValidateEvidenceRecordOptions> = {}): EvidenceFailure[] {
  return validateEvidenceRecord(value, { ...options, ...overrides }).failures;
}

function has(list: EvidenceFailure[], code: string, path?: string): boolean {
  return list.some((failure) => failure.code === code && (path === undefined || failure.path === path));
}

/** The same UTC minute 23:59 written at another offset, with second 60. */
function atOffset(utcDay: string, offsetMinutes: number, fraction: string): string {
  const local = new Date(Date.parse(`${utcDay}T23:59:00Z`) + offsetMinutes * 60_000).toISOString().slice(0, 16);
  if (offsetMinutes === 0) return `${local}:60${fraction}Z`;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const size = Math.abs(offsetMinutes);
  return `${local}:60${fraction}${sign}${String(Math.floor(size / 60)).padStart(2, "0")}:${String(size % 60).padStart(2, "0")}`;
}

/** How each of the package's four paths treats a date-time with second 60: as now, in a record, in the checker and on the JSON Schema path. */
function implementationAccepts(value: string): "accepted" | "rejected" | string {
  const asNow = !has(failures(records.minimal as object, { now: value }), "EVIDENCE_OPTIONS_INVALID");
  const inRecord = record({ "/timing/startedAt": value, "/timing/completedAt": value });
  const validator = !has(failures(inRecord), "EVIDENCE_MALFORMED", "/timing/startedAt");
  const checker = !checkEvidenceCrossValues(inRecord).some((failure) => failure.path === "/timing/startedAt");
  const schema = validateWithSchema(inRecord);
  const all = [asNow, validator, checker, schema];
  if (all.every(Boolean)) return "accepted";
  if (all.every((accepted) => !accepted)) return "rejected";
  return `inconsistent: now ${asNow}, validator ${validator}, checker ${checker}, schema ${schema}`;
}

function monthEnds(fromYear: number, toYear: number): string[] {
  const days: string[] = [];
  for (let year = fromYear; year <= toYear; year += 1) {
    for (let month = 1; month <= 12; month += 1) days.push(new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10));
  }
  return days;
}

const SWEEP_FORMS: Array<[number, string]> = [
  [0, ""],
  [0, ".999999999"],
  [60, ".5"],
  [-300, ".5"],
  [330, ".5"],
  [840, ".5"],
  [-720, ".5"],
];

function sweep(): { checked: number; forms: string[]; acceptedDays: string[]; mismatches: Array<{ value: string } & Row> } {
  const acceptedDays = new Set<string>();
  const mismatches: Array<{ value: string } & Row> = [];
  let checked = 0;
  for (const day of monthEnds(1970, 2028)) {
    for (const [offset, fraction] of SWEEP_FORMS) {
      const value = atOffset(day, offset, fraction);
      const expected = referenceTai(list, value) === undefined ? "rejected" : "accepted";
      const actual = implementationAccepts(value);
      checked += 1;
      if (actual === "accepted") acceptedDays.add(day);
      if (actual !== expected) mismatches.push({ value, expected, actual });
    }
  }
  return {
    checked,
    forms: SWEEP_FORMS.map(([offset, fraction]) => atOffset("2016-12-31", offset, fraction)),
    acceptedDays: [...acceptedDays],
    mismatches,
  };
}

/** Five instants around an inserted second, in order, some at an offset. */
function around(day: string): string[] {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return [`${day}T23:59:59.999999999Z`, `${day}T23:59:60Z`, atOffset(day, 60, ".5"), `${day}T23:59:60.999999999Z`, `${next}T00:00:00Z`];
}

function ordering(): Array<{ a: string; b: string } & Row> {
  const rows: Array<{ a: string; b: string } & Row> = [];
  for (const day of insertionDays(list)) {
    const instants = around(day);
    for (let index = 0; index + 1 < instants.length; index += 1) {
      const a = instants[index] as string;
      const b = instants[index + 1] as string;
      const taiA = referenceTai(list, a) as bigint;
      const taiB = referenceTai(list, b) as bigint;
      const expected = taiA < taiB ? "a<b" : taiA === taiB ? "a=b" : "a>b";
      // startedAt after completedAt is malformed; expiresAt at or before now is expired.
      const startedAfter = (x: string, y: string) => has(failures(record({ "/timing/startedAt": x, "/timing/completedAt": y })), "EVIDENCE_MALFORMED", "/timing/startedAt");
      const expired = (expiresAt: string, now: string) => has(failures(record({ "/expiresAt": expiresAt }), { now }), "EVIDENCE_EXPIRED");
      const forward = !startedAfter(a, b) && !expired(b, a);
      const backward = startedAfter(b, a) && expired(a, b);
      const actual = forward && backward ? "a<b" : !startedAfter(a, b) && !startedAfter(b, a) ? "a=b" : "a>b";
      rows.push({ a, b, expected, actual });
    }
  }
  return rows;
}

const CUTOFF_CASES: Array<[string, string]> = [
  ["2016-12-31T23:00:00Z", "1"],
  ["2016-12-31T23:00:00.5Z", "1"],
  ["2016-12-31T23:59:59.5Z", "0.0005"],
  ["2016-12-31T23:59:60Z", "1"],
  ["2016-12-31T23:59:60.75Z", "0.0005"],
  ["2017-01-01T00:59:60.25+01:00", "1"],
  ["2016-12-31T18:59:59.5-05:00", "0.0005"],
  ["2017-01-01T00:00:00Z", "1"],
  ["2016-12-31T12:00:00Z", "24"],
  ["2016-12-30T23:59:59Z", "24"],
  ["2015-06-30T23:30:00Z", "0.5"],
  ["1972-01-01T00:00:00Z", "8784"],
  ["1972-06-30T23:59:60Z", "4416"],
  ["2008-12-31T00:00:00Z", "87672"],
  ["2026-02-28T23:30:00Z", "1"],
  ["2027-06-30T23:30:00Z", "1"],
  ["1969-12-31T23:30:00Z", "1"],
];

function policyCutoffs(): Array<{ completedAt: string; hours: string; atCutoff: string; justOver: string } & Row> {
  return CUTOFF_CASES.map(([completedAt, hours]) => {
    const cutoffTai = (referenceTai(list, completedAt) as bigint) + hoursToNs(hours);
    const expected = referenceUtc(list, cutoffTai);
    const justOver = referenceUtc(list, cutoffTai + 1n);
    const policy = { expiryPolicy: { "unit-test": Number(hours) }, now: completedAt };
    const base = { "/timing/startedAt": completedAt, "/timing/completedAt": completedAt };
    const exceeds = (expiresAt: string) => failures(record({ ...base, "/expiresAt": expiresAt }), policy).find((failure) => failure.code === "EVIDENCE_EXPIRY_EXCEEDS_POLICY");
    const actual = exceeds("9999-12-31T23:59:59Z")?.detail?.maximumExpiresAt;
    return {
      completedAt,
      hours,
      expected,
      actual,
      atCutoff: exceeds(expected) === undefined ? "passes" : "EVIDENCE_EXPIRY_EXCEEDS_POLICY",
      justOver: exceeds(justOver) === undefined ? `passes at ${justOver}` : `EVIDENCE_EXPIRY_EXCEEDS_POLICY at ${justOver}`,
    };
  });
}

const EXPIRY_CASES: Array<[string, string | number]> = [
  ["2016-12-31T23:59:60.5Z", "2016-12-31T23:59:59.999Z"],
  ["2016-12-31T23:59:60.5Z", "2016-12-31T23:59:60.4Z"],
  ["2016-12-31T23:59:60.5Z", "2016-12-31T23:59:60.5Z"],
  ["2016-12-31T23:59:60.5Z", "2017-01-01T00:59:60.5+01:00"],
  ["2016-12-31T23:59:60.5Z", "2016-12-31T23:59:60.6Z"],
  ["2016-12-31T23:59:60.5Z", "2017-01-01T00:00:00Z"],
  ["2016-12-31T23:59:60.5Z", Date.UTC(2016, 11, 31, 23, 59, 59) + 999],
  ["2016-12-31T23:59:60.5Z", Date.UTC(2017, 0, 1)],
  ["2017-01-01T00:00:00Z", "2016-12-31T23:59:60.999999999Z"],
  ["2017-01-01T00:00:00Z", Date.UTC(2017, 0, 1)],
];

function referenceTaiOfNow(now: string | number): bigint {
  return typeof now === "number" ? referenceTaiOfPosixNs(list, BigInt(now) * 1_000_000n) : (referenceTai(list, now) as bigint);
}

function expiry(): Array<{ instant: string; now: string | number; expiresAtVerdict: Row; completedAtVerdict: Row }> {
  return EXPIRY_CASES.map(([instant, now]) => {
    const instantTai = referenceTai(list, instant) as bigint;
    const nowTai = referenceTaiOfNow(now);
    const expiredList = failures(record({ "/expiresAt": instant, "/timing/startedAt": "2016-12-31T22:00:00Z", "/timing/completedAt": "2016-12-31T22:00:00Z" }), { now });
    const futureList = failures(record({ "/timing/startedAt": instant, "/timing/completedAt": instant, "/expiresAt": "2017-01-01T12:00:00Z" }), { now });
    return {
      instant,
      now,
      expiresAtVerdict: { expected: instantTai <= nowTai ? "EVIDENCE_EXPIRED" : "current", actual: has(expiredList, "EVIDENCE_EXPIRED") ? "EVIDENCE_EXPIRED" : "current" },
      completedAtVerdict: {
        expected: instantTai > nowTai ? "EVIDENCE_COMPLETED_IN_FUTURE" : "not in future",
        actual: has(futureList, "EVIDENCE_COMPLETED_IN_FUTURE") ? "EVIDENCE_COMPLETED_IN_FUTURE" : "not in future",
      },
    };
  });
}

const NOON = Date.UTC(2026, 10, 1, 12);
const NUMERIC_NOW: Array<[string, number]> = [
  ["0.3", 0.3],
  ["-0.3", -0.3],
  ["2 ** -30", 2 ** -30],
  ["1e-7", 1e-7],
  ["2026-11-01T12:00:00Z + 0.1", NOON + 0.1],
  ["2026-11-01T12:00:00Z + 0.4", NOON + 0.4],
  ["2026-11-01T12:00:00Z + 0.5", NOON + 0.5],
  ["2017-01-01T00:00:00Z - 0.25", Date.UTC(2017, 0, 1) - 0.25],
  ["2017-01-01T00:00:00Z", Date.UTC(2017, 0, 1)],
];

function numericNow(): Array<{ now: string; atNow: string; justAfter: string } & Row> {
  return NUMERIC_NOW.map(([label, now]) => {
    const expected = referenceExactMilliseconds(now);
    const far = failures(record({ "/timing/completedAt": "9999-12-31T23:59:59Z", "/expiresAt": "9999-12-31T23:59:59Z" }), { now });
    const actual = far.find((failure) => failure.code === "EVIDENCE_COMPLETED_IN_FUTURE")?.detail?.now;
    const fraction = expected.slice(20, -1).padEnd(120, "0");
    const justAfterValue = `${expected.slice(0, 20)}${fraction}1Z`;
    const completed = (completedAt: string) => has(failures(record({ "/timing/startedAt": "1960-01-01T00:00:00Z", "/timing/completedAt": completedAt }), { now }), "EVIDENCE_COMPLETED_IN_FUTURE");
    return {
      now: label,
      expected,
      actual,
      atNow: completed(expected) ? "EVIDENCE_COMPLETED_IN_FUTURE" : "not in future",
      justAfter: completed(justAfterValue) ? "EVIDENCE_COMPLETED_IN_FUTURE" : "not in future",
    };
  });
}

function buildReport() {
  const days = insertionDays(list);
  const report = {
    reference: {
      source: REFERENCE_SOURCE.name,
      url: REFERENCE_SOURCE.url,
      file: "test/reference/leap-seconds.list",
      fileSha256: list.fileSha256,
      updatedNtp: list.updatedNtp,
      updated: ntpToIso(list.updatedNtp),
      expiresNtp: list.expiresNtp,
      expires: ntpToIso(list.expiresNtp),
      integrityHash: list.hash,
      integrityHashVerified: list.hash === list.computedHash,
      numericNow: "Number.prototype.toFixed(100), the exact decimal of a binary64 value below 1e21",
    },
    leapSecondDays: { expected: days, actual: [...LEAP_SECOND_DAYS] },
    listExpires: { expected: ntpToIso(list.expiresNtp).slice(0, 10), actual: LEAP_SECOND_LIST_EXPIRES },
    secondSixty: sweep(),
    ordering: ordering(),
    policyCutoffs: policyCutoffs(),
    expiry: expiry(),
    numericNow: numericNow(),
  };
  return report;
}

describe("leap seconds against the IANA reference", () => {
  const report = buildReport();

  it("reads the pinned reference intact", () => {
    expect(report.reference.integrityHashVerified).toBe(true);
    expect(report.reference.fileSha256).toBe("db5a895f16853b03bfc865e8d68f9fc8710ef1740e3400c701cd46a5bbbc3433");
    expect(report.reference.expires).toBe("2027-06-28T00:00:00.000Z");
  });

  it("lists the same leap-second days and expiry as the reference", () => {
    expect(report.leapSecondDays.actual).toEqual(report.leapSecondDays.expected);
    expect(report.listExpires.actual).toBe(report.listExpires.expected);
  });

  it("accepts second 60 exactly where the reference has an inserted second, at every offset form, on all four paths", () => {
    expect(report.secondSixty.mismatches).toEqual([]);
    expect(report.secondSixty.acceptedDays).toEqual(report.leapSecondDays.expected);
  });

  it("orders instants before, during and after each inserted second as the reference does", () => {
    for (const row of report.ordering) expect(row.actual, `${row.a} vs ${row.b}`).toBe(row.expected);
    expect(report.ordering.every((row) => row.expected === "a<b")).toBe(true);
  });

  it("computes each policy cutoff as the reference's elapsed time, passing at it and failing one nanosecond later", () => {
    for (const row of report.policyCutoffs) {
      expect(row.actual, `${row.completedAt} + ${row.hours} h`).toBe(row.expected);
      expect(row.atCutoff).toBe("passes");
      expect(row.justOver).toMatch(/^EVIDENCE_EXPIRY_EXCEEDS_POLICY at /);
    }
  });

  it("decides expiry and future completion around an inserted second as the reference does", () => {
    for (const row of report.expiry) {
      expect(row.expiresAtVerdict.actual, `${row.instant} vs ${row.now}`).toBe(row.expiresAtVerdict.expected);
      expect(row.completedAtVerdict.actual, `${row.instant} vs ${row.now}`).toBe(row.completedAtVerdict.expected);
    }
  });

  it("takes a numeric now at the exact value the reference gives for it", () => {
    for (const row of report.numericNow) {
      expect(row.actual, row.now).toBe(row.expected);
      expect(row.atNow).toBe("not in future");
      expect(row.justAfter).toBe("EVIDENCE_COMPLETED_IN_FUTURE");
    }
  });

  it("matches the recorded comparison report", () => {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (process.env.UPDATE_LEAP_SECOND_REPORT === "1") writeFileSync(REPORT, text);
    expect(existsSync(REPORT), "run with UPDATE_LEAP_SECOND_REPORT=1 to record the report").toBe(true);
    expect(JSON.parse(readFileSync(REPORT, "utf8"))).toEqual(JSON.parse(text));
  });
});
