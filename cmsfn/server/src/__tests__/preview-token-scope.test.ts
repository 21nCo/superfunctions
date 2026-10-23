import { createHmac } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { mintPreviewToken, verifyPreviewToken, validPreviewConfig } from '../preview/tokens.js';
const secret = 'fixture-preview-secret-32-bytes-minimum';
const audience = 'https://preview.test';
const scope = { audience, dataset: 'prod', docId: 'one' };
afterEach(() => vi.restoreAllMocks());
it('binds signatures to trusted audience/dataset/doc scope and rejects exactly expired tokens', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const minted = mintPreviewToken({ secret, audience, ttlSec: 2 }, 'prod', ['drafts.one', 'one']);
  expect(minted.docIds).toEqual(['one']); expect(minted.audience).toBe(audience);
  expect(verifyPreviewToken(secret, minted.token, scope)).toMatchObject({ version: 2, docIds: ['one'], exp: 1002 });
  for (const changed of [{ ...scope, audience: 'https://elsewhere.test' }, { ...scope, dataset: 'staging' }, { ...scope, docId: 'two' }]) expect(verifyPreviewToken(secret, minted.token, changed)).toBeNull();
  expect(verifyPreviewToken(secret, minted.token + 'x', scope)).toBeNull();
  vi.mocked(Date.now).mockReturnValue(1_002_000);
  expect(verifyPreviewToken(secret, minted.token, scope)).toBeNull();
});
it('rejects legacy unaudienced tokens, malformed claims and unsafe/weak host configurations', () => {
  const sign = (claims: unknown) => { const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`; };
  const exp = Math.floor(Date.now() / 1000) + 60;
  for (const claims of [{ dataset: 'prod', docIds: ['one'], exp }, { version: 2, audience, dataset: 'prod', docIds: [1], exp }, { version: 2, audience, dataset: 'prod', docIds: ['one'], exp: exp + 3600 }]) expect(verifyPreviewToken(secret, sign(claims), scope)).toBeNull();
  for (const config of [{ secret: 'short', audience }, { secret, audience: 'javascript:alert(1)' }, { secret, audience: 'https://user:password@preview.test' }, { secret, audience, ttlSec: Infinity }, { secret, audience, ttlSec: 901 }, { secret, audience, ttlSec: 0 }]) expect(validPreviewConfig(config)).toBe(false);
  expect(() => mintPreviewToken({ secret, audience }, 'prod', [])).toThrow();
});
