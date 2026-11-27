import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** The error `run` throws; fails the test when it does not throw. Compares nothing, so a hostile cause is never read. */
function thrownBy(run: () => unknown): ScopeError {
  try {
    run();
  } catch (error) {
    return error as ScopeError;
  }
  throw new Error('expected a throw');
}

const riskOf = () => 'read' as const;

describe('defineScopeGrammar', () => {
  it('rejects any dimension kind outside the closed set', () => {
    for (const kind of ['regex', 'numericMin', 'suffixGlob', undefined]) {
      expect(() =>
        defineScopeGrammar({ provider: 'p', dimensions: { d: { kind } as never }, riskOf }),
      ).toThrow(TypeError);
    }
  });

  it('rejects invalid definitions instead of building a permissive grammar', () => {
    const bad: unknown[] = [
      null,
      { provider: '', dimensions: { d: { kind: 'prefixGlobSet' } }, riskOf },
      { provider: 'p', dimensions: {}, riskOf },
      { provider: 'p', dimensions: [], riskOf },
      { provider: 'p', dimensions: { d: { kind: 'prefixGlobSet' } } },
      { provider: 'p', dimensions: { d: { kind: 'prefixGlobSet' } }, riskOf, normalize: 'identity' },
      { provider: 'p', dimensions: { 'bad name': { kind: 'prefixGlobSet' } }, riskOf },
      { provider: 'p', dimensions: { __proto__x: { kind: 'prefixGlobSet' } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'exactSet', values: ['repo*'] } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'exactSet', values: 'repo' } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'numericMax', min: 5, max: 1 } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'numericMax', max: Number.NaN } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'numericMax', integer: 'yes' } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'ttlMax', maxSeconds: 1.5 } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'ttlMax', minSeconds: 0 } }, riskOf },
      { provider: 'p', dimensions: { d: { kind: 'ttlMax', minSeconds: 60, maxSeconds: 30 } }, riskOf },
    ];
    for (const definition of bad) expect(() => defineScopeGrammar(definition as never), JSON.stringify(definition)).toThrow(TypeError);
  });

  it('rejects options a dimension kind does not have instead of dropping them', () => {
    const bad: unknown[] = [
      // A mistyped cap must not leave the dimension unbounded.
      { kind: 'ttlMax', max: 60 },
      { kind: 'numericMax', maxSeconds: 60 },
      { kind: 'exactSet', value: ['a'] },
      { kind: 'prefixGlobSet', values: ['a'] },
    ];
    for (const d of bad) {
      expect(() => defineScopeGrammar({ provider: 'p', dimensions: { d } as never, riskOf })).toThrow(TypeError);
    }
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: { d: { kind: 'prefixGlobSet' } }, riskOf, normalise: (x: unknown) => x } as never),
    ).toThrow(TypeError);
  });

  it('rejects an undefined dimension entry but allows undefined optional fields', () => {
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
    expect(optional.dimensions).toEqual({ size: { kind: 'numericMax', max: 10 }, names: { kind: 'exactSet' } });
    expect(optional.normalize({ size: 11 }).ok).toBe(false);
    expect(optional.normalize({ size: 10 }).ok).toBe(true);
  });

  it('reads the dimensions once as their structured clone', () => {
    // Definitions are trusted, but they are still read once: a Proxy or a
    // function cannot be cloned, and a getter runs exactly once.
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: new Proxy({ ttl: { kind: 'ttlMax' as const } }, {}), riskOf }),
    ).toThrow(TypeError);
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: { ttl: { kind: 'ttlMax', maxSeconds: () => 60 } } as never, riskOf }),
    ).toThrow(TypeError);
    let reads = 0;
    const ttl = {
      kind: 'ttlMax' as const,
      get maxSeconds() {
        reads++;
        return reads === 1 ? 60 : 3600;
      },
    };
    const once = defineScopeGrammar({ provider: 'p', dimensions: { ttl }, riskOf });
    expect(reads).toBe(1);
    expect(once.dimensions.ttl).toEqual({ kind: 'ttlMax', maxSeconds: 60 });
    expect(once.normalize({ ttl: 61 }).ok).toBe(false);
  });

  it('rejects an exactSet vocabulary that is too large, sparse or not made of strings', () => {
    const sparse = ['contents:read'];
    sparse.length = 2;
    for (const values of [new Array(SCOPE_LIMITS.maxSetItems + 1), sparse, [1], [new String('a')]]) {
      expect(() => defineScopeGrammar({ provider: 'p', dimensions: { d: { kind: 'exactSet', values } as never }, riskOf })).toThrow(TypeError);
    }
  });

  it('rejects asynchronous callbacks when the grammar is defined', () => {
    const dimensions = { names: { kind: 'exactSet' as const } };
    const asyncRisk = async () => 'read' as const;
    const asyncNormalize = async (input: unknown) => input;
    async function* asyncGenerator() {
      yield 'read' as const;
    }
    for (const definition of [
      { provider: 'p', dimensions, riskOf: asyncRisk },
      { provider: 'p', dimensions, riskOf: asyncGenerator },
      { provider: 'p', dimensions, riskOf, normalize: asyncNormalize },
      { provider: 'p', dimensions, riskOf, normalize: asyncGenerator },
    ]) {
      expect(() => defineScopeGrammar(definition as never)).toThrow(/synchronous/);
    }
  });

  it('accepts any well-formed dimension name, constructor included', () => {
    const named = defineScopeGrammar({ provider: 'p', dimensions: { constructor: { kind: 'exactSet' }, toString: { kind: 'ttlMax' } }, riskOf });
    expect(named.isSubset({ constructor: ['a'], toString: 60 }, { constructor: ['a'], toString: 60 }).ok).toBe(true);
    expect(named.isSubset({ constructor: ['b'], toString: 60 }, { constructor: ['a'], toString: 60 }).ok).toBe(false);
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
    const owned = defineScopeGrammar({ provider: 'owned', dimensions: dimensions as never, riskOf });
    (dimensions.names as { kind: string }).kind = 'prefixGlobSet';
    dimensions.names.values.push('b*');
    dimensions.ttl.maxSeconds = 3600;
    expect(owned.isSubset({ names: ['b'], ttl: 60 } as never, { names: ['b*'], ttl: 60 } as never).ok).toBe(false);
    expect(owned.normalize({ names: [], ttl: 120 } as never).ok).toBe(false);
  });
});

