import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkEvidenceCrossValues, evidenceRecordSchemaV1, validateEvidenceRecord } from "../src/index.js";
import type { EvidenceFailure } from "../src/index.js";
import { STRUCTURAL_CODES, cases, materialize, pointers, records, removeAt, schemaErrors, setAt, validatePlainSchema, validateWithSchema } from "./fixtures.js";

function sorted(failures: EvidenceFailure[]): EvidenceFailure[] {
  return [...failures].sort((a, b) => `${a.code} ${a.path}`.localeCompare(`${b.code} ${b.path}`));
}

const schemaFile = JSON.parse(readFileSync(new URL("../schema/evidence-record.v1.json", import.meta.url), "utf8"));

describe("exported JSON Schema", () => {
  it("is the same document as schema/evidence-record.v1.json", () => {
    expect(evidenceRecordSchemaV1).toEqual(schemaFile);
  });

  it("is frozen, so a consumer cannot change it for others", () => {
    expect(Object.isFrozen(evidenceRecordSchemaV1)).toBe(true);
    expect(Object.isFrozen(evidenceRecordSchemaV1.properties.source.properties.artifactHashes)).toBe(true);
  });

  it.each(cases.valid.map((entry) => [entry.name, entry] as const))("accepts the valid case: %s", (_name, entry) => {
    const { record } = materialize(entry);
    expect(validateWithSchema(record), schemaErrors(record)).toBe(true);
  });

  it.each(cases.invalid.map((entry) => [entry.name, entry] as const))("agrees on the invalid case: %s", (_name, entry) => {
    const { record, options } = materialize(entry);
    expect(validateWithSchema(record), schemaErrors(record)).toBe(entry.schema === "accept");
    // Every structural failure is rejected; every other failure is beyond structure.
    const structural = entry.expected.some((failure) => STRUCTURAL_CODES.has(failure.code));
    expect(structural).toBe(entry.schema === "reject");
    // Only a case with a schemaNote relies on the cross-value checker: the
    // plain schema accepts it, and the checker reports exactly the validator's
    // failures, detail included.
    expect(validatePlainSchema(record), schemaErrors(record)).toBe(entry.schema === "accept" || entry.schemaNote !== undefined);
    if (entry.schemaNote !== undefined) {
      expect(sorted(checkEvidenceCrossValues(record))).toEqual(sorted(validateEvidenceRecord(record, options).failures));
    }
  });

  it.each([...cases.valid, ...cases.invalid].map((entry) => [entry.name, entry] as const))(
    "has the cross-value checker report only failures the validator reports, identically: %s",
    (_name, entry) => {
      const { record, options } = materialize(entry);
      const validator = validateEvidenceRecord(record, options).failures;
      for (const failure of checkEvidenceCrossValues(record)) expect(validator).toContainEqual(failure);
    },
  );

  it("leaves artifact uniqueness to the cross-value checker: no uniqueItems on artifactHashes", () => {
    // Ajv 8 uniqueItems on object items calls each item's valueOf/toString and
    // throws when a record gives them as own members; paths are unique by the
    // checker, which implies unique entries.
    expect(schemaFile.properties.source.properties.artifactHashes).not.toHaveProperty("uniqueItems");
    expect(evidenceRecordSchemaV1.properties.source.properties.artifactHashes).not.toHaveProperty("uniqueItems");
  });

  // With Ajv strict and allErrors (the settings the README's path uses), a
  // malformed artifact entry is a validation error, never an exception.
  type WithArtifacts = { source: { artifactHashes: unknown[] } };
  const artifact = (records.minimal as WithArtifacts).source.artifactHashes[0] as Record<string, unknown>;
  const other = { path: "reports/other.json", sha256: "b".repeat(64) };
  it.each([
    ["own valueOf", [artifact, { ...other, valueOf: 0 }], [1]],
    ["own toString", [artifact, { ...other, toString: 0 }], [1]],
    ["own valueOf and toString on every entry", [{ ...artifact, valueOf: 0, toString: "x" }, { ...other, valueOf: null, toString: {} }], [0, 1]],
    ["own valueOf on a duplicate of the first entry", [artifact, { ...artifact, valueOf: 0 }], [1]],
    ["own toString on a duplicate of the first entry", [artifact, { ...artifact, toString: 0 }], [1]],
    ["own hasOwnProperty and constructor", [artifact, { ...other, hasOwnProperty: 0, constructor: 0 }], [1]],
    ["own __proto__ from JSON", [artifact, JSON.parse(`{"path":"reports/other.json","sha256":"${"b".repeat(64)}","__proto__":0}`)], [1]],
  ] as const)("Ajv strict allErrors rejects an artifact entry with %s without throwing", (_name, artifactHashes, indexes) => {
    const record = structuredClone(records.minimal) as WithArtifacts;
    record.source.artifactHashes = structuredClone(artifactHashes as readonly unknown[]) as unknown[];
    let accepted: boolean | undefined;
    expect(() => {
      accepted = validatePlainSchema(record);
    }).not.toThrow();
    expect(accepted).toBe(false);
    // One additionalProperties error per unknown member, at that entry.
    const errors = new Set((validatePlainSchema.errors ?? []).map((error) => `${error.instancePath} ${error.keyword}`));
    expect([...errors].sort()).toEqual(indexes.map((index) => `/source/artifactHashes/${index} additionalProperties`));
    expect(validateWithSchema(record)).toBe(false);
    const failures = validateEvidenceRecord(record, cases.options).failures;
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((failure) => failure.code === "EVIDENCE_MALFORMED" && failure.path?.startsWith("/source/artifactHashes/"))).toBe(true);
  });

  const full = { ...cases.options, expectedCommit: "2".repeat(64) };
  for (const [name, base, options] of [
    ["minimal", records.minimal, cases.options],
    ["full", records.full, full],
  ] as const) {
    it(`agrees with the validator on the ${name} record with each member in turn removed or replaced by null`, () => {
      for (const pointer of pointers(base)) {
        for (const [how, mutate] of [
          ["removed", removeAt],
          ["null", (root: unknown, at: string) => setAt(root, at, null)],
        ] as const) {
          const record = structuredClone(base);
          mutate(record, pointer);
          const structural = validateEvidenceRecord(record, options).failures.some((failure) => STRUCTURAL_CODES.has(failure.code));
          expect(validateWithSchema(record), `${pointer} ${how}: ${schemaErrors(record)}`).toBe(!structural);
        }
      }
    });
  }
});
