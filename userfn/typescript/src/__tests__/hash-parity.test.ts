import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hash, getBucket } from '../utils/hash';
const vectors = JSON.parse(readFileSync(new URL('../../../python/tests/fixtures/hash-vectors.json', import.meta.url), 'utf8')) as Array<{key: string; userId: string; hash: number; bucket: number}>;
describe('shared UTF-16 rollout vectors', () => {
  it.each(vectors)('matches the fixed vector for $key / $userId', vector => {
    expect(hash(`${vector.key}:${vector.userId}`)).toBe(vector.hash);
    expect(getBucket(vector.key, vector.userId)).toBe(vector.bucket);
  });
});
