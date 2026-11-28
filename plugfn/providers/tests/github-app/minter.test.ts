import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { inspect } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { CredentialMinterError, ScopeNotGrantable } from 'plugfn/credentials';
import {
  createGitHubAppMinter,
  GitHubAppKeyError,
  GitHubAppRevokeHandle,
  pemToPkcs8,
  type GitHubAppMinterOptions,
} from '../../src/github-app/index.js';
import {
  EXPIRES_AT,
  fakeInstallationToken,
  generateTestAppKeys,
  NOW_MS,
  NOW_SECONDS,
  pem,
  RECORDED_ERRORS,
  recordedAccessToken,
  recordingFetch,
  verifyJwt,
  type RecordedResponse,
  type TestAppKeys,
} from './helpers.js';

let keys: TestAppKeys;

beforeAll(async () => {
  keys = await generateTestAppKeys();
});

const SCOPE = { repositories: ['lib', 'App'], permissions: { issues: 'write', contents: 'read' } } as const;

function minter(responses: RecordedResponse[], options: Partial<GitHubAppMinterOptions> = {}) {
  const recorder = recordingFetch(responses);
  const instance = createGitHubAppMinter({
    appId: 12345,
    privateKey: keys.pkcs1Pem,
    fetch: recorder.fetch,
    now: () => NOW_MS,
    ...options,
  });
  return { minter: instance, calls: recorder.calls };
}

async function rejection(promise: Promise<unknown>): Promise<CredentialMinterError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CredentialMinterError);
  return error as CredentialMinterError;
}

describe('GitHub App minter: mint (recorded responses)', () => {
  it('mints a token narrowed to the requested repositories and permissions', async () => {
    const token = fakeInstallationToken(1);
    const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(token) }]);

    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });

    expect(minted.secret).toBe(token);
    expect(minted.expiresAt.toISOString()).toBe(new Date(EXPIRES_AT).toISOString());
    expect(minted.revokeHandle).toBeInstanceOf(GitHubAppRevokeHandle);
    expect(minted.revokeHandle.installationId).toBe('42');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe('POST');
    expect(call!.url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(call!.headers.accept).toBe('application/vnd.github+json');
    expect(call!.headers['x-github-api-version']).toBe('2022-11-28');
    expect(call!.headers['user-agent']).toBeTruthy();
    expect(call!.headers['content-type']).toBe('application/json');
    // Repository names lower-cased and sorted; each permission at its highest requested level.
    expect(JSON.parse(call!.body!)).toEqual({ repositories: ['app', 'lib'], permissions: { contents: 'read', issues: 'write' } });
    expect(m.grammar.provider).toBe('github-app');
  });

  it('accepts a decimal-string installation ID and a GitHub Enterprise Server base URL', async () => {
    const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(fakeInstallationToken(1)) }], {
      baseUrl: 'https://ghe.example.test/api/v3/',
    });
    await m.mint({ installation: '42', scope: SCOPE, ttl: 600 });
    expect(calls[0]!.url).toBe('https://ghe.example.test/api/v3/app/installations/42/access_tokens');
  });

  it('maps 401 to unauthorized', async () => {
    const { minter: m } = minter([{ status: 401, body: RECORDED_ERRORS[401] }]);
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(error.code).toBe('unauthorized');
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
    expect(error).not.toBeInstanceOf(ScopeNotGrantable);
  });

  it('maps 404 to installation_not_found', async () => {
    const { minter: m } = minter([{ status: 404, body: RECORDED_ERRORS[404] }]);
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(error.code).toBe('installation_not_found');
    expect(error.status).toBe(404);
  });

  it('maps 422 for a repository outside the installation to ScopeNotGrantable', async () => {
    const { minter: m } = minter([{ status: 422, body: RECORDED_ERRORS[422] }]);
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(error).toBeInstanceOf(ScopeNotGrantable);
    expect(error.code).toBe('scope_not_grantable');
    expect(error.status).toBe(422);
    expect(error.message).toContain('not accessible to the parent installation');
  });

  it('maps 5xx and 429 to a retryable provider_unavailable, and other statuses to provider_error', async () => {
    for (const status of [500, 502, 503, 429]) {
      const { minter: m } = minter([{ status, body: { message: 'Server Error' } }]);
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect([status, error.code, error.retryable]).toEqual([status, 'provider_unavailable', true]);
    }
    const { minter: m } = minter([{ status: 302, body: '' }]);
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect([error.code, error.retryable]).toEqual(['provider_error', false]);
  });

  it('fails closed and revokes a token GitHub granted wider than requested', async () => {
    const cases: Record<string, unknown>[] = [
      { repository_selection: 'all' },
      { permissions: { contents: 'write', issues: 'write' } },
      { permissions: { contents: 'read', issues: 'write', administration: 'read' } },
      { permissions: { contents: 'read', issues: 'write', metadata: 'write' } },
      { repositories: [{ name: 'app' }, { name: 'secret-repo' }] },
    ];
    for (const override of cases) {
      const token = fakeInstallationToken(7);
      const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(token, override) }, { status: 204 }]);
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect(error.code).toBe('provider_error');
      expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
      expect(calls[1]!.headers.authorization).toBe(`Bearer ${token}`);
      expect(error.message).not.toContain(token);
    }
  });

  it('accepts the read-only metadata permission GitHub adds to every token', async () => {
    const body = recordedAccessToken(fakeInstallationToken(1), { permissions: { contents: 'read', issues: 'write', metadata: 'read' } });
    const { minter: m, calls } = minter([{ status: 201, body }]);
    await expect(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 })).resolves.toMatchObject({ secret: fakeInstallationToken(1) });
    expect(calls).toHaveLength(1);
  });

  it('rejects a 201 without a usable token or expiry', async () => {
    for (const body of [{ expires_at: EXPIRES_AT }, { token: fakeInstallationToken(1) }, 'not json']) {
      const { minter: m } = minter([{ status: 201, body }]);
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect(error.code).toBe('provider_error');
    }
  });
});

