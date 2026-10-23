// Simple FNV-1a hash implementation for deterministic bucketing
export function hash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // Ensure unsigned 32-bit integer
}

export function getBucket(key: string, contextId: string, totalBuckets: number = 100): number {
  const combined = `${key}:${contextId}`;
  const h = hash(combined);
  // Matches 0 to totalBuckets-1
  return h % totalBuckets;
}
