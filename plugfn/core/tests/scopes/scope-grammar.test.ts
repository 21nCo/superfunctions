import { describe, expect, it } from 'vitest';
import { defineScopeGrammar, SCOPE_LIMITS, SCOPE_RISK_LEVELS, ScopeError, type ScopeRisk } from '../../src/scopes/index.js';

const grammar = defineScopeGrammar({
  provider: 'test-provider',
  dimensions: {
    permissions: { kind: 'exactSet', values: ['contents:read', 'contents:write', 'admin'] },
    labels: { kind: 'exactSet' },
    resources: { kind: 'prefixGlobSet' },
    rate: { kind: 'numericMax', min: 0, max: 1000, integer: true },
    ttl: { kind: 'ttlMax', minSeconds: 900, maxSeconds: 3600 },
  },
  riskOf: ({ dimension, value }): ScopeRisk => {
    if (value === 'admin') return 'destructive';
    if (dimension === 'permissions' && String(value).endsWith(':write')) return 'write';
    return 'read';
  },
});

const envelope = {
  permissions: ['contents:read', 'contents:write'],
  labels: ['alpha', 'beta'],
  resources: ['org/app-*', 'org/docs'],
  rate: 100,
  ttl: 3600,
};

const base = { permissions: [], labels: [], resources: [], rate: 0, ttl: 900 };

function violationsOf(request: Record<string, unknown>, env: Record<string, unknown> = envelope) {
  return grammar.isSubset(request as never, env as never);
}

/** An array whose descriptor for `key` cannot be read. */
function throwingArray(key: string, error: () => unknown = () => new Error(`${key} descriptor failed`)): string[] {
  return new Proxy(['alpha'], {
    getOwnPropertyDescriptor(target, property) {
      if (property === key) throw error();
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
}

describe('defineScopeGrammar', () => {
  it('rejects any dimension kind outside the closed set', () => {
    for (const kind of ['regex', 'numericMin', 'suffixGlob', undefined]) {
      expect(() =>
        defineScopeGrammar({ provider: 'p', dimensions: { d: { kind } as never }, riskOf: () => 'read' }),
      ).toThrow(TypeError);
    }
  });

  it('rejects invalid definitions instead of building a permissive grammar', () => {
    const riskOf = () => 'read' as const;
    const bad: unknown[] = [
      { provider: '', dimensions: { d: { kind: 'prefixGlobSet' } }, riskOf },
      { provider: 'p', dimensions: {}, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'prefixGlobSet' } } },
      { provider: 'p', dimensions: { 'bad name': { kind: 'prefixGlobSet' } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'exactSet', values: ['repo*'] } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'numericMax', min: 5, max: 1 } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'numericMax', max: Number.NaN } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'ttlMax', maxSeconds: 1.5 } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'ttlMax', minSeconds: 0 } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'ttlMax', minSeconds: 60, maxSeconds: 30 } }, riskOf },
    ];
    for (const definition of bad) expect(() => defineScopeGrammar(definition as never)).toThrow(TypeError);
  });

  it('rejects options a dimension kind does not have instead of dropping them', () => {
    const riskOf = () => 'read' as const;
    const bad: unknown[] = [
      // A mistyped cap must not leave the dimension unbounded.
      { kind: 'ttlMax', max: 60 },
      { kind: 'numericMax', maxSeconds: 60 },
      { kind: 'exactSet', value: ['a'] },
      { kind: 'prefixGlobSet', values: ['a'] },
      { kind: 'ttlMax', [Symbol('maxSeconds')]: 60 },
      Object.defineProperty({ kind: 'ttlMax' }, 'maxSeconds', { enumerable: true, get: () => 60 }),
    ];
    for (const d of bad) {
      expect(() => defineScopeGrammar({ provider: 'p', dimensions: { d } as never, riskOf })).toThrow(TypeError);
    }
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: { d: { kind: 'prefixGlobSet' } }, riskOf, normalise: (x: unknown) => x } as never),
    ).toThrow(TypeError);
  });

  it('rejects an undefined dimension entry but allows undefined optional fields', () => {
    const riskOf = () => 'read' as const;
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: { perms: { kind: 'exactSet' }, ttl: undefined } as never, riskOf }),
    ).toThrow(TypeError);
    const optional = defineScopeGrammar({
      provider: 'p',
      dimensions: {
        size: { kind: 'numericMax', min: undefined, max: 10, integer: undefined },
        names: { kind: 'exactSet', values: undefined },
      },
      normalize: undefined,
      riskOf,
    });
    expect(Object.keys(optional.dimensions)).toEqual(['size', 'names']);
    expect(optional.normalize({ size: 11 }).ok).toBe(false);
    expect(optional.normalize({ size: 10 }).ok).toBe(true);
  });

  it('rejects an exactSet vocabulary whose length is invalid or too large', () => {
    const riskOf = () => 'read' as const;
    for (const length of [Number.NaN, -1, 1.5, SCOPE_LIMITS.maxSetItems + 1]) {
      const values = new Proxy(['a'], {
        getOwnPropertyDescriptor: (target, key) =>
          key === 'length' ? { value: length, writable: true, enumerable: false, configurable: false } : Reflect.getOwnPropertyDescriptor(target, key),
      });
      expect(() => defineScopeGrammar({ provider: 'p', dimensions: { d: { kind: 'exactSet', values } }, riskOf })).toThrow(TypeError);
    }
  });

  it('rejects definition keys that have no own data property instead of dropping them', () => {
    // A Proxy may list a key in ownKeys and report no descriptor for it.
    const hiding = <T extends object>(target: T, hidden: string) =>
      new Proxy(target, {
        getOwnPropertyDescriptor: (t, key) => (key === hidden ? undefined : Reflect.getOwnPropertyDescriptor(t, key)),
      });
    const riskOf = () => 'read' as const;
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: { ttl: hiding({ kind: 'ttlMax', maxSeconds: 60 }, 'maxSeconds') as never }, riskOf }),
    ).toThrow(TypeError);
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: hiding({ ttl: { kind: 'ttlMax' as const } }, 'ttl'), riskOf }),
    ).toThrow(TypeError);
    const sparse = ['contents:read'];
    sparse.length = 2;
    const inherited = ['contents:read'];
    inherited.length = 2;
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype) as object, { 1: 'admin' }));
    const accessor = ['contents:read'];
    Object.defineProperty(accessor, 0, { get: () => 'admin' });
    for (const values of [sparse, inherited, accessor]) {
      expect(() => defineScopeGrammar({ provider: 'p', dimensions: { d: { kind: 'exactSet', values } }, riskOf })).toThrow(TypeError);
    }
  });

  it('exposes a frozen grammar whose dimensions mirror the definition', () => {
    expect(Object.isFrozen(grammar)).toBe(true);
    expect(Object.isFrozen(grammar.dimensions)).toBe(true);
    for (const def of Object.values(grammar.dimensions)) expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(grammar.dimensions.permissions.values)).toBe(true);
    expect(grammar.dimensions).toEqual({
      permissions: { kind: 'exactSet', values: ['contents:read', 'contents:write', 'admin'] },
      labels: { kind: 'exactSet' },
      resources: { kind: 'prefixGlobSet' },
      rate: { kind: 'numericMax', min: 0, max: 1000, integer: true },
      ttl: { kind: 'ttlMax', minSeconds: 900, maxSeconds: 3600 },
    });
  });

  it('cannot be changed after definition through its dimensions or the definition object', () => {
    const wildcardLabels = () => violationsOf({ ...base, labels: ['alpha'] }, { ...envelope, labels: ['al*'] });
    expect(wildcardLabels().ok).toBe(false);
    expect(() => {
      (grammar.dimensions.labels as { kind: string }).kind = 'prefixGlobSet';
    }).toThrow(TypeError);
    expect(() => {
      (grammar.dimensions.permissions.values as string[]).push('issues:write');
    }).toThrow(TypeError);
    expect(wildcardLabels().ok).toBe(false);

    const dimensions = { names: { kind: 'exactSet', values: ['a'] as string[] }, ttl: { kind: 'ttlMax', maxSeconds: 60 } };
    const owned = defineScopeGrammar({ provider: 'owned', dimensions: dimensions as never, riskOf: () => 'read' });
    (dimensions.names as { kind: string }).kind = 'prefixGlobSet';
    dimensions.names.values.push('b*');
    dimensions.ttl.maxSeconds = 3600;
    expect(owned.isSubset({ names: ['b'], ttl: 60 } as never, { names: ['b*'], ttl: 60 } as never).ok).toBe(false);
    expect(owned.normalize({ names: [], ttl: 120 } as never).ok).toBe(false);
  });
});