describe('GitHub App minter: request validation', () => {
  it('rejects scopes that would widen to the whole installation, before calling GitHub', async () => {
    const scopes = [
      { permissions: { contents: 'read' } },
      { repositories: ['app'] },
      { repositories: [], permissions: {} },
      {},
    ];
    for (const scope of scopes) {
      const { minter: m, calls } = minter([]);
      const error = await rejection(m.mint({ installation: 42, scope, ttl: 3600 }));
      expect(error).toBeInstanceOf(ScopeNotGrantable);
      expect(calls).toHaveLength(0);
    }
  });

  it('rejects a scope outside the grammar as ScopeNotGrantable with violations', async () => {
    const scopes: unknown[] = [
      { repositories: ['example-org/app'], permissions: { contents: 'read' } },
      { repositories: ['app'], permissions: { contents: 'owner' } },
      { repositories: ['app'], permissions: { contents: 'read' }, repository_ids: [1] },
      { repositories: 'app', permissions: { contents: 'read' } },
      null,
    ];
    for (const scope of scopes) {
      const { minter: m, calls } = minter([]);
      const error = await rejection(m.mint({ installation: 42, scope: scope as never, ttl: 3600 }));
      expect(error).toBeInstanceOf(ScopeNotGrantable);
      expect((error as ScopeNotGrantable).violations.length).toBeGreaterThan(0);
      expect((error as ScopeNotGrantable).violations[0]!.code).toBe('malformed');
      expect(calls).toHaveLength(0);
    }
  });

  it('rejects a ttl longer than GitHub token lifetime, and an invalid ttl or installation', async () => {
    const { minter: m, calls } = minter([]);
    expect(await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3601 }))).toBeInstanceOf(ScopeNotGrantable);
    for (const ttl of [0, -1, 1.5, Number.NaN, '60' as never]) {
      expect((await rejection(m.mint({ installation: 42, scope: SCOPE, ttl }))).code).toBe('invalid_request');
    }
    for (const installation of [0, -1, 1.5, '42/../../user', '', '0042', 2 ** 60]) {
      expect((await rejection(m.mint({ installation, scope: SCOPE, ttl: 60 }))).code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(0);
  });

  it('reports the real expiry when the requested ttl is shorter than GitHub lifetime', async () => {
    const { minter: m } = minter([{ status: 201, body: recordedAccessToken(fakeInstallationToken(1)) }]);
    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 60 });
    expect(minted.expiresAt.toISOString()).toBe(new Date(EXPIRES_AT).toISOString());
  });

  it('rejects invalid configuration at construction', () => {
    expect(() => createGitHubAppMinter({ appId: 1, privateKey: 'not a key' })).toThrow(GitHubAppKeyError);
    expect(() => createGitHubAppMinter({ appId: 1, privateKey: keys.pkcs8Pem, baseUrl: 'http://api.github.com' })).toThrow(TypeError);
    expect(() => createGitHubAppMinter({ appId: 1, privateKey: keys.pkcs8Pem, baseUrl: ['https://', 'test-user', ':', 'test-password', '@api.github.com'].join('') })).toThrow(TypeError);
    expect(() => createGitHubAppMinter({ appId: 0, privateKey: keys.pkcs8Pem })).toThrow(TypeError);
    expect(() => createGitHubAppMinter({ appId: 'a b', privateKey: keys.pkcs8Pem })).toThrow(TypeError);
  });
});

