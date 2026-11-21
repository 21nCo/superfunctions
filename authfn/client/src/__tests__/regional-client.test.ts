import { describe, expect, it } from 'vitest';
import { createTestServer } from './test-server.js';
import { createAuthFnRegionalClient, type AuthFnCachedRegion, type AuthFnRegionStorage } from '../index.js';

function memoryRegionStorage(): AuthFnRegionStorage & { values: Map<string, AuthFnCachedRegion> } {
  const values = new Map<string, AuthFnCachedRegion>();
  return {
    values,
    async get(identifier) {
      return values.get(identifier) ?? null;
    },
    async set(identifier, value) {
      values.set(identifier, value);
    },
    async delete(identifier) {
      values.delete(identifier);
    }
  };
}


/** A regional client whose requests are answered by `answer` (an OTP send by default). */
function lookupClient(
  answer: (url: string) => Response | undefined,
  extra: Partial<Parameters<typeof createAuthFnRegionalClient>[0]> = {}
) {
  const urls: string[] = [];
  const storage = memoryRegionStorage();
  const client = createAuthFnRegionalClient({
    defaultRegionId: 'us-east-1',
    resolveBaseUrl: (regionId) => `https://${regionId}.account.example.com/auth`,
    storage,
    ...extra,
    clientOptions: {
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        urls.push(url);
        return answer(url) ?? Response.json({ ok: true, data: { challengeId: 'otp_1', sent: true }, requestId: 'req_send' });
      }
    }
  });
  return { client, urls, storage };
}

function lookupAnswer(data: Record<string, unknown>) {
  return (url: string) => url.endsWith('/regions/lookup')
    ? Response.json({ ok: true, data, requestId: 'req_lookup' })
    : undefined;
}

function sentTo(urls: string[]): string | undefined {
  return urls.find((url) => url.endsWith('/otp/send'));
}