describe('exactSet dimension', () => {
  it('accepts a subset', () => {
    expect(violationsOf({ ...base, permissions: ['contents:read'] })).toEqual({
      ok: true,
      violations: [],
      scope: { ...base, permissions: ['contents:read'] },
    });
  });

  it('accepts an equal set, with duplicates and any order', () => {
    expect(violationsOf({ ...base, permissions: ['contents:write', 'contents:read', 'contents:read'] }).ok).toBe(true);
  });

  it('reports each item of a superset that the envelope lacks', () => {
    const result = violationsOf({ ...base, permissions: ['contents:read', 'admin'], labels: ['alpha', 'gamma'] });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ code: 'not_in_envelope', side: 'request', dimension: 'permissions', item: 'admin' }),
      expect.objectContaining({ code: 'not_in_envelope', side: 'request', dimension: 'labels', item: 'gamma' }),
    ]);
  });

  it('rejects malformed input on either side', () => {
    const malformedRequests: unknown[] = [
      'contents:read',
      [42],
      [''],
      ['alp*'],
      ['line\nbreak'],
      [undefined],
    ];
    for (const labels of malformedRequests) {
      const result = violationsOf({ ...base, labels });
      expect(result.ok, JSON.stringify(labels)).toBe(false);
      expect(result.violations[0]).toMatchObject({ code: 'malformed', side: 'request', dimension: 'labels' });
    }
    // A value outside the declared vocabulary does not normalise, even if the envelope lists it.
    const outside = violationsOf({ ...base, permissions: ['issues:write'] }, { ...envelope, permissions: ['issues:write'] });
    expect(outside.violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', item: 'issues:write' }),
      expect.objectContaining({ code: 'malformed', side: 'envelope', item: 'issues:write' }),
    ]);
  });

  it('does not treat "*" as a wildcard', () => {
    const result = violationsOf({ ...base, labels: ['alpha'] }, { ...envelope, labels: ['*'] });
    expect(result.violations).toEqual([expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'labels' })]);
  });
});

describe('prefixGlobSet dimension', () => {
  it('accepts literals and narrower globs under an envelope glob', () => {
    expect(violationsOf({ ...base, resources: ['org/app-web', 'org/app-', 'org/app-api*', 'org/app-*', 'org/docs'] }).ok).toBe(true);
  });

  it('accepts an equal set', () => {
    expect(violationsOf({ ...base, resources: ['org/docs', 'org/app-*'] }).ok).toBe(true);
  });

  it('rejects a superset: wider globs and uncovered literals', () => {
    const result = violationsOf({ ...base, resources: ['org/app*', 'org/docs*', 'org/docs-private', 'org/*', '*'] });
    expect(result.ok).toBe(false);
    expect(result.violations.map(v => v.item)).toEqual(['org/app*', 'org/docs*', 'org/docs-private', 'org/*', '*']);
    expect(result.violations.every(v => v.code === 'not_in_envelope')).toBe(true);
  });

  it('matches envelope prefixes of mixed lengths exactly', () => {
    const env = { ...envelope, resources: ['a/*', 'a/b/c/*', 'ab*', 'ac*', 'zz'] };
    expect(violationsOf({ ...base, resources: ['a/b/c/d', 'a/x', 'abc', 'ac*', 'a/b*', 'zz'] }, env).ok).toBe(true);
    expect(violationsOf({ ...base, resources: ['ad', 'a', 'a*', 'b/x', 'z', 'zz*'] }, env).violations.map(v => v.item)).toEqual([
      'ad',
      'a',
      'a*',
      'b/x',
      'z',
      'zz*',
    ]);
  });

  it('lets a bare "*" envelope cover everything', () => {
    expect(violationsOf({ ...base, resources: ['anything', 'x*', '*'] }, { ...envelope, resources: ['*'] }).ok).toBe(true);
  });

  it('rejects a glob with an interior or leading "*" on either side', () => {
    for (const pattern of ['org/*/app', '*org', 'org/**', 'o*rg*']) {
      const request = violationsOf({ ...base, resources: [pattern] });
      expect(request.ok, pattern).toBe(false);
      expect(request.violations).toEqual([expect.objectContaining({ code: 'malformed', side: 'request', item: pattern })]);

      const env = violationsOf({ ...base, resources: ['org/docs'] }, { ...envelope, resources: ['org/docs', pattern] });
      expect(env.ok, pattern).toBe(false);
      expect(env.violations).toEqual([expect.objectContaining({ code: 'malformed', side: 'envelope', item: pattern })]);
    }
  });

  it('rejects other malformed members', () => {
    for (const resources of [[''], [null], 'org/*', { 0: 'org/docs', length: 1 }]) {
      expect(violationsOf({ ...base, resources }).violations[0], JSON.stringify(resources)).toMatchObject({
        code: 'malformed',
        dimension: 'resources',
      });
    }
  });
});