describe('structuredClone resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('fails closed when the runtime has no structuredClone', async () => {
    vi.stubGlobal('structuredClone', undefined);
    vi.resetModules();
    const fresh = await import('../../src/scopes/grammar.js');
    expect(() => fresh.defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet' } }, riskOf })).toThrow(
      /structuredClone/,
    );
  });

  it('keeps the structuredClone it resolved at load when the global is replaced later', () => {
    const forged = vi.fn(() => ({ ...base, permissions: ['admin'] }));
    vi.stubGlobal('structuredClone', forged);
    expect(violationsOf({ ...base, permissions: ['contents:read'] }).scope?.permissions).toEqual(['contents:read']);
    expect(forged).not.toHaveBeenCalled();
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

  it('rejects scopes that are not plain objects, whatever they clone to', () => {
    const scopes: [string, unknown][] = [
      ['null', null],
      ['undefined', undefined],
      ['an array', []],
      ['a string', 'scope'],
      ['a number', 5],
      ['a Map', new Map(Object.entries(base))],
      ['a Set', new Set()],
      ['a Date', new Date(0)],
      ['an Error', Object.assign(new Error('scope'), base)],
      ['a boxed string', new String('scope')],
    ];
    for (const [label, scope] of scopes) {
      expect(violationsOf(scope as never).violations, label).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'request', message: 'scope must be a plain object' }),
      ]);
      expect(grammar.isSubset(base, scope as never).violations, label).toEqual([
        expect.objectContaining({ code: 'malformed', side: 'envelope' }),
      ]);
    }
  });

  it('rejects members and scalars that clone to objects', () => {
    expect(violationsOf({ ...base, labels: [new String('alpha')] }).violations).toEqual([
      expect.objectContaining({ code: 'malformed', dimension: 'labels' }),
    ]);
    expect(violationsOf({ ...base, rate: new Number(1) }).violations).toEqual([expect.objectContaining({ code: 'malformed', dimension: 'rate' })]);
    expect(violationsOf({ ...base, labels: new Set(['alpha']) }).violations).toEqual([
      expect.objectContaining({ code: 'malformed', dimension: 'labels' }),
    ]);
  });

  it('rejects sparse sets on either side instead of skipping holes', () => {
    const sparse = ['contents:read'];
    sparse.length = 2;
    expect(violationsOf({ ...base, permissions: sparse }).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'permissions', message: 'dimension "permissions" item 1 is missing' }),
    ]);
    expect(violationsOf(base, { ...envelope, permissions: sparse }).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'permissions' }),
    ]);
  });

  it('never fills a missing value from a polluted prototype', () => {
    const objectProto = Object.prototype as Record<string, unknown>;
    const arrayProto = Array.prototype as unknown as Record<number, unknown>;
    objectProto.rate = 1;
    arrayProto[1] = 'admin';
    try {
      const { rate: _rate, ...withoutRate } = base;
      expect(violationsOf(withoutRate).violations).toEqual([expect.objectContaining({ code: 'malformed', dimension: 'rate' })]);
      const holed = ['contents:read'];
      holed.length = 2;
      expect(violationsOf({ ...base, permissions: holed }).ok).toBe(false);
    } finally {
      delete objectProto.rate;
      delete arrayProto[1];
    }
  });

  it('never takes a dimension kind, option or callback from a polluted prototype at define time', () => {
    const objectProto = Object.prototype as Record<string, unknown>;
    const injected = () => ({});
    const pollution: Record<string, unknown> = { kind: 'prefixGlobSet', values: ['other'], max: -1, integer: true, normalize: injected };
    Object.assign(objectProto, pollution);
    let missingKind: unknown;
    let defined: ReturnType<typeof defineScopeGrammar> | undefined;
    try {
      missingKind = thrownBy(() => defineScopeGrammar({ provider: 'polluted', dimensions: { paths: {} } as never, riskOf }));
      defined = defineScopeGrammar({ provider: 'polluted', dimensions: { names: { kind: 'exactSet' }, rate: { kind: 'numericMax' } }, riskOf });
    } finally {
      for (const key of Object.keys(pollution)) delete objectProto[key];
    }
    expect(missingKind).toBeInstanceOf(TypeError);
    expect((missingKind as Error).message).toMatch(/unsupported kind undefined/);
    // No vocabulary, max, integer or normalize was taken from the prototype.
    const scope = { names: ['x'], rate: 1.5 };
    expect(defined!.isSubset(scope, { names: ['x'], rate: 2 })).toMatchObject({ ok: true, scope });
    expect(defined!.isSubset({ names: ['x'], rate: 3 }, { names: ['x'], rate: 2 }).violations).toEqual([
      expect.objectContaining({ code: 'exceeds_envelope', dimension: 'rate' }),
    ]);
  });

  it('keeps every result and never throws a native error when the prototype is polluted after define', () => {
    const vectors: [unknown, unknown][] = [
      [base, envelope],
      [{ ...base, permissions: ['contents:write'], resources: ['org/app-1'], rate: 100, ttl: 3600 }, envelope],
      [{ ...base, permissions: ['admin'], resources: ['org/x'], rate: 101, ttl: 3601 }, envelope],
      [{ ...base, permissions: ['nope'] }, envelope],
      [base, { ...envelope, rate: 'x' }],
    ];
    const run = () =>
      vectors.map(([request, env]) => {
        const risk = (() => {
          try {
            return grammar.classifyRisk(request as never);
          } catch (error) {
            return error instanceof ScopeError ? 'ScopeError' : error;
          }
        })();
        return { subset: grammar.isSubset(request as never, env as never), normalized: grammar.normalize(request as never), risk };
      });
    const expected = JSON.stringify(run());
    const objectProto = Object.prototype as Record<string, unknown>;
    const pollution: Record<string, unknown> = {
      vocabulary: {},
      min: 1e9,
      max: -1,
      integer: true,
      scope: new Map([['rate', 0]]),
      cause: 'polluted',
    };
    Object.assign(objectProto, pollution);
    let polluted: string;
    try {
      polluted = JSON.stringify(run());
    } finally {
      for (const key of Object.keys(pollution)) delete objectProto[key];
    }
    expect(polluted).toBe(expected);
    expect(expected).toContain('"ok":true');
  });

  it('rejects sets beyond the input limits on the cloned value, before validating any member', () => {
    const tooMany = Array.from({ length: SCOPE_LIMITS.maxSetItems + 1 }, (_, i) => `l-${i}`);
    expect(violationsOf({ ...base, labels: tooMany }).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'labels' }),
    ]);
    // A huge sparse array is rejected for its length, not walked hole by hole.
    const huge: string[] = [];
    huge.length = 5_000_000;
    expect(violationsOf(base, { ...envelope, labels: huge }).violations).toEqual([
      expect.objectContaining({ side: 'envelope', message: `dimension "labels" must have at most ${SCOPE_LIMITS.maxSetItems} items` }),
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
      expect.objectContaining({ code: 'malformed', side: 'request', message: 'normalize threw' }),
    ]);
    expect(github.normalize({ repositories: ['org/a', 'org/a'], permissions: {} })).toEqual({
      ok: true,
      scope: { repositories: ['org/a'], permissions: [] },
    });
  });
});

