import { describe, expect, it } from 'vitest';
import { DefaultOAuthTokenHttpClient, type OAuthFetchLike } from '@superfunctions/oauth-http';
import { createAuthFn } from '../src/index.js';
import { createSocialOAuthService, type SocialOAuthError } from '../src/social-oauth/index.js';

describe('authfn social oauth', () => {
  it('uses shared oauth service for login url + callback flow and persists identity records', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const service = createSocialOAuthService({
      providers: {
        google: {
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
          redirectUris: ['https://app.example.com/oauth/callback'],
          scopes: ['openid', 'email', 'profile'],
        },
      },
      tokenHttpClient: new DefaultOAuthTokenHttpClient({
        fetcher: createFetchStub({
          onCall: (input) => calls.push(input),
        }),
      }),
      now: createClock(),
    });

    const login = await service.getLoginUrl({
      provider: 'google',
      tenantId: 't1',
      userIdHint: 'u1',
      redirectUri: 'https://app.example.com/oauth/callback',
    });
    const authUrl = new URL(login.url);
    expect(authUrl.origin).toBe('https://accounts.google.com');
    expect(authUrl.searchParams.get('state')).toBe(login.stateId);
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();

    const callback = await service.handleLoginCallback({
      provider: 'google',
      code: 'auth-code-1',
      state: login.stateId,
      redirectUri: 'https://app.example.com/oauth/callback',
    });

    expect(callback.identityId).toContain('sid_');
    expect(callback.email).toBe('user@example.com');
    expect(callback.profile.providerId).toBe('google');

    const linked = await service.listLinkedIdentities({ tenantId: 't1', userId: 'u1' });
    expect(linked).toHaveLength(1);
    expect(linked[0].id).toBe(callback.identityId);
    expect(calls.some((call) => call.url.includes('/token'))).toBe(true);
  });

  it('disconnect clears local identity/token and attempts provider-side revoke when supported', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const service = createSocialOAuthService({
      providers: {
        google: {
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
          redirectUris: ['https://app.example.com/oauth/callback'],
        },
      },
      tokenHttpClient: new DefaultOAuthTokenHttpClient({
        fetcher: createFetchStub({
          onCall: (input) => calls.push(input),
        }),
      }),
      now: createClock(),
    });

    const login = await service.getLoginUrl({
      provider: 'google',
      tenantId: 't2',
      userIdHint: 'u2',
      redirectUri: 'https://app.example.com/oauth/callback',
    });
    const callback = await service.handleLoginCallback({
      provider: 'google',
      code: 'auth-code-2',
      state: login.stateId,
      redirectUri: 'https://app.example.com/oauth/callback',
    });

    await expect(
      service.disconnectIdentity({
        tenantId: 't2',
        identityId: callback.identityId,
      })
    ).resolves.toBeUndefined();

    await expect(service.disconnectIdentity({
      tenantId: 't2',
      identityId: callback.identityId,
    })).resolves.toBeUndefined();

    expect(await service.listLinkedIdentities({ tenantId: 't2', userId: 'u2' })).toHaveLength(0);
    expect(calls.some((call) => call.url.includes('/revoke'))).toBe(true);
  });

  it('keeps legacy oauth-shaped methods as extensions for backward compatibility', async () => {
    const service = createSocialOAuthService({
      providers: {
        google: {
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
          redirectUris: ['https://app.example.com/oauth/callback'],
        },
      },
      tokenHttpClient: new DefaultOAuthTokenHttpClient({
        fetcher: createFetchStub({}),
      }),
      now: createClock(),
    });

    const login = await service.createLoginUrl({
      providerId: 'google',
      tenantId: 'tb',
      userId: 'ub',
      redirectUri: 'https://app.example.com/oauth/callback',
    });
    expect(login.authorizationUrl).toContain('accounts.google.com');

    const callback = await service.handleCallback({
      providerId: 'google',
      code: 'auth-code-legacy',
      state: login.stateId,
      redirectUri: 'https://app.example.com/oauth/callback',
    });
    expect(callback.identity.userId).toBe('ub');
  });

  it('records and surfaces revocation failures after local cleanup', async () => {
    const service = createSocialOAuthService({
      providers: {
        google: {
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
          redirectUris: ['https://app.example.com/oauth/callback'],
        },
      },
      tokenHttpClient: new DefaultOAuthTokenHttpClient({
        fetcher: createFetchStub({
          failRevoke: true,
        }),
      }),
      now: createClock(),
    });

    const login = await service.getLoginUrl({
      provider: 'google',
      tenantId: 't3',
      userIdHint: 'u3',
      redirectUri: 'https://app.example.com/oauth/callback',
    });
    const callback = await service.handleLoginCallback({
      provider: 'google',
      code: 'auth-code-3',
      state: login.stateId,
      redirectUri: 'https://app.example.com/oauth/callback',
    });

    await expect(
      service.disconnectIdentity({
        tenantId: 't3',
        identityId: callback.identityId,
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'provider revoke failed after local cleanup',
    });

    expect(await service.listLinkedIdentities({ tenantId: 't3', userId: 'u3' })).toHaveLength(0);
    const failures = await service.getRevocationFailures({ tenantId: 't3', userId: 'u3' });
    expect(failures).toHaveLength(1);
    expect(failures[0].providerId).toBe('google');
  });

  it('keeps api-key authentication behavior unchanged', async () => {
    const database = new InMemoryAuthFnAdapter();
    const auth = createAuthFn({
      database: database as any,
      namespace: 'authfn',
    });

    const created = await auth.createKey({
      name: 'Test Key',
      resourceIds: ['resource-1'],
    });
    const request = new Request('https://service.example.com', {
      headers: {
        authorization: `Bearer ${created.key}`,
      },
    });

    const session = await auth.provider.authenticate(request);
    expect(session?.type).toBe('api-key');
    expect(session?.resourceIds).toEqual(['resource-1']);
    await expect(auth.provider.authorize(session!, 'resource-1')).resolves.toBe(true);
  });

  it('uses shared oauth-flow package in implementation surface', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/social-oauth/index.ts', import.meta.url), 'utf8')
    );

    expect(source).toContain("@superfunctions/oauth-flow");
    expect(source).toContain("@superfunctions/oauth-http");
    expect(source).toContain("@superfunctions/oauth-storage");
  });
});

