import { describe, expect, it } from 'vitest';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import {
  AuthFnConfigError,
  AuthFnInsufficientScopeError,
  AuthFnUnauthenticatedError,
  AuthFnValidationError,
  assertRegisteredScopes,
  defineAuthFnScopes,
  hasScopes,
  requireScopes,
  type AuthFnRuntimeConfig
} from '../index.js';
import { authenticateApiKey, createApiKey, listApiKeysForUser } from '../core/api-keys.js';
import { issueSessionCookies } from '../core/cookies.js';
import { authenticateSessionToken, getCookieSessionState, issueSession } from '../core/sessions.js';
import { createUser } from '../core/users.js';
import { createTestServer } from './test-server.js';

const REGISTRY = defineAuthFnScopes({
  memotron: ['read', 'write'],
  pointron: ['read', 'write'],
  nucleum: ['read', 'write']
});

function createConfig(scopes: AuthFnRuntimeConfig['scopes'] = REGISTRY): AuthFnRuntimeConfig {
  return {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    scopes,
    plugins: [authFnApiKeyPlugin()]
  };
}

function grants(...scopes: string[]) {
  return { scopes };
}

describe('scope registry declaration', () => {
  it.each([
    ['an uppercase owner', { Memotron: ['read'] }],
    ['an owner containing the separator', { 'memo:tron': ['read'] }],
    ['the wildcard as an owner', { '*': ['read'] }],
    ['the wildcard as an action', { memotron: ['*'] }],
    ['an action containing the separator', { memotron: ['read:all'] }],
    ['an empty action', { memotron: [''] }],
    ['an owner longer than 64 characters', { ['m'.repeat(65)]: ['read'] }],
    ['an owner with no actions', { memotron: [] }],
    ['actions that are not an array', { memotron: 'read' }],
    ['a non-string action', { memotron: [1] }]
  ])('rejects %s', (_label, registry) => {
    expect(() => defineAuthFnScopes(registry as never)).toThrow(AuthFnConfigError);
    expect(() => createTestServer(createConfig(registry as never))).toThrow(AuthFnConfigError);
  });

  it.each([null, [], 'memotron:read'])('rejects a registry that is not an owner map: %j', (registry) => {
    expect(() => createTestServer(createConfig(registry as never))).toThrow(AuthFnConfigError);
  });

  it('accepts a well-formed registry and returns it unchanged', () => {
    const registry = { 'memotron-v2': ['read', 'sync.all'], app_1: ['admin'] };
    expect(defineAuthFnScopes(registry)).toBe(registry);
    expect(() => createTestServer(createConfig(registry))).not.toThrow();
  });
});

describe('API-key scope validation at creation', () => {
  it('accepts registered scopes, registered owner wildcards and the full wildcard, deduplicated', () => {
    expect(assertRegisteredScopes(REGISTRY, [
      'memotron:read', 'pointron:*', '*', 'memotron:read'
    ])).toEqual(['memotron:read', 'pointron:*', '*']);
    expect(assertRegisteredScopes(REGISTRY, [])).toEqual([]);
  });

  it.each([
    'memotron:delete',
    'unknown:read',
    'unknown:*',
    'Memotron:read',
    'memotron',
    'memotron:read:extra',
    ':read',
    'memotron:',
    ' memotron:read',
    'constructor:read',
    'toString:*',
    '**'
  ])('rejects %j with a 400 validation error naming it', (scope) => {
    const attempt = () => assertRegisteredScopes(REGISTRY, ['memotron:read', scope]);
    expect(attempt).toThrow(AuthFnValidationError);
    try {
      attempt();
    } catch (error) {
      expect(error).toMatchObject({ status: 400, details: { field: 'scopes', unknownScopes: [scope] } });
    }
  });

  it.each([[null], ['memotron:read'], [{}], [['memotron:read', 7]]])('rejects scopes %j that are not an array of strings', (scopes) => {
    expect(() => assertRegisteredScopes(REGISTRY, scopes)).toThrow(AuthFnValidationError);
  });

  it('accepts only the full wildcard when the host declares no registry', () => {
    expect(assertRegisteredScopes(undefined, ['*'])).toEqual(['*']);
    expect(() => assertRegisteredScopes(undefined, ['memotron:read'])).toThrow(AuthFnValidationError);
  });

  it('stores nothing when createApiKey receives an unregistered scope', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    await expect(createApiKey(config, {
      userId: user.id,
      name: 'cli',
      scopes: ['memotron:read', 'billing:read']
    })).rejects.toMatchObject({ code: 'AUTHFN_VALIDATION_ERROR', details: { unknownScopes: ['billing:read'] } });
    expect(await listApiKeysForUser(config, user.id)).toEqual([]);
  });

  it('rejects an unregistered scope on the HTTP create route with 400 and keeps registered ones', async () => {
    const config = createConfig();
    const auth = createTestServer(config);
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    const issued = await issueSession(config, {}, {
      request: new Request('https://account.example.com/auth/session'),
      userId: user.id,
      methods: ['password']
    });
    const cookie = Object.values(issueSessionCookies(issued.cookiePolicy!, issued.sessionToken, issued.csrfToken))
      .map((value) => value.slice(0, value.indexOf(';')))
      .join('; ');
    const create = (body: unknown) => auth.router.handle(new Request('https://account.example.com/auth/api-keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-authfn-csrf': issued.csrfToken },
      body: JSON.stringify(body)
    }));

    for (const scopes of [['memotron:read', 'billing:read'], ['unknown:*'], 'memotron:read', [null]]) {
      const rejected = await create({ name: 'cli', scopes });
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).error.code).toBe('AUTHFN_VALIDATION_ERROR');
    }
    expect(await listApiKeysForUser(config, user.id)).toEqual([]);

    const created = await create({ name: 'cli', scopes: ['memotron:*', 'nucleum:read', 'memotron:*'] });
    expect(created.status).toBe(201);
    const { secret } = (await created.json()).data;
    expect((await listApiKeysForUser(config, user.id)).map((key) => key.scopes)).toEqual([
      ['memotron:*', 'nucleum:read']
    ]);
    const session = await auth.provider.authenticate(new Request('https://account.example.com/x', {
      headers: { authorization: `Bearer ${secret}` }
    }));
    expect(session?.scopes).toEqual(['memotron:*', 'nucleum:read']);
  });
});