/** A Proxy that counts every trap call and answers benign first, `admin` afterwards. */
function statefulProxy<T extends object>(target: T, admin: T) {
  let calls = 0;
  const handler: ProxyHandler<T> = {};
  for (const trap of ['get', 'getOwnPropertyDescriptor', 'ownKeys', 'getPrototypeOf', 'has'] as const) {
    (handler as Record<string, unknown>)[trap] = (_target: T, ...rest: unknown[]) => {
      calls++;
      return (Reflect[trap] as (...args: unknown[]) => unknown)(calls === 1 ? target : admin, ...rest);
    };
  }
  return { proxy: new Proxy(target, handler), calls: () => calls };
}

describe('untrusted input is read once, as a structured clone (I1)', () => {
  const cloneFailure = (side: string) => expect.objectContaining({ code: 'malformed', side, message: 'scope must be plain data that structuredClone can copy' });

  it('rejects a stateful Proxy scope or set on the right side without calling a trap', () => {
    const scope = statefulProxy({ ...base }, { ...base, permissions: ['admin'] });
    const set = statefulProxy(['contents:read'], ['admin']);
    expect(violationsOf(scope.proxy).violations).toEqual([cloneFailure('request')]);
    expect(violationsOf(base, scope.proxy).violations).toEqual([expect.objectContaining({ side: 'envelope', code: 'malformed' })]);
    expect(violationsOf({ ...base, permissions: set.proxy }).violations).toEqual([expect.objectContaining({ side: 'request', code: 'malformed' })]);
    expect(() => grammar.classifyRisk(scope.proxy)).toThrow(expect.objectContaining({ name: 'ScopeError', cause: expect.objectContaining({ name: 'DataCloneError' }) }));
    expect(grammar.normalize(set.proxy as never).ok).toBe(false);
    expect(scope.calls()).toBe(0);
    expect(set.calls()).toBe(0);
  });

  it('rejects a prototype-flipping or revoked Proxy and never answers ok', () => {
    let flips = 0;
    const flipping = new Proxy({ ...base }, { getPrototypeOf: () => (flips++ % 2 ? Array.prototype : Object.prototype) });
    const { proxy: revoked, revoke } = Proxy.revocable({ ...base }, {});
    revoke();
    for (const scope of [flipping, revoked]) {
      expect(violationsOf(scope).violations).toEqual([cloneFailure('request')]);
      expect(() => grammar.classifyRisk(scope)).toThrow(ScopeError);
    }
    expect(flips).toBe(0);
  });

  it('runs a stateful getter exactly once and decides and returns from that one read', () => {
    let reads = 0;
    const request = {
      ...base,
      get permissions() {
        reads++;
        return reads === 1 ? ['contents:read'] : ['admin'];
      },
    };
    const result = violationsOf(request);
    expect(reads).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.scope?.permissions).toEqual(['contents:read']);
    expect(grammar.classifyScope(result.scope!)).toBe('read');
    // The raw object now answers admin; the snapshot does not change.
    expect(request.permissions).toEqual(['admin']);
    expect(result.scope?.permissions).toEqual(['contents:read']);
  });

  it('turns a throwing getter into a fixed message without reading the thrown value', () => {
    let messageReads = 0;
    const hostile = new Error('hidden');
    Object.defineProperty(hostile, 'message', {
      get() {
        messageReads++;
        return Symbol('not a string');
      },
    });
    for (const thrown of [hostile, Symbol('thrown'), new Proxy({}, { get: () => { messageReads++; return 'x'; } })]) {
      const request = Object.defineProperty({ ...base }, 'labels', {
        enumerable: true,
        get() {
          throw thrown;
        },
      });
      expect(violationsOf(request).violations).toEqual([cloneFailure('request')]);
      expect(grammar.normalize(request).ok).toBe(false);
      const error = thrownBy(() => grammar.classifyRisk(request));
      expect(error).toBeInstanceOf(ScopeError);
      expect(error.cause).toBe(thrown);
    }
    expect(messageReads).toBe(0);
  });

  it('rejects every kind of promise as a scope on either side, with or without normalize', () => {
    const native = Promise.resolve(base);
    const nullPrototype = Object.setPrototypeOf(Promise.resolve(base), null) as object;
    const dataCarrying = Object.assign(Object.setPrototypeOf(Promise.resolve(base), Object.prototype) as object, { names: ['a'] });
    const rejected = Promise.reject(new Error('caller rejection'));
    rejected.catch(() => undefined);
    const plain = defineScopeGrammar({ provider: 'set-only', dimensions: { names: { kind: 'exactSet' } }, riskOf });
    const defaulting = vi.fn((input: { names?: string[] } | null) => ({ names: input?.names ?? [] }));
    const normalized = defineScopeGrammar({ provider: 'defaulting', dimensions: { names: { kind: 'exactSet' } }, normalize: defaulting, riskOf });
    for (const g of [plain, normalized]) {
      for (const promise of [native, nullPrototype, dataCarrying, rejected]) {
        defaulting.mockClear();
        expect(g.normalize(promise as never).ok).toBe(false);
        expect(() => g.classifyRisk(promise as never)).toThrow(ScopeError);
        // normalize never sees a promise: it runs only for the other, plain side.
        expect(defaulting).not.toHaveBeenCalled();
        expect(g.isSubset(promise as never, { names: ['a'] }).violations).toEqual([cloneFailure('request')]);
        expect(g.isSubset({ names: [] }, promise as never).violations).toEqual([cloneFailure('envelope')]);
        expect(defaulting.mock.calls.length).toBe(g === normalized ? 2 : 0);
      }
    }
  });

  it('drops non-enumerable and symbol keys, which can only narrow a request', () => {
    const request = { ...base, [Symbol('permissions')]: ['admin'] };
    Object.defineProperty(request, 'labels', { value: ['gamma'], enumerable: false });
    const result = violationsOf(request);
    expect(result.ok).toBe(true);
    expect(result.scope?.labels).toEqual([]);
    // A hidden scalar is missing, so the request is malformed rather than unbounded.
    const hiddenTtl = Object.defineProperty({ ...base }, 'ttl', { value: 900, enumerable: false });
    expect(violationsOf(hiddenTtl).violations).toEqual([expect.objectContaining({ code: 'malformed', dimension: 'ttl' })]);
  });

  it('judges a class instance or null-prototype object by its own data', () => {
    const nullPrototype = Object.assign(Object.create(null) as object, base);
    const instance = Object.assign(new (class Scope {})(), base);
    expect(violationsOf(nullPrototype).ok).toBe(true);
    expect(violationsOf(instance as never).ok).toBe(true);
  });
});

