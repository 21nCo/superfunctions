import { describe, expect, it } from 'vitest';
import { defineScopeGrammar, ScopeError, type ScopeRisk } from '../../src/scopes/index.js';

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

  it('exposes a frozen grammar', () => {
    expect(Object.isFrozen(grammar)).toBe(true);
    expect(Object.isFrozen(grammar.dimensions)).toBe(true);
    expect(grammar.dimensions.ttl.kind).toBe('ttlMax');
  });
});

describe('exactSet dimension', () => {
  it('accepts a subset', () => {
    expect(violationsOf({ ...base, permissions: ['contents:read'] })).toEqual({ ok: true, violations: [] });
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
    try {
      grammar.classifyRisk({ ...base, rate: -1 });
    } catch (error) {
      expect((error as ScopeError).violations).toEqual([expect.objectContaining({ code: 'malformed', dimension: 'rate' })]);
    }
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
  const n = 10_000;
  const big = defineScopeGrammar({
    provider: 'big',
    dimensions: { ids: { kind: 'exactSet' }, paths: { kind: 'prefixGlobSet' }, ttl: { kind: 'ttlMax' } },
    riskOf: ({ value }) => (String(value).startsWith('w') ? 'write' : 'read'),
  });
  const ids = Array.from({ length: n }, (_, i) => `id-${i}`);
  // 10k distinct envelope globs: a matcher that compares every request item
  // with every envelope pattern does 10^8 comparisons and cannot meet the bound.
  const envelopePaths = Array.from({ length: n }, (_, i) => `team-${i}/*`);
  const requestPaths = Array.from({ length: n }, (_, i) => (i % 2 ? `team-${n - 1 - i}/repo` : `team-${n - 1 - i}/sub*`));
  const request = { ids, paths: requestPaths, ttl: 60 };
  const env = { ids: [...ids].reverse(), paths: envelopePaths, ttl: 60 };

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

  it('evaluates 10k items per dimension in under 50 ms', () => {
    let result: ReturnType<typeof big.isSubset> | undefined;
    const elapsed = bestOfThree(() => {
      result = big.isSubset(request, env);
    });
    expect(result).toEqual({ ok: true, violations: [] });
    expect(elapsed).toBeLessThan(50);
  });

  it('reports 10k uncovered items in under 50 ms', () => {
    let result: ReturnType<typeof big.isSubset> | undefined;
    const elapsed = bestOfThree(() => {
      result = big.isSubset(request, { ids: [], paths: ['other/*'], ttl: 60 });
    });
    expect(result?.violations).toHaveLength(2 * n);
    expect(elapsed).toBeLessThan(50);
  });

  it('classifies 10k items in under 50 ms', () => {
    let risk: ScopeRisk | undefined;
    const elapsed = bestOfThree(() => {
      risk = big.classifyRisk({ ids: [...ids, 'w-last'], paths: requestPaths, ttl: 60 });
    });
    expect(risk).toBe('write');
    expect(elapsed).toBeLessThan(50);
  });
});
