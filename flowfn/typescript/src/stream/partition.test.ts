import { describe, expect, it } from 'vitest';
import { partitionFor, validatePartitions } from './partition.js';

describe('stable stream partition routing', () => {
  // Independently computed with Python hashlib.sha256(key.encode('utf-8')).
  it.each([['', 2], ['tenant-α', 4], ['é', 13], ['e\u0301', 8], ['東京', 15], ['🧪', 13]] as const)(
    'uses exact UTF-8 without normalization for %s', (key, expected) => {
      expect(partitionFor(17, 'unused', key)).toBe(expected);
      expect(partitionFor(1, 'unused', key)).toBe(0);
    });
  it('routes unkeyed publications by their stable ID and honors explicit partitions', () => {
    expect(partitionFor(17, 'tenant-α')).toBe(4);
    expect(partitionFor(17, 'unused', 'tenant-α', 9)).toBe(9);
  });
  it('rejects invalid counts, out-of-range partitions and malformed Unicode', () => {
    for (const count of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) expect(() => validatePartitions(count)).toThrow();
    for (const partition of [-1, 3, 0.5, NaN]) expect(() => partitionFor(3, 'id', undefined, partition)).toThrow();
    for (const key of ['\ud800', '\udc00', 'x\ud800y']) {
      expect(() => partitionFor(3, 'id', key)).toThrow();
      expect(() => partitionFor(3, 'id', key, 0)).toThrow();
    }
  });
});
