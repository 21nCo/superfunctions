import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import { buildOperationCatalog, clone, fixture, readJson } from "./helpers.js";

interface UpconvertEdit {
  path: string[];
  openapi30: unknown;
  /** The value in the 3.1 form; the 3.0 value when absent. */
  openapi31?: unknown;
}

/** One value placed at `path`, or several `edits` (a reference and its target). */
type UpconvertCase = { name: string } & (UpconvertEdit | { edits: UpconvertEdit[] });

/** A case whose 3.1 form is rejected with `error`; the 3.0 form must give the same whole result. */
type RejectedUpconvertCase = UpconvertCase & { error: { code: string; pointer: string } };

/** Shared with scripts/verify-packed-consumer.mjs, which runs the same rows against the registry @apifn/core. */
export const UPCONVERT_CASES = readJson<{
  literals: UpconvertCase[];
  schemas: UpconvertCase[];
  references: UpconvertCase[];
  rejected: RejectedUpconvertCase[];
}>(fileURLToPath(new URL("./upconvert-cases.json", import.meta.url)));

/** The catalog fixture spec at `version` with each edit's 3.0 or 3.1 value placed at its path. */
export function specWith(version: string, entry: UpconvertCase): Record<string, any> {
  const spec = clone(fixture("catalog/openapi.json"));
  spec.openapi = version;
  for (const edit of "edits" in entry ? entry.edits : [entry]) {
    let node: any = spec;
    for (const key of edit.path.slice(0, -1)) node = node[key];
    node[edit.path[edit.path.length - 1]] = clone(version.startsWith("3.0.") ? edit.openapi30 : (edit.openapi31 ?? edit.openapi30));
  }
  return spec;
}

/**
 * OpenAPI 3.0 input (object, JSON text and YAML text) gives the whole result of
 * its 3.1 form: upconversion rewrites Schema Object positions only.
 */
export function describeUpconvertParity(label: string): void {
  const expectParity = (entry: UpconvertCase | RejectedUpconvertCase) => {
    const current = buildOperationCatalog(specWith("3.1.0", entry), clone(fixture("catalog/manifest.json")));
    const errors = current.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if ("error" in entry) expect(errors).toContainEqual(expect.objectContaining(entry.error));
    else expect(errors).toEqual([]);
    const legacy = specWith("3.0.3", entry);
    for (const input of [legacy, JSON.stringify(legacy), stringify(legacy)]) {
      expect(canonicalJson(buildOperationCatalog(input, clone(fixture("catalog/manifest.json"))))).toBe(canonicalJson(current));
    }
  };

  describe(`OpenAPI 3.0 upconversion ${label}`, () => {
    it.each(UPCONVERT_CASES.literals.map((entry) => [entry.name, entry] as const))("copies %s verbatim, as 3.1 does", (_name, entry) => expectParity(entry));
    it.each(UPCONVERT_CASES.schemas.map((entry) => [entry.name, entry] as const))("makes nullable on %s a null type", (_name, entry) => expectParity(entry));
    it.each(UPCONVERT_CASES.references.map((entry) => [entry.name, entry] as const))("reads %s by the type of its reference", (_name, entry) => expectParity(entry));
    it.each(UPCONVERT_CASES.rejected.map((entry) => [entry.name, entry] as const))("rejects %s as 3.1 does", (_name, entry) => expectParity(entry));
  });
}
