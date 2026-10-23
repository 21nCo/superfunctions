/**
 * Pattern matching utilities for cache keys
 */

/**
 * Convert a glob pattern to a RegExp
 */
export function globToRegex(pattern: string): RegExp {
  // Escape special regex characters except * and ?
  let regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${regexPattern}$`);
}

/**
 * Check if a key matches a pattern
 */
export function matchesPattern(key: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(key);
  }
  return globToRegex(pattern).test(key);
}

/**
 * Filter keys by pattern
 */
export function filterByPattern(
  keys: string[],
  pattern?: string | RegExp
): string[] {
  if (!pattern) {
    return keys;
  }
  return keys.filter((key) => matchesPattern(key, pattern));
}
