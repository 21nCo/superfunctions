import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CredentialMinterError, ScopeNotGrantable } from 'plugfn/credentials';
import {
  createGitHubAppMinter,
  GitHubAppKeyError,
  GitHubAppRevokeHandle,
  pemToPkcs8,
  type GitHubAppMinter,
  type GitHubAppMinterOptions,
} from '../../src/github-app/index.js';
import {
  controlledBody,
  EXPIRES_AT,
  fakeInstallationToken,
  generateTestAppKeys,
  NOW_MS,
  NOW_SECONDS,
  pem,
  RECORDED_ERRORS,
  recordedAccessToken,
  recordingFetch,
  statefulGitHub,
  verifyJwt,
  type RecordedResponse,
  type TestAppKeys,
} from './helpers.js';

let keys: TestAppKeys;

beforeAll(async () => {
  keys = await generateTestAppKeys();
});

const SCOPE = { repositories: ['lib', 'App'], permissions: { issues: 'write', contents: 'read' } } as const;
/** The five-minute clock-skew tolerance the minter adds to every key hold. */
const SKEW_MS = 5 * 60 * 1000;

function minter(responses: RecordedResponse[], options: Partial<GitHubAppMinterOptions> = {}) {
  const recorder = recordingFetch(responses);
  const merged: GitHubAppMinterOptions = { appId: 12345, privateKey: keys.pkcs1Pem, fetch: recorder.fetch, now: () => NOW_MS, cleanupRetryDelayMs: 0, ...options };
  // Holds follow the test clock unless a test gives them their own.
  const instance = createGitHubAppMinter({ monotonicNow: merged.now, ...merged });
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

  it('mints a grant of 500 repositories whose 201 body is larger than 1 MiB', async () => {
    const names = Array.from({ length: 500 }, (_, i) => `repo-${i}`);
    const token = fakeInstallationToken(500);
    const repositories = names.map((name, id) => ({ id, name, full_name: `example-org/${name}`, private: true, description: 'example repository '.repeat(250) }));
    const body = JSON.stringify(recordedAccessToken(token, { repositories }));
    expect(body.length).toBeGreaterThan(2 * 1024 * 1024);
    const { minter: m } = minter([{ status: 201, body }]);
    const minted = await m.mint({ installation: 42, scope: { repositories: names, permissions: SCOPE.permissions }, ttl: 3600 });
    expect(minted.secret).toBe(token);
  });

  it('rejects more than 500 repositories before calling GitHub', async () => {
    const { minter: m, calls } = minter([]);
    const repositories = Array.from({ length: 501 }, (_, i) => `repo-${i}`);
    expect(await rejection(m.mint({ installation: 42, scope: { repositories, permissions: SCOPE.permissions }, ttl: 3600 }))).toBeInstanceOf(ScopeNotGrantable);
    expect(calls).toHaveLength(0);
  });

  it('revokes the leading token of a 201 body too large to read', async () => {
    const token = fakeInstallationToken(7);
    const oversized = `{"token":"${token}","expires_at":"${EXPIRES_AT}","padding":"${'x'.repeat(9 * 1024 * 1024)}"}`;
    const { minter: m, calls } = minter([{ status: 201, body: oversized }, { status: 204 }]);
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-oversized' }));
    expect(error.code).toBe('provider_error');
    expect(calls.map((call) => [call.method, call.headers.authorization === `Bearer ${token}`])).toEqual([
      ['POST', false],
      ['DELETE', true],
    ]);
    expect(error.message).not.toContain(token);
  });

  it('revokes the leading token of a 201 body cut short', async () => {
    const token = fakeInstallationToken(8);
    const { minter: m, calls } = minter([{ status: 201, body: `{"token":"${token}","expires_at":"${EXPIRES_AT}","permis` }, { status: 204 }]);
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect([error.code, error.message.includes(token)]).toEqual(['provider_error', false]);
    expect(calls.map((call) => [call.method, call.headers.authorization === `Bearer ${token}`])).toEqual([
      ['POST', false],
      ['DELETE', true],
    ]);
  });

  it('reports a 201 without a usable token as an unknown outcome, making no further call', async () => {
    for (const body of [{ expires_at: EXPIRES_AT }, { token: 'has a space', expires_at: EXPIRES_AT }, 'not json', [1], '']) {
      const { minter: m, calls } = minter([{ status: 201, body }]);
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect([error.code, error.retryable], JSON.stringify(body)).toEqual(['mint_outcome_unknown', false]);
      expect(error.message).toMatch(/may have been issued/);
      expect(calls).toHaveLength(1);
    }
  });

  it('revokes a returned token whose expires_at is missing, unparseable or already past', async () => {
    const notStrictUtc = ['2050', '2026-11-28', '2026-11-28T13:00:00+00:00', '2026-11-28 13:00:00Z', '2026-02-30T13:00:00Z', 'Sat, 28 Nov 2026 13:00:00 GMT'];
    // Later than now + 1 h + the 5-minute skew tolerance: not a GitHub installation token's expiry.
    const beyondLifetime = ['2099-01-01T00:00:00Z', '2026-11-28T13:05:00.001Z'];
    for (const expires of [undefined, 'not a date', 42, '2026-11-28T11:00:00Z', ...notStrictUtc, ...beyondLifetime]) {
      const token = fakeInstallationToken(3);
      const body = recordedAccessToken(token, { expires_at: expires });
      const { minter: m, calls } = minter([{ status: 201, body }, { status: 204 }]);
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect(error.code, String(expires)).toBe('provider_error');
      expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
      expect(calls[1]!.headers.authorization).toBe(`Bearer ${token}`);
      expect(error.message).not.toContain(token);
    }
  });

  it('keeps expires_at fractional seconds to the millisecond, and tolerates five minutes of clock skew', async () => {
    for (const [expires, iso] of [
      ['2026-11-28T12:59:59.5Z', '2026-11-28T12:59:59.500Z'],
      ['2026-11-28T13:00:00.123456Z', '2026-11-28T13:00:00.123Z'],
      ['2026-11-28T13:05:00Z', '2026-11-28T13:05:00.000Z'],
    ]) {
      const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(fakeInstallationToken(1), { expires_at: expires }) }]);
      const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
      expect(minted.expiresAt.toISOString()).toBe(iso);
      expect(minted.revokeHandle.expiresAt.toISOString()).toBe(iso);
      expect(calls).toHaveLength(1);
    }
  });

  it('fails closed, revoking the token, when the 201 grants less than requested', async () => {
    const cases: Record<string, unknown>[] = [
      { repositories: [{ name: 'app' }] },
      { permissions: { contents: 'read' } },
      { permissions: { contents: 'read', issues: 'read' } },
      { permissions: { contents: 'read', issues: 'write', metadata: 'read' }, repositories: [{ name: 'lib' }] },
      { repositories: [], permissions: {} },
      { repositories: [], permissions: { metadata: 'read' } },
    ];
    for (const override of cases) {
      const token = fakeInstallationToken(6);
      const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(token, override) }, { status: 204 }]);
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect(error.code, JSON.stringify(override)).toBe('provider_error');
      expect(error.message).toMatch(/did not grant the token every requested (repository|permission)/);
      expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
      expect(calls[1]!.headers.authorization).toBe(`Bearer ${token}`);
    }
  });

  it('fails closed, revoking the token, when the 201 omits or garbles the grant it made', async () => {
    const cases: Record<string, unknown>[] = [
      { repository_selection: undefined },
      { repository_selection: 'SELECTED' },
      { repositories: undefined },
      { repositories: { name: 'app' } },
      { repositories: ['app'] },
      { permissions: undefined },
      { permissions: null },
      { permissions: ['contents:read'] },
      { permissions: { contents: 'none' } },
    ];
    for (const override of cases) {
      const token = fakeInstallationToken(8);
      const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(token, override) }, { status: 204 }]);
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect(error.code, JSON.stringify(override)).toBe('provider_error');
      expect(error.message).toContain('was revoked');
      expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    }
  });

  it('retries a transient failure of the cleanup DELETE inside mint', async () => {
    for (const transient of [{ status: 503, body: { message: 'Service unavailable' } }, { status: 429 }, { throws: new TypeError('socket hang up') }] as RecordedResponse[]) {
      const token = fakeInstallationToken(4);
      const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(token, { repository_selection: 'all' }) }, transient, { status: 204 }]);
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect([error.code, error.revokeHandle]).toEqual(['provider_error', undefined]);
      expect(error.message).toContain('was revoked');
      expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE', 'DELETE']);
      expect(calls.slice(1).map((c) => c.headers.authorization)).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
    }
  });

  it('hands back a revoke handle, never the token, when the cleanup still fails', async () => {
    const persistent: RecordedResponse[][] = [
      Array(3).fill({ status: 503, body: { message: 'Service unavailable' } }),
      Array(3).fill({ throws: new TypeError('socket hang up') }),
      [{ status: 403, body: { message: 'Forbidden' } }],
    ];
    for (const failures of persistent) {
      const token = fakeInstallationToken(4);
      const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(token, { repository_selection: 'all' }) }, ...failures, { status: 204 }]);
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect(error.code).toBe('rejected_credential_not_revoked');
      expect(error.retryable).toBe(false);
      expect(error.message).toMatch(/may stay active until it expires/);
      expect(error.cause).toBeInstanceOf(CredentialMinterError);
      // Retried only while the failure is transient.
      expect(calls.map((c) => c.method)).toEqual(['POST', ...failures.map(() => 'DELETE')]);
      expect(error.revokeHandle).toBeInstanceOf(GitHubAppRevokeHandle);
      const text = [String(error), JSON.stringify(error), inspect(error, { depth: 10, showHidden: true })].join('\n');
      expect(text).not.toContain(token);

      await m.revoke(error.revokeHandle as GitHubAppRevokeHandle);
      expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://api.github.com/installation/token' });
      expect(calls.at(-1)!.headers.authorization).toBe(`Bearer ${token}`);
      await m.revoke(error.revokeHandle as GitHubAppRevokeHandle);
      expect(calls).toHaveLength(failures.length + 2);
    }
  });

  it('waits between cleanup attempts', async () => {
    const token = fakeInstallationToken(4);
    const started = Date.now();
    const { minter: m, calls } = minter(
      [{ status: 201, body: recordedAccessToken(token, { repository_selection: 'all' }) }, { status: 503 }, { status: 503 }, { status: 204 }],
      { cleanupRetryDelayMs: 20 },
    );
    await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(calls).toHaveLength(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(() => createGitHubAppMinter({ appId: 1, privateKey: keys.pkcs1Pem, cleanupRetryDelayMs: -1 })).toThrow(TypeError);
  });

  it('decides by status when the response body cannot be read', async () => {
    const reset = () => new TypeError('body stream reset');
    const unreadable422 = minter([{ status: 422, bodyThrows: reset() }]);
    const notGrantable = await rejection(unreadable422.minter.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(notGrantable).toBeInstanceOf(ScopeNotGrantable);

    const unreadable201 = minter([{ status: 201, bodyThrows: reset() }]);
    const lost = await rejection(unreadable201.minter.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect([lost.code, lost.status, lost.retryable]).toEqual(['mint_outcome_unknown', 201, false]);
    expect(lost.message).toMatch(/may have been issued/);

    for (const status of [204, 401]) {
      const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(fakeInstallationToken(5)) }, { status, bodyThrows: reset() }]);
      const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
      await expect(m.revoke(minted.revokeHandle)).resolves.toBeUndefined();
      await expect(m.revoke(minted.revokeHandle)).resolves.toBeUndefined();
      expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    }
  });

  it('does not wait for a DELETE body when the status already decides', async () => {
    for (const status of [204, 401]) {
      const stalled = (async (_input: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') return new Response(JSON.stringify(recordedAccessToken(fakeInstallationToken(5))), { status: 201 });
        const response = new Response(null, { status });
        // A body that never finishes arriving.
        Object.defineProperty(response, 'text', { value: () => new Promise<string>(() => undefined) });
        return response;
      }) as typeof fetch;
      const { minter: m } = minter([], { fetch: stalled });
      const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
      await expect(m.revoke(minted.revokeHandle)).resolves.toBeUndefined();
    }
  });
});