describe('@authfn/client regional client', () => {
  it('caches mismatch metadata and retries password sign-in once on the target region', async () => {
    const storage = memoryRegionStorage();
    const urls: string[] = [];
    const client = createAuthFnRegionalClient({
      defaultRegionId: 'us-east-1',
      resolveBaseUrl: (regionId) => `https://${regionId}.account.example.com/auth`,
      storage,
      clientOptions: {
        fetch: async (input) => {
          const url = typeof input === 'string' ? input : input.toString();
          urls.push(url);
          if (url.includes('/regions/lookup')) {
            return Response.json({
              ok: false,
              error: {
                code: 'AUTHFN_REGION_NOT_FOUND',
                message: 'not found',
                retryable: false
              },
              requestId: 'req_lookup'
            }, {
              status: 404
            });
          }
          if (new URL(url).origin === 'https://us-east-1.account.example.com') {
            return Response.json({
              ok: false,
              error: {
                code: 'AUTHFN_REGION_MISMATCH',
                message: 'wrong region',
                retryable: false,
                details: {
                  regionId: 'eu-west-1',
                  authority: 'https://eu-west-1.account.example.com/auth',
                  redirectTo: 'https://eu-west-1.account.example.com/auth'
                }
              },
              requestId: 'req_mismatch'
            }, {
              status: 409
            });
          }
          return Response.json({
            ok: true,
            data: {
              session: {
                id: 'sess_1',
                type: 'session',
                subject: {
                  actorId: 'user_1',
                  actorType: 'user',
                  regionId: 'eu-west-1'
                },
                actorType: 'user',
                actorId: 'user_1',
                regionId: 'eu-west-1',
                resourceIds: [],
                methods: ['password']
              }
            },
            requestId: 'req_success'
          });
        }
      }
    });

    const result = await client.signInWithPassword({
      email: 'ADA@example.com',
      password: 'Sup3rSecurePassphrase!'
    });

    expect(result.ok).toBe(true);
    expect(client.getCurrentRegionId()).toBe('eu-west-1');
    expect(storage.values.get('ada@example.com')).toMatchObject({
      regionId: 'eu-west-1'
    });
    expect(urls).toEqual([
      'https://us-east-1.account.example.com/auth/regions/lookup',
      'https://us-east-1.account.example.com/auth/sign-in/password',
      'https://eu-west-1.account.example.com/auth/sign-in/password'
    ]);
  });

  it('blocks sign-up methods when lookup finds an existing account in any region', async () => {
    const storage = memoryRegionStorage();
    const urls: string[] = [];
    const client = createAuthFnRegionalClient({
      defaultRegionId: 'us-east-1',
      resolveBaseUrl: (regionId) => `https://${regionId}.account.example.com/auth`,
      storage,
      clientOptions: {
        fetch: async (input) => {
          const url = typeof input === 'string' ? input : input.toString();
          urls.push(url);
          return Response.json({
            ok: true,
            data: {
              identifier: 'ada@example.com',
              userId: 'user_1',
              regionId: 'eu-west-1',
              authority: 'https://eu-west-1.account.example.com/auth',
              continueLocally: false,
              redirectTo: 'https://eu-west-1.account.example.com/auth'
            },
            requestId: 'req_lookup'
          });
        }
      }
    });

    const sent = await client.sendOtp({
      purpose: 'sign-up',
      email: 'ADA@example.com'
    });
    expect(sent.ok).toBe(false);
    if (sent.ok) {
      throw new Error('sendOtp sign-up should be blocked');
    }
    expect(sent.error).toMatchObject({
      code: 'AUTHFN_ACCOUNT_ALREADY_EXISTS',
      details: {
        identifier: 'ada@example.com',
        userId: 'user_1',
        regionId: 'eu-west-1'
      }
    });

    const passwordSignUp = await client.signUpWithPassword({
      email: 'ADA@example.com',
      password: 'Sup3rSecurePassphrase!'
    });
    expect(passwordSignUp.ok).toBe(false);
    if (passwordSignUp.ok) {
      throw new Error('password sign-up should be blocked');
    }
    expect(passwordSignUp.error.code).toBe('AUTHFN_ACCOUNT_ALREADY_EXISTS');

    expect(client.getCurrentRegionId()).toBe('us-east-1');
    expect(storage.values.get('ada@example.com')).toMatchObject({
      regionId: 'eu-west-1'
    });
    expect(urls).toEqual([
      'https://us-east-1.account.example.com/auth/regions/lookup',
      'https://us-east-1.account.example.com/auth/regions/lookup'
    ]);
  });

  it('keeps new sign-up OTP in the selected region after lookup preflight', async () => {
    const storage = memoryRegionStorage();
    const urls: string[] = [];
    const client = createAuthFnRegionalClient({
      defaultRegionId: 'us-east-1',
      resolveBaseUrl: (regionId) => `https://${regionId}.account.example.com/auth`,
      storage,
      clientOptions: {
        fetch: async (input) => {
          const url = typeof input === 'string' ? input : input.toString();
          urls.push(url);
          if (url.endsWith('/regions/lookup')) {
            return Response.json({
              ok: true,
              data: {
                identifier: 'new@example.com',
                regionId: 'eu-west-1',
                authority: 'https://eu-west-1.account.example.com/auth',
                continueLocally: true
              },
              requestId: 'req_lookup'
            });
          }
          return Response.json({
            ok: true,
            data: {
              challengeId: 'otp_1',
              sent: true
            },
            requestId: 'req_send'
          });
        }
      }
    });
    client.setCurrentRegionId('eu-west-1');

    const sent = await client.sendOtp({
      purpose: 'sign-up',
      email: 'new@example.com'
    });

    expect(sent.ok).toBe(true);
    expect(client.getCurrentRegionId()).toBe('eu-west-1');
    expect(storage.values.get('new@example.com')).toMatchObject({
      regionId: 'eu-west-1'
    });
    expect(urls).toEqual([
      'https://eu-west-1.account.example.com/auth/regions/lookup',
      'https://eu-west-1.account.example.com/auth/otp/send'
    ]);
  });

  it('lets a new sign-up through when a gateway lookup names no region', async () => {
    const { client, urls } = lookupClient(lookupAnswer({ identifier: 'new@example.com', authority: 'https://account.example.com', continueLocally: true }));
    expect((await client.sendOtp({ purpose: 'sign-up', email: 'new@example.com' })).ok).toBe(true);
    expect(sentTo(urls)).toBeDefined();
  });

  it('lets a new sign-up through when a server without a configured region answers unknown', async () => {
    const { client } = lookupClient(lookupAnswer({ identifier: 'new@example.com', regionId: 'unknown', authority: 'https://us-east-1.account.example.com', continueLocally: true }));
    expect((await client.sendOtp({ purpose: 'sign-up', email: 'new@example.com' })).ok).toBe(true);
  });

  it.each([
    ['an account owned by another region served from the same authority', { regionId: 'eu-west-1', authority: 'https://account.example.com', continueLocally: true, ownedElsewhere: true }],
    ['an earlier server naming the user of a local account', { userId: 'user_test_1', regionId: 'us-east-1', authority: 'https://us-east-1.account.example.com', continueLocally: true }]
  ])('blocks sign-up for %s', async (_label, data) => {
    const { client } = lookupClient(lookupAnswer({ identifier: 'ada@example.com', ...data }));
    const sent = await client.sendOtp({ purpose: 'sign-up', email: 'ada@example.com' });
    expect(sent.ok ? undefined : sent.error.code).toBe('AUTHFN_ACCOUNT_ALREADY_EXISTS');
  });

  it('lets a new sign-up through when the server answers with its own region for an unknown email', async () => {
    const { client } = lookupClient(lookupAnswer({ identifier: 'ada@example.com', regionId: 'eu-west-1', authority: 'https://eu-west-1.account.example.com', continueLocally: true }));
    expect((await client.sendOtp({ purpose: 'sign-up', email: 'ada@example.com' })).ok).toBe(true);
  });

  it('does not cache or switch to a region the server calls unknown', async () => {
    const resolved: string[] = [];
    const { client, storage } = lookupClient(lookupAnswer({ identifier: 'ada@example.com', regionId: 'unknown', authority: 'https://us-east-1.account.example.com', continueLocally: true }), {
      resolveBaseUrl: (regionId) => {
        resolved.push(regionId);
        if (regionId === 'unknown') {
          throw new Error('no base URL for region unknown');
        }
        return `https://${regionId}.account.example.com/auth`;
      }
    });
    expect((await client.sendOtp({ purpose: 'sign-in', email: 'ada@example.com' })).ok).toBe(true);
    expect(resolved).not.toContain('unknown');
    expect(await storage.get('ada@example.com')).toBeNull();
  });

  it('drops a cached route when a fresh lookup names no region', async () => {
    const { client, storage } = lookupClient(lookupAnswer({ identifier: 'ada@example.com', authority: 'https://account.example.com', continueLocally: true }));
    await storage.set('ada@example.com', {
      identifier: 'ada@example.com',
      regionId: 'eu-west-1',
      authority: 'https://eu-west-1.account.example.com',
      cachedAt: Date.now(),
      expiresAt: Date.now() + 60_000
    });
    await expect(client.resolveRegion({ identifier: 'ada@example.com', forceRefresh: true })).resolves.toBeNull();
    expect(await storage.get('ada@example.com')).toBeNull();
  });

  it.each([
    ['a redirect to a region called unknown', { regionId: 'unknown', authority: 'https://unknown.account.example.com', continueLocally: false, ownedElsewhere: true, redirectTo: 'https://unknown.account.example.com' }, {}, undefined],
    ['a selected region configured as unknown', { regionId: 'unknown', authority: 'https://unknown.account.example.com', continueLocally: true }, {}, 'unknown'],
    ['an earlier server naming a known account in a region called unknown', { userId: 'user_test_1', regionId: 'unknown', authority: 'https://account.example.com', continueLocally: true }, {}, undefined],
    ['an app that says unknown is a region', { regionId: 'unknown', authority: 'https://account.example.com', continueLocally: true }, { unknownIsARegion: true }, undefined]
  ])('routes sign-in to the region called unknown for %s', async (_label, data, extra, selected) => {
    const { client, urls } = lookupClient(lookupAnswer({ identifier: 'ada@example.com', ...data }), extra);
    if (selected) {
      client.setCurrentRegionId(selected);
    }
    expect((await client.sendOtp({ purpose: 'sign-in', email: 'ada@example.com' })).ok).toBe(true);
    expect(sentTo(urls)).toContain('https://unknown.account.example.com/');
  });

  it.each([
    ['answered from, even one called unknown', { identifier: 'ada@example.com', regionId: 'unknown', authority: 'https://unknown.account.example.com', continueLocally: true }, 'unknown'],
    ['default when the retry names none', { identifier: 'ada@example.com', authority: 'https://account.example.com', continueLocally: true }, 'us-east-1']
  ])('after a mismatch retry, reports and selects the region %s', async (_label, retryData, expected) => {
    const { client, storage } = lookupClient((url) => {
      if (url.startsWith('https://ap-south-1.')) {
        return Response.json({
          ok: false,
          error: {
            code: 'AUTHFN_REGION_MISMATCH',
            message: 'Request must continue on a different region authority',
            retryable: false,
            details: { regionId: expected === 'unknown' ? 'unknown' : 'eu-west-1', authority: 'https://elsewhere.account.example.com' }
          },
          requestId: 'req_mismatch'
        }, { status: 409 });
      }
      return lookupAnswer(retryData)(url);
    });
    client.setCurrentRegionId('ap-south-1');
    const prepared = await client.prepareEmailAuth({ email: 'ada@example.com', flow: 'sign-in' });
    expect(prepared.ok ? prepared.data.regionId : undefined).toBe(expected);
    expect(client.getCurrentRegionId()).toBe(expected);
    if (expected === 'us-east-1') {
      expect(await storage.get('ada@example.com')).toBeNull();
    }
  });

  it('sends the sign-in code where preparation pointed, after a mismatch whose retry names no region', async () => {
    const { client, urls } = lookupClient((url) => {
      if (!url.endsWith('/regions/lookup')) {
        return undefined;
      }
      if (url.startsWith('https://us-east-1.')) {
        return Response.json({
          ok: false,
          error: {
            code: 'AUTHFN_REGION_MISMATCH',
            message: 'Request must continue on a different region authority',
            retryable: false,
            details: { regionId: 'eu-west-1', authority: 'https://eu-west-1.account.example.com' }
          },
          requestId: 'req_mismatch'
        }, { status: 409 });
      }
      return lookupAnswer({ identifier: 'ada@example.com', authority: 'https://account.example.com', continueLocally: true })(url);
    });
    const prepared = await client.prepareEmailAuth({ email: 'ada@example.com', flow: 'sign-in' });
    expect(prepared.ok ? prepared.data.regionId : undefined).toBe('us-east-1');
    expect((await client.sendOtp({ purpose: 'sign-in', email: 'ada@example.com' })).ok).toBe(true);
    expect(sentTo(urls)).toContain('https://us-east-1.account.example.com/');
  });

  it.each([
    ['a storage that keeps nothing', { storage: { get: async () => null, set: async () => {}, delete: async () => {} } }],
    ['a cache TTL of 0', { cacheTtlMs: 0 }]
  ])('routes sign-in to the looked-up region with %s', async (_label, extra) => {
    const { client, urls } = lookupClient(lookupAnswer({ identifier: 'ada@example.com', regionId: 'eu-west-1', authority: 'https://eu-west-1.account.example.com', continueLocally: false, ownedElsewhere: true, redirectTo: 'https://eu-west-1.account.example.com' }), extra);
    expect((await client.sendOtp({ purpose: 'sign-in', email: 'ada@example.com' })).ok).toBe(true);
    expect(sentTo(urls)).toContain('https://eu-west-1.account.example.com/');
  });

  it('caches nothing until the mismatch retry settles, and falls back to the mismatch destination when it fails', async () => {
    const seenDuringRetry: unknown[] = [];
    const holder: { storage?: AuthFnRegionStorage } = {};
    const { client, urls, storage } = lookupClient((url) => {
      if (!url.endsWith('/regions/lookup')) {
        return undefined;
      }
      if (url.startsWith('https://us-east-1.')) {
        return Response.json({
          ok: false,
          error: {
            code: 'AUTHFN_REGION_MISMATCH',
            message: 'Request must continue on a different region authority',
            retryable: false,
            details: { regionId: 'eu-west-1', authority: 'https://eu-west-1.account.example.com' }
          },
          requestId: 'req_mismatch'
        }, { status: 409 });
      }
      seenDuringRetry.push(holder.storage!.get('ada@example.com'));
      // The retry's headers arrive but its body cannot be read.
      return new Response('{"ok": tr', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    holder.storage = storage;
    expect((await client.sendOtp({ purpose: 'sign-in', email: 'ada@example.com' })).ok).toBe(true);
    expect(await Promise.all(seenDuringRetry)).toEqual([null]);
    expect(sentTo(urls)).toContain('https://eu-west-1.account.example.com/');
  });

  it('looks up uncached identifiers through the currently selected region', async () => {
    const storage = memoryRegionStorage();
    const urls: string[] = [];
    const client = createAuthFnRegionalClient({
      defaultRegionId: 'us-east-1',
      resolveBaseUrl: (regionId) => `https://${regionId}.account.example.com/auth`,
      storage,
      clientOptions: {
        fetch: async (input) => {
          const url = typeof input === 'string' ? input : input.toString();
          urls.push(url);
          return Response.json({
            ok: true,
            data: {
              identifier: 'new@example.com',
              regionId: 'eu-west-1',
              authority: 'https://eu-west-1.account.example.com/auth',
              continueLocally: true
            },
            requestId: 'req_lookup'
          });
        }
      }
    });
    client.setCurrentRegionId('eu-west-1');

    const region = await client.resolveRegion({
      identifier: 'new@example.com',
      forceRefresh: true
    });

    expect(region).toMatchObject({
      regionId: 'eu-west-1'
    });
    expect(urls).toEqual([
      'https://eu-west-1.account.example.com/auth/regions/lookup'
    ]);
  });

  it('preserves server lookup metadata for signup conflict checks', async () => {
    const storage = memoryRegionStorage();
    const client = createAuthFnRegionalClient({
      defaultRegionId: 'us-east-1',
      resolveBaseUrl: (regionId) => `https://${regionId}.account.example.com/auth`,
      storage,
      clientOptions: {
        fetch: async () => Response.json({
          ok: true,
          data: {
            identifier: 'ada@example.com',
            userId: 'user_1',
            regionId: 'us-east-1',
            authority: 'https://us-east-1.account.example.com/auth',
            continueLocally: false,
            redirectTo: 'https://us-east-1.account.example.com/auth'
          },
          requestId: 'req_lookup'
        })
      }
    });
    client.setCurrentRegionId('eu-west-1');

    const lookup = await client.lookupRegion({
      identifier: 'ADA@example.com'
    });

    expect(lookup.ok).toBe(true);
    if (!lookup.ok) {
      throw new Error('lookup should succeed');
    }
    expect(lookup.data).toMatchObject({
      identifier: 'ada@example.com',
      userId: 'user_1',
      regionId: 'us-east-1',
      continueLocally: false
    });
    expect(storage.values.get('ada@example.com')).toMatchObject({
      regionId: 'us-east-1'
    });
  });
});
