// Helpers shared by the validator and the cross-value checker.

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A member counts as present when it is an own property whose value is not undefined. */
export function has(value: JsonObject, key: string): boolean {
  return Object.hasOwn(value, key) && value[key] !== undefined;
}

export function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/** Length in Unicode code points, as JSON Schema's minLength and maxLength count. */
export function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** True when a path is relative POSIX with no empty value, leading slash, . or .. segment, backslash or NUL. */
export function isRelativePosixPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\u0000")) return false;
  return path.split("/").every((segment) => segment !== "." && segment !== "..");
}

/** A well-formed subject ID: a non-empty string of at most 200 characters. */
export function isSubjectId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && codePoints(value) <= 200;
}

export const EXPECTED = {
  dateTime: "an RFC 3339 date-time with an offset",
  insertedLeapSecond: "second 60 only in a leap second UTC inserted (23:59:60 UTC on a day in the leap-second list)",
  uniqueSubjectId: "a unique subject ID",
  uniqueArtifactPath: "a path no other artifact hash uses",
  startedNotAfterCompleted: "not later than completedAt",
} as const;