describe('numericMax dimension', () => {
  it('accepts a smaller value', () => {
    expect(violationsOf({ ...base, rate: 10 }).ok).toBe(true);
  });

  it('accepts an equal value', () => {
    expect(violationsOf({ ...base, rate: 100 }).ok).toBe(true);
  });

  it('rejects a larger value with the envelope limit', () => {
    expect(violationsOf({ ...base, rate: 101 }).violations).toEqual([
      expect.objectContaining({ code: 'exceeds_envelope', dimension: 'rate', item: 101, limit: 100 }),
    ]);
  });

  it('rejects malformed values and never treats a missing one as unbounded', () => {
    for (const rate of ['10', Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 1001, null]) {
      expect(violationsOf({ ...base, rate }).violations[0], String(rate)).toMatchObject({ code: 'malformed', dimension: 'rate' });
    }
    const { rate: _rate, ...missing } = base;
    expect(violationsOf(missing).violations).toEqual([expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'rate' })]);
    const { rate: _envRate, ...envelopeWithoutRate } = envelope;
    expect(violationsOf(base, envelopeWithoutRate).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'rate' }),
    ]);
  });
});

describe('ttlMax dimension', () => {
  it('accepts a shorter lifetime', () => {
    expect(violationsOf({ ...base, ttl: 1800 }).ok).toBe(true);
  });

  it('accepts an equal lifetime', () => {
    expect(violationsOf({ ...base, ttl: 3600 }).ok).toBe(true);
  });

  it('rejects a longer lifetime than the envelope', () => {
    const result = violationsOf({ ...base, ttl: 1800 }, { ...envelope, ttl: 1200 });
    expect(result.violations).toEqual([expect.objectContaining({ code: 'exceeds_envelope', dimension: 'ttl', item: 1800, limit: 1200 })]);
  });

  it('rejects malformed lifetimes', () => {
    for (const ttl of [0, -900, 900.5, '1h', 600, 7200, Number.MAX_SAFE_INTEGER + 2, undefined]) {
      expect(violationsOf({ ...base, ttl }).violations[0], String(ttl)).toMatchObject({ code: 'malformed', dimension: 'ttl' });
    }
  });
});

describe('fail closed', () => {
  it('rejects unknown dimensions instead of ignoring them', () => {
    const result = violationsOf({ ...base, extra: ['x'] });
    expect(result).toEqual({ ok: false, violations: [expect.objectContaining({ code: 'malformed', side: 'request' })] });
    expect(violationsOf(JSON.parse('{"__proto__":{"rate":1},"rate":1,"ttl":900}')).ok).toBe(false);
  });

  it('rejects non-object scopes and accessor properties', () => {
    for (const request of [null, [], 'scope', 5, Promise.resolve(base), new (class Scope {})()]) {
      expect(violationsOf(request as never).ok).toBe(false);
    }
    const accessor = { ...base };
    Object.defineProperty(accessor, 'rate', { enumerable: true, get: () => 1 });
    expect(violationsOf(accessor).violations).toEqual([expect.objectContaining({ code: 'malformed', dimension: 'rate' })]);
  });

  it('rejects a set whose reported length is invalid instead of skipping it', () => {
    // The length descriptor of an array target is writable, so a Proxy may report any value for it.
    const lying = (length: unknown) =>
      new Proxy(['admin'], {
        getOwnPropertyDescriptor: (target, key) =>
          key === 'length' ? { value: length, writable: true, enumerable: false, configurable: false } : Reflect.getOwnPropertyDescriptor(target, key),
      });
    for (const length of [Number.NaN, -1, 0.5, '1', Number.POSITIVE_INFINITY, 5_000_000]) {
      const malformedLength = expect.objectContaining({ code: 'malformed', dimension: 'permissions' });
      expect(violationsOf({ ...base, permissions: lying(length) }).violations).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'permissions' }),
      ]);
      expect(violationsOf(base, { ...envelope, permissions: lying(length) }).violations).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'permissions' }),
      ]);
      expect(grammar.normalize({ ...base, permissions: lying(length) }).ok).toBe(false);
      expect(() => grammar.classifyRisk({ ...base, permissions: lying(length) })).toThrow(
        expect.objectContaining({ name: 'ScopeError', violations: [malformedLength] }),
      );
    }
  });

  it('rejects sets and members beyond the input limits', () => {
    const tooMany = Array.from({ length: SCOPE_LIMITS.maxSetItems + 1 }, (_, i) => `l-${i}`);
    expect(violationsOf({ ...base, labels: tooMany }).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'labels' }),
    ]);
    const longest = 'a'.repeat(SCOPE_LIMITS.maxMemberLength);
    expect(violationsOf({ ...base, labels: [longest] }, { ...envelope, labels: [longest] }).ok).toBe(true);
    expect(violationsOf({ ...base, resources: [`${longest}b`] }, { ...envelope, resources: ['*'] }).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'resources' }),
    ]);
    expect(violationsOf(base, { ...envelope, resources: [`${longest}*`] }).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'resources' }),
    ]);
  });

  it('rejects everything against a malformed envelope, even an empty request', () => {
    expect(violationsOf(base, { ...envelope, resources: ['a*b'] }).ok).toBe(false);
    expect(violationsOf(base, { ...envelope, unknown: 1 }).ok).toBe(false);
  });

  it('rejects input that normalize cannot map or maps outside the grammar', () => {
    const github = defineScopeGrammar({
      provider: 'github-like',
      dimensions: {
        repositories: { kind: 'prefixGlobSet' },
        permissions: { kind: 'exactSet', values: ['contents:read', 'contents:write'] },
      },
      normalize: (input: { repositories: string[]; permissions: Record<string, string> }) => {
        if (!input.permissions) throw new Error('permissions are required');
        return {
          repositories: input.repositories,
          permissions: Object.entries(input.permissions).map(([name, level]) => `${name}:${level}`),
        };
      },
      riskOf: ({ value }) => (String(value).endsWith(':write') ? 'write' : 'read'),
    });
    const env = { repositories: ['org/*'], permissions: { contents: 'write' } };
    expect(github.isSubset({ repositories: ['org/app'], permissions: { contents: 'write' } }, env).ok).toBe(true);
    expect(github.classifyRisk({ repositories: ['org/app'], permissions: { contents: 'write' } })).toBe('write');
    expect(github.isSubset({ repositories: ['org/app'], permissions: { contents: 'admin' } }, env).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', item: 'contents:admin' }),
    ]);
    expect(github.isSubset({ repositories: ['org/app'] } as never, env).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', message: 'normalize failed: permissions are required' }),
    ]);
    expect(github.normalize({ repositories: ['org/a', 'org/a'], permissions: {} })).toEqual({
      ok: true,
      scope: { repositories: ['org/a'], permissions: [] },
    });
  });
});

