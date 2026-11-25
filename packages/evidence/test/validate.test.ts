import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { EVIDENCE_FAILURE_CODES, validateEvidenceRecord } from "../src/index.js";
import type { EvidenceValidationResult, ValidateEvidenceRecordOptions } from "../src/index.js";
import { cases, materialize, pointers, records, removeAt, setAt } from "./fixtures.js";

const options = cases.options;

function summary(result: EvidenceValidationResult): Array<{ code: string; path?: string }> {
  return result.failures.map(({ code, path }) => (path === undefined ? { code } : { code, path }));
}

function expectWellFormedResult(result: EvidenceValidationResult): void {
  expect(result.ok).toBe(result.failures.length === 0);
  const keys = result.failures.map((failure) => `${failure.code} ${failure.path ?? ""}`);
  expect(new Set(keys).size).toBe(keys.length);
  for (const failure of result.failures) expect(EVIDENCE_FAILURE_CODES).toContain(failure.code);
}

describe("valid records", () => {
  it.each(cases.valid.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const { record, options: caseOptions } = materialize(entry);
    expect(validateEvidenceRecord(record, caseOptions)).toEqual({ ok: true, failures: [] });
  });

  it("accepts now as a Date, epoch milliseconds, an RFC 3339 string or a Date from another realm", () => {
    const time = Date.parse("2026-11-01T12:00:00Z");
    for (const now of [new Date(time), time, "2026-11-01T14:00:00+02:00", runInNewContext(`new Date(${time})`) as Date]) {
      expect(validateEvidenceRecord(records.minimal, { ...options, now })).toEqual({ ok: true, failures: [] });
    }
  });

  it("does not change or depend on mutating the record", () => {
    const frozen = structuredClone(records.full) as object;
    const deepFreeze = (value: unknown): void => {
      if (typeof value === "object" && value !== null) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
      }
    };
    deepFreeze(frozen);
    expect(validateEvidenceRecord(frozen, { ...options, expectedCommit: "2".repeat(64) }).ok).toBe(true);
    expect(frozen).toEqual(records.full);
  });

  it("accepts any member names, including __proto__, inside tools and attributes", () => {
    const record = JSON.parse(JSON.stringify(records.minimal).replace('"tools":{}', '"tools":{"__proto__":"1.0.0","constructor":"2"},"attributes":{"__proto__":null}'));
    expect(Object.hasOwn(record.environment.tools, "__proto__")).toBe(true);
    expect(validateEvidenceRecord(record, options)).toEqual({ ok: true, failures: [] });
  });
});

describe("invalid records", () => {
  it.each(cases.invalid.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const { record, options: caseOptions } = materialize(entry);
    const result = validateEvidenceRecord(record, caseOptions);
    expectWellFormedResult(result);
    expect(result.ok).toBe(false);
    const expected = entry.expected.map(({ code, path }) => (path === undefined ? { code } : { code, path }));
    expect(summary(result)).toEqual(expect.arrayContaining(expected));
    expect(result.failures).toHaveLength(expected.length);
    for (const failure of entry.expected) {
      if (failure.detail) expect(result.failures.find((actual) => actual.code === failure.code && actual.path === failure.path)?.detail).toMatchObject(failure.detail);
    }
  });

  it("has a case returning exactly each failure code alone", () => {
    const alone = new Set(cases.invalid.filter((entry) => entry.expected.length === 1).map((entry) => entry.expected[0]?.code));
    expect([...alone].sort()).toEqual([...EVIDENCE_FAILURE_CODES].sort());
  });

  it("reports an unknown member at an escaped JSON Pointer", () => {
    const record = { ...(records.minimal as object), "a/b~c": true };
    expect(summary(validateEvidenceRecord(record, options))).toEqual([{ code: "EVIDENCE_MALFORMED", path: "/a~1b~0c" }]);
  });

  it("rejects an own __proto__ member at the top level as unknown", () => {
    const record = JSON.parse(JSON.stringify(records.minimal).replace("{", '{"__proto__":{"dirty":true},'));
    expect(summary(validateEvidenceRecord(record, options))).toEqual([{ code: "EVIDENCE_MALFORMED", path: "/__proto__" }]);
  });

  it("rejects a repeated __proto__ subject ID, which Ajv's uniqueItems misses", () => {
    const record = { ...(records.minimal as object), subjectIds: ["__proto__", "__proto__"] };
    expect(summary(validateEvidenceRecord(record, options))).toEqual([{ code: "EVIDENCE_MALFORMED", path: "/subjectIds/1" }]);
  });

  it("treats a member whose value is undefined as absent", () => {
    const record = { ...(records.minimal as object), recordId: undefined, extra: undefined };
    expect(summary(validateEvidenceRecord(record, options))).toEqual([{ code: "EVIDENCE_MISSING_FIELD", path: "/recordId" }]);
  });
});

