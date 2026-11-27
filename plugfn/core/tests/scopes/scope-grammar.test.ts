import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineScopeGrammar, SCOPE_LIMITS, type AnyScopeGrammar } from '../../src/scopes/index.js';

const grammar = defineScopeGrammar({
  provider: 'test-provider',
  dimensions: {
    permissions: { kind: 'exactSet', values: ['contents:read', 'contents:write', 'admin'] },
    labels: { kind: 'exactSet' },
    resources: { kind: 'prefixGlobSet' },
    rate: { kind: 'numericMax', min: 0, max: 1000, integer: true },
    ttl: { kind: 'ttlMax', minSeconds: 900, maxSeconds: 3600 },
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
function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
}

const NOT_PLAIN_DATA = 'scope must be plain data (objects, arrays, strings, finite numbers, booleans, null) without cycles or shared references';
const dimensionNotPlain = (name: string) => `dimension "${name}" must be plain data (arrays, strings, finite numbers) without shared references`;

describe('defineScopeGrammar', () => {
  it('rejects any dimension kind outside the closed set', () => {
    for (const kind of ['regex', 'numericMin', 'suffixGlob', undefined]) {
      expect(() =>
        defineScopeGrammar({ provider: 'p', dimensions: { d: { kind } as never } }),
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
      const error = thrownBy(() => defineScopeGrammar({ provider: 'p', dimensions: dimensions as never }));
      expect(error, label).toBeInstanceOf(TypeError);
      expect(error.message, label).toMatch(/must be plain data/);
    }
    const definition = { provider: 'p', dimensions: { names: { kind: 'exactSet' as const } } };
    expect(() => defineScopeGrammar(hidden({ ...definition }, 'normalize', (x: unknown) => x) as never)).toThrow(TypeError);
    expect(() => defineScopeGrammar({ ...definition, [Symbol('normalize')]: (x: unknown) => x } as never)).toThrow(TypeError);
    // The same bounds written as ordinary properties are enforced.
    const capped = defineScopeGrammar({ provider: 'p', dimensions: { ttl: { kind: 'ttlMax', maxSeconds: 30 } } });
    expect(capped.isSubset({ ttl: 120 }, { ttl: 120 }).ok).toBe(false);
    expect(capped.dimensions.ttl).toEqual({ kind: 'ttlMax', maxSeconds: 30 });
  });

  it('rejects invalid definitions instead of building a permissive grammar', () => {
    const bad: unknown[] = [
      null,
      { provider: '', dimensions: { d: { kind: 'prefixGlobSet' } } },
      { provider: 'p', dimensions: {} },
      { provider: 'p', dimensions: [] },
      { provider: 'p' },
      // normalize needs riskOf: only a callback grammar takes callbacks.
      { provider: 'p', dimensions: { d: { kind: 'prefixGlobSet' } }, normalize: (value: unknown) => value },
      { provider: 'p', dimensions: { d: { kind: 'prefixGlobSet' } }, riskOf: 'read' },
      { provider: 'p', dimensions: { d: { kind: 'prefixGlobSet' } }, riskOf: () => 'read', normalize: {} },
      { provider: 'p', dimensions: { 'bad name': { kind: 'prefixGlobSet' } } },
      { provider: 'p', dimensions: { __proto__x: { kind: 'prefixGlobSet' } } },
      { provider: 'p', dimensions: { d: { kind: 'exactSet', values: ['repo*'] } } },
      { provider: 'p', dimensions: { d: { kind: 'exactSet', values: 'repo' } } },
      { provider: 'p', dimensions: { d: { kind: 'numericMax', min: 5, max: 1 } } },
      { provider: 'p', dimensions: { d: { kind: 'numericMax', max: Number.NaN } } },
      { provider: 'p', dimensions: { d: { kind: 'numericMax', integer: 'yes' } } },
      { provider: 'p', dimensions: { d: { kind: 'ttlMax', maxSeconds: 1.5 } } },
      { provider: 'p', dimensions: { d: { kind: 'ttlMax', minSeconds: 0 } } },
      { provider: 'p', dimensions: { d: { kind: 'ttlMax', minSeconds: 60, maxSeconds: 30 } } },
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
      expect(() => defineScopeGrammar({ provider: 'p', dimensions: { d } as never })).toThrow(TypeError);
    }
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: { d: { kind: 'prefixGlobSet' } }, normalise: (x: unknown) => x } as never),
    ).toThrow(TypeError);
  });

  it('rejects an undefined dimension entry but allows undefined optional fields', () => {
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: { perms: { kind: 'exactSet' }, ttl: undefined } as never }),
    ).toThrow(TypeError);
    const optional = defineScopeGrammar({
      provider: 'p',
      dimensions: {
        size: { kind: 'numericMax', min: undefined, max: 10, integer: undefined },
        names: { kind: 'exactSet', values: undefined },
      },
    });
    expect(optional.dimensions).toEqual({ size: { kind: 'numericMax', max: 10 }, names: { kind: 'exactSet' } });
    expect(optional.normalize({ size: 11 }).ok).toBe(false);
    expect(optional.normalize({ size: 10 }).ok).toBe(true);
  });

  it('reads the definition once as plain data and never runs a definition getter', () => {
    // A transparent Proxy is read once as the data it reports; a function option still throws.
    const proxied = defineScopeGrammar({ provider: 'p', dimensions: new Proxy({ ttl: { kind: 'ttlMax' as const, maxSeconds: 60 } }, {}) });
    expect(proxied.dimensions.ttl).toEqual({ kind: 'ttlMax', maxSeconds: 60 });
    expect(proxied.isSubset({ ttl: 120 }, { ttl: 120 }).ok).toBe(false);
    expect(() =>
      defineScopeGrammar({ provider: 'p', dimensions: { ttl: { kind: 'ttlMax', maxSeconds: () => 60 } } as never }),
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
    expect(thrownBy(() => defineScopeGrammar({ provider: 'p', dimensions: { ttl } })).message).toMatch(/must be plain data/);
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
      const error = thrownBy(() => defineScopeGrammar({ provider: 'p', dimensions: dimensions as never }));
      expect(error, label).toBeInstanceOf(TypeError);
      expect(error.message, label).toMatch(/must be plain data/);
    }
    const definition = { provider: 'p', dimensions: { ttl: ttlEntry } } as Record<string, unknown>;
    const definitionCases: [string, unknown][] = [
      ...['provider', 'dimensions'].map((key): [string, unknown] => {
        const value = definition[key];
        const { [key]: _omitted, ...rest } = definition;
        return [`an accessor ${key}`, accessor(rest, key, value)];
      }),
      ['a class instance definition', Object.assign(new (class Definition {})(), definition)],
      ['an inherited definition field', inherit({}, { provider: 'p', dimensions: { ttl: ttlEntry } })],
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
        return defineScopeGrammar({ provider: 'p', dimensions: dims as never });
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
    const defined = defineScopeGrammar({ provider: 'p', dimensions });
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
    const accessorField = Object.defineProperty({ provider: 'p' }, 'dimensions', getter({ ttl: { kind: 'ttlMax' } }));
    const cases: [string, unknown][] = [
      ['an accessor option', { provider: 'p', dimensions: { ttl: accessorOption } }],
      ['an accessor entry', { provider: 'p', dimensions: accessorEntry }],
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
    expect(() => defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet', values } } })).toThrow(TypeError);
  });

  it('rejects an exactSet vocabulary that is too large, sparse or not made of strings', () => {
    const sparse = ['contents:read'];
    sparse.length = 2;
    for (const values of [new Array(SCOPE_LIMITS.maxSetItems + 1), sparse, [1], [new String('a')]]) {
      expect(() => defineScopeGrammar({ provider: 'p', dimensions: { d: { kind: 'exactSet', values } as never } })).toThrow(TypeError);
    }
  });

  it('accepts any well-formed dimension name, constructor included', () => {
    const named = defineScopeGrammar({ provider: 'p', dimensions: { constructor: { kind: 'exactSet' }, toString: { kind: 'ttlMax' } } });
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
    const owned = defineScopeGrammar({ provider: 'owned', dimensions: dimensions as never });
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
    expect(() => fresh.defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet' } } })).toThrow(
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

  it('rejects arrays with extra keys and shared arrays on either side', () => {
    const withShared = () => Object.assign(['alpha'], { extra: new SharedArrayBuffer(8) });
    const withPlain = () => Object.assign(['alpha'], { extra: 'x' });
    for (const labels of [withShared(), withPlain()]) {
      const failure = (side: string) => expect.objectContaining({ code: 'malformed', side, dimension: 'labels', message: dimensionNotPlain('labels') });
      expect(violationsOf({ ...base, labels }).violations).toEqual([failure('request')]);
      expect(violationsOf({ ...base, labels: ['alpha'] }, { ...envelope, labels }).violations).toEqual([failure('envelope')]);
      expect(grammar.normalize({ ...base, labels } as never)).toEqual({ ok: false, violations: [failure('request')] });
    }
    // The reviewer's vector: a glob envelope carrying shared memory on an extra key never answers ok.
    const globs = defineScopeGrammar({ provider: 'globs', dimensions: { paths: { kind: 'prefixGlobSet' } } });
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

  it('never takes a dimension kind or option from a polluted prototype at define time', () => {
    const objectProto = Object.prototype as Record<string, unknown>;
    const pollution: Record<string, unknown> = { kind: 'prefixGlobSet', values: ['other'], max: -1, integer: true };
    Object.assign(objectProto, pollution);
    let missingKind: unknown;
    let defined: AnyScopeGrammar | undefined;
    try {
      missingKind = thrownBy(() => defineScopeGrammar({ provider: 'polluted', dimensions: { paths: {} } as never }));
      defined = defineScopeGrammar({ provider: 'polluted', dimensions: { names: { kind: 'exactSet' }, rate: { kind: 'numericMax' } } });
    } finally {
      for (const key of Object.keys(pollution)) delete objectProto[key];
    }
    expect(missingKind).toBeInstanceOf(TypeError);
    expect((missingKind as Error).message).toMatch(/unsupported kind undefined/);
    // No vocabulary, max, or integer was taken from the prototype.
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
    const run = () => vectors.map(([request, env]) => ({
      subset: grammar.isSubset(request as never, env as never),
      normalized: grammar.normalize(request as never),
    }));
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
    }
    expect(messageReads).toBe(0);
  });

  it('rejects every kind of promise as a scope on either side', () => {
    const native = Promise.resolve(base);
    const nullPrototype = Object.setPrototypeOf(Promise.resolve(base), null) as object;
    const dataCarrying = Object.assign(Object.setPrototypeOf(Promise.resolve(base), Object.prototype) as object, { names: ['a'] });
    const rejected = Promise.reject(new Error('caller rejection'));
    rejected.catch(() => undefined);
    const plain = defineScopeGrammar({ provider: 'set-only', dimensions: { names: { kind: 'exactSet' } } });
    for (const promise of [native, nullPrototype, dataCarrying, rejected]) {
      expect(plain.normalize(promise as never).violations).toEqual([cloneFailure('request')]);
      expect(plain.isSubset(promise as never, { names: ['a'] }).violations).toEqual([cloneFailure('request')]);
      expect(plain.isSubset({ names: [] }, promise as never).violations).toEqual([cloneFailure('envelope')]);
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

  const g = defineScopeGrammar({
    provider: 'own-records',
    dimensions: { ids: { kind: 'exactSet' }, paths: { kind: 'prefixGlobSet' }, rate: { kind: 'numericMax' }, ttl: { kind: 'ttlMax' } },
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
    const seen = whilePolluted(() => [g.normalize(fine), g.isSubset(fine, env)].map(result => ({ ...observeResult(result), scope: result.scope })));
    for (const result of seen) {
      expect(result.broken).toEqual([]);
      expect(result.values[0]).toBe(true);
      expect(result.values[1]).toEqual([]);
      expect(result.violationsFrozen).toBe(true);
      expect(result.scope).toEqual(fine);
      expect(Object.isFrozen(result.scope)).toBe(true);
    }
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
    const g = defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet' } } });
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
});

describe('isSubset captures the envelope before it reads the request', () => {
  const g = defineScopeGrammar({ provider: 'order', dimensions: { perms: { kind: 'exactSet', values: ['test-read', 'test-write'] } } });

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


  it('lists request violations first when both inputs are malformed', () => {
    const result = g.isSubset({ perms: 'bad' } as never, { perms: 'bad' } as never);
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

describe('radix trie insertion order', () => {
  const globs = defineScopeGrammar({ provider: 'trie', dimensions: { paths: { kind: 'prefixGlobSet' } } });
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

describe('decisions do not depend on the Array iteration protocol or call-time Array methods', () => {
  const g = defineScopeGrammar({
    provider: 'intrinsics',
    dimensions: { perms: { kind: 'exactSet' }, repos: { kind: 'prefixGlobSet' }, ttl: { kind: 'ttlMax' } },
  });
  const env = { perms: [], repos: ['org/*'], ttl: 60 };
  const requested = { perms: ['admin'], repos: ['x/secret'], ttl: 99999 };

  const iterator = Array.prototype[Symbol.iterator];
  const methods = { push: Array.prototype.push, pop: Array.prototype.pop, map: Array.prototype.map, fill: Array.prototype.fill };
  const isArray = Array.isArray;
  const restore = () => {
    Array.prototype[Symbol.iterator] = iterator;
    Object.assign(Array.prototype, methods);
    Array.isArray = isArray;
  };
  const drop = (keep: (array: unknown[]) => boolean) =>
    function (this: unknown[]) {
      return iterator.call(keep(this) ? this : []);
    };
  const isViolation = (value: unknown) => {
    const code = (value as { code?: unknown } | null)?.code;
    return code === 'not_in_envelope' || code === 'exceeds_envelope';
  };
  const tampers: Record<string, () => void> = {
    // Skips the frozen request arrays holding the requested members.
    'an iterator that skips admin and x/secret': () => {
      Array.prototype[Symbol.iterator] = drop(a => !(Object.isFrozen(a) && (a[0] === 'admin' || a[0] === 'x/secret')));
    },
    // Empties the grammar's frozen array of 3 compiled dimensions.
    'an iterator that empties a frozen array of 3 objects': () => {
      Array.prototype[Symbol.iterator] = drop(a => !(Object.isFrozen(a) && a.length === 3 && typeof a[0] === 'object'));
    },
    'an iterator that empties every array': () => {
      Array.prototype[Symbol.iterator] = drop(() => false);
    },
    'a push that drops not_in_envelope and exceeds_envelope': () => {
      Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
        for (let i = 0; i < items.length; i++) if (!isViolation(items[i])) this[this.length] = items[i];
        return this.length;
      };
    },
    'map, pop and fill that return nothing, and an Array.isArray that is always false': () => {
      Array.prototype.map = function () {
        return [];
      } as never;
      Array.prototype.pop = function () {
        return undefined;
      };
      Array.prototype.fill = function (this: unknown[]) {
        return this;
      } as never;
      Array.isArray = ((_: unknown) => false) as typeof Array.isArray;
    },
  };

  /** Runs `run` with `tamper` applied by a request getter (after the envelope is captured) or before the call. */
  function under<T>(tamper: () => void, fromGetter: boolean, run: (request: object) => T): T {
    const request = fromGetter
      ? {
          get perms() {
            tamper();
            return requested.perms;
          },
          repos: requested.repos,
          ttl: requested.ttl,
        }
      : requested;
    try {
      if (!fromGetter) tamper();
      return run(request);
    } finally {
      restore();
    }
  }

  const cases = Object.keys(tampers).flatMap(name => [
    [name, 'from a request getter', true],
    [name, 'before the call', false],
  ]) as [string, string, boolean][];

  it.each(cases)('isSubset still denies with %s applied %s', (name, _when, fromGetter) => {
    const result = under(tampers[name]!, fromGetter, request => g.isSubset(request as never, env as never));
    expect(result.ok).toBe(false);
    expect(result.scope).toBeUndefined();
    expect(result.violations).toEqual([
      expect.objectContaining({ code: 'not_in_envelope', dimension: 'perms', item: 'admin' }),
      expect.objectContaining({ code: 'not_in_envelope', dimension: 'repos', item: 'x/secret' }),
      expect.objectContaining({ code: 'exceeds_envelope', dimension: 'ttl', item: 99999, limit: 60 }),
    ]);
  });

  it.each(cases)('normalize keeps every dimension with %s applied %s', (name, _when, fromGetter) => {
    const result = under(tampers[name]!, fromGetter, request => g.normalize(request as never));
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.scope).toEqual({ perms: ['admin'], repos: ['x/secret'], ttl: 99999 });
  });
});

describe('engine-built arrays are filled by own-property definition', () => {
  const g = defineScopeGrammar({
    provider: 'index-pollution',
    dimensions: { perms: { kind: 'exactSet' }, repos: { kind: 'prefixGlobSet' }, ttl: { kind: 'ttlMax' } },
  });
  const env = { perms: ['contents:read'], repos: ['org/*'], ttl: 60 };
  const requested = { perms: ['contents:read', 'admin'], repos: ['org/app', 'org/docs'], ttl: 99999 };
  const badRequest = { perms: ['contents:read', 5], repos: ['org/app'], ttl: 60 };
  const badEnvelope = { perms: ['contents:read'], repos: ['org/*'], ttl: 'sixty' };

  type Prototype = typeof Array.prototype | typeof Object.prototype;
  // Every key a tamper may plant. The bookkeeping uses no array, because the
  // tampers break index assignment and push while they are in place.
  const plantable: readonly (readonly [Prototype, PropertyKey])[] = [
    [Array.prototype, 0],
    [Array.prototype, 1],
    [Object.prototype, 0],
    [Object.prototype, 1],
    [Object.prototype, 'get'],
    [Object.prototype, 'set'],
  ];
  for (const [target, key] of plantable) expect(Object.hasOwn(target, key)).toBe(false);
  /** Defines with a null-prototype descriptor, so an earlier plant of `get` or `set` cannot leak into it. */
  const plant = (target: Prototype, key: PropertyKey, fields: PropertyDescriptor) => {
    Object.defineProperty(target, key, Object.assign(Object.create(null) as PropertyDescriptor, fields, { configurable: true, enumerable: false }));
  };
  const restore = () => {
    for (const [target, key] of plantable) delete (target as Record<PropertyKey, unknown>)[key];
  };
  const nonWritable = (target: Prototype, index: number) => () => plant(target, index, { value: 'polluted', writable: false });
  const noOpAccessor = (index: number) => () =>
    plant(Array.prototype, index, {
      get: () => undefined,
      set: () => {},
    });
  const tampers: Record<string, () => void> = {
    'a non-writable Array.prototype[0]': nonWritable(Array.prototype, 0),
    'a non-writable Array.prototype[1]': nonWritable(Array.prototype, 1),
    'a non-writable Object.prototype[0]': nonWritable(Object.prototype, 0),
    'a non-writable Object.prototype[1]': nonWritable(Object.prototype, 1),
    'a no-op accessor at Array.prototype[0]': noOpAccessor(0),
    'a no-op accessor at Array.prototype[1]': noOpAccessor(1),
    // A plain-object descriptor would inherit these and become an invalid accessor descriptor.
    'Object.prototype get and set functions': () => {
      plant(Object.prototype, 'get', { value: () => undefined, writable: true });
      plant(Object.prototype, 'set', { value: () => {}, writable: true });
    },
  };

  /** Runs `run` with `tamper` applied by a request getter (after the envelope is captured) or before the call, restoring before it returns. */
  function under<T>(tamper: () => void, fromGetter: boolean, source: Record<string, unknown>, run: (request: object) => T): T {
    const request = fromGetter
      ? {
          get perms() {
            tamper();
            return source.perms;
          },
          repos: source.repos,
          ttl: source.ttl,
        }
      : source;
    try {
      if (!fromGetter) tamper();
      return run(request);
    } finally {
      restore();
    }
  }

  const cases = Object.keys(tampers).flatMap(name => [
    [name, 'from a request getter', true],
    [name, 'before the call', false],
  ]) as [string, string, boolean][];

  it.each(cases)('isSubset denies exactly with %s applied %s', (name, _when, fromGetter) => {
    const result = under(tampers[name]!, fromGetter, requested, request => g.isSubset(request as never, env as never));
    expect(result.ok).toBe(false);
    expect(result.scope).toBeUndefined();
    expect(result.violations).toEqual([
      expect.objectContaining({ code: 'not_in_envelope', side: 'request', dimension: 'perms', item: 'admin' }),
      expect.objectContaining({ code: 'exceeds_envelope', side: 'request', dimension: 'ttl', item: 99999, limit: 60 }),
    ]);
  });

  it.each(cases)('normalize keeps every member and scalar with %s applied %s', (name, _when, fromGetter) => {
    const result = under(tampers[name]!, fromGetter, requested, request => g.normalize(request as never));
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.scope).toEqual({ perms: ['contents:read', 'admin'], repos: ['org/app', 'org/docs'], ttl: 99999 });
  });

  it.each(cases)('a malformed request stays malformed on the request side with %s applied %s', (name, _when, fromGetter) => {
    const subset = under(tampers[name]!, fromGetter, badRequest, request => g.isSubset(request as never, env as never));
    const normalized = under(tampers[name]!, fromGetter, badRequest, request => g.normalize(request as never));
    for (const result of [subset, normalized]) {
      expect(result.ok).toBe(false);
      expect(result.scope).toBeUndefined();
      expect(result.violations).toEqual([expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'perms' })]);
    }
  });

  it.each(cases)('a malformed envelope stays malformed on the envelope side with %s applied %s', (name, _when, fromGetter) => {
    const result = under(tampers[name]!, fromGetter, requested, request => g.isSubset(request as never, badEnvelope as never));
    expect(result.ok).toBe(false);
    expect(result.scope).toBeUndefined();
    expect(result.violations).toEqual([expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'ttl' })]);
  });
});

describe('defineScopeGrammar follows the same rule as per-call evaluation', () => {
  const definition = () => ({
    provider: 'define-time',
    dimensions: { perms: { kind: 'exactSet', values: ['issues:read', 'contents:read'] }, ttl: { kind: 'ttlMax', maxSeconds: 30 } },
  });

  type Prototype = typeof Array.prototype | typeof Object.prototype;
  // Every key a tamper may plant. The bookkeeping uses no array while a tamper
  // is in place, because the tampers break index assignment, push and iteration.
  const plantable: readonly (readonly [Prototype, PropertyKey])[] = [
    [Array.prototype, 0],
    [Array.prototype, 1],
    [Object.prototype, 1],
  ];
  for (const [target, key] of plantable) expect(Object.hasOwn(target, key)).toBe(false);
  const methods = {
    iterator: Array.prototype[Symbol.iterator],
    push: Array.prototype.push,
    map: Array.prototype.map,
    flatMap: Array.prototype.flatMap,
  };
  const restore = () => {
    for (const [target, key] of plantable) delete (target as Record<PropertyKey, unknown>)[key];
    Array.prototype[Symbol.iterator] = methods.iterator;
    Array.prototype.push = methods.push;
    Array.prototype.map = methods.map;
    Array.prototype.flatMap = methods.flatMap;
  };
  const plant = (target: Prototype, key: PropertyKey, fields: PropertyDescriptor) => {
    Object.defineProperty(target, key, Object.assign(Object.create(null) as PropertyDescriptor, fields, { configurable: true, enumerable: false }));
  };
  /** Swaps a vocabulary member for `admin`, and a `maxSeconds` entry for one without a value. */
  const substitute = (value: unknown): unknown => {
    if (value === 'issues:read' || value === 'contents:read') return 'admin';
    if (Array.isArray(value) && value[0] === 'maxSeconds') return ['maxSeconds', { value: undefined, writable: true, enumerable: true, configurable: true }];
    return value;
  };
  const substitutingAccessor = (index: number) => () =>
    plant(Array.prototype, index, {
      get: () => undefined,
      set(this: unknown[], value: unknown) {
        Object.defineProperty(this, index, { value: substitute(value), writable: true, enumerable: true, configurable: true });
      },
    });
  const noOpAccessor = (index: number) => () => plant(Array.prototype, index, { get: () => undefined, set: () => {} });
  const nonWritable = (target: Prototype, index: number) => () => plant(target, index, { value: 'polluted', writable: false });
  const tampers: Record<string, () => void> = {
    'a substituting accessor at Array.prototype[0]': substitutingAccessor(0),
    'a substituting accessor at Array.prototype[1]': substitutingAccessor(1),
    'a no-op accessor at Array.prototype[0]': noOpAccessor(0),
    'a no-op accessor at Array.prototype[1]': noOpAccessor(1),
    'a non-writable Array.prototype[0]': nonWritable(Array.prototype, 0),
    'a non-writable Object.prototype[1]': nonWritable(Object.prototype, 1),
    'an Array iterator that yields nothing': () => {
      Array.prototype[Symbol.iterator] = function () {
        return methods.iterator.call([]);
      } as never;
    },
    'an Array iterator that drops the last item': () => {
      Array.prototype[Symbol.iterator] = function (this: unknown[]) {
        const it = methods.iterator.call(this);
        let left = this.length - 1;
        return { next: () => (left-- > 0 ? it.next() : { done: true, value: undefined }), [Symbol.iterator]() { return this; } } as never;
      } as never;
    },
    'a push that adds nothing': () => {
      Array.prototype.push = function (this: unknown[]) {
        return this.length;
      };
    },
    'map and flatMap that return nothing': () => {
      Array.prototype.map = function () {
        return [];
      } as never;
      Array.prototype.flatMap = function () {
        return [];
      } as never;
    },
  };

  /** Defines the grammar with `tamper` in place, restoring every planted property before it returns. */
  function defineUnder(tamper: () => void): { grammar?: AnyScopeGrammar; error?: unknown } {
    const def = definition();
    try {
      tamper();
      return { grammar: defineScopeGrammar(def) };
    } catch (error) {
      return { error };
    } finally {
      restore();
    }
  }

  it.each(Object.keys(tampers))('compiles, publishes and enforces exactly the definition with %s', name => {
    const { grammar: g, error } = defineUnder(tampers[name]!);
    expect(error).toBeUndefined();
    expect(g!.dimensions).toEqual(definition().dimensions);
    const outside = g!.isSubset({ perms: ['admin'], ttl: 120 } as never, { perms: ['admin'], ttl: 120 } as never);
    expect(outside.ok).toBe(false);
    expect(outside.violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'perms', item: 'admin' }),
      expect.objectContaining({ code: 'malformed', side: 'request', dimension: 'ttl', item: 120 }),
      expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'perms', item: 'admin' }),
      expect.objectContaining({ code: 'malformed', side: 'envelope', dimension: 'ttl', item: 120 }),
    ]);
    const inside = g!.isSubset({ perms: ['contents:read'], ttl: 30 } as never, { perms: ['issues:read', 'contents:read'], ttl: 30 } as never);
    expect(inside.ok).toBe(true);
    expect(inside.violations).toEqual([]);
    expect(inside.scope).toEqual({ perms: ['contents:read'], ttl: 30 });
  });
});