describe('unreadable input', () => {

  const hostileScopes: Array<[string, () => unknown]> = [
    ['an array whose index descriptor trap throws', () => ({ ...base, labels: throwingArray('0') })],
    [
      'a Proxy whose ownKeys trap throws',
      () =>
        new Proxy(
          { ...base },
          {
            ownKeys() {
              throw new Error('ownKeys trap failed');
            },
          },
        ),
    ],
    [
      'a Proxy whose getPrototypeOf trap throws',
      () =>
        new Proxy(
          { ...base },
          {
            getPrototypeOf() {
              throw new Error('getPrototypeOf trap failed');
            },
          },
        ),
    ],
    ['a set whose length descriptor trap throws', () => ({ ...base, labels: throwingArray('length') })],
    [
      'a Proxy whose property descriptor trap throws',
      () =>
        new Proxy(
          { ...base },
          {
            getOwnPropertyDescriptor() {
              throw new Error('getOwnPropertyDescriptor trap failed');
            },
          },
        ),
    ],
  ];

  it.each(hostileScopes)('rejects %s as malformed on either side without throwing', (_label, make) => {
    expect(violationsOf(make() as never).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', message: expect.stringContaining('scope could not be read') }),
    ]);
    expect(violationsOf(base, make() as never).violations).toEqual([expect.objectContaining({ code: 'malformed', side: 'envelope' })]);
    expect(grammar.normalize(make() as never).ok).toBe(false);
    expect(() => grammar.classifyRisk(make() as never)).toThrow(ScopeError);
  });

  it('rejects a normalizer throw that cannot be formatted', () => {
    const errorWithThrowingMessage = new Error('hidden');
    Object.defineProperty(errorWithThrowingMessage, 'message', {
      get() {
        throw new Error('message getter failed');
      },
    });
    for (const thrown of [Object.create(null), errorWithThrowingMessage, { toString: () => { throw new Error('toString failed'); } }]) {
      const throwing = defineScopeGrammar({
        provider: 'throwing-normalize',
        dimensions: { names: { kind: 'exactSet' } },
        normalize: (): { names: string[] } => {
          throw thrown;
        },
        riskOf: () => 'read',
      });
      expect(throwing.isSubset({}, {}).violations).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'request', message: 'normalize failed: an unreadable value was thrown' }),
        expect.objectContaining({ code: 'malformed', side: 'envelope' }),
      ]);
      expect(throwing.normalize({}).ok).toBe(false);
      expect(() => throwing.classifyRisk({})).toThrow(ScopeError);
    }
  });
});