describe('the returned snapshot (I4)', () => {
  it('returns the frozen snapshot it judged, which later changes to the input cannot reach', () => {
    const request = { ...base, permissions: ['contents:read'] };
    const result = violationsOf(request);
    request.permissions.push('admin');
    expect(result.scope?.permissions).toEqual(['contents:read']);
    expect(Object.isFrozen(result.scope)).toBe(true);
    expect(Object.isFrozen(result.scope?.permissions)).toBe(true);
    expect(grammar.classifyScope(result.scope!)).toBe('read');
  });

  it('classifies only snapshots this grammar returned', () => {
    const scope = violationsOf(base).scope!;
    const other = defineScopeGrammar({ provider: 'other', dimensions: grammar.dimensions as never, riskOf });
    expect(() => grammar.classifyScope({ ...scope })).toThrow(ScopeError);
    expect(() => other.classifyScope(scope as never)).toThrow(ScopeError);
    expect(() => grammar.classifyScope(null as never)).toThrow(ScopeError);
    const normalized = grammar.normalize(base);
    expect(normalized.ok && grammar.classifyScope(normalized.scope)).toBe('read');
  });

  it('returns snapshots and dimensions with no inherited names', () => {
    const scope = violationsOf(base).scope! as Record<string, unknown>;
    const normalized = grammar.normalize(base);
    const dimensions = grammar.dimensions as Record<string, unknown>;
    for (const target of [scope, normalized.ok ? (normalized.scope as Record<string, unknown>) : {}, dimensions]) {
      expect(Object.getPrototypeOf(target)).toBeNull();
      expect(Object.isFrozen(target)).toBe(true);
      for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'missing']) expect(target[name]).toBeUndefined();
    }
  });

  it('accepts its own snapshot back as input', () => {
    const scope = violationsOf(base).scope!;
    expect(grammar.isSubset(scope, envelope).ok).toBe(true);
  });
});

