import { createHash } from 'node:crypto';

export const PARTITION_ROUTING = 'sha256-utf8-u32be-v1';
export function validatePartitions(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > 2_147_483_647)
    throw new Error('Stream partitions must be an integer between 1 and 2147483647');
}
/** Exact UTF-8 bytes, without Unicode normalization; malformed UTF-16 is rejected. */
export function partitionFor(count: number, id: string, key?: string, explicit?: number): number {
  validatePartitions(count);
  const value = key ?? id;
  if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))
    throw new Error('Stream partition key must be valid Unicode');
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 0 || explicit >= count)
      throw new Error('Stream partition is outside the configured range');
    return explicit;
  }
  return createHash('sha256').update(value, 'utf8').digest().readUInt32BE(0) % count;
}