describe('snapshot reads', () => {
  /** A scope that lists `permissions` in ownKeys but has no descriptor for it. */
  function listedWithoutDescriptor(permissions: readonly string[]) {
    return new Proxy(
      { ...base, permissions },
      { getOwnPropertyDescriptor: (target, key) => (key === 'permissions' ? undefined : Reflect.getOwnPropertyDescriptor(target, key)) },
    );
  }

  it('rejects a listed key without an own data property instead of treating it as absent', () => {
    const request = listedWithoutDescriptor(['admin']);
    expect(request.permissions).toEqual(['admin']);
    expect(violationsOf(request).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'permissions' }),
    ]);
    expect(violationsOf(base, listedWithoutDescriptor(['contents:read'])).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'permissions' }),
    ]);
    expect(grammar.normalize(request).ok).toBe(false);
    expect(() => grammar.classifyRisk(request)).toThrow(ScopeError);
  });

  it('decides from the own length and elements, not from a Proxy get trap', () => {
    // `get` claims an empty array; the own data properties hold ['admin'].
    const hidden = new Proxy(['admin'], {
      get: (target, key, receiver) => (key === 'length' ? 0 : (Reflect.get(target, key, receiver) as unknown)),
    });
    expect(violationsOf({ ...base, permissions: hidden }).violations).toEqual([
      expect.objectContaining({ code: 'not_in_envelope', dimension: 'permissions', item: 'admin' }),
    ]);
    expect(grammar.classifyRisk({ ...base, permissions: hidden })).toBe('destructive');
  });

  it('rejects holes, inherited elements and accessor elements on either side', () => {
    const sparse = ['alpha'];
    sparse.length = 2;
    const inherited = ['alpha'];
    inherited.length = 2;
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype) as object, { 1: 'gamma' }));
    const accessor = ['alpha'];
    Object.defineProperty(accessor, 0, { enumerable: true, get: () => 'alpha' });
    for (const labels of [sparse, inherited, accessor]) {
      expect(violationsOf({ ...base, labels }).violations).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'labels', message: expect.stringContaining('own data property') }),
      ]);
      expect(violationsOf(base, { ...envelope, labels }).violations).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'labels' }),
      ]);
      expect(() => grammar.classifyRisk({ ...base, labels })).toThrow(ScopeError);
    }
  });

  it('returns the frozen snapshot it judged, which later reads of the input cannot change', () => {
    // Reads benign the first time and admin on every later read.
    let reads = 0;
    const stateful = new Proxy(
      { ...base },
      {
        getOwnPropertyDescriptor: (target, key) =>
          key === 'permissions'
            ? { value: reads++ === 0 ? ['contents:read'] : ['admin'], writable: true, enumerable: true, configurable: true }
            : Reflect.getOwnPropertyDescriptor(target, key),
      },
    );
    const result = grammar.isSubset(stateful as never, envelope);
    expect(result.ok).toBe(true);
    expect(Object.getOwnPropertyDescriptor(stateful, 'permissions')?.value).toEqual(['admin']);
    const scope = result.scope!;
    expect(scope.permissions).toEqual(['contents:read']);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.permissions)).toBe(true);
    expect(grammar.classifyScope(scope)).toBe('read');
    expect(grammar.classifyRisk(stateful as never)).toBe('destructive');
  });

  it('classifies only snapshots this grammar returned', () => {
    const normalized = grammar.normalize({ ...base, permissions: ['contents:write'] });
    expect(normalized.ok && grammar.classifyScope(normalized.scope)).toBe('write');
    const other = defineScopeGrammar({ provider: 'other', dimensions: grammar.dimensions, riskOf: () => 'read' });
    const foreign = other.normalize({ ...base, permissions: ['admin'] });
    expect(foreign.ok).toBe(true);
    for (const scope of [{ ...base, permissions: ['admin'] }, foreign.ok ? foreign.scope : undefined, null, 'scope']) {
      expect(() => grammar.classifyScope(scope as never)).toThrow(ScopeError);
    }
  });

  it('returns snapshots and dimensions with no inherited names', () => {
    const result = grammar.isSubset({ ...base, permissions: ['contents:read'] }, envelope);
    expect(result.ok).toBe(true);
    const normalized = grammar.normalize(base);
    for (const view of [result.scope, normalized.ok ? normalized.scope : undefined, grammar.dimensions]) {
      expect(view).toBeDefined();
      expect(Object.getPrototypeOf(view)).toBeNull();
      expect(Object.isFrozen(view)).toBe(true);
      const record = view as unknown as Record<string, unknown>;
      for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'missing']) expect(record[name]).toBeUndefined();
    }
    expect(Object.keys(grammar.dimensions)).toEqual(['permissions', 'labels', 'resources', 'rate', 'ttl']);
    expect(grammar.classifyScope(result.scope!)).toBe('read');
  });
});