describe('normalize works on engine-owned copies (I2)', () => {
  const dimensions = { names: { kind: 'exactSet' as const } };

  it('receives a clone of the input, never the caller object', () => {
    const input = { names: ['a'] };
    let seen: unknown;
    const g = defineScopeGrammar({
      provider: 'clone-in',
      dimensions,
      normalize: (value: { names: string[] }) => {
        seen = value;
        value.names.push('b');
        return value;
      },
      riskOf,
    });
    expect(g.normalize(input)).toEqual({ ok: true, scope: { names: ['a', 'b'] } });
    expect(seen).not.toBe(input);
    expect(input.names).toEqual(['a']);
  });

  it('clones its result before validation', () => {
    let reads = 0;
    const withGetter = defineScopeGrammar({
      provider: 'getter-out',
      dimensions,
      normalize: () => ({
        get names() {
          reads++;
          return reads === 1 ? ['a'] : ['admin'];
        },
      }),
      riskOf,
    });
    const result = withGetter.normalize({ names: [] });
    expect(result).toEqual({ ok: true, scope: { names: ['a'] } });
    expect(reads).toBe(1);

    const outputFailure = (side: string) =>
      expect.objectContaining({ code: 'malformed', side, message: 'normalize must return plain data that structuredClone can copy' });
    for (const output of [new Proxy({ names: ['a'] }, {}), { names: ['a'], extra: () => 'x' }]) {
      const g = defineScopeGrammar({ provider: 'bad-out', dimensions, normalize: () => output as never, riskOf });
      expect(g.isSubset({ names: [] }, { names: [] }).violations).toEqual([
        outputFailure('request'),
        outputFailure('envelope'),
      ]);
    }
  });

  it('reports a normalize throw with a fixed message and keeps it as the classifyRisk cause', () => {
    const thrown = new Proxy({}, { get: () => { throw new Error('trap ran'); } });
    const g = defineScopeGrammar({
      provider: 'throws',
      dimensions,
      normalize: () => {
        throw thrown;
      },
      riskOf,
    });
    expect(g.isSubset({ names: [] }, { names: [] }).violations.map(v => [v.side, v.message])).toEqual([
      ['request', 'normalize threw'],
      ['envelope', 'normalize threw'],
    ]);
    const error = thrownBy(() => g.classifyRisk({ names: [] }));
    expect(error).toBeInstanceOf(ScopeError);
    expect(error.cause).toBe(thrown);
  });
});

