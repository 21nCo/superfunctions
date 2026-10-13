import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import { buildOperationCatalog } from "../src/index.js";
import { clone, fixture, readJson } from "./helpers.js";

interface UpconvertCase {
  name: string;
  path: string[];
  openapi30: unknown;
  openapi31?: unknown;
}

/** Shared with scripts/verify-packed-consumer.mjs, which runs the same rows against the registry @apifn/core. */
export const UPCONVERT_CASES = readJson<{ literals: UpconvertCase[]; schemas: UpconvertCase[] }>(new URL("./upconvert-cases.json", import.meta.url).pathname);

/** The catalog fixture spec at `version` with `value` placed at `path`. */
export function specWith(version: string, path: string[], value: unknown): Record<string, any> {
  const spec = clone(fixture("catalog/openapi.json"));
  spec.openapi = version;
  let node: any = spec;
  for (const key of path.slice(0, -1)) node = node[key];
  node[path[path.length - 1]] = JSON.parse(JSON.stringify(value));
  return spec;
}

/**
 * OpenAPI 3.0 input (object, JSON text and YAML text) gives the whole result of
 * its 3.1 form: upconversion rewrites Schema Object positions only.
 */
export function describeUpconvertParity(label: string): void {
  const expectParity = (entry: UpconvertCase) => {
    const current = buildOperationCatalog(specWith("3.1.0", entry.path, entry.openapi31 ?? entry.openapi30), clone(fixture("catalog/manifest.json")));
    expect(current.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const legacy = specWith("3.0.3", entry.path, entry.openapi30);
    for (const input of [legacy, JSON.stringify(legacy), stringify(legacy)]) {
      expect(canonicalJson(buildOperationCatalog(input, clone(fixture("catalog/manifest.json"))))).toBe(canonicalJson(current));
    }
  };

  describe(`OpenAPI 3.0 upconversion ${label}`, () => {
    it.each(UPCONVERT_CASES.literals.map((entry) => [entry.name, entry] as const))("copies %s verbatim, as 3.1 does", (_name, entry) => expectParity(entry));
    it.each(UPCONVERT_CASES.schemas.map((entry) => [entry.name, entry] as const))("makes nullable on %s a null type", (_name, entry) => expectParity(entry));
  });
}
