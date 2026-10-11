import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
