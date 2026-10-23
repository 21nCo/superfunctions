import { createHash } from "crypto";

/**
 * Generate a hash for job deduplication
 */
export function hashJob(data: any, options?: { algorithm?: string }): string {
  const algorithm = options?.algorithm || "sha256";
  const hash = createHash(algorithm);

  // Normalize and stringify the data for consistent hashing
  const normalized = JSON.stringify(data, Object.keys(data).sort());
  hash.update(normalized);

  return hash.digest("hex");
}

/**
 * Generate a deduplication key from job name and data
 */
export function generateDeduplicationKey(name: string, data: any): string {
  return `${name}:${hashJob(data)}`;
}

/**
 * Check if two job payloads are equivalent
 */
export function areJobsEquivalent(job1: any, job2: any): boolean {
  return hashJob(job1) === hashJob(job2);
}
