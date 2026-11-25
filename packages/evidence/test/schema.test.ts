import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evidenceRecordSchemaV1, validateEvidenceRecord } from "../src/index.js";
import { STRUCTURAL_CODES, cases, crossValueFailures, materialize, pointers, records, removeAt, schemaErrors, setAt, validatePlainSchema, validateWithSchema } from "./fixtures.js";

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
    const { record } = materialize(entry);
    expect(validateWithSchema(record), schemaErrors(record)).toBe(entry.schema === "accept");
    // Every structural failure is rejected; every other failure is beyond structure.
    const structural = entry.expected.some((failure) => STRUCTURAL_CODES.has(failure.code));
    expect(structural).toBe(entry.schema === "reject");
    // Only a case with a schemaNote relies on a cross-value check: the plain
    // schema accepts it, and the check reports the validator's failure path.
    expect(validatePlainSchema(record), schemaErrors(record)).toBe(entry.schema === "accept" || entry.schemaNote !== undefined);
    if (entry.schemaNote !== undefined) {
      expect(crossValueFailures(record)).toEqual(entry.expected.map((failure) => failure.path));
    }
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
