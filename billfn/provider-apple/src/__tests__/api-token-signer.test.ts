import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAppStoreServerApiTokenSigner } from '../api-token-signer.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PRIVATE_KEY_PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const ISSUED_AT_MS = Date.parse('2026-11-17T00:00:00.000Z');

function decode(token: string, key: KeyObject = publicKey) {
  const [header, payload, signature] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>,
    verified: verify('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  };
}

function signer(overrides: Partial<Parameters<typeof createAppStoreServerApiTokenSigner>[0]> = {}) {
  return createAppStoreServerApiTokenSigner({
    issuerId: '57246542-96fe-1a63-e053-0824d011072a',
    keyId: '2X9R4HXF34',
    privateKey: PRIVATE_KEY_PEM,
    bundleId: 'com.example',
    ...overrides
  });
}

describe('createAppStoreServerApiTokenSigner', () => {
  it("signs an ES256 token with Apple's App Store Server API claims", async () => {
    const token = await signer({ now: () => ISSUED_AT_MS })();
    const decoded = decode(token);
    expect(decoded.verified).toBe(true);
    expect(decoded.header).toEqual({ alg: 'ES256', kid: '2X9R4HXF34', typ: 'JWT' });
    expect(decoded.payload).toEqual({
      iss: '57246542-96fe-1a63-e053-0824d011072a',
      iat: ISSUED_AT_MS / 1000,
      exp: ISSUED_AT_MS / 1000 + 1200,
      aud: 'appstoreconnect-v1',
      bid: 'com.example'
    });
  });

  it('reuses a token until shortly before it expires, then signs a new one', async () => {
    let now = ISSUED_AT_MS;
    const provider = signer({ ttlSeconds: 600, now: () => now });
    const [first, concurrent] = await Promise.all([provider(), provider()]);
    expect(concurrent).toBe(first);
    now += 539_000;
    expect(await provider()).toBe(first);
    now += 2_000;
    const renewed = await provider();
    expect(renewed).not.toBe(first);
    expect(decode(renewed).payload.iat).toBe((ISSUED_AT_MS + 541_000) / 1000);
  });

  it('signs concurrent first requests once', async () => {
    const sign = vi.spyOn(crypto.subtle, 'sign');
    try {
      const provider = signer();
      const tokens = await Promise.all([provider(), provider(), provider()]);
      expect(new Set(tokens).size).toBe(1);
      expect(sign).toHaveBeenCalledTimes(1);
    } finally {
      sign.mockRestore();
    }
  });

  it('refuses a lifetime Apple would reject and missing claims', () => {
    expect(() => signer({ ttlSeconds: 3601 })).toThrow(/lifetime/);
    expect(() => signer({ ttlSeconds: 0 })).toThrow(/lifetime/);
    expect(() => signer({ issuerId: '' })).toThrow(/issuerId/);
    expect(() => signer({ bundleId: ' ' })).toThrow(/bundleId/);
  });

  it('refuses a key that is not a PKCS#8 P-256 key', async () => {
    const sec1 = privateKey.export({ format: 'pem', type: 'sec1' }).toString();
    expect(() => signer({ privateKey: sec1 })).toThrow(/PKCS#8/);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const provider = signer({ privateKey: p384 });
    await expect(provider()).rejects.toThrow(/PKCS#8 P-256/);
    // A failed import is not cached as a success; the next call reports the same error again.
    await expect(provider()).rejects.toThrow(/PKCS#8 P-256/);
  });
});
