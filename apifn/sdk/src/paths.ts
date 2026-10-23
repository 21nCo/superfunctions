// Package-relative path rules shared by generation and writing.

/** Orders by UTF-16 code unit, independent of locale, as the default sort does. */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export const comparePaths = compareCodeUnits;

/** A relative POSIX path with no empty, `.` or `..` segments, backslashes, drive letters or control characters. */
export function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || /[\\\0-\x1f:]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
