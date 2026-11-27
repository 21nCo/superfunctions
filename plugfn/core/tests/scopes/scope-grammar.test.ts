import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineScopeGrammar, SCOPE_LIMITS, SCOPE_RISK_LEVELS, ScopeError, type AnyScopeGrammar, type ScopeRisk } from '../../src/scopes/index.js';

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
const NOT_PLAIN_DATA = 'scope must be plain data (objects, arrays, strings, finite numbers, booleans, null) without cycles or shared references';
const dimensionNotPlain = (name: string) => `dimension "${name}" must be plain data (arrays, strings, finite numbers) without shared references`;

describe('defineScopeGrammar', () => {
  it('rejects any dimension kind outside the closed set', () => {
    for (const kind of ['regex', 'numericMin', 'suffixGlob', undefined]) {
      expect(() =>
        defineScopeGrammar({ provider: 'p', dimensions: { d: { kind } as never }, riskOf }),
      ).toThrow(TypeError);
    }
  });

  it('throws when the definition holds a non-enumerable or symbol-keyed property', () => {
    const hidden = <T extends object>(target: T, key: PropertyKey, value: unknown): T =>
      Object.defineProperty(target, key, { value, enumerable: false });
    const definitions: [string, unknown][] = [
      ['a non-enumerable maxSeconds', { ttl: hidden({ kind: 'ttlMax' }, 'maxSeconds', 30) }],
      ['a non-enumerable max', { rate: hidden({ kind: 'numericMax' }, 'max', 10) }],
      ['non-enumerable values', { names: hidden({ kind: 'exactSet' }, 'values', ['a']) }],
      ['a non-enumerable kind', { names: hidden({}, 'kind', 'exactSet') }],
      ['a non-enumerable dimension', hidden({ names: { kind: 'exactSet' } }, 'ttl', { kind: 'ttlMax', maxSeconds: 30 })],
      ['a symbol-keyed option', { ttl: { kind: 'ttlMax', maxSeconds: 30, [Symbol('minSeconds')]: 10 } }],
      ['a symbol-keyed dimension', { names: { kind: 'exactSet' }, [Symbol('ttl')]: { kind: 'ttlMax' } }],
    ];
    for (const [label, dimensions] of definitions) {
      const error = thrownBy(() => defineScopeGrammar({ provider: 'p', dimensions: dimensions as never, riskOf }));
      expect(error, label).toBeInstanceOf(TypeError);
      expect(error.message, label).toMatch(/must be plain data/);
    }
    const definition = { provider: 'p', dimensions: { names: { kind: 'exactSet' as const } }, riskOf };
    expect(() => defineScopeGrammar(hidden({ ...definition }, 'normalize', (x: unknown) => x) as never)).toThrow(TypeError);
    expect(() => defineScopeGrammar({ ...definition, [Symbol('normalize')]: (x: unknown) => x } as never)).toThrow(TypeError);
    // The same bounds written as ordinary properties are enforced.
    const capped = defineScopeGrammar({ provider: 'p', dimensions: { ttl: { kind: 'ttlMax', maxSeconds: 30 } }, riskOf });
    expect(capped.isSubset({ ttl: 120 }, { ttl: 120 }).ok).toBe(false);
    expect(capped.dimensions.ttl).toEqual({ kind: 'ttlMax', maxSeconds: 30 });
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

  it('reads the definition once as plain data and never runs a definition getter', () => {
    // A transparent Proxy is read once as the data it reports; a function option still throws.
    const proxied = defineScopeGrammar({ provider: 'p', dimensions: new Proxy({ ttl: { kind: 'ttlMax' as const, maxSeconds: 60 } }, {}), riskOf });
    expect(proxied.dimensions.ttl).toEqual({ kind: 'ttlMax', maxSeconds: 60 });
    expect(proxied.isSubset({ ttl: 120 }, { ttl: 120 }).ok).toBe(false);
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: { ttl: { kind: 'ttlMax', maxSeconds: () => 60 } } as never, riskOf }),
    ).toThrow(TypeError);
    // A getter is rejected from its descriptor, without running it.
    let reads = 0;
    const ttl = {
      kind: 'ttlMax' as const,
      get maxSeconds() {
        reads++;
        return reads === 1 ? 60 : 3600;
      },
    };
    expect(thrownBy(() => defineScopeGrammar({ provider: 'p', dimensions: { ttl }, riskOf })).message).toMatch(/must be plain data/);
    expect(reads).toBe(0);
  });

  it('enforces exactly the definition it was given: inherited options and accessors throw instead of being dropped', () => {
    class TtlWithGetter {
      readonly kind = 'ttlMax';
      get maxSeconds() {
        return 60;
      }
    }
    class TtlWithField {
      readonly kind = 'ttlMax';
      readonly maxSeconds = 60;
    }
    class Dimensions {
      readonly ttl = { kind: 'ttlMax', maxSeconds: 60 };
    }
    const accessor = <T extends object>(target: T, key: string, value: unknown): T =>
      Object.defineProperty(target, key, { get: () => value, enumerable: true });
    const inherit = (proto: object, own: object) => Object.assign(Object.create(proto) as object, own);
    const ttlEntry = { kind: 'ttlMax', maxSeconds: 60 };
    const dimensionCases: [string, unknown][] = [
      ['a class instance entry with a getter option', { ttl: new TtlWithGetter() }],
      ['a class instance entry with own fields', { ttl: new TtlWithField() }],
      ['an inherited maxSeconds', { ttl: inherit({ maxSeconds: 60 }, { kind: 'ttlMax' }) }],
      ['an inherited max', { rate: inherit({ max: 10 }, { kind: 'numericMax' }) }],
      ['an inherited integer', { rate: inherit({ integer: true }, { kind: 'numericMax' }) }],
      ['inherited values', { names: inherit({ values: ['a'] }, { kind: 'exactSet' }) }],
      ['an inherited kind', { names: inherit({ kind: 'exactSet' }, {}) }],
      ['a class instance as the dimensions object', new Dimensions()],
      ['an accessor-backed dimension entry', accessor({ names: { kind: 'exactSet' } }, 'ttl', ttlEntry)],
      ['an accessor-backed option', { ttl: accessor({ kind: 'ttlMax' }, 'maxSeconds', 60) }],
      ['a values array with an accessor member', { names: { kind: 'exactSet', values: accessor(['a'], '1', 'b') } }],
    ];
    for (const [label, dimensions] of dimensionCases) {
      const error = thrownBy(() => defineScopeGrammar({ provider: 'p', dimensions: dimensions as never, riskOf }));
      expect(error, label).toBeInstanceOf(TypeError);
      expect(error.message, label).toMatch(/must be plain data/);
    }
    const definition = { provider: 'p', dimensions: { ttl: ttlEntry }, riskOf } as Record<string, unknown>;
    const definitionCases: [string, unknown][] = [
      ...['provider', 'dimensions', 'normalize', 'riskOf'].map((key): [string, unknown] => {
        const value = key === 'normalize' ? (input: unknown) => input : definition[key];
        const { [key]: _omitted, ...rest } = definition;
        return [`an accessor ${key}`, accessor(rest, key, value)];
      }),
      ['a class instance definition', Object.assign(new (class Definition {})(), definition)],
      ['an inherited definition field', inherit({ riskOf }, { provider: 'p', dimensions: { ttl: ttlEntry } })],
    ];
    for (const [label, candidate] of definitionCases) {
      expect(() => defineScopeGrammar(candidate as never), label).toThrow(TypeError);
    }
    // Null-prototype objects holding data properties are plain data, and their bounds are enforced.
    const bare = <T extends object>(fields: T): T => Object.assign(Object.create(null) as T, fields);
    const nullProto = defineScopeGrammar(
      bare({
        provider: 'p',
        dimensions: bare({ ttl: bare({ kind: 'ttlMax' as const, maxSeconds: 60 }), names: bare({ kind: 'exactSet' as const, values: ['a'] }) }),
        riskOf,
      }),
    );
    expect(nullProto.dimensions).toEqual({ ttl: { kind: 'ttlMax', maxSeconds: 60 }, names: { kind: 'exactSet', values: ['a'] } });
    expect(nullProto.isSubset({ ttl: 86_400, names: ['a'] }, { ttl: 86_400, names: ['a'] }).ok).toBe(false);
    expect(nullProto.isSubset({ ttl: 60, names: ['b'] }, { ttl: 60, names: ['a', 'b'] }).ok).toBe(false);
    expect(nullProto.isSubset({ ttl: 60, names: ['a'] }, { ttl: 60, names: ['a'] }).ok).toBe(true);
  });

  it('compiles only its own copy of the dimensions, so a trap that changes the author objects mid-read cannot drop a checked bound', () => {
    // A sibling Proxy entry, read before ttl, hides the ttl cap and swaps itself out.
    const ttl = { kind: 'ttlMax' as const, maxSeconds: 30 };
    const dims: Record<string, unknown> = {};
    let swapped = false;
    dims.p = new Proxy(
      { kind: 'prefixGlobSet' },
      {
        ownKeys(target) {
          if (!swapped) {
            swapped = true;
            Object.defineProperty(ttl, 'maxSeconds', { enumerable: false });
            dims.p = { kind: 'prefixGlobSet' };
          }
          return Reflect.ownKeys(target);
        },
      },
    );
    dims.ttl = ttl;
    const outcome = (() => {
      try {
        return defineScopeGrammar({ provider: 'p', dimensions: dims as never, riskOf });
      } catch (error) {
        return error;
      }
    })();
    if (outcome instanceof Error) {
      expect(outcome).toBeInstanceOf(TypeError);
    } else {
      const defined = outcome as AnyScopeGrammar;
      expect(defined.dimensions.ttl).toEqual({ kind: 'ttlMax', maxSeconds: 30 });
      expect(defined.isSubset({ ttl: 86_400 }, { ttl: 86_400 }).ok).toBe(false);
    }

    // A dimensions Proxy whose trap changes a sibling while it is read, and
    // changes to the author objects after define: the grammar enforces exactly
    // what it publishes, and nothing after the read reaches it.
    const rate = { kind: 'numericMax' as const, max: 10 };
    const names = { kind: 'exactSet' as const, values: ['a'] };
    const dimensions = new Proxy(
      { rate, names },
      {
        ownKeys(target) {
          rate.max = 20;
          return Reflect.ownKeys(target);
        },
      },
    );
    const defined = defineScopeGrammar({ provider: 'p', dimensions, riskOf });
    rate.max = 1_000_000;
    names.values.push('b');
    Object.defineProperty(rate, 'max', { enumerable: false });
    expect(defined.dimensions).toEqual({ rate: { kind: 'numericMax', max: 20 }, names: { kind: 'exactSet', values: ['a'] } });
    expect(defined.isSubset({ rate: 20, names: ['a'] }, { rate: 20, names: ['a'] }).ok).toBe(true);
    expect(defined.isSubset({ rate: 21, names: ['a'] }, { rate: 21, names: ['a'] }).ok).toBe(false);
    expect(defined.isSubset({ rate: 1, names: ['b'] }, { rate: 1, names: ['a', 'b'] }).ok).toBe(false);
  });

  it('never lets a polluted descriptor default make an accessor look like data', () => {
    const objectProto = Object.prototype as Record<string, unknown>;
    let reads = 0;
    const getter = (value: unknown) => ({
      enumerable: true,
      get: () => {
        reads++;
        return value;
      },
    });
    const accessorOption = Object.defineProperty({ kind: 'ttlMax' }, 'maxSeconds', getter(30));
    const accessorEntry = Object.defineProperty({}, 'ttl', getter({ kind: 'ttlMax', maxSeconds: 30 }));
    const accessorField = Object.defineProperty({ provider: 'p', riskOf }, 'dimensions', getter({ ttl: { kind: 'ttlMax' } }));
    const cases: [string, unknown][] = [
      ['an accessor option', { provider: 'p', dimensions: { ttl: accessorOption }, riskOf }],
      ['an accessor entry', { provider: 'p', dimensions: accessorEntry, riskOf }],
      ['an accessor definition field', accessorField],
    ];
    const pollution: Record<string, unknown> = { value: 30, enumerable: true, writable: true };
    Object.assign(objectProto, pollution);
    const errors: unknown[] = [];
    try {
      for (const [, definition] of cases) errors.push(thrownBy(() => defineScopeGrammar(definition as never)));
    } finally {
      for (const key of Object.keys(pollution)) delete objectProto[key];
    }
    errors.forEach((error, i) => {
      expect(error, cases[i]![0]).toBeInstanceOf(TypeError);
      expect((error as Error).message, cases[i]![0]).toMatch(/must be plain data/);
    });
    expect(reads).toBe(0);
  });

  it('rejects a definition values array with an extra key', () => {
    const values = Object.assign(['a'], { extra: 'b' });
    expect(() => defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet', values } }, riskOf })).toThrow(TypeError);
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
    // A root that is plain data but not an object fails validation; any other root fails the plain-data check.
    const notObject = expect.objectContaining({ code: 'malformed', side: 'request', message: 'scope must be a plain object' });
    const notPlain = expect.objectContaining({ code: 'malformed', side: 'request', message: NOT_PLAIN_DATA });
    for (const [label, scope] of scopes) {
      const plainRoot = scope === null || typeof scope === 'string' || typeof scope === 'number' || Array.isArray(scope);
      expect(violationsOf(scope as never).violations, label).toEqual([plainRoot ? notObject : notPlain]);
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
      expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'permissions', message: dimensionNotPlain('permissions') }),
    ]);
    expect(violationsOf(base, { ...envelope, permissions: sparse }).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'permissions' }),
    ]);
  });

  it('rejects arrays with extra keys and shared arrays on either side, without normalize', () => {
    const withShared = () => Object.assign(['alpha'], { extra: new SharedArrayBuffer(8) });
    const withPlain = () => Object.assign(['alpha'], { extra: 'x' });
    for (const labels of [withShared(), withPlain()]) {
      const failure = (side: string) => expect.objectContaining({ code: 'malformed', side, dimension: 'labels', message: dimensionNotPlain('labels') });
      expect(violationsOf({ ...base, labels }).violations).toEqual([failure('request')]);
      expect(violationsOf({ ...base, labels: ['alpha'] }, { ...envelope, labels }).violations).toEqual([failure('envelope')]);
      expect(grammar.normalize({ ...base, labels } as never)).toEqual({ ok: false, violations: [failure('request')] });
      const error = thrownBy(() => grammar.classifyRisk({ ...base, labels } as never));
      expect(error).toBeInstanceOf(ScopeError);
      expect(error.violations).toEqual([failure('request')]);
    }
    // The reviewer's vector: a glob envelope carrying shared memory on an extra key never answers ok.
    const globs = defineScopeGrammar({ provider: 'globs', dimensions: { paths: { kind: 'prefixGlobSet' } }, riskOf });
    const sharedEnvelope = { paths: Object.assign(['a'], { extra: new SharedArrayBuffer(8) }) };
    expect(globs.isSubset({ paths: ['a'] }, sharedEnvelope).ok).toBe(false);
    // One array object used for two dimensions is a shared reference.
    const none: string[] = [];
    const shared = violationsOf({ ...base, permissions: none, labels: none }).violations;
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ code: 'malformed', side: 'request' });
    expect(['permissions', 'labels']).toContain(shared[0]!.dimension);
  });

  it('checks the item limit on an oversized clone once, with one violation and one getter read', () => {
    const tooMany: unknown[] = Array.from({ length: SCOPE_LIMITS.maxSetItems + 1 }, (_, i) => `l-${i}`);
    tooMany[0] = 42;
    let reads = 0;
    Object.defineProperty(tooMany, 7, {
      enumerable: true,
      get: () => {
        reads++;
        return 'l-7';
      },
    });
    expect(violationsOf({ ...base, labels: tooMany }).violations).toEqual([
      { code: 'malformed', side: 'request', dimension: 'labels', message: `dimension "labels" must have at most ${SCOPE_LIMITS.maxSetItems} items` },
    ]);
    expect(reads).toBe(1);
  });

  it('never fills a missing value from a polluted prototype', () => {
    const objectProto = Object.prototype as Record<string, unknown>;
    const arrayProto = Array.prototype as unknown as Record<number, unknown>;
    objectProto.rate = 1;
    arrayProto[1] = 'admin';
    let missing: ReturnType<typeof violationsOf>;
    let holedOk: boolean;
    try {
      const { rate: _rate, ...withoutRate } = base;
      missing = violationsOf(withoutRate);
      const holed = ['contents:read'];
      holed.length = 2;
      holedOk = violationsOf({ ...base, permissions: holed }).ok;
    } finally {
      delete objectProto.rate;
      delete arrayProto[1];
    }
    // Asserted after the cleanup: the matcher itself would see the polluted key.
    expect(missing.violations).toEqual([expect.objectContaining({ code: 'malformed', dimension: 'rate' })]);
    expect(holedOk).toBe(false);
  });

  it('never takes a dimension kind, option or callback from a polluted prototype at define time', () => {
    const objectProto = Object.prototype as Record<string, unknown>;
    const injected = () => ({});
    const pollution: Record<string, unknown> = { kind: 'prefixGlobSet', values: ['other'], max: -1, integer: true, normalize: injected };
    Object.assign(objectProto, pollution);
    let missingKind: unknown;
    let defined: AnyScopeGrammar | undefined;
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
    // A huge sparse array is rejected as not plain data from its own key count, not walked hole by hole.
    const huge: string[] = [];
    huge.length = 5_000_000;
    expect(violationsOf(base, { ...envelope, labels: huge }).violations).toEqual([
      expect.objectContaining({ side: 'envelope', dimension: 'labels', message: dimensionNotPlain('labels') }),
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
      violations: [],
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

describe('every record the engine hands out is its own (I7)', () => {
  const VIOLATION_FIELDS = ['code', 'side', 'dimension', 'item', 'limit', 'message'] as const;
  const RESULT_FIELDS = ['ok', 'violations', 'scope'] as const;
  const pollution: Record<string, unknown> = {
    scope: { ids: ['*'], ttl: 86_400 },
    item: 'polluted-item',
    limit: 99,
    dimension: 'polluted-dimension',
    cause: 'polluted-cause',
    ok: true,
    violations: ['polluted-violation'],
  };

  /** Runs `read` with `Object.prototype` polluted; everything it returns is asserted after the cleanup. */
  function whilePolluted<T>(read: () => T): T {
    const objectProto = Object.prototype as Record<string, unknown>;
    Object.assign(objectProto, pollution);
    try {
      return read();
    } finally {
      for (const key of Object.keys(pollution)) delete objectProto[key];
    }
  }

  /** What a direct read of each field gives, and which record-shape rules it breaks: read while polluted. */
  function observe(record: object, fields: readonly string[]) {
    const values: unknown[] = fields.map(field => (record as Record<string, unknown>)[field]);
    const broken: string[] = [];
    if (Object.getPrototypeOf(record) !== null) broken.push('prototype');
    if (!Object.isFrozen(record)) broken.push('not frozen');
    for (const field of fields) if (!Object.hasOwn(record, field)) broken.push(`${field} not own`);
    return { values, broken };
  }

  function observeResult(result: object) {
    const own = observe(result, RESULT_FIELDS);
    const violations = (result as { violations: readonly object[] }).violations;
    return {
      ...own,
      violationsFrozen: Object.isFrozen(violations),
      violations: violations.map(record => observe(record, VIOLATION_FIELDS)),
    };
  }

  const items: object[] = [];
  const g = defineScopeGrammar({
    provider: 'own-records',
    dimensions: { ids: { kind: 'exactSet' }, paths: { kind: 'prefixGlobSet' }, rate: { kind: 'numericMax' }, ttl: { kind: 'ttlMax' } },
    riskOf: item => {
      items.push(item);
      return 'read';
    },
  });
  const env = { ids: ['a'], paths: ['org/*'], rate: 10, ttl: 60 };
  const fine = { ids: ['a'], paths: ['org/x'], rate: 1, ttl: 60 };

  it.each([
    ['normalize, malformed', () => g.normalize({ ...fine, ids: [1] } as never), ['malformed', 'request', 'ids', undefined, undefined]],
    ['isSubset, malformed request', () => g.isSubset({ ...fine, ids: [1] } as never, env), ['malformed', 'request', 'ids', undefined, undefined]],
    ['isSubset, malformed envelope', () => g.isSubset(fine, { ...env, ttl: 0 }), ['malformed', 'envelope', 'ttl', 0, undefined]],
    ['isSubset, malformed root', () => g.isSubset(fine, [] as never), ['malformed', 'envelope', undefined, undefined, undefined]],
    ['isSubset, exactSet not_in_envelope', () => g.isSubset({ ...fine, ids: ['b'] }, env), ['not_in_envelope', 'request', 'ids', 'b', undefined]],
    ['isSubset, prefixGlobSet not_in_envelope', () => g.isSubset({ ...fine, paths: ['other/x'] }, env), ['not_in_envelope', 'request', 'paths', 'other/x', undefined]],
    ['isSubset, numericMax exceeds_envelope', () => g.isSubset({ ...fine, rate: 11 }, env), ['exceeds_envelope', 'request', 'rate', 11, 10]],
    ['isSubset, ttlMax exceeds_envelope', () => g.isSubset({ ...fine, ttl: 61 }, env), ['exceeds_envelope', 'request', 'ttl', 61, 60]],
  ] as const)('%s: a failed result and its violation hold only their own fields', (_name, run, [code, side, dimension, item, limit]) => {
    const seen = whilePolluted(() => observeResult(run()));
    expect(seen.broken).toEqual([]);
    expect(seen.values).toEqual([false, expect.any(Array), undefined]);
    expect(seen.violationsFrozen).toBe(true);
    expect(seen.violations).toHaveLength(1);
    const [violation] = seen.violations;
    expect(violation!.broken).toEqual([]);
    expect(violation!.values.slice(0, 5)).toEqual([code, side, dimension, item, limit]);
  });

  it('gives ok results an own frozen empty violations array and the snapshot as scope', () => {
    const seen = whilePolluted(() => [g.normalize(fine), g.isSubset(fine, env)].map(result => ({ ...observeResult(result), isSnapshot: g.classifyScope(result.scope!) })));
    for (const result of seen) {
      expect(result.broken).toEqual([]);
      expect(result.values[0]).toBe(true);
      expect(result.values[1]).toEqual([]);
      expect(result.violationsFrozen).toBe(true);
      expect(result.isSnapshot).toBe('read');
    }
  });

  it('gives ScopeError its own frozen violations and an own cause, undefined when there is none', () => {
    const seen = whilePolluted(() =>
      [thrownBy(() => g.classifyRisk({ ...fine, ids: [1] } as never)), thrownBy(() => g.classifyScope({} as never))].map(error => ({
        ownCause: Object.hasOwn(error, 'cause'),
        cause: error.cause,
        frozen: Object.isFrozen(error.violations),
        violations: error.violations.map(record => observe(record, VIOLATION_FIELDS)),
      })),
    );
    expect(seen.map(({ ownCause, cause, frozen }) => [ownCause, cause, frozen])).toEqual([
      [true, undefined, true],
      [true, undefined, true],
    ]);
    expect(seen[0]!.violations).toEqual([{ values: ['malformed', 'request', 'ids', undefined, undefined, expect.any(String)], broken: [] }]);
    expect(seen[1]!.violations).toEqual([]);
  });

  it('passes riskOf a frozen null-prototype item with every field own', () => {
    items.length = 0;
    const seen = whilePolluted(() => {
      g.classifyRisk(fine);
      return items.map(item => observe(item, ['dimension', 'kind', 'value']));
    });
    expect(seen).toEqual([
      { values: ['ids', 'exactSet', 'a'], broken: [] },
      { values: ['paths', 'prefixGlobSet', 'org/x'], broken: [] },
      { values: ['rate', 'numericMax', 1], broken: [] },
      { values: ['ttl', 'ttlMax', 60], broken: [] },
    ]);
  });

  it('publishes dimension definitions with a null prototype', () => {
    const seen = whilePolluted(() => Object.values(g.dimensions).map(def => [Object.getPrototypeOf(def), (def as { values?: unknown }).values]));
    expect(seen).toEqual([
      [null, undefined],
      [null, undefined],
      [null, undefined],
      [null, undefined],
    ]);
  });

  it('keeps combined violations flat when Symbol.isConcatSpreadable is polluted', () => {
    const g = defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet' } }, riskOf });
    for (const target of [Object.prototype, Array.prototype]) {
      let facts: { length: number; nested: boolean[]; codes: unknown[]; sides: unknown[] };
      try {
        Object.defineProperty(target, Symbol.isConcatSpreadable, { value: false, configurable: true, writable: true });
        const { violations } = g.isSubset({ names: 'x' } as never, { names: 7 } as never);
        const nested: boolean[] = [];
        const codes: unknown[] = [];
        const sides: unknown[] = [];
        for (let i = 0; i < violations.length; i++) {
          nested[i] = Array.isArray(violations[i]);
          codes[i] = (violations[i] as { code?: unknown }).code;
          sides[i] = (violations[i] as { side?: unknown }).side;
        }
        facts = { length: violations.length, nested, codes, sides };
      } finally {
        delete (target as Record<symbol, unknown>)[Symbol.isConcatSpreadable];
      }
      expect(facts).toEqual({ length: 2, nested: [false, false], codes: ['malformed', 'malformed'], sides: ['request', 'envelope'] });
    }
  });

  it('builds returned records only through its constructors: no object literal is returned or pushed', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/scopes/grammar.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/return\s*\{/);
    expect(source).not.toMatch(/push\(\s*\{/);
    expect(source).not.toMatch(/\.\.\.\(/);
    expect(source).not.toMatch(/\.concat\(/);
  });

  it('hands normalize a clone whose records all have a null prototype, so a polluted Object.prototype grants nothing', () => {
    const grant = ['test-write'];
    const inputs: { access?: unknown; meta?: unknown; list?: unknown }[] = [];
    const n = defineScopeGrammar({
      provider: 'input-records',
      dimensions: { perms: { kind: 'exactSet', values: ['test-read', 'test-write'] } },
      normalize: ((input: { access?: string[] }) => {
        inputs.push(input);
        return { perms: input.access ?? [] };
      }) as never,
      riskOf,
    });
    const before = n.isSubset({ access: grant } as never, {} as never).ok;
    const objectProto = Object.prototype as Record<string, unknown>;
    let polluted: { envelopeGrant: boolean; requestPerms: unknown };
    try {
      objectProto.access = grant;
      polluted = {
        envelopeGrant: n.isSubset({ access: grant } as never, {} as never).ok,
        requestPerms: n.normalize({} as never).scope?.perms,
      };
    } finally {
      delete objectProto.access;
    }
    expect(before).toBe(false);
    expect(polluted).toEqual({ envelopeGrant: false, requestPerms: [] });

    inputs.length = 0;
    n.normalize({ access: [], meta: { nested: { deep: true } }, list: [{ inArray: 1 }] } as never);
    const [input] = inputs as [{ meta: { nested: object }; list: object[] }];
    expect([input, input.meta, input.meta.nested, input.list[0]].map(record => Object.getPrototypeOf(record))).toEqual([null, null, null, null]);
    expect(Object.getPrototypeOf(input.list)).toBe(Array.prototype);
  });
});

describe('isSubset captures the envelope before it reads the request', () => {
  const g = defineScopeGrammar({ provider: 'order', dimensions: { perms: { kind: 'exactSet', values: ['test-read', 'test-write'] } }, riskOf });

  it('denies a request whose getter widens the envelope object', () => {
    const plainEnvelope = { perms: ['test-read'] };
    expect(g.isSubset({ perms: ['test-write'] }, plainEnvelope).ok).toBe(false);
    const env = { perms: ['test-read'] };
    const request = {
      get perms() {
        env.perms.push('test-write');
        return ['test-write'];
      },
    };
    const result = g.isSubset(request as never, env);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([expect.objectContaining({ code: 'not_in_envelope', item: 'test-write' })]);
  });

  it('normalizes the envelope first and still lists request violations first', () => {
    const sides: string[] = [];
    const n = defineScopeGrammar({
      provider: 'order',
      dimensions: { perms: { kind: 'exactSet' } },
      normalize: ((input: { side: string; perms: unknown }) => {
        sides.push(input.side);
        return { perms: input.perms };
      }) as never,
      riskOf,
    });
    const result = n.isSubset({ side: 'request', perms: 'bad' } as never, { side: 'envelope', perms: 'bad' } as never);
    expect(sides).toEqual(['envelope', 'request']);
    expect(result.violations.map(v => v.side)).toEqual(['request', 'envelope']);
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
    expect(g.normalize(input)).toEqual({ ok: true, violations: [], scope: { names: ['a', 'b'] } });
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
    expect(result).toEqual({ ok: true, violations: [], scope: { names: ['a'] } });
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

  const notPlain = (side: string) =>
    expect.objectContaining({
      code: 'malformed',
      side,
      message: NOT_PLAIN_DATA,
    });

  it('passes only plain JSON-like data to normalize: shared memory and other clonable objects are malformed', () => {
    // normalize records what it is given: only the plain side of each call may reach it.
    const seen: unknown[] = [];
    const g = defineScopeGrammar({
      provider: 'plain-in',
      dimensions,
      normalize: (value: unknown) => {
        seen.push(value);
        return { names: ['a'] };
      },
      riskOf,
    });
    const shared = new SharedArrayBuffer(8);
    const inputs: unknown[] = [
      shared,
      { names: shared },
      { names: [new Int32Array(shared)] },
      { nested: { deeper: [{ view: new DataView(new ArrayBuffer(4)) }] } },
      { names: new ArrayBuffer(4) },
      new Map([['names', ['a']]]),
      { names: ['a'], when: new Date(0) },
      { names: ['a'], pattern: /a/ },
      { names: ['a'], error: new Error('test-error') },
      { names: [new String('a')] },
      { names: ['a'], missing: undefined },
      { names: ['a'], big: 1n },
      { names: ['a'], limit: Number.NaN },
      { names: Object.assign(['a'], { extra: 1 }) },
      // eslint-disable-next-line no-sparse-arrays
      { names: ['a', , 'b'] },
    ];
    for (const input of inputs) {
      expect(g.isSubset(input as never, { names: ['a'] }).violations).toEqual([notPlain('request')]);
      expect(g.isSubset({ names: ['a'] }, input as never).violations).toEqual([notPlain('envelope')]);
      expect(g.normalize(input as never)).toEqual({ ok: false, violations: [notPlain('request')] });
      expect(thrownBy(() => g.classifyRisk(input as never))).toBeInstanceOf(ScopeError);
    }
    // Only the plain { names: ['a'] } side of each isSubset call reached normalize.
    expect(seen).toHaveLength(2 * inputs.length);
    expect(seen.every(value => JSON.stringify(value) === '{"names":["a"]}')).toBe(true);
    // Plain JSON-like data of every allowed kind still reaches normalize.
    const plain = { names: ['a'], flag: true, none: null, count: 1, nested: { list: [{}] } };
    expect(g.normalize(plain as never).ok).toBe(true);
    expect(seen.at(-1)).toEqual(plain);
  });

  it('checks the re-cloned normalize result for extra array keys and shared arrays', () => {
    const two = { names: { kind: 'exactSet' as const }, tags: { kind: 'exactSet' as const } };
    const shared = ['a'];
    const outputs: [string, unknown, string][] = [
      ['an extra array key', { names: Object.assign(['a'], { extra: 1 }), tags: [] }, 'names'],
      ['shared memory on an extra key', { names: Object.assign(['a'], { extra: new SharedArrayBuffer(8) }), tags: [] }, 'names'],
    ];
    for (const [label, output, dimension] of outputs) {
      const g = defineScopeGrammar({ provider: 'out', dimensions: two, normalize: () => output as never, riskOf });
      const failure = (side: string) => expect.objectContaining({ code: 'malformed', side, dimension, message: dimensionNotPlain(dimension) });
      expect(g.isSubset({}, {}).violations, label).toEqual([failure('request'), failure('envelope')]);
      expect(thrownBy(() => g.classifyRisk({})).violations, label).toEqual([failure('request')]);
    }
    const sharing = defineScopeGrammar({ provider: 'out', dimensions: two, normalize: () => ({ names: shared, tags: shared }), riskOf });
    const result = sharing.normalize({});
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.violations).toEqual([expect.objectContaining({ code: 'malformed', side: 'request' })]);
  });

  it('rejects cycles and shared references before normalize, and survives deep nesting', () => {
    let calls = 0;
    const g = defineScopeGrammar({
      provider: 'plain-graph',
      dimensions,
      normalize: () => {
        calls++;
        return { names: [] };
      },
      riskOf,
    });
    const cyclic: Record<string, unknown> = { names: [] };
    cyclic.self = cyclic;
    const member = ['a'];
    const sharedReference = { names: member, again: member };
    for (const input of [cyclic, sharedReference]) {
      expect(g.normalize(input as never)).toEqual({ ok: false, violations: [notPlain('request')] });
    }
    expect(calls).toBe(0);

    // 500 levels clone and pass the walk; 100k levels exceed structuredClone's
    // own depth limit and are malformed. Neither throws.
    for (const levels of [500, 100_000]) {
      let deep: unknown = [];
      for (let i = 0; i < levels; i++) deep = { inner: deep };
      const result = g.normalize(deep as never);
      expect(result.ok || result.violations.every(v => v.code === 'malformed' && v.side === 'request')).toBe(true);
    }
    expect(calls).toBeGreaterThanOrEqual(1);
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

/** Runs `run` synchronously, then lets Node report unhandled rejections; returns their reasons. */
async function unhandledRejectionsOf(run: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    run();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

describe('callbacks are synchronous and a returned promise is contained, never awaited (I5)', () => {
  const names = { names: { kind: 'exactSet' } } as const;
  const rejecting = (marker: string) => (input: { names: string[] }) =>
    input.names[0] === marker ? Promise.reject(new Error('normalize rejected')) : input;
  const asyncThrowing = async (): Promise<never> => {
    throw new Error('async callback threw');
  };

  it('fails closed on a rejected promise from normalize on either side, with no unhandled rejection', async () => {
    const g = defineScopeGrammar({ provider: 'p', dimensions: names, normalize: rejecting('reject') as never, riskOf });
    const results: unknown[] = [];
    const seen = await unhandledRejectionsOf(() => {
      results.push(g.isSubset({ names: ['reject'] }, { names: [] }).violations);
      results.push(g.isSubset({ names: [] }, { names: ['reject'] }).violations);
      results.push(g.normalize({ names: ['reject'] }).ok);
      results.push(thrownBy(() => g.classifyRisk({ names: ['reject'] })) instanceof ScopeError);
    });
    expect(seen).toEqual([]);
    expect(results).toEqual([
      [expect.objectContaining({ side: 'request', code: 'malformed' })],
      [expect.objectContaining({ side: 'envelope', code: 'malformed' })],
      false,
      true,
    ]);
  });

  it('fails closed on an async normalize reached through a plain function, with no unhandled rejection', async () => {
    const g = defineScopeGrammar({ provider: 'p', dimensions: names, normalize: (() => asyncThrowing()) as never, riskOf });
    const results: unknown[] = [];
    const seen = await unhandledRejectionsOf(() => {
      results.push(g.isSubset({ names: [] }, { names: [] }).violations);
      results.push(g.normalize({ names: [] }).ok);
    });
    expect(seen).toEqual([]);
    expect(results).toEqual([
      [expect.objectContaining({ side: 'request', code: 'malformed' }), expect.objectContaining({ side: 'envelope', code: 'malformed' })],
      false,
    ]);
  });

  it('throws ScopeError for a rejected or async-thrown riskOf result, with no unhandled rejection', async () => {
    for (const result of [() => Promise.reject(new Error('riskOf rejected')), () => asyncThrowing()]) {
      const g = defineScopeGrammar({ provider: 'p', dimensions: names, riskOf: result as never });
      let error: unknown;
      const seen = await unhandledRejectionsOf(() => {
        error = thrownBy(() => g.classifyRisk({ names: ['a', 'b'] }));
      });
      expect(seen).toEqual([]);
      expect(error).toBeInstanceOf(ScopeError);
      expect((error as Error).message).toMatch(/unknown risk/);
    }
  });

  it('never calls the own then of a returned native promise or a plain thenable', async () => {
    const ownThen = vi.fn();
    const withOwnThen = () => Object.defineProperty(Promise.reject(new Error('own then')), 'then', { value: ownThen });
    const thenable = () => ({ then: ownThen });
    for (const make of [withOwnThen, thenable]) {
      const viaNormalize = defineScopeGrammar({ provider: 'p', dimensions: names, normalize: make as never, riskOf });
      const viaRisk = defineScopeGrammar({ provider: 'p', dimensions: names, riskOf: make as never });
      const results: unknown[] = [];
      const seen = await unhandledRejectionsOf(() => {
        results.push(viaNormalize.isSubset({ names: [] }, { names: [] }).ok);
        results.push(thrownBy(() => viaRisk.classifyRisk({ names: ['a'] })) instanceof ScopeError);
      });
      expect(seen).toEqual([]);
      expect(results).toEqual([false, true]);
    }
    expect(ownThen).not.toHaveBeenCalled();
  });

  it('uses the then captured at load, not a later Promise.prototype.then', async () => {
    const g = defineScopeGrammar({ provider: 'p', dimensions: names, normalize: rejecting('reject') as never, riskOf });
    const viaRisk = defineScopeGrammar({ provider: 'p', dimensions: names, riskOf: () => Promise.reject(new Error('riskOf rejected')) as never });
    const original = Object.getOwnPropertyDescriptor(Promise.prototype, 'then')!;
    const replacement = vi.fn();
    const results: unknown[] = [];
    const seen = await unhandledRejectionsOf(() => {
      try {
        Object.defineProperty(Promise.prototype, 'then', { ...original, value: replacement });
        results.push(g.isSubset({ names: ['reject'] }, { names: [] }).ok);
        results.push(thrownBy(() => viaRisk.classifyRisk({ names: ['a'] })) instanceof ScopeError);
      } finally {
        Object.defineProperty(Promise.prototype, 'then', original);
      }
    });
    expect(replacement).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(results).toEqual([false, true]);
  });

  describe('when the species lookup inside then throws', () => {
    const throwingConstructor = () => {
      const promise = Promise.reject(new Error('species rejected'));
      Object.defineProperty(promise, 'constructor', {
        configurable: true,
        get() {
          throw new Error('constructor lookup threw');
        },
      });
      return promise;
    };
    class ThrowingSpecies extends Promise<never> {
      static get [Symbol.species](): never {
        throw new Error('species threw');
      }
    }
    class NonConstructorSpecies extends Promise<never> {
      static get [Symbol.species](): PromiseConstructor {
        return 5 as never;
      }
    }
    const makers: [string, () => object][] = [
      ['an own throwing constructor getter', throwingConstructor],
      ['a subclass whose species getter throws', () => ThrowingSpecies.reject(new Error('species rejected'))],
      ['a subclass whose species is not a constructor', () => NonConstructorSpecies.reject(new Error('species rejected'))],
    ];

    /** Every path: normalize on either side, normalize() and classifyRisk, and riskOf. */
    function runAll(make: () => object, made: [object, PropertyDescriptor | undefined][]) {
      const record = () => {
        const value = make();
        made.push([value, Object.getOwnPropertyDescriptor(value, 'constructor')]);
        return value;
      };
      const viaNormalize = defineScopeGrammar({
        provider: 'p',
        dimensions: names,
        normalize: ((input: { names: string[] }) => (input.names[0] === 'reject' ? record() : input)) as never,
        riskOf,
      });
      const viaRisk = defineScopeGrammar({ provider: 'p', dimensions: names, riskOf: record as never });
      return [
        viaNormalize.isSubset({ names: ['reject'] }, { names: [] }).violations.map(v => v.side),
        viaNormalize.isSubset({ names: [] }, { names: ['reject'] }).violations.map(v => v.side),
        viaNormalize.normalize({ names: ['reject'] }).ok,
        thrownBy(() => viaRisk.classifyRisk({ names: ['a'] })) instanceof ScopeError,
      ];
    }

    it.each(makers)('contains %s on every path and restores the own constructor exactly', async (_label, make) => {
      const made: [object, PropertyDescriptor | undefined][] = [];
      let results: unknown[] = [];
      const seen = await unhandledRejectionsOf(() => {
        results = runAll(make, made);
      });
      expect(seen).toEqual([]);
      expect(results).toEqual([['request'], ['envelope'], false, true]);
      expect(made).toHaveLength(4);
      for (const [value, before] of made) {
        const after = Object.getOwnPropertyDescriptor(value, 'constructor');
        expect(after).toEqual(before);
        expect(after?.get).toBe(before?.get);
      }
    });

    it('contains a plain rejected promise after Promise[Symbol.species] is redefined to throw', async () => {
      const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!;
      const made: [object, PropertyDescriptor | undefined][] = [];
      let results: unknown[] = [];
      const seen = await unhandledRejectionsOf(() => {
        Object.defineProperty(Promise, Symbol.species, {
          configurable: true,
          get() {
            throw new Error('species threw');
          },
        });
        try {
          results = runAll(() => Promise.reject(new Error('species rejected')), made);
        } finally {
          Object.defineProperty(Promise, Symbol.species, original);
        }
      });
      expect(seen).toEqual([]);
      expect(results).toEqual([['request'], ['envelope'], false, true]);
      expect(made).toHaveLength(4);
      for (const [value] of made) expect(Object.hasOwn(value, 'constructor')).toBe(false);
    });

    it('still fails closed on the documented residual: a non-configurable or non-extensible promise', () => {
      const nonConfigurable = () =>
        Object.defineProperty(Promise.resolve('settled'), 'constructor', {
          get() {
            throw new Error('constructor lookup threw');
          },
        });
      const nonExtensible = () => Object.preventExtensions(ThrowingSpecies.resolve('settled' as never));
      for (const make of [nonConfigurable, nonExtensible]) {
        expect(runAll(make, [])).toEqual([['request'], ['envelope'], false, true]);
      }
    });
  });

  it('never awaits or calls then in the engine source; the only Promise reference is the captured intrinsic', () => {
    const dir = fileURLToPath(new URL('../../src/scopes/', import.meta.url));
    let promiseReferences = 0;
    for (const file of readdirSync(dir)) {
      const code = readFileSync(`${dir}${file}`, 'utf8')
        .split('\n')
        .filter(line => !/^\s*(\*|\/\*\*|\/\/)/.test(line))
        .join('\n');
      expect(code, file).not.toMatch(/\bawait\b|\.then\(|\.catch\(|\bnew Promise\b/);
      promiseReferences += (code.match(/\bPromise\b/g) ?? []).length;
      if (file === 'grammar.ts') {
        expect(code).toMatch(/const intrinsicPromisePrototype = Promise\.prototype;/);
        expect(code).toMatch(/Function\.prototype\.call\.bind\(\s*intrinsicPromisePrototype\.then,?\s*\)/);
      }
    }
    expect(promiseReferences).toBe(1);
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

  it('has no comparison sort and no hashed child index in the glob trie', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/scopes/grammar.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/\.sort\(/);
    const start = source.indexOf('class RadixNode');
    const end = source.indexOf('function comparePrefixGlob');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(end);
    const trie = source.slice(start, end);
    expect(trie).toContain('RadixNode');
    expect(trie).not.toMatch(/\bMap\b|\bSet\b/);
  });

  it('agrees with the naive definition when code units differ in any nibble, in any insertion order', () => {
    // These code units first differ from 'a' (0x0061) in nibble 3, 2, 1 and 0 of the unit.
    const alphabet = ['a', 'q', '\u0161', '\u1061', '\u10a1'];
    let seed = 11;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    const word = () => Array.from({ length: next() % 4 }, () => alphabet[next() % alphabet.length]).join('');
    for (let round = 0; round < 300; round++) {
      const env = Array.from({ length: 1 + (next() % 8) }, () => (next() % 3 ? `${word()}*` : word() || 'a'));
      const request = [...new Set(Array.from({ length: 10 }, () => (next() % 2 ? `${word()}*` : word() || 'q')))];
      const expected = request.filter(item => !naive(item, env));
      for (const order of [env, [...env].reverse(), [...env].sort(), [...env].sort().reverse()]) {
        expect(uncovered(request, order), JSON.stringify({ request, order })).toEqual(expected);
      }
    }
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