describe('asynchronous callbacks', () => {
  /** Runs `body`, lets pending rejections surface, and returns every unhandled rejection Node reported. */
  async function unhandledRejectionsDuring(body: () => void): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', listener);
    try {
      body();
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', listener);
    }
    return seen;
  }

  it('rejects a promise from normalize without leaving an unhandled rejection', async () => {
    const failing = defineScopeGrammar({
      provider: 'async-normalize',
      dimensions: { names: { kind: 'exactSet' } },
      normalize: (async () => {
        throw new Error('async normalize failed');
      }) as never,
      riskOf: () => 'read',
    });
    const seen = await unhandledRejectionsDuring(() => {
      expect(failing.isSubset({}, {}).violations).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'request', message: expect.stringContaining('promise') }),
        expect.objectContaining({ code: 'malformed', side: 'envelope', message: expect.stringContaining('promise') }),
      ]);
      expect(failing.normalize({}).ok).toBe(false);
      expect(() => failing.classifyRisk({})).toThrow(ScopeError);
    });
    expect(seen).toEqual([]);
    const resolving = defineScopeGrammar({
      provider: 'async-normalize-ok',
      dimensions: { names: { kind: 'exactSet' } },
      normalize: (async () => ({ names: [] })) as never,
      riskOf: () => 'read',
    });
    expect(resolving.isSubset({}, {}).ok).toBe(false);
  });

  it('rejects a promise from riskOf with a ScopeError without leaving an unhandled rejection', async () => {
    const failing = defineScopeGrammar({
      provider: 'async-risk',
      dimensions: { names: { kind: 'exactSet' } },
      riskOf: (async () => {
        throw new Error('async riskOf failed');
      }) as never,
    });
    const seen = await unhandledRejectionsDuring(() => {
      expect(() => failing.classifyRisk({ names: ['a', 'b'] })).toThrow(ScopeError);
    });
    expect(seen).toEqual([]);
    const resolving = defineScopeGrammar({
      provider: 'async-risk-ok',
      dimensions: { names: { kind: 'exactSet' } },
      riskOf: (async () => 'read') as never,
    });
    expect(() => resolving.classifyRisk({ names: ['a'] })).toThrow(ScopeError);
  });

  it('attaches a rejection handler to a rejected null-prototype promise', async () => {
    const nullPrototypeRejection = (): Promise<never> => {
      const promise = Promise.reject(new Error('null-prototype rejection'));
      Object.setPrototypeOf(promise, null);
      return promise;
    };
    const seen = await unhandledRejectionsDuring(() => {
      const viaNormalize = defineScopeGrammar({
        provider: 'null-proto-normalize',
        dimensions: { names: { kind: 'exactSet' } },
        normalize: nullPrototypeRejection as never,
        riskOf: () => 'read',
      });
      expect(viaNormalize.isSubset({}, {}).violations).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'request', message: expect.stringContaining('promise') }),
        expect.objectContaining({ code: 'malformed', side: 'envelope', message: expect.stringContaining('promise') }),
      ]);
      const viaRisk = defineScopeGrammar({
        provider: 'null-proto-risk',
        dimensions: { names: { kind: 'exactSet' } },
        riskOf: nullPrototypeRejection as never,
      });
      expect(() => viaRisk.classifyRisk({ names: ['a'] })).toThrow(/promise/);
    });
    expect(seen).toEqual([]);
  });

  it('still rejects a rejected promise whose species or constructor lookup throws, leaving its rejection to the author', async () => {
    // Pins the documented boundary: `Promise.prototype.then` runs these lookups
    // before attaching a handler, so the engine cannot mark such a promise
    // handled. It still rejects the value synchronously; the test handles each
    // rejection itself once the lookups are disarmed.
    let armed = true;
    const lookups: string[] = [];
    class SpeciesThrowingPromise extends Promise<unknown> {
      static override get [Symbol.species](): PromiseConstructor {
        lookups.push('species');
        if (armed) throw new Error('species getter failed');
        return Promise;
      }
    }
    const constructorThrowing = (promise: Promise<unknown>): Promise<unknown> =>
      Object.defineProperty(promise, 'constructor', {
        get() {
          lookups.push('constructor');
          if (armed) throw new Error('constructor getter failed');
          return Promise;
        },
      });
    const created: Promise<unknown>[] = [];
    const factories: Array<() => Promise<unknown>> = [
      () => SpeciesThrowingPromise.reject(new Error('species rejection')),
      () => constructorThrowing(Promise.reject(new Error('constructor rejection'))),
    ];
    const seen = await unhandledRejectionsDuring(() => {
      for (const make of factories) {
        const produce = (): Promise<unknown> => {
          const promise = make();
          created.push(promise);
          return promise;
        };
        const viaNormalize = defineScopeGrammar({
          provider: 'throwing-lookup-normalize',
          dimensions: { names: { kind: 'exactSet' } },
          normalize: produce as never,
          riskOf: () => 'read',
        });
        expect(viaNormalize.isSubset({}, {}).violations).toEqual([
          expect.objectContaining({ code: 'malformed', side: 'request' }),
          expect.objectContaining({ code: 'malformed', side: 'envelope' }),
        ]);
        const viaRisk = defineScopeGrammar({
          provider: 'throwing-lookup-risk',
          dimensions: { names: { kind: 'exactSet' } },
          riskOf: produce as never,
        });
        expect(() => viaRisk.classifyRisk({ names: ['a'] })).toThrow(ScopeError);
      }
      expect(lookups).toEqual(expect.arrayContaining(['species', 'constructor']));
      armed = false;
      for (const promise of created) promise.catch(() => undefined);
    });
    expect(created).toHaveLength(6);
    expect(seen).toEqual([]);
  });

  it('rejects hostile thenables without throwing', () => {
    class HostilePromise extends Promise<unknown> {
      static override get [Symbol.species](): PromiseConstructor {
        throw new Error('species getter failed');
      }
    }
    const thenGetter = Object.defineProperty({}, 'then', {
      get() {
        throw new Error('then getter failed');
      },
    });
    for (const result of [HostilePromise.resolve({ names: [] }), thenGetter, { then: () => undefined }]) {
      const hostile = defineScopeGrammar({
        provider: 'hostile-thenable',
        dimensions: { names: { kind: 'exactSet' } },
        normalize: () => result as never,
        riskOf: () => result as never,
      });
      expect(hostile.isSubset({}, {}).violations).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'request' }),
        expect.objectContaining({ code: 'malformed', side: 'envelope' }),
      ]);
      const plain = defineScopeGrammar({ provider: 'hostile-risk', dimensions: { names: { kind: 'exactSet' } }, riskOf: () => result as never });
      expect(() => plain.classifyRisk({ names: ['a'] })).toThrow(ScopeError);
    }
  });

  it('rejects a plain-prototype promise as a scope even without normalize', async () => {
    const setOnly = defineScopeGrammar({ provider: 'set-only', dimensions: { names: { kind: 'exactSet' } }, riskOf: () => 'destructive' });
    const reparented = (proto: object | null, data?: Record<string, unknown>, rejected = false): Promise<unknown> => {
      const promise = rejected ? Promise.reject(new Error('reparented rejection')) : Promise.resolve({ names: [] });
      Object.setPrototypeOf(promise, proto);
      if (data) Object.assign(promise, data);
      return promise;
    };
    const benign = { names: ['a'] };
    const seen = await unhandledRejectionsDuring(() => {
      for (const proto of [null, Object.prototype]) {
        for (const data of [undefined, { names: ['a'] }]) {
          for (const rejected of [false, true]) {
            const make = () => reparented(proto, data, rejected) as never;
            expect(setOnly.isSubset(make(), benign).violations).toEqual([
              expect.objectContaining({ code: 'malformed', side: 'request', message: expect.stringContaining('promise') }),
            ]);
            expect(setOnly.isSubset(benign, make()).violations).toEqual([
              expect.objectContaining({ code: 'malformed', side: 'envelope', message: expect.stringContaining('promise') }),
            ]);
            expect(setOnly.normalize(make()).ok).toBe(false);
            expect(() => setOnly.classifyRisk(make())).toThrow(ScopeError);
          }
        }
      }
    });
    expect(seen).toEqual([]);
  });

  it('runs no caller code to recognise a promise and rejects one with an own constructor as an unknown dimension', () => {
    const setOnly = defineScopeGrammar({ provider: 'set-only-ctor', dimensions: { names: { kind: 'exactSet' } }, riskOf: () => 'read' });
    let lookups = 0;
    const species = Object.defineProperty(function Species() {}, Symbol.species, {
      get() {
        lookups++;
        throw new Error('species lookup ran');
      },
    });
    for (const ctor of [0, species, undefined]) {
      const promise = Promise.resolve();
      Object.setPrototypeOf(promise, null);
      Object.defineProperty(promise, 'constructor', { value: ctor, enumerable: false });
      Object.assign(promise, { names: ['a'] });
      expect(setOnly.isSubset(promise as never, { names: ['a'] }).violations).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'request', message: expect.stringContaining('"constructor"') }),
      ]);
      expect(() => setOnly.classifyRisk(promise as never)).toThrow(ScopeError);
    }
    expect(lookups).toBe(0);
    expect(() =>
      defineScopeGrammar({ provider: 'reserved', dimensions: { constructor: { kind: 'exactSet' } }, riskOf: () => 'read' }),
    ).toThrow(TypeError);
  });
});