describe('scopes on every session', () => {
  it('gives cookie and bearer user sessions the full wildcard', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    const request = new Request('https://account.example.com/auth/session');
    const issued = await issueSession(config, {}, { request, userId: user.id, methods: ['password'] });
    expect(issued.session.scopes).toEqual(['*']);

    const cookie = Object.values(issueSessionCookies(issued.cookiePolicy!, issued.sessionToken, issued.csrfToken))
      .map((value) => value.slice(0, value.indexOf(';')))
      .join('; ');
    const cookieState = await getCookieSessionState(config, new Request(request.url, { headers: { cookie } }));
    expect(cookieState.session?.scopes).toEqual(['*']);
    expect((await authenticateSessionToken(config, issued.sessionToken))?.scopes).toEqual(['*']);
  });

  it('gives an API key without scopes an empty grant that every check denies', async () => {
    const config = createConfig();
    const key = await createApiKey(config, { userId: null, name: 'worker' });
    const session = await authenticateApiKey(config, key.secret);
    expect(session?.scopes).toEqual([]);
    expect(() => requireScopes(session, 'memotron:read')).toThrow(AuthFnInsufficientScopeError);
  });

  it('exposes only the string entries of scopes stored before validation existed', async () => {
    const config = createConfig();
    const key = await createApiKey(config, { userId: null, name: 'legacy', scopes: ['memotron:read'] });
    await config.database.update({
      model: 'api_keys',
      where: [{ field: 'id', operator: 'eq', value: key.keyId }],
      data: { scopes: ['memotron:read', 42, null, 'read'] },
      namespace: 'authfn'
    });
    const session = await authenticateApiKey(config, key.secret);
    expect(session?.scopes).toEqual(['memotron:read', 'read']);
    expect(session?.metadata?.scopes).toEqual(['memotron:read', 'read']);
  });
});

describe('requireScopes', () => {
  it('grants an exact scope and denies another action of the same owner', () => {
    expect(() => requireScopes(grants('memotron:read'), 'memotron:read')).not.toThrow();
    expect(() => requireScopes(grants('memotron:read'), 'memotron:write')).toThrow(AuthFnInsufficientScopeError);
  });

  it('expands an owner wildcard to that owner only', () => {
    const session = grants('memotron:*');
    expect(hasScopes(session, ['memotron:read', 'memotron:write'])).toBe(true);
    expect(hasScopes(session, 'pointron:read')).toBe(false);
    // An owner that merely shares a prefix is a different owner.
    expect(hasScopes(grants('memo:*'), 'memotron:read')).toBe(false);
    expect(hasScopes(grants('memotron:*'), 'memotron-v2:read')).toBe(false);
  });

  it('expands the full wildcard to every scope', () => {
    expect(hasScopes(grants('*'), ['memotron:write', 'pointron:read', 'nucleum:write'])).toBe(true);
    expect(hasScopes(grants('*'), ['memotron:write'], { registry: REGISTRY })).toBe(true);
  });

  it('requires every needed scope and reports the missing ones with 403', () => {
    const attempt = () => requireScopes(grants('memotron:read', 'pointron:*'), [
      'memotron:read', 'pointron:write', 'nucleum:read', 'memotron:write'
    ]);
    expect(attempt).toThrow(AuthFnInsufficientScopeError);
    try {
      attempt();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'AUTHFN_INSUFFICIENT_SCOPE',
        status: 403,
        details: {
          requiredScopes: ['memotron:read', 'pointron:write', 'nucleum:read', 'memotron:write'],
          missingScopes: ['nucleum:read', 'memotron:write']
        }
      });
    }
  });

  it('throws 401 without a session', () => {
    expect(() => requireScopes(null, 'memotron:read')).toThrow(AuthFnUnauthenticatedError);
    expect(() => requireScopes(undefined, 'memotron:read')).toThrow(AuthFnUnauthenticatedError);
  });

  it('never treats metadata, malformed scope lists or wildcard-looking strings as a grant', () => {
    const forged = { scopes: [], metadata: { scopes: ['*'] }, subject: { attributes: { scopes: ['*'] } } };
    expect(hasScopes(forged, 'memotron:read')).toBe(false);
    for (const scopes of [undefined, null, '*', { 0: '*' }, [1], ['memotron'], ['memotron:**'], [':*']]) {
      expect(hasScopes({ scopes: scopes as unknown as string[] }, 'memotron:read')).toBe(false);
    }
  });

  it.each([
    [[]],
    ['*'],
    ['memotron:*'],
    ['memotron'],
    ['Memotron:read'],
    [['memotron:read', 'pointron']]
  ])('rejects needed scopes %j as a host programming error', (needed) => {
    expect(() => requireScopes(grants('*'), needed as string[])).toThrow(TypeError);
  });

  it('rejects an unregistered needed scope when given the registry, even for the full wildcard', () => {
    expect(() => requireScopes(grants('*'), 'billing:read' as never, { registry: REGISTRY })).toThrow(TypeError);
    expect(() => requireScopes(grants('*'), 'billing:read')).not.toThrow();
  });
});