function createFetchStub(input: {
  failRevoke?: boolean;
  onCall?: (call: { url: string; body?: string }) => void;
}): OAuthFetchLike {
  return async (url, init) => {
    input.onCall?.({ url, body: init.body });

    if (url.includes('/token')) {
      return createResponse(200, {
        access_token: 'at_google_1',
        refresh_token: 'rt_google_1',
        expires_in: 3600,
        scope: 'openid email profile',
        token_type: 'Bearer',
        id_token: buildTestIdToken({
          sub: 'google-user-1',
          email: 'user@example.com',
          name: 'User One',
        }),
      });
    }

    if (url.includes('/revoke')) {
      if (input.failRevoke) {
        return createResponse(500, {
          error: 'server_error',
          error_description: 'revoke failed',
        });
      }
      return createResponse(200, {});
    }

    return createResponse(404, { error: 'not_found' });
  };
}

function createResponse(status: number, body: Record<string, unknown>) {
  const bodyText = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'content-type') {
          return 'application/json';
        }
        return null;
      },
    },
    text: async () => bodyText,
  };
}

function buildTestIdToken(payload: Record<string, unknown>): string {
  const header = toBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = toBase64Url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function createClock(): () => Date {
  let tick = Date.parse('2026-03-12T00:00:00.000Z');
  return () => {
    const value = new Date(tick);
    tick += 1000;
    return value;
  };
}

class InMemoryAuthFnAdapter {
  private readonly data = new Map<string, Array<Record<string, any>>>();

  async create(input: {
    model: string;
    data: Record<string, any>;
    namespace?: string;
  }): Promise<Record<string, any>> {
    const key = scopedModel(input.namespace, input.model);
    const existing = this.data.get(key) ?? [];
    existing.push({ ...input.data });
    this.data.set(key, existing);
    return { ...input.data };
  }

  async findOne<T>(input: {
    model: string;
    where: Array<{ field: string; operator: string; value: unknown }>;
    namespace?: string;
  }): Promise<T | null> {
    const key = scopedModel(input.namespace, input.model);
    const records = this.data.get(key) ?? [];
    const found = records.find((record) =>
      input.where.every((clause) => record[clause.field] === clause.value)
    );
    return (found as T) ?? null;
  }

  async findMany<T>(input: {
    model: string;
    where?: Array<{ field: string; operator: string; value: unknown }>;
    namespace?: string;
  }): Promise<T[]> {
    const key = scopedModel(input.namespace, input.model);
    const records = this.data.get(key) ?? [];
    if (!input.where || input.where.length === 0) {
      return records as T[];
    }

    return records.filter((record) =>
      input.where!.every((clause) => {
        if (clause.operator === 'contains' && Array.isArray(record[clause.field])) {
          return record[clause.field].includes(clause.value);
        }
        return record[clause.field] === clause.value;
      })
    ) as T[];
  }

  async update(input: {
    model: string;
    where: Array<{ field: string; operator: string; value: unknown }>;
    data: Record<string, unknown>;
    namespace?: string;
  }): Promise<number> {
    const key = scopedModel(input.namespace, input.model);
    const records = this.data.get(key) ?? [];
    let updated = 0;
    for (const record of records) {
      const match = input.where.every((clause) => record[clause.field] === clause.value);
      if (!match) {
        continue;
      }
      Object.assign(record, input.data);
      updated += 1;
    }
    return updated;
  }

  async delete(input: {
    model: string;
    where: Array<{ field: string; operator: string; value: unknown }>;
    namespace?: string;
  }): Promise<number> {
    const key = scopedModel(input.namespace, input.model);
    const records = this.data.get(key) ?? [];
    const remaining = records.filter(
      (record) => !input.where.every((clause) => record[clause.field] === clause.value)
    );
    this.data.set(key, remaining);
    return records.length - remaining.length;
  }
}

function scopedModel(namespace: string | undefined, model: string): string {
  return `${namespace ?? 'default'}:${model}`;
}