describe('unreadable error messages', () => {
  /** An error whose `message` getter returns the given values in turn. */
  function shiftingError(...reads: unknown[]): Error {
    const error = new Error('placeholder');
    let read = 0;
    Object.defineProperty(error, 'message', { get: () => reads[Math.min(read++, reads.length - 1)] });
    return error;
  }

  const symbolMessage = Symbol('unreadable');
  const cases: Array<[string, () => Error, string]> = [
    ['a string, then a Symbol', () => shiftingError('test-error', symbolMessage), 'test-error'],
    ['a Symbol, then a string', () => shiftingError(symbolMessage, 'test-error'), 'an unreadable value was thrown'],
    ['an object whose toString throws', () => shiftingError({ toString: () => { throw new Error('toString failed'); } }), 'an unreadable value was thrown'],
  ];

  it.each(cases)('formats a normalizer error whose message reads as %s without throwing', (_label, make, text) => {
    const throwing = defineScopeGrammar({
      provider: 'shifting-normalize',
      dimensions: { names: { kind: 'exactSet' } },
      normalize: (): { names: string[] } => {
        throw make();
      },
      riskOf: () => 'read',
    });
    expect(throwing.isSubset({}, {}).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', message: `normalize failed: ${text}` }),
      expect.objectContaining({ code: 'malformed', side: 'envelope', message: `normalize failed: ${text}` }),
    ]);
    expect(throwing.normalize({}).ok).toBe(false);
    expect(() => throwing.classifyRisk({})).toThrow(ScopeError);
  });

  it.each(cases)('formats a scope-reading error whose message reads as %s without throwing', (_label, make, text) => {
    const hostile = () => ({ ...base, labels: throwingArray('0', make) });
    expect(violationsOf(hostile()).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', message: `scope could not be read: ${text}` }),
    ]);
    expect(violationsOf(base, hostile()).violations).toEqual([expect.objectContaining({ code: 'malformed', side: 'envelope' })]);
    expect(grammar.normalize(hostile()).ok).toBe(false);
    expect(() => grammar.classifyRisk(hostile())).toThrow(ScopeError);
  });

  it('shortens a very long error message', () => {
    const throwing = defineScopeGrammar({
      provider: 'long-error',
      dimensions: { names: { kind: 'exactSet' } },
      normalize: (): { names: string[] } => {
        throw new Error('x'.repeat(100_000));
      },
      riskOf: () => 'read',
    });
    const result = throwing.normalize({});
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.violations[0]!.message.length).toBeLessThan(300);
  });
});