describe('GitHub App minter: App JWT', () => {
  it('signs RS256 with iat back-dated 60 s and exp at most 10 minutes after iat', async () => {
    const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(fakeInstallationToken(1)) }], { appId: 'Iv1.exampleclientid' });
    await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    const jwt = calls[0]!.headers.authorization!.replace(/^Bearer /, '');
    const decoded = await verifyJwt(jwt, keys.publicKey);
    expect(decoded.valid).toBe(true);
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decoded.claims).toEqual({ iat: NOW_SECONDS - 60, exp: decoded.claims.exp, iss: 'Iv1.exampleclientid' });
    const { iat, exp } = decoded.claims as { iat: number; exp: number };
    expect(exp - iat).toBeLessThanOrEqual(600);
    expect(exp - NOW_SECONDS).toBeLessThanOrEqual(600);
    expect(exp).toBeGreaterThan(NOW_SECONDS);
  });

  it('signs identically from PKCS#1 and PKCS#8 PEM, matching an independent RS256 signer', async () => {
    expect(pemToPkcs8(keys.pkcs1Pem).format).toBe('pkcs1');
    expect(pemToPkcs8(keys.pkcs8Pem).format).toBe('pkcs8');
    // The DER wrap of the PKCS#1 key is byte-identical to the runtime's own PKCS#8 export.
    expect(Buffer.from(pemToPkcs8(keys.pkcs1Pem).der).equals(Buffer.from(pemToPkcs8(keys.pkcs8Pem).der))).toBe(true);

    const jwts: string[] = [];
    for (const privateKey of [keys.pkcs1Pem, keys.pkcs8Pem]) {
      const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(fakeInstallationToken(1)) }], { privateKey });
      await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
      jwts.push(calls[0]!.headers.authorization!.replace(/^Bearer /, ''));
    }
    // RSASSA-PKCS1-v1_5 is deterministic, so both key forms give the same JWT.
    expect(jwts[0]).toBe(jwts[1]);
    const [header, claims, signature] = jwts[0]!.split('.');
    // Known answer from Node's OpenSSL signer reading the PKCS#1 PEM directly.
    const expected = nodeSign('sha256', Buffer.from(`${header}.${claims}`), createPrivateKey(keys.pkcs1Pem)).toString('base64url');
    expect(signature).toBe(expected);
  });

  it('rejects a PEM that is not an RSA private key without echoing it', async () => {
    const bogus = pem('PRIVATE KEY', new TextEncoder().encode('test-not-a-real-key-material'));
    const { minter: m, calls } = minter([], { privateKey: bogus });
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(error.code).toBe('invalid_configuration');
    expect(inspect(error, { depth: 5 })).not.toContain(btoa('test-not-a-real-key-material'));
    expect(calls).toHaveLength(0);
  });
});

