import { beforeAll, describe, expect, it } from 'vitest';
import { CredentialMinterError, ScopeNotGrantable } from 'plugfn/credentials';
import { createGitHubAppMinter, pemToPkcs8 } from '../../src/github-app/index.js';
import {
  EXPIRES_AT,
  fakeInstallationToken,
  generateTestAppKeys,
  NOW_MS,
  NOW_SECONDS,
  RECORDED_ERRORS,
  recordedAccessToken,
  recordingFetch,
  verifyJwt,
  type TestAppKeys,
} from '../github-app/helpers.js';

let keys: TestAppKeys;

beforeAll(async () => {
  keys = await generateTestAppKeys();
});

const SCOPE = { repositories: ['app', 'lib'], permissions: { contents: 'read', issues: 'write' } } as const;

describe('GitHub App minter on workerd', () => {
  it('runs on the Workers runtime', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });

  for (const format of ['pkcs1', 'pkcs8'] as const) {
    it(`mints and revokes with a ${format.toUpperCase()} key, signing the App JWT with WebCrypto`, async () => {
      const privateKey = format === 'pkcs1' ? keys.pkcs1Pem : keys.pkcs8Pem;
      expect(pemToPkcs8(privateKey).format).toBe(format);
      const token = fakeInstallationToken(1);
      const recorder = recordingFetch([{ status: 201, body: recordedAccessToken(token) }, { status: 204 }, { status: 401, body: RECORDED_ERRORS.revoked401 }]);
      const minter = createGitHubAppMinter({ appId: 12345, privateKey, fetch: recorder.fetch, now: () => NOW_MS });

      const minted = await minter.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
      expect(minted.secret).toBe(token);
      expect(minted.expiresAt.toISOString()).toBe(new Date(EXPIRES_AT).toISOString());

      const decoded = await verifyJwt(recorder.calls[0]!.headers.authorization!.replace(/^Bearer /, ''), keys.publicKey);
      expect(decoded.valid).toBe(true);
      expect(decoded.header.alg).toBe('RS256');
      expect(decoded.claims.iat).toBe(NOW_SECONDS - 60);
      expect((decoded.claims.exp as number) - (decoded.claims.iat as number)).toBeLessThanOrEqual(600);
      expect(JSON.parse(recorder.calls[0]!.body!)).toEqual({ repositories: ['app', 'lib'], permissions: { contents: 'read', issues: 'write' } });

      await minter.revoke(minted.revokeHandle);
      await minter.revoke(minted.revokeHandle);
      expect(recorder.calls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
      expect(JSON.stringify(minted.revokeHandle)).not.toContain(token);
    });
  }

  it('maps a recorded 422 to ScopeNotGrantable without the JWT in the error', async () => {
    let jwt = '';
    const minter = createGitHubAppMinter({
      appId: 12345,
      privateKey: keys.pkcs1Pem,
      now: () => NOW_MS,
      fetch: (async (_input: unknown, init?: RequestInit) => {
        jwt = (init!.headers as Record<string, string>).authorization!.replace(/^Bearer /, '');
        return new Response(JSON.stringify({ ...RECORDED_ERRORS[422], message: `${RECORDED_ERRORS[422].message} ${jwt}` }), { status: 422 });
      }) as typeof fetch,
    });
    const error = await minter.mint({ installation: 42, scope: SCOPE, ttl: 3600 }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ScopeNotGrantable);
    expect(error).toBeInstanceOf(CredentialMinterError);
    expect(`${(error as Error).message} ${JSON.stringify(error)} ${String((error as Error).stack)}`).not.toContain(jwt);
  });
});