describe('classifyRisk', () => {
  it('returns the maximum risk over all requested items', () => {
    expect(grammar.classifyRisk(base)).toBe('read');
    expect(grammar.classifyRisk({ ...base, permissions: ['contents:read'] })).toBe('read');
    expect(grammar.classifyRisk({ ...base, permissions: ['contents:read', 'contents:write'] })).toBe('write');
    expect(grammar.classifyRisk({ ...base, permissions: ['admin', 'contents:read'] })).toBe('destructive');
    expect(grammar.classifyRisk({ ...base, permissions: ['contents:read', 'contents:write', 'admin'] })).toBe('destructive');
  });

  it('asks riskOf about every set member and scalar', () => {
    const seen: unknown[] = [];
    const recording = defineScopeGrammar({
      provider: 'recording',
      dimensions: { names: { kind: 'exactSet' }, ttl: { kind: 'ttlMax' }, size: { kind: 'numericMax' } },
      riskOf: item => {
        seen.push([item.dimension, item.kind, item.value]);
        return item.dimension === 'size' && Number(item.value) > 10 ? 'write' : 'read';
      },
    });
    expect(recording.classifyRisk({ names: ['a', 'b'], ttl: 60, size: 11 })).toBe('write');
    expect(seen).toEqual([
      ['names', 'exactSet', 'a'],
      ['names', 'exactSet', 'b'],
      ['ttl', 'ttlMax', 60],
      ['size', 'numericMax', 11],
    ]);
  });

  it('throws for a malformed request instead of guessing a risk', () => {
    expect(() => grammar.classifyRisk({ ...base, resources: ['org/*/x'] })).toThrow(ScopeError);
    let caught: unknown;
    try {
      grammar.classifyRisk({ ...base, rate: -1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScopeError);
    expect((caught as ScopeError).violations).toEqual([expect.objectContaining({ code: 'malformed', dimension: 'rate' })]);
  });

  it('keeps its own risk order when the exported levels are tampered with', () => {
    expect(Object.isFrozen(SCOPE_RISK_LEVELS)).toBe(true);
    expect(() => {
      (SCOPE_RISK_LEVELS as unknown as string[])[2] = 'read';
    }).toThrow(TypeError);
    expect(grammar.classifyRisk({ ...base, permissions: ['admin'] })).toBe('destructive');
  });

  it('turns a throwing riskOf into a ScopeError', () => {
    const failure = new Error('riskOf exploded');
    const throwing = defineScopeGrammar({
      provider: 'throwing',
      dimensions: { names: { kind: 'exactSet' } },
      riskOf: () => {
        throw failure;
      },
    });
    expect(() => throwing.classifyRisk({ names: ['a'] })).toThrow(expect.objectContaining({ name: 'ScopeError', cause: failure }));
  });

  it('validates riskOf for every item, whatever the order, after the highest level', () => {
    const levels = defineScopeGrammar({
      provider: 'levels',
      dimensions: { names: { kind: 'exactSet' }, size: { kind: 'numericMax' } },
      riskOf: ({ value }) => {
        if (value === 'admin') return 'destructive';
        if (value === 'boom') throw new Error('riskOf failed for boom');
        if (value === 'bad') return 'admin' as never;
        return 'read';
      },
    });
    for (const names of [['admin', 'bad'], ['bad', 'admin'], ['admin', 'boom'], ['boom', 'admin']]) {
      expect(() => levels.classifyRisk({ names, size: 1 })).toThrow(ScopeError);
    }
    const laterScalar = defineScopeGrammar({
      provider: 'later-scalar',
      dimensions: { names: { kind: 'exactSet' }, size: { kind: 'numericMax' } },
      riskOf: ({ dimension }) => (dimension === 'names' ? 'destructive' : ('unknown' as never)),
    });
    expect(() => laterScalar.classifyRisk({ names: ['admin'], size: 1 })).toThrow(ScopeError);
    expect(levels.classifyRisk({ names: ['admin', 'x'], size: 1 })).toBe('destructive');
  });

  it('throws when riskOf returns a level outside the closed set', () => {
    const broken = defineScopeGrammar({
      provider: 'broken',
      dimensions: { names: { kind: 'exactSet' } },
      riskOf: () => 'admin' as never,
    });
    expect(() => broken.classifyRisk({ names: ['a'] })).toThrow(ScopeError);
    expect(broken.classifyRisk({ names: [] })).toBe('read');
  });
});

describe('performance', () => {
  // Every timed workload holds exactly 10k requested items, the acceptance bound.
  const n = 10_000;
  const half = n / 2;
  const big = defineScopeGrammar({
    provider: 'big',
    dimensions: { ids: { kind: 'exactSet' }, paths: { kind: 'prefixGlobSet' }, ttl: { kind: 'ttlMax' } },
    riskOf: ({ value }) => (String(value).startsWith('w') ? 'write' : 'read'),
  });
  const ids = Array.from({ length: half }, (_, i) => `id-${i}`);
  // 10k distinct envelope globs: a matcher that compares every request item
  // with every envelope pattern does 5 x 10^7 comparisons and cannot meet the bound.
  const envelopePaths = Array.from({ length: n }, (_, i) => `team-${i}/*`);
  const requestPaths = Array.from({ length: half - 1 }, (_, i) => (i % 2 ? `team-${n - 1 - 2 * i}/repo` : `team-${n - 1 - 2 * i}/sub*`));
  // 5k ids + 4,999 paths + 1 ttl = 10k items.
  const request = { ids, paths: requestPaths, ttl: 60 };
  const env = { ids: [...ids].reverse(), paths: envelopePaths, ttl: 60 };
  // 5k ids + 4,999 paths + 1 ttl = 10k items, every one outside the envelope below.
  const uncovered = { ids, paths: requestPaths, ttl: 61 };
  const writeLast = { ids: [...ids.slice(0, -1), 'w-last'], paths: requestPaths, ttl: 60 };

  /** Best of three timed runs after a warm-up, so scheduler noise from parallel suites does not decide the result. */
  function bestOfThree(run: () => void): number {
    run();
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  it('evaluates 10k requested items against 10k envelope globs in under 50 ms', () => {
    let result: ReturnType<typeof big.isSubset> | undefined;
    const elapsed = bestOfThree(() => {
      result = big.isSubset(request, env);
    });
    expect(result).toEqual({ ok: true, violations: [], scope: expect.objectContaining({ ttl: 60 }) });
    expect(elapsed).toBeLessThan(50);
  });

  it('reports 10k uncovered items in under 50 ms', () => {
    let result: ReturnType<typeof big.isSubset> | undefined;
    const elapsed = bestOfThree(() => {
      result = big.isSubset(uncovered, { ids: [], paths: ['other/*'], ttl: 60 });
    });
    expect(result?.violations).toHaveLength(n);
    expect(elapsed).toBeLessThan(50);
  });

  /**
   * 2^levels distinct strings that share one 32-bit FNV-1a hash. Each level
   * appends one of two two-character blocks that collide from the same state:
   * the first characters give equal high 16 bits, and the second characters
   * cancel the low 16 bits. This is the input shape that degrades a
   * hash-bucketed prefix index to E x R comparisons.
   */
  function fnvCollidingStrings(levels: number): string[] {
    const step = (hash: number, code: number) => Math.imul(hash ^ code, 0x01000193);
    const usable = (code: number) => code >= 0x100 && code <= 0xffff && (code < 0xd800 || code > 0xdfff);
    let strings = [''];
    let state = 0x811c9dc5 | 0;
    for (let level = 0; level < levels; level++) {
      const firstByHighBits = new Map<number, number>();
      let blocks: [string, string] | undefined;
      for (let a = 0x100; !blocks; a++) {
        const mid = step(state, a);
        const other = firstByHighBits.get(mid >>> 16);
        if (other === undefined) {
          firstByHighBits.set(mid >>> 16, a);
          continue;
        }
        const delta = (step(state, other) ^ mid) & 0xffff;
        for (let b = 0x100; b <= 0xffff; b++) {
          if (usable(b) && usable(b ^ delta)) {
            blocks = [String.fromCharCode(other, b ^ delta), String.fromCharCode(a, b)];
            state = step(mid, b);
            break;
          }
        }
      }
      const [left, right] = blocks;
      strings = strings.flatMap(prefix => [prefix + left, prefix + right]);
    }
    return strings;
  }

  it('stays within 50 ms for 10k envelope prefixes and 10k request items that share a hash', () => {
    const colliding = fnvCollidingStrings(15);
    const globs = defineScopeGrammar({ provider: 'globs', dimensions: { paths: { kind: 'prefixGlobSet' } }, riskOf: () => 'read' });
    const collidingEnvelope = { paths: colliding.slice(0, n).map(prefix => `${prefix}*`) };
    const collidingRequest = { paths: colliding.slice(n, 2 * n) };
    let result: ReturnType<typeof globs.isSubset> | undefined;
    const elapsed = bestOfThree(() => {
      result = globs.isSubset(collidingRequest, collidingEnvelope);
    });
    expect(result?.violations).toHaveLength(n);
    expect(globs.isSubset({ paths: [`${colliding[n - 1]}/repo`] }, collidingEnvelope).ok).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });

  it('keeps long envelope globs cheap: memory and time follow the item count, not a node per character', () => {
    // 1,000 envelope globs of the maximum member length (about 4M characters)
    // and 1,000 maximum-length literals under them. A per-character trie
    // allocates about 4M nodes here and takes seconds.
    const count = 1_000;
    const filler = 'x'.repeat(SCOPE_LIMITS.maxMemberLength - 5);
    const prefixes = Array.from({ length: count }, (_, i) => `${String(i).padStart(4, '0')}${filler}`);
    const globs = defineScopeGrammar({ provider: 'long-globs', dimensions: { paths: { kind: 'prefixGlobSet' } }, riskOf: () => 'read' });
    const longEnvelope = { paths: prefixes.map(prefix => `${prefix}*`) };
    const longRequest = { paths: prefixes.map(prefix => `${prefix}r`) };
    let result: ReturnType<typeof globs.isSubset> | undefined;
    const elapsed = bestOfThree(() => {
      result = globs.isSubset(longRequest, longEnvelope);
    });
    expect(result?.ok).toBe(true);
    expect(globs.isSubset({ paths: [`${prefixes[0]!.slice(0, -1)}y`] }, longEnvelope).ok).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });

  it('classifies 10k items in under 50 ms', () => {
    let risk: ScopeRisk | undefined;
    const elapsed = bestOfThree(() => {
      risk = big.classifyRisk(writeLast);
    });
    expect(risk).toBe('write');
    expect(elapsed).toBeLessThan(50);
  });
});
