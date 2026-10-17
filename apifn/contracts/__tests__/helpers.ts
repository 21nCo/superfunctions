import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { expect } from "vitest";
import { buildOperationCatalog as buildUnchecked, type OperationCatalog } from "../src/index.js";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
export const SCHEMAS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schemas");

export function readJson<T = Record<string, any>>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function fixture<T = Record<string, any>>(relative: string): T {
  return readJson<T>(path.join(FIXTURES, relative));
}

/** Compares generated JSON with a committed fixture; UPDATE_FIXTURES=1 rewrites it. */
export function matchFixture(relative: string, value: unknown): unknown {
  const file = path.join(FIXTURES, relative);
  if (process.env.UPDATE_FIXTURES === "1") {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }
  return readJson(file);
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Recursively reverses object key order without changing content. */
export function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .reverse()
        .map((key) => [key, reverseKeys((value as Record<string, unknown>)[key])])
    ) as T;
  }
  return value;
}

/** JSON pointers where two JSON values differ (array length changes report the array). */
export function jsonDiff(left: unknown, right: unknown, pointer = ""): string[] {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return [pointer];
    return left.flatMap((item, index) => jsonDiff(item, right[index], `${pointer}/${index}`));
  }
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].sort().flatMap((key) =>
      jsonDiff((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${pointer}/${key}`)
    );
  }
  return JSON.stringify(left) === JSON.stringify(right) ? [] : [pointer];
}

/** Scaling rows allow this much time: inputs are sized for hosted runners under load, and a quadratic rule fails the ratio, not the clock. */
export const SCALING_TIMEOUT = 60_000;

/** The ratio {@link scalingRatio} must stay below: well above linear (4), well below quadratic (16). */
export const LINEAR_RATIO = 9;

/**
 * Best-of-`runs` wall time of `work(4 * size)` over `work(size)`, the smaller
 * time floored at 1 ms so sub-millisecond noise cannot inflate it. A linear
 * rule stays near 4; a quadratic one approaches 16. Load on a shared runner
 * only inflates a ratio, so one at or above {@link LINEAR_RATIO} is measured
 * again, up to `attempts` times, and the lowest is returned: a quadratic rule
 * exceeds it on every attempt.
 */
export function scalingRatio(work: (size: number) => void, size: number, runs = 3, attempts = 3): number {
  const time = (n: number) => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < runs; run += 1) {
      const started = performance.now();
      work(n);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  let lowest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts && lowest >= LINEAR_RATIO; attempt += 1) {
    const small = time(size);
    lowest = Math.min(lowest, time(size * 4) / Math.max(small, 1));
  }
  return lowest;
}

const oracle = new Ajv2020({ strict: false, logger: false });

/**
 * Every schema a catalog publishes (component and inline) that is not valid
 * JSON Schema 2020-12, as "<catalog pointer>: <reason>": each must pass the
 * 2020-12 meta-schema and (unless `compile` is false) compile in Ajv2020 as
 * one document without a base URI, so `#/components/schemas/*` references
 * resolve against the catalog's own schemas.
 */
export function unpublishableSchemas(catalog: OperationCatalog, { compile = true } = {}): string[] {
  const placed: Array<[string, unknown]> = Object.entries(catalog.schemas).map(([name, schema]) => [`/schemas/${name}`, schema]);
  catalog.operations.forEach((operation, i) => {
    operation.parameters.forEach((parameter, j) => placed.push([`/operations/${i}/parameters/${j}/schema`, parameter.schema]));
    operation.requestBody?.contents.forEach((content, j) => placed.push([`/operations/${i}/requestBody/contents/${j}/schema`, content.schema]));
    operation.responses.forEach((response, j) => response.contents.forEach((content, k) => placed.push([`/operations/${i}/responses/${j}/contents/${k}/schema`, content.schema])));
  });
  const schemas = placed.filter(([, schema]) => schema !== null);
  const problems = schemas.flatMap(([at, schema]) => (oracle.validateSchema(schema as object) ? [] : [`${at}: ${oracle.errorsText(oracle.errors)}`]));
  if (!compile) return problems;
  try {
    oracle.compile({
      components: { schemas: catalog.schemas },
      published: schemas.map(([, schema]) => schema),
      allOf: schemas.map((_, index) => ({ $ref: `#/published/${index}` })),
    });
  } catch (error) {
    problems.push(`compile: ${(error as Error).message}`);
  } finally {
    oracle.removeSchema();
  }
  return problems;
}

/** buildOperationCatalog, asserting that every schema a successful catalog publishes is valid JSON Schema 2020-12 that compiles. */
export function buildOperationCatalog(...args: Parameters<typeof buildUnchecked>): ReturnType<typeof buildUnchecked> {
  const result = buildUnchecked(...args);
  if (result.catalog) expect(unpublishableSchemas(result.catalog)).toEqual([]);
  return result;
}