describe("missing records", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "{}"],
    ["a boolean", true],
    ["an array", [records.minimal]],
  ])("%s returns only EVIDENCE_MISSING", (_name, record) => {
    expect(validateEvidenceRecord(record, options)).toEqual({ ok: false, failures: [{ code: "EVIDENCE_MISSING" }] });
  });
});

describe("options", () => {
  const invalidOptions: Array<[string, unknown, string[]]> = [
    ["options undefined", undefined, ["options"]],
    ["options null", null, ["options"]],
    ["options an array", [], ["options"]],
    ["expectedCommit missing", { now: options.now, expiryPolicy: options.expiryPolicy }, ["expectedCommit"]],
    ["expectedCommit of 39 characters", { ...options, expectedCommit: "1".repeat(39) }, ["expectedCommit"]],
    ["expectedCommit in uppercase", { ...options, expectedCommit: "A".repeat(40) }, ["expectedCommit"]],
    ["now missing", { ...options, now: undefined }, ["now"]],
    ["now NaN", { ...options, now: Number.NaN }, ["now"]],
    ["now Infinity", { ...options, now: Number.POSITIVE_INFINITY }, ["now"]],
    ["now beyond the Date range", { ...options, now: 8.64e15 + 1 }, ["now"]],
    ["now an invalid Date", { ...options, now: new Date("not a date") }, ["now"]],
    ["now without an offset", { ...options, now: "2026-11-01T12:00:00" }, ["now"]],
    ["now not a date-time", { ...options, now: "yesterday" }, ["now"]],
    ["now a leap second outside 23:59 UTC", { ...options, now: "2026-11-01T12:00:60Z" }, ["now"]],
    ["now a leap second at an offset that is not 23:59 UTC", { ...options, now: "2016-12-31T23:59:60+01:00" }, ["now"]],
    ["now a plain object", { ...options, now: {} }, ["now"]],
    ["now an object claiming to be a Date", { ...options, now: { [Symbol.toStringTag]: "Date", getTime: () => 0 } }, ["now"]],
    ["expiryPolicy missing", { ...options, expiryPolicy: undefined }, ["expiryPolicy"]],
    ["expiryPolicy null", { ...options, expiryPolicy: null }, ["expiryPolicy"]],
    ["expiryPolicy an array", { ...options, expiryPolicy: [24] }, ["expiryPolicy"]],
    ["expiryPolicy with zero hours", { ...options, expiryPolicy: { "unit-test": 0 } }, ["expiryPolicy"]],
    ["expiryPolicy with negative hours", { ...options, expiryPolicy: { "unit-test": -1 } }, ["expiryPolicy"]],
    ["expiryPolicy with infinite hours", { ...options, expiryPolicy: { "unit-test": Number.POSITIVE_INFINITY } }, ["expiryPolicy"]],
    ["expiryPolicy with string hours", { ...options, expiryPolicy: { "unit-test": "24" } }, ["expiryPolicy"]],
    ["every option invalid", { expectedCommit: 1, now: null, expiryPolicy: "24" }, ["expectedCommit", "now", "expiryPolicy"]],
  ];

  it.each(invalidOptions)("%s returns only EVIDENCE_OPTIONS_INVALID, even for a missing record", (_name, invalid, names) => {
    for (const record of [records.minimal, undefined]) {
      expect(validateEvidenceRecord(record, invalid as ValidateEvidenceRecordOptions)).toEqual({
        ok: false,
        failures: [{ code: "EVIDENCE_OPTIONS_INVALID", detail: { invalid: names } }],
      });
    }
  });

  it("compares a fraction of about 100000 digits exactly and in linear time", () => {
    // A trailing-zero trim that backtracks would take minutes on these.
    const tiny = `${"0".repeat(99_999)}1`;
    const record = structuredClone(records.minimal) as object;
    setAt(record, "/timing/completedAt", `2026-11-01T10:00:00.${tiny}Z`);
    setAt(record, "/expiresAt", `2026-11-02T10:00:00.${tiny}Z`);
    const started = performance.now();
    expect(validateEvidenceRecord(record, { ...options, now: `2026-11-01T10:00:00.${tiny}Z` })).toEqual({ ok: true, failures: [] });
    expect(summary(validateEvidenceRecord(record, { ...options, now: `2026-11-01T10:00:00.${tiny}1Z` }))).toEqual([]);
    expect(summary(validateEvidenceRecord(record, { ...options, now: `2026-11-01T10:00:00.${"0".repeat(99_999)}0Z` }))).toEqual([
      { code: "EVIDENCE_COMPLETED_IN_FUTURE", path: "/timing/completedAt" },
    ]);
    setAt(record, "/expiresAt", `2026-11-02T10:00:00.${"0".repeat(99_999)}2Z`);
    expect(summary(validateEvidenceRecord(record, { ...options, now: `2026-11-01T10:00:00.${tiny}Z` }))).toEqual([
      { code: "EVIDENCE_EXPIRY_EXCEEDS_POLICY", path: "/expiresAt" },
    ]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("accepts a leap second as now", () => {
    expect(summary(validateEvidenceRecord(records.minimal, { ...options, now: "2016-12-31T23:59:60Z" }))).toEqual([
      { code: "EVIDENCE_COMPLETED_IN_FUTURE", path: "/timing/completedAt" },
    ]);
  });

  it("compares epoch milliseconds with a fraction exactly against a sub-millisecond completedAt", () => {
    const record = structuredClone(records.minimal) as object;
    setAt(record, "/timing/completedAt", "2026-11-01T12:00:00.0005Z");
    const noon = Date.parse("2026-11-01T12:00:00Z");
    const inFuture = (now: number) => validateEvidenceRecord(record, { ...options, now }).failures.some((failure) => failure.code === "EVIDENCE_COMPLETED_IN_FUTURE");
    expect([noon + 0.4, noon + 0.5, noon + 0.6].map(inFuture)).toEqual([true, false, false]);
  });

  it("accepts an empty expiry policy, so every class is outside it", () => {
    expect(summary(validateEvidenceRecord(records.minimal, { ...options, expiryPolicy: {} }))).toEqual([
      { code: "EVIDENCE_CLASS_NOT_IN_POLICY", path: "/evidenceClass" },
    ]);
  });

  it("does not use inherited expiry policy entries", () => {
    const policy = Object.create({ "unit-test": 24 }) as Record<string, number>;
    expect(summary(validateEvidenceRecord(records.minimal, { ...options, expiryPolicy: policy }))).toEqual([
      { code: "EVIDENCE_CLASS_NOT_IN_POLICY", path: "/evidenceClass" },
    ]);
  });
});

describe("never throws", () => {
  const full = { ...options, expectedCommit: "2".repeat(64) };
  const bases = [
    ["minimal", records.minimal, options],
    ["full", records.full, full],
  ] as const;

  for (const [name, base, baseOptions] of bases) {
    it(`returns a result for the ${name} record with each member in turn removed or replaced by null`, () => {
      for (const pointer of pointers(base)) {
        for (const mutate of [removeAt, (root: unknown, at: string) => setAt(root, at, null)]) {
          const record = structuredClone(base);
          mutate(record, pointer);
          expectWellFormedResult(validateEvidenceRecord(record, baseOptions));
        }
      }
    });
  }
});