describe('GitHub App minter: minting the approved snapshot', () => {
  const ENVELOPE = { repositories: ['app', 'lib'], permissions: { contents: 'write', issues: 'write' } } as const;

  it('mints the scope isSubset approved, passed as decision.scope', async () => {
    const token = fakeInstallationToken(6);
    const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(token) }]);
    const decision = m.grammar.isSubset(SCOPE, ENVELOPE);
    expect(decision.ok).toBe(true);
    const minted = await m.mint({ installation: 42, scope: decision.scope!, ttl: 3600 });
    expect(minted.secret).toBe(token);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ repositories: ['app', 'lib'], permissions: { contents: 'read', issues: 'write' } });
  });

  it('cannot be widened by a request that answers differently after isSubset', async () => {
    let reads = 0;
    const request = {
      repositories: ['app'],
      get permissions() {
        reads++;
        return reads === 1 ? { contents: 'read' } : { contents: 'admin', administration: 'admin' };
      },
    };
    const decision = m0().grammar.isSubset(request as never, ENVELOPE);
    expect(decision.ok).toBe(true);
    // The request now reads as admin; the snapshot still holds what was approved.
    expect(m0().grammar.isSubset(request as never, ENVELOPE).ok).toBe(false);

    const { minter: m, calls } = minter([
      { status: 201, body: recordedAccessToken(fakeInstallationToken(6), { permissions: { contents: 'read' }, repositories: [{ name: 'app' }] }) },
    ]);
    const minted = await m.mint({ installation: 42, scope: decision.scope!, ttl: 3600 });
    expect(minted.secret).toBe(fakeInstallationToken(6));
    expect(JSON.parse(calls[0]!.body!)).toEqual({ repositories: ['app'], permissions: { contents: 'read' } });

    function m0() {
      return minter([]).minter;
    }
  });

  it('reads each mint request field once', async () => {
    const { minter: m, calls } = minter([{ status: 201, body: recordedAccessToken(fakeInstallationToken(6)) }]);
    let scopeReads = 0;
    const request = {
      installation: 42,
      ttl: 3600,
      get scope() {
        scopeReads++;
        return scopeReads === 1 ? SCOPE : { repositories: ['app', 'lib', 'other'], permissions: { administration: 'admin' } };
      },
    };
    await m.mint(request as never);
    expect(scopeReads).toBe(1);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ repositories: ['app', 'lib'], permissions: { contents: 'read', issues: 'write' } });
  });

  it('treats a copy of a snapshot as unapproved input, not as a snapshot', async () => {
    const { minter: m, calls } = minter([]);
    const decision = m.grammar.isSubset(SCOPE, ENVELOPE);
    const copy = { repositories: [...decision.scope!.repositories], permissions: [...decision.scope!.permissions] };
    const error = await rejection(m.mint({ installation: 42, scope: copy as never, ttl: 3600 }));
    expect(error).toBeInstanceOf(ScopeNotGrantable);
    expect(calls).toHaveLength(0);
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
    // A header fetch would refuse is caught here, not after a POST may have been sent.
    expect(() => createGitHubAppMinter({ appId: 1, privateKey: keys.pkcs8Pem, userAgent: 'test-agent\nx' })).toThrow(TypeError);
    expect(() => createGitHubAppMinter({ appId: 1, privateKey: keys.pkcs8Pem, waitUntil: 'later' as never })).toThrow(TypeError);
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

  it('still asks GitHub after the local expiry, and a 401 for the expired token resolves', async () => {
    let now = NOW_MS;
    const token = fakeInstallationToken(3);
    const { minter: m, calls } = minter(
      [{ status: 201, body: recordedAccessToken(token) }, { status: 401, body: RECORDED_ERRORS.revoked401 }],
      { now: () => now },
    );
    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    now = Date.parse(EXPIRES_AT) + 1000;
    await expect(m.revoke(minted.revokeHandle)).resolves.toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('does not mark a token revoked on the local clock alone', async () => {
    let now = NOW_MS;
    const { minter: m, calls } = minter(
      [{ status: 201, body: recordedAccessToken(fakeInstallationToken(3)) }, { status: 503 }, { status: 204 }],
      { now: () => now },
    );
    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    now = Date.parse(EXPIRES_AT) + 1000;
    await rejection(m.revoke(minted.revokeHandle));
    await m.revoke(minted.revokeHandle);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE', 'DELETE']);
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

  it('revokes each token of an unkeyed retry with its own bearer', async () => {
    const github = statefulGitHub();
    const { minter: m } = minter([], { fetch: github.fetch });
    const request = { installation: 42, scope: SCOPE, ttl: 3600 };
    const first = await m.mint(request);
    const second = await m.mint(request);
    expect(github.live.size).toBe(2);
    await m.revoke(first.revokeHandle);
    await m.revoke(second.revokeHandle);
    const deletes = github.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.headers.authorization)).toEqual([`Bearer ${first.secret}`, `Bearer ${second.secret}`]);
    expect(github.live.size).toBe(0);
  });

  it('returns the same credential for a retried mint with the same idempotency key', async () => {
    const github = statefulGitHub();
    const { minter: m } = minter([], { fetch: github.fetch });
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-1' };
    const first = await m.mint(request);
    const retried = await m.mint({ ...request, installation: '42', scope: { repositories: ['app', 'lib'], permissions: { contents: 'read', issues: 'write' } } });
    expect(retried).toBe(first);
    expect(github.calls.filter((c) => c.method === 'POST')).toHaveLength(1);

    await m.revoke(retried.revokeHandle);
    expect(github.live.size).toBe(0);
    await m.revoke(first.revokeHandle);
    expect(github.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);

    // Once revoked, the key mints a new credential.
    const after = await m.mint(request);
    expect(after.secret).not.toBe(first.secret);
    expect(github.live).toEqual(new Set([after.secret]));
  });

  it('shares one POST between concurrent mints with the same idempotency key', async () => {
    const github = statefulGitHub();
    const { minter: m } = minter([], { fetch: github.fetch });
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-2' };
    const results = await Promise.all([m.mint(request), m.mint(request), m.mint(request)]);
    expect(new Set(results).size).toBe(1);
    expect(github.calls).toHaveLength(1);
    await m.revoke(results[0]!.revokeHandle);
    expect(github.live.size).toBe(0);
  });

  it('rejects an idempotency key reused for a different request, without calling GitHub', async () => {
    const github = statefulGitHub();
    const { minter: m } = minter([], { fetch: github.fetch });
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-3' };
    const pending = m.mint(request);
    for (const changed of [
      { ...request, ttl: 600 },
      { ...request, installation: 43 },
      { ...request, scope: { repositories: ['app'], permissions: { contents: 'read', issues: 'write' } } },
      { ...request, scope: { repositories: ['app', 'lib'], permissions: { contents: 'write', issues: 'write' } } },
    ]) {
      expect((await rejection(m.mint(changed))).code).toBe('invalid_request');
    }
    await pending;
    expect((await rejection(m.mint({ ...request, ttl: 600 }))).code).toBe('invalid_request');
    expect(github.calls).toHaveLength(1);
    // Other keys are independent.
    await m.mint({ ...request, ttl: 600, idempotencyKey: 'test-operation-4' });
    expect(github.calls).toHaveLength(2);
  });

  it('frees a key after a failed mint and after its credential expires', async () => {
    let now = NOW_MS;
    const { minter: m, calls } = minter(
      [
        { status: 429, body: { message: 'API rate limit exceeded' } },
        { status: 201, body: recordedAccessToken(fakeInstallationToken(1)) },
        { status: 201, body: recordedAccessToken(fakeInstallationToken(2), { expires_at: '2026-11-28T14:00:00Z' }) },
      ],
      { now: () => now },
    );
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-5' };
    // A 429 is a definite refusal: nothing was issued, so the key is free.
    expect((await rejection(m.mint(request))).code).toBe('provider_unavailable');
    const first = await m.mint(request);
    expect(await m.mint(request)).toBe(first);
    now = Date.parse(EXPIRES_AT) - 1;
    expect(await m.mint(request)).toBe(first);
    // GitHub's clock may run up to five minutes ahead: past expires_at the key returns no credential and sends no POST until that skew has passed.
    now = Date.parse(EXPIRES_AT) + SKEW_MS - 1;
    const blocked = await rejection(m.mint(request));
    expect([blocked.code, blocked.retryable, calls.length]).toEqual(['provider_unavailable', true, 2]);
    now += 1;
    const second = await m.mint(request);
    expect([first.secret, second.secret]).toEqual([fakeInstallationToken(1), fakeInstallationToken(2)]);
    expect(calls).toHaveLength(3);
  });

  it('keeps reporting a lost 201 for its key until any token it carried has expired', async () => {
    let now = NOW_MS;
    const { minter: m, calls } = minter(
      [{ status: 201, bodyThrows: new TypeError('body stream reset') }, { status: 201, body: recordedAccessToken(fakeInstallationToken(1), { expires_at: '2026-11-28T14:00:01Z' }) }],
      { now: () => now },
    );
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-6' };
    const lost = await rejection(m.mint(request));
    expect([lost.code, lost.retryable]).toEqual(['mint_outcome_unknown', false]);
    now += 30 * 60 * 1000;
    expect(await rejection(m.mint(request))).toBe(lost);
    now = NOW_MS + 3600 * 1000 + SKEW_MS - 1;
    expect(await rejection(m.mint(request))).toBe(lost);
    expect(calls).toHaveLength(1);
    now += 1;
    await expect(m.mint(request)).resolves.toMatchObject({ secret: fakeInstallationToken(1) });
    expect(calls).toHaveLength(2);
  });

  it('rejects an invalid idempotency key before calling GitHub', async () => {
    const { minter: m, calls } = minter([]);
    for (const idempotencyKey of ['', 'k'.repeat(257), 42, null]) {
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey } as never));
      expect(error.code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('GitHub App minter: an idempotency key never issues a second live token', () => {
  const posts = (calls: { method: string }[]) => calls.filter((c) => c.method === 'POST').length;

  // Each fake issues a live token on the first POST, then loses or garbles the answer.
  const lostAnswers: [string, (token: string) => Response][] = [
    ['fetch rejects after GitHub issued the token', () => {
      throw new TypeError('socket hang up');
    }],
    ['502 after GitHub issued the token', () => new Response(JSON.stringify({ message: 'Bad Gateway' }), { status: 502 })],
    ['a 302 after GitHub issued the token', () => new Response(null, { status: 302 })],
    ['a 201 whose body is not JSON', () => new Response('{"token": "trunc', { status: 201 })],
    ['a 201 without a token', (token) => new Response(JSON.stringify({ ...recordedAccessToken(token), token: undefined }), { status: 201 })],
  ];

  for (const [name, answer] of lostAnswers) {
    it(`holds the key after ${name}`, async () => {
      let now = NOW_MS;
      const later = (token: string) => new Response(JSON.stringify(recordedAccessToken(token, { expires_at: '2026-11-28T14:00:00Z' })), { status: 201 });
      const github = statefulGitHub({ onPost: (token, n) => (n === 1 ? answer(token) : later(token)) });
      const { minter: m } = minter([], { fetch: github.fetch, now: () => now });
      const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-held' };
      const lost = await rejection(m.mint(request));
      expect([lost.code, lost.retryable]).toEqual(['mint_outcome_unknown', false]);
      now += 59 * 60 * 1000;
      expect(await rejection(m.mint(request))).toBe(lost);
      expect(posts(github.calls)).toBe(1);
      // The lost token is the only live one; nothing the minter returned can reach it.
      expect(github.live.size).toBe(1);

      // An hour and the skew tolerance after the failure any token from that POST has expired, and the key mints again.
      now = NOW_MS + 3600 * 1000 + SKEW_MS;
      const minted = await m.mint(request);
      expect(posts(github.calls)).toBe(2);
      await m.revoke(minted.revokeHandle);
      expect(github.live.size).toBe(1);
    });
  }

  it('without a key, a transport failure or 5xx stays retryable', async () => {
    for (const answer of [lostAnswers[0]![1], lostAnswers[1]![1]]) {
      const github = statefulGitHub({ onPost: (token, n) => (n === 1 ? answer(token) : undefined) });
      const { minter: m } = minter([], { fetch: github.fetch });
      const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect([error.code, error.retryable]).toEqual(['provider_unavailable', true]);
    }
  });

  it('repeats a rejected grant whose cleanup failed, with the same handle, until that handle is revoked', async () => {
    const github = statefulGitHub({
      onPost: (token, n) => (n === 1 ? new Response(JSON.stringify(recordedAccessToken(token, { repository_selection: 'all' })), { status: 201 }) : undefined),
      onDelete: (n) => (n <= 3 ? new Response(JSON.stringify({ message: 'Service unavailable' }), { status: 503 }) : undefined),
    });
    const { minter: m } = minter([], { fetch: github.fetch });
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-rejected' };
    const rejected = await rejection(m.mint(request));
    expect(rejected.code).toBe('rejected_credential_not_revoked');
    const retried = await rejection(m.mint(request));
    expect(retried).toBe(rejected);
    expect(retried.revokeHandle).toBe(rejected.revokeHandle);
    expect(posts(github.calls)).toBe(1);

    await m.revoke(rejected.revokeHandle as GitHubAppRevokeHandle);
    expect(github.live.size).toBe(0);
    // Its token confirmed revoked, the key mints again; revoking that leaves nothing live.
    const minted = await m.mint(request);
    expect(posts(github.calls)).toBe(2);
    await m.revoke(minted.revokeHandle);
    expect(github.live.size).toBe(0);
  });

  it('frees the key once a rejected grant has been revoked inside mint', async () => {
    const github = statefulGitHub({
      onPost: (token, n) => (n === 1 ? new Response(JSON.stringify(recordedAccessToken(token, { repository_selection: 'all' })), { status: 201 }) : undefined),
    });
    const { minter: m } = minter([], { fetch: github.fetch });
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-cleaned' };
    expect((await rejection(m.mint(request))).code).toBe('provider_error');
    expect(github.live.size).toBe(0);
    const minted = await m.mint(request);
    await m.revoke(minted.revokeHandle);
    expect(github.live.size).toBe(0);
  });

  it('keeps its own copy of the expiry: changing the returned Date does not free the key', async () => {
    const github = statefulGitHub();
    const { minter: m } = minter([], { fetch: github.fetch });
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-date' };
    const first = await m.mint(request);
    first.expiresAt.setTime(0);
    expect(await m.mint(request)).toBe(first);
    expect(posts(github.calls)).toBe(1);
    await m.revoke(first.revokeHandle);
    expect(github.live.size).toBe(0);
  });

  it('holds a key whose first mint does not settle until any token from its POST has expired, and revokes it if it settles later', async () => {
    let now = NOW_MS;
    // The first invocation's POST reaches GitHub, which issues a token, but its request is cancelled and fetch does not settle.
    const later = (token: string) => new Response(JSON.stringify(recordedAccessToken(token, { expires_at: '2026-11-28T14:00:00Z' })), { status: 201 });
    const github = statefulGitHub({ onPost: (token) => later(token) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fake = ((input: string, init?: RequestInit) => {
      const answer = github.fetch(input, init);
      return posts(github.calls) === 1 ? held.then(() => answer) : answer;
    }) as typeof fetch;
    const { minter: m } = minter([], { fetch: fake, now: () => now });
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-stuck' };
    const stuck = m.mint(request);
    await vi.waitFor(() => expect(posts(github.calls)).toBe(1));
    // A second invocation later shares the pending mint: no second POST while the first token may be live.
    now = NOW_MS + 3600 * 1000 + SKEW_MS - 1;
    const shared = m.mint(request);
    const settled = await Promise.race([shared.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('pending'), 50))]);
    expect([settled, posts(github.calls)]).toEqual(['pending', 1]);
    // Past dispatch + token lifetime + skew, that token has expired and the key mints again.
    now += 1;
    const minted = await m.mint(request);
    expect(posts(github.calls)).toBe(2);
    // The first mint settling now cannot add a second live token for the key: its token is revoked.
    release();
    expect((await rejection(stuck)).code).toBe('provider_error');
    expect([...github.live]).toEqual([minted.secret]);
    await m.revoke(minted.revokeHandle);
    expect(github.live.size).toBe(0);
  });

  it('does not send the POST of a mint whose key was freed before it was dispatched', async () => {
    let now = NOW_MS;
    const github = statefulGitHub({
      onPost: (token) => new Response(JSON.stringify(recordedAccessToken(token, { expires_at: '2026-11-28T14:00:00Z' })), { status: 201 }),
    });
    const { minter: m } = minter([], { fetch: github.fetch, now: () => now });
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-superseded' };
    const first = rejection(m.mint(request));
    // Still signing its App JWT when the key's deadline passes and another mint takes the key.
    now += 3600 * 1000 + SKEW_MS;
    const second = await m.mint(request);
    expect((await first).code).toBe('provider_unavailable');
    expect(posts(github.calls)).toBe(1);
    await m.revoke(second.revokeHandle);
    expect(github.live.size).toBe(0);
  });

  it('measures key holds on performance.now by default, even with a caller-supplied now', async () => {
    let wall = NOW_MS;
    const github = statefulGitHub({ onPost: (token, n) => (n === 1 ? new Response(JSON.stringify({ message: 'Bad Gateway' }), { status: 502 }) : undefined) });
    const { minter: m } = minter([], { fetch: github.fetch, now: () => wall, monotonicNow: undefined });
    const lostRequest = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-clock-lost' };
    const lost = await rejection(m.mint(lostRequest));
    expect(lost.code).toBe('mint_outcome_unknown');
    const mintedRequest = { ...lostRequest, idempotencyKey: 'test-operation-clock-minted' };
    const minted = await m.mint(mintedRequest);
    // The wall clock steps two hours forward; almost no time has elapsed on the hold clock, so no key is freed and nothing is sent.
    wall += 2 * 3600 * 1000;
    expect(await rejection(m.mint(lostRequest))).toBe(lost);
    expect((await rejection(m.mint(mintedRequest))).code).toBe('provider_unavailable');
    expect(posts(github.calls)).toBe(2);
    await m.revoke(minted.revokeHandle);
  });

  it('decides when a credential has expired on the hold clock alone, whatever the wall clock does', async () => {
    let wall = NOW_MS;
    let hold = 0;
    const github = statefulGitHub();
    const { minter: m } = minter([], { fetch: github.fetch, now: () => wall, monotonicNow: () => hold });
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-two-clocks' };
    const first = await m.mint(request);
    // GitHub's expires_at, converted to the hold clock when the 201 arrived.
    const expiry = Date.parse(EXPIRES_AT) - NOW_MS;
    hold = expiry - 1;
    wall = NOW_MS - 3 * 3600 * 1000;
    expect(await m.mint(request)).toBe(first);
    // Forward past expires_at the credential is refused sooner, but the key is not freed and nothing is sent.
    wall = NOW_MS + 3 * 3600 * 1000;
    const early = await rejection(m.mint(request));
    expect([early.code, posts(github.calls)]).toEqual(['provider_unavailable', 1]);
    hold = expiry;
    for (const step of [-3, 3, -3]) {
      // Back by hours the expired credential is still not returned; forward, the key is not freed early.
      wall = NOW_MS + step * 3600 * 1000;
      const refused = await rejection(m.mint(request));
      expect([refused.code, refused.retryable, posts(github.calls)]).toEqual(['provider_unavailable', true, 1]);
      hold = expiry + SKEW_MS - 1;
    }
    // The fake GitHub stamps every token with the same expires_at, so the next mint is checked at the original wall time.
    hold = expiry + SKEW_MS;
    wall = NOW_MS;
    const second = await m.mint(request);
    expect([second === first, posts(github.calls)]).toEqual([false, 2]);
  });

  it("stops returning a credential at GitHub's expires_at once a wall-clock error at mint is corrected", async () => {
    // The wall clock runs four minutes slow when the 201 arrives, within the skew tolerance.
    let wall = NOW_MS - 4 * 60 * 1000;
    let hold = 0;
    const github = statefulGitHub();
    const { minter: m } = minter([], { fetch: github.fetch, now: () => wall, monotonicNow: () => hold });
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-slow-wall' };
    const first = await m.mint(request);
    // Corrected, the wall clock reaches GitHub's expires_at while the hold clock still says four minutes remain.
    hold = Date.parse(EXPIRES_AT) - NOW_MS;
    wall = Date.parse(EXPIRES_AT);
    const refused = await rejection(m.mint(request));
    expect([refused.code, refused.retryable, posts(github.calls)]).toEqual(['provider_unavailable', true, 1]);
    await m.revoke(first.revokeHandle);
  });

  // Each hold starts at hold-clock 0 and ends exactly an hour plus the skew tolerance later.
  const heldCases: [string, () => { fetch: typeof fetch; settle: (m: GitHubAppMinter, request: object) => Promise<unknown> }][] = [
    ['an unknown outcome', () => {
      const github = statefulGitHub({ onPost: (token, n) => (n === 1 ? new Response(JSON.stringify({ message: 'Bad Gateway' }), { status: 502 }) : undefined) });
      return { fetch: github.fetch, settle: (m, request) => rejection(m.mint(request as never)) };
    }],
    ['a rejected grant whose cleanup failed', () => {
      const github = statefulGitHub({
        onPost: (token, n) => (n === 1 ? new Response(JSON.stringify(recordedAccessToken(token, { repository_selection: 'all' })), { status: 201 }) : undefined),
        onDelete: (n) => (n <= 3 ? new Response(JSON.stringify({ message: 'Service unavailable' }), { status: 503 }) : undefined),
      });
      return { fetch: github.fetch, settle: (m, request) => rejection(m.mint(request as never)) };
    }],
    ['a mint that never settles', () => {
      const github = statefulGitHub();
      const fake = ((input: string, init?: RequestInit) => {
        const answer = github.fetch(input, init);
        return posts(github.calls) === 1 ? new Promise<never>(() => undefined) : answer;
      }) as typeof fetch;
      return {
        fetch: fake,
        settle: async (m, request) => {
          void m.mint(request as never);
          await vi.waitFor(() => expect(posts(github.calls)).toBe(1));
        },
      };
    }],
  ];

  for (const [name, setup] of heldCases) {
    it(`holds the key after ${name} on the hold clock, ignoring wall-clock steps both ways`, async () => {
      let wall = NOW_MS;
      let hold = 0;
      const { fetch: fake, settle } = setup();
      const sent: string[] = [];
      const counting = ((input: string, init?: RequestInit) => {
        sent.push(init!.method!);
        return fake(input, init);
      }) as typeof fetch;
      const { minter: m } = minter([], { fetch: counting, now: () => wall, monotonicNow: () => hold });
      const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-held-clock' };
      await settle(m, request);
      for (const step of [3, -3, 30]) {
        wall = NOW_MS + step * 3600 * 1000;
        hold = 3600 * 1000 + SKEW_MS - 1;
        const retried = await Promise.race([m.mint(request).then(() => 'minted', () => 'held'), new Promise((resolve) => setTimeout(() => resolve('held'), 20))]);
        expect([retried, sent.filter((method) => method === 'POST').length]).toEqual(['held', 1]);
      }
      hold += 1;
      wall = NOW_MS;
      await m.mint(request);
      expect(sent.filter((method) => method === 'POST')).toHaveLength(2);
    });
  }

  it('frees the key after a definite refusal (422)', async () => {
    const { minter: m, calls } = minter([
      { status: 422, body: RECORDED_ERRORS[422] },
      { status: 201, body: recordedAccessToken(fakeInstallationToken(1)) },
    ]);
    const request = { installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-422' };
    expect(await rejection(m.mint(request))).toBeInstanceOf(ScopeNotGrantable);
    await expect(m.mint(request)).resolves.toMatchObject({ secret: fakeInstallationToken(1) });
    expect(calls).toHaveLength(2);
  });
});

describe('GitHub App minter: slow response bodies', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function bodyFetch(answers: Record<string, () => Response>) {
    const calls: { method: string; authorization: string | undefined }[] = [];
    const fake = (async (_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
      return answers[method]!();
    }) as typeof fetch;
    return { fetch: fake, calls };
  }

  it('cancels a stalled error body after the read timeout and still maps the status', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = controlledBody();
    const { fetch: fake } = bodyFetch({ POST: () => new Response(body.stream, { status: 422 }) });
    const { minter: m } = minter([], { fetch: fake });
    const pending = rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    await body.pulled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeInstanceOf(ScopeNotGrantable);
    expect(body.cancelled).toBe(true);
  });

  it('cancels a stalled revoke error body and keeps the revoke retryable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = controlledBody();
    const { fetch: fake } = bodyFetch({
      POST: () => new Response(JSON.stringify(recordedAccessToken(fakeInstallationToken(1))), { status: 201 }),
      DELETE: () => new Response(body.stream, { status: 503 }),
    });
    const { minter: m } = minter([], { fetch: fake });
    const minted = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
    const pending = rejection(m.revoke(minted.revokeHandle));
    await body.pulled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect([(await pending).code, body.cancelled]).toEqual(['provider_unavailable', true]);
  });

  it('reports a stalled 201 as an unknown outcome, then cancels the body if it never arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = controlledBody();
    const { fetch: fake, calls } = bodyFetch({ POST: () => new Response(body.stream, { status: 201 }) });
    const { minter: m } = minter([], { fetch: fake });
    const pending = rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    await body.pulled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).code).toBe('mint_outcome_unknown');
    // Still read, so a late token can be revoked, until the late-body limit.
    expect(body.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(body.cancelled).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('revokes a token from a 201 body that arrives after the read timeout, never returning it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const token = fakeInstallationToken(9);
    const body = controlledBody();
    const { fetch: fake, calls } = bodyFetch({
      POST: () => new Response(body.stream, { status: 201 }),
      DELETE: () => new Response(null, { status: 204 }),
    });
    const { minter: m } = minter([], { fetch: fake });
    const pending = rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600, idempotencyKey: 'test-operation-late' }));
    await body.pulled;
    await vi.advanceTimersByTimeAsync(10_000);
    const lost = await pending;
    expect(lost.code).toBe('mint_outcome_unknown');
    body.push(JSON.stringify(recordedAccessToken(token)));
    for (let i = 0; i < 50 && calls.length < 2; i++) await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(calls[1]!.authorization).toBe(`Bearer ${token}`);
    expect([String(lost), JSON.stringify(lost), inspect(lost, { depth: 10, showHidden: true })].join('\n')).not.toContain(token);
  });

  it('revokes at once a token already read when the rest of the 201 body stalls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const token = fakeInstallationToken(11);
    const body = controlledBody();
    const { fetch: fake, calls } = bodyFetch({
      POST: () => new Response(body.stream, { status: 201 }),
      DELETE: () => new Response(null, { status: 204 }),
    });
    const tasks: Promise<unknown>[] = [];
    const { minter: m } = minter([], { fetch: fake, waitUntil: (task) => tasks.push(task) });
    const pending = rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    await body.pulled;
    body.push(`{"token":"${token}","expires_at":"${EXPIRES_AT}",`, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).code).toBe('mint_outcome_unknown');
    await tasks[0];
    expect(calls.map((c) => [c.method, c.authorization === `Bearer ${token}`])).toEqual([
      ['POST', false],
      ['DELETE', true],
    ]);
    expect(body.cancelled).toBe(true);
  });

  it('hands the late read and its revocation to waitUntil, so a Workers request can keep them alive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const token = fakeInstallationToken(10);
    const body = controlledBody();
    const { fetch: fake, calls } = bodyFetch({
      POST: () => new Response(body.stream, { status: 201 }),
      DELETE: () => new Response(null, { status: 204 }),
    });
    const tasks: Promise<unknown>[] = [];
    const { minter: m } = minter([], { fetch: fake, waitUntil: (task) => tasks.push(task) });
    const pending = rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    await body.pulled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).code).toBe('mint_outcome_unknown');
    expect(tasks).toHaveLength(1);
    body.push(JSON.stringify(recordedAccessToken(token)));
    await tasks[0];
    expect(calls.map((c) => [c.method, c.authorization])).toEqual([
      ['POST', expect.any(String)],
      ['DELETE', `Bearer ${token}`],
    ]);
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

  it('never puts the JWT in the cause name of a failing fetch', async () => {
    let jwt = '';
    const failingFetch = (async (_input: unknown, init?: RequestInit) => {
      jwt = (init!.headers as Record<string, string>).authorization!.replace(/^Bearer /, '');
      const error = new Error('request failed');
      error.name = `Bearer ${jwt}`;
      throw error;
    }) as typeof fetch;
    const { minter: m } = minter([], { fetch: failingFetch });
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(error.code).toBe('provider_unavailable');
    expect((error.cause as Error).name).toBe('Error');
    expect(rendered(error)).not.toContain(jwt);
    expect(rendered(error)).not.toContain(jwt.split('.')[2]!);
  });

  it('contains a throwing name or message getter on a fetch error, in mint and revoke', async () => {
    for (const field of ['name', 'message'] as const) {
      let jwt = '';
      const token = fakeInstallationToken(10);
      const hostile = (secret: string) => {
        const error = new Error('request failed');
        Object.defineProperty(error, field, {
          get() {
            throw new Error(`Bearer ${secret}`);
          },
        });
        return error;
      };
      let failMint = true;
      const failingFetch = (async (_input: unknown, init?: RequestInit) => {
        const bearer = (init!.headers as Record<string, string>).authorization!.replace(/^Bearer /, '');
        if (init?.method === 'POST' && !failMint) return new Response(JSON.stringify(recordedAccessToken(token)), { status: 201 });
        if (init?.method === 'POST') jwt = bearer;
        throw hostile(bearer);
      }) as typeof fetch;
      const { minter: m } = minter([], { fetch: failingFetch });
      const mintError = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
      expect(mintError.code).toBe('provider_unavailable');
      expect([(mintError.cause as Error).name, (mintError.cause as Error).message]).toEqual(['Error', 'unreadable error']);
      expect(jwt.length).toBeGreaterThan(100);
      expect(rendered(mintError)).not.toContain(jwt);
      expect(rendered(mintError)).not.toContain(jwt.split('.')[2]!);

      failMint = false;
      const credential = await m.mint({ installation: 42, scope: SCOPE, ttl: 3600 });
      const revokeError = await rejection(m.revoke(credential.revokeHandle));
      expect(revokeError.code).toBe('provider_unavailable');
      expect(rendered(revokeError)).not.toContain(token);
    }
  });

  it('keeps a plain error name on the cause', async () => {
    const { minter: m } = minter([{ throws: new TypeError('fetch failed') }]);
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect((error.cause as Error).name).toBe('TypeError');
  });

  it('redacts a JWT inside a long provider message in linear time', async () => {
    const jwtShaped = ['header-part', 'payload-part', 'signature-part'].join('.');
    const message = `${'a'.repeat(500_000)} ${jwtShaped} ${'b'.repeat(500_000)}`;
    const { minter: m } = minter([{ status: 422, body: { message: `${jwtShaped} ${message}` } }]);
    const started = performance.now();
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(error.message).not.toContain(jwtShaped);
  });

  it('redacts token-shaped text in provider messages', async () => {
    const shaped = ['gh', 's_', 'test', 'tokenvalue'].join('');
    const { minter: m } = minter([{ status: 422, body: { message: `repository not accessible for ${shaped}` } }]);
    const error = await rejection(m.mint({ installation: 42, scope: SCOPE, ttl: 3600 }));
    expect(error.message).not.toContain(shaped);
  });
});
