/**
 * Fast hash function for key generation
 */

/**
 * Simple hash function (FNV-1a)
 */
export function hash(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Hash function arguments for memoization
 */
export function hashArgs(args: any[]): string {
  return hash(JSON.stringify(args));
}

/**
 * Generate a cache key from arguments
 */
export function generateKey(prefix: string, args: any[]): string {
  if (args.length === 0) {
    return prefix;
  }
  return `${prefix}:${hashArgs(args)}`;
}