describe('callbacks are synchronous and the engine never touches a promise (I5)', () => {
  it('fails closed at once when a plain function returns a promise', async () => {
    const pending: Promise<unknown>[] = [];
    const keep = <T>(promise: Promise<T>): Promise<T> => {
      // The rejection is the grammar author's to handle; this test handles it.
      pending.push(promise.catch(() => undefined));
      return promise;
    };
    const normalizeResults = [() => keep(Promise.resolve({ names: ['a'] })), () => keep(Promise.reject(new Error('normalize rejected')))];
    for (const result of normalizeResults) {
      const g = defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet' } }, normalize: result as never, riskOf });
      expect(g.isSubset({ names: [] }, { names: [] }).violations).toEqual([
        expect.objectContaining({ side: 'request', code: 'malformed' }),
        expect.objectContaining({ side: 'envelope', code: 'malformed' }),
      ]);
      expect(g.normalize({ names: [] }).ok).toBe(false);
    }
    for (const result of [() => keep(Promise.resolve('read')), () => keep(Promise.reject(new Error('riskOf rejected')))]) {
      const g = defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet' } }, riskOf: result as never });
      expect(() => g.classifyRisk({ names: ['a'] })).toThrow(/unknown risk/);
    }
    await Promise.all(pending);
  });

  it('has no promise handling in the engine source', () => {
    const dir = fileURLToPath(new URL('../../src/scopes/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}${file}`, 'utf8');
      expect(source, file).not.toMatch(/\bawait\b|\.then\b|\bPromise\b/);
    }
  });
});

describe('radix trie insertion order', () => {
  const globs = defineScopeGrammar({ provider: 'trie', dimensions: { paths: { kind: 'prefixGlobSet' } }, riskOf });
  /** The definition of coverage, checked item by item against every envelope pattern. */
  const naive = (item: string, env: readonly string[]) =>
    env.some(pattern => {
      if (!pattern.endsWith('*')) return pattern === item;
      const prefix = pattern.slice(0, -1);
      return item.startsWith(prefix) && (!item.endsWith('*') || item.length - 1 >= prefix.length);
    });
  const uncovered = (request: string[], env: string[]) => globs.isSubset({ paths: request }, { paths: env }).violations.map(v => v.item);

  it('lets a shorter covering glob added after a longer one cover its whole subtree', () => {
    expect(uncovered(['abz', 'abcd', 'ab*', 'a*', 'b'], ['abcd*', 'abc*', 'ab*'])).toEqual(['a*', 'b']);
    expect(uncovered(['az', 'abz', 'a*'], ['abc*', 'abd*', 'a*'])).toEqual([]);
  });

  it('keeps a terminal when a duplicate or a longer glob is added after it', () => {
    expect(uncovered(['ab', 'abx', 'abcdz', 'ab*'], ['ab*', 'ab*', 'abcd*', 'abcde*'])).toEqual([]);
    expect(uncovered(['a', 'a*'], ['ab*', 'ab*'])).toEqual(['a', 'a*']);
  });

  it('agrees with the naive definition on random envelopes in any insertion order', () => {
    let seed = 7;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    const word = () => Array.from({ length: next() % 4 }, () => 'ab'[next() % 2]).join('');
    for (let round = 0; round < 300; round++) {
      const env = Array.from({ length: 1 + (next() % 6) }, () => (next() % 3 ? `${word()}*` : word() || 'a'));
      const request = [...new Set(Array.from({ length: 8 }, () => (next() % 2 ? `${word()}*` : word() || 'b')))];
      const expected = request.filter(item => !naive(item, env));
      for (const order of [env, [...env].reverse(), [...env].sort(), [...env].sort().reverse()]) {
        expect(uncovered(request, order), JSON.stringify({ request, order })).toEqual(expected);
      }
    }
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