describe('GitHub App minter: revoke (recorded responses)', () => {
  it('revokes with DELETE /installation/token authenticated by the token', async () => {
    const token = fakeInstallationToken(3);
    const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(token) }, { status: 204 }]);
    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    await m.revoke(minted.revokeHandle);
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: 'https://api.github.com/installation/token', body: undefined });
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('is idempotent: a second revoke, and a concurrent one, make no further call', async () => {
    const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(fakeInstallationToken(3)) }, { status: 204 }]);
    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    await Promise.all([m.revoke(minted.revokeHandle), m.revoke(minted.revokeHandle)]);
    await m.revoke(minted.revokeHandle);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
  });

  it('treats 401 for an already-revoked token as revoked', async () => {
    const { minter: m, calls } = minter([
      { status: 201, body: recordedAccessToken(fakeInstallationToken(3)) },
      { status: 401, body: RECORDED_ERRORS.revoked401 },
    ]);
    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    await expect(m.revoke(minted.revokeHandle)).resolves.toBeUndefined();
    await expect(m.revoke(minted.revokeHandle)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('skips the call for a token that has already expired', async () => {
    let now = NOW_MS;
    const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(fakeInstallationToken(3)) }], { now: () => now });
    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    now = Date.parse(EXPIRES_AT);
    await m.revoke(minted.revokeHandle);
    expect(calls).toHaveLength(1);
  });

  it('keeps a failed revoke retryable', async () => {
    const { minter: m, calls } = minter([
      { status: 201, body: recordedAccessToken(fakeInstallationToken(3)) },
      { status: 503, body: { message: 'Service Unavailable' } },
      { status: 204 },
    ]);
    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    const error = await rejection(m.revoke(minted.revokeHandle));
    expect([error.code, error.retryable]).toEqual(['provider_unavailable', true]);
    await m.revoke(minted.revokeHandle);
    await m.revoke(minted.revokeHandle);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE', 'DELETE']);
  });

  it('rejects a handle another minter returned, or a forged one', async () => {
    const first = minter([{ status: 201, body: recordedAccessToken(fakeInstallationToken(3)) }]);
    const second = minter([]);
    const minted = await first.minter.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    await expect(second.minter.revoke(minted.revokeHandle)).rejects.toThrow(TypeError);
    await expect(second.minter.revoke({ installationId: '42' } as never)).rejects.toThrow(TypeError);
    expect(() => new GitHubAppRevokeHandle(Symbol('forged'), '42', NOW_MS)).toThrow(TypeError);
    expect(second.calls).toHaveLength(0);
  });
});

describe('GitHub App minter: retried mint', () => {
  it('asks for the same grant again after a failed attempt, with a fresh JWT', async () => {
    let now = NOW_MS;
    const { minter: m, calls } = minter(
      [
        { status: 502, body: { message: 'Bad Gateway' } },
        { throws: new TypeError('fetch failed') },
        { status: 201, body: recordedAccessToken(fakeInstallationToken(1)) },
        { status: 201, body: recordedAccessToken(fakeInstallationToken(2)) },
      ],
      { now: () => now },
    );
    const request = { installation: 42, scope: SCOPE, ttl: 3600 };
    expect((await rejection(m.mint(request))).retryable).toBe(true);
    now += 1000;
    expect((await rejection(m.mint(request))).code).toBe('provider_unavailable');
    now += 1000;
    const first = await m.mint(request);
    const second = await m.mint(request);
    expect(calls.map((c) => c.body)).toEqual(Array(4).fill(calls[0]!.body));
    expect(new Set(calls.map((c) => c.url)).size).toBe(1);
    expect(calls[0]!.headers.authorization).not.toBe(calls[2]!.headers.authorization);
    expect([first.secret, second.secret]).toEqual([fakeInstallationToken(1), fakeInstallationToken(2)]);
    // Each grant revokes on its own.
    expect(first.revokeHandle).not.toBe(second.revokeHandle);
  });
});

describe('GitHub App minter: redaction', () => {
  function rendered(error: unknown): string {
    const parts = [String(error), JSON.stringify(error), inspect(error, { depth: 10, showHidden: true })];
    if (error instanceof Error) parts.push(String(error.stack), String(error.cause), JSON.stringify(error.cause ?? null));
    return parts.join('\n');
  }

  it('never puts the App JWT or the private key in an error', async () => {
    const jwtEcho = (status: number): RecordedResponse => ({ status, body: { message: 'echo' } });
    for (const status of [401, 403, 404, 422, 500]) {
      let jwt = '';
      const base = recordingFetch([jwtEcho(status)]);
      const echoingFetch = (async (input: unknown, init?: RequestInit) => {
        jwt = (init!.headers as Record<string, string>).authorization!.replace(/^Bearer /, '');
        await base.fetch(input as string, init);
        return new Response(JSON.stringify({ message: `token ${jwt} rejected` }), { status });
      }) as typeof fetch;
      const { minter: m } = minter([], { fetch: echoingFetch });
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      const text = rendered(error);
      expect(jwt.length).toBeGreaterThan(100);
      expect(text).not.toContain(jwt);
      expect(text).not.toContain(jwt.split('.')[2]!);
      expect(text).toContain('[redacted]');
      expect(text).not.toContain(keys.pkcs1Pem.split('\n')[1]!);
    }
  });

  it('never puts the JWT in an error from a failing fetch', async () => {
    let jwt = '';
    const failingFetch = (async (_input: unknown, init?: RequestInit) => {
      jwt = (init!.headers as Record<string, string>).authorization!.replace(/^Bearer /, '');
      const error = new TypeError(`fetch failed with header Bearer ${jwt}`);
      Object.assign(error, { request: { headers: init!.headers } });
      throw error;
    }) as typeof fetch;
    const { minter: m } = minter([], { fetch: failingFetch });
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(error.code).toBe('provider_unavailable');
    expect(rendered(error)).not.toContain(jwt);
  });

  it('never puts the installation token in a revoke error or a handle', async () => {
    const token = fakeInstallationToken(9);
    const { minter: m } = minter([
      { status: 201, body: recordedAccessToken(token) },
      { status: 500, body: { message: `could not revoke ${token}` } },
      { throws: new TypeError(`socket closed while sending Bearer ${token}`) },
    ]);
    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    const handleText = [JSON.stringify(minted.revokeHandle), inspect(minted.revokeHandle, { showHidden: true, depth: 10 }), String(minted.revokeHandle)].join('\n');
    expect(handleText).not.toContain(token);
    expect(JSON.parse(JSON.stringify(minted.revokeHandle))).toEqual({ provider: 'github-app', installationId: '42', expiresAt: new Date(EXPIRES_AT).toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await rejection(m.revoke(minted.revokeHandle));
      expect(rendered(error)).not.toContain(token);
    }
  });

  it('redacts token-shaped text in provider messages', async () => {
    const shaped = ['gh', 's_', 'test', 'tokenvalue'].join('');
    const { minter: m } = minter([{ status: 422, body: { message: `repository not accessible for ${shaped}` } }]);
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(error.message).not.toContain(shaped);
  });
});
