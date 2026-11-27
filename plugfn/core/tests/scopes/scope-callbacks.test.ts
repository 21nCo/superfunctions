import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  defineScopeGrammar,
  SCOPE_RISK_LEVELS,
  ScopeError,
  type AnyScopeCallbackGrammar,
  type ScopeRisk,
} from '../../src/scopes/index.js';

/**
 * Callback grammars: a required per-item `riskOf` and an optional
 * provider-shaped `normalize` (SFNS-334, restored from SFNS-110's source
 * commit ebb421e97). The data-only engine is covered by scope-grammar.test.ts.
 */
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

describe('defining a callback grammar', () => {
  it('keeps the data-only entry point: no callbacks, no risk methods', () => {
    const dataOnly = defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet' } } });
    const withUndefined = defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet' } }, normalize: undefined, riskOf: undefined });
    for (const g of [dataOnly, withUndefined]) {
      expect(Object.isFrozen(g)).toBe(true);
      expect(Object.keys(g).sort()).toEqual(['dimensions', 'isSubset', 'normalize', 'provider']);
      expect(g.isSubset({ names: ['a'] }, { names: ['a'] }).ok).toBe(true);
    }
    const callbacks = defineScopeGrammar({ provider: 'p', dimensions: { names: { kind: 'exactSet' } }, riskOf });
    expect(Object.isFrozen(callbacks)).toBe(true);
    expect(Object.keys(callbacks).sort()).toEqual(['classifyRisk', 'classifyScope', 'dimensions', 'isSubset', 'normalize', 'provider']);
  });

  it('requires riskOf when normalize is given, and functions for both', () => {
    const dimensions = { names: { kind: 'exactSet' as const } };
    expect(() => defineScopeGrammar({ provider: 'p', dimensions, normalize: (input: unknown) => input } as never)).toThrow(/riskOf is required/);
    for (const definition of [
      { provider: 'p', dimensions, riskOf: 'read' },
      { provider: 'p', dimensions, riskOf: null },
      { provider: 'p', dimensions, riskOf, normalize: {} },
      { provider: 'p', dimensions, riskOf, normalize: null },
    ]) {
      expect(() => defineScopeGrammar(definition as never)).toThrow(/must be a function/);
    }
  });

  it('rejects asynchronous callbacks when the grammar is defined, in any realm', () => {
    const dimensions = { names: { kind: 'exactSet' as const } };
    const asyncRisk = async () => 'read' as const;
    const asyncNormalize = async (input: unknown) => input;
    async function* asyncGenerator() {
      yield 'read' as const;
    }
    const crossRealmAsync = runInNewContext('(async () => "read")') as () => Promise<'read'>;
    for (const definition of [
      { provider: 'p', dimensions, riskOf: asyncRisk },
      { provider: 'p', dimensions, riskOf: asyncGenerator },
      { provider: 'p', dimensions, riskOf: asyncRisk.bind(null) },
      { provider: 'p', dimensions, riskOf: crossRealmAsync },
      { provider: 'p', dimensions, riskOf, normalize: asyncNormalize },
      { provider: 'p', dimensions, riskOf, normalize: asyncGenerator },
    ]) {
      expect(() => defineScopeGrammar(definition as never)).toThrow(/synchronous/);
    }
  });

  it('never takes a callback from a polluted prototype at define time', () => {
    const objectProto = Object.prototype as Record<string, unknown>;
    const injected = vi.fn(() => ({ names: ['admin'] }));
    const injectedRisk = vi.fn(() => 'read');
    let dataOnly: object | undefined;
    let callbacks: AnyScopeCallbackGrammar | undefined;
    try {
      objectProto.normalize = injected;
      objectProto.riskOf = injectedRisk;
      dataOnly = defineScopeGrammar({ provider: 'polluted', dimensions: { names: { kind: 'exactSet' } } });
      callbacks = defineScopeGrammar({ provider: 'polluted', dimensions: { names: { kind: 'exactSet' } }, riskOf: () => 'write' });
    } finally {
      delete objectProto.normalize;
      delete objectProto.riskOf;
    }
    expect(Object.hasOwn(dataOnly!, 'classifyRisk')).toBe(false);
    expect(callbacks!.isSubset({ names: ['a'] }, { names: [] }).ok).toBe(false);
    expect(callbacks!.classifyRisk({ names: ['a'] })).toBe('write');
    expect(injected).not.toHaveBeenCalled();
    expect(injectedRisk).not.toHaveBeenCalled();
  });
});

describe('normalize maps provider-shaped input', () => {
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

  it('rejects every kind of promise as a scope on either side, without calling normalize for it', () => {
    const cloneFailure = (side: string) => expect.objectContaining({ code: 'malformed', side, message: 'scope must be plain data that structuredClone can copy' });
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
        expect(defaulting).not.toHaveBeenCalled();
        expect(g.isSubset(promise as never, { names: ['a'] }).violations).toEqual([cloneFailure('request')]);
        expect(g.isSubset({ names: [] }, promise as never).violations).toEqual([cloneFailure('envelope')]);
        expect(defaulting.mock.calls.length).toBe(g === normalized ? 2 : 0);
      }
    }
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
    expect(withGetter.normalize({ names: [] })).toEqual({ ok: true, violations: [], scope: { names: ['a'] } });
    expect(reads).toBe(1);

    const outputFailure = (side: string) =>
      expect.objectContaining({ code: 'malformed', side, message: 'normalize must return plain data that structuredClone can copy' });
    for (const output of [new Proxy({ names: ['a'] }, {}), { names: ['a'], extra: () => 'x' }]) {
      const g = defineScopeGrammar({ provider: 'bad-out', dimensions, normalize: () => output as never, riskOf });
      expect(g.isSubset({ names: [] }, { names: [] }).violations).toEqual([outputFailure('request'), outputFailure('envelope')]);
    }
  });

  const notPlain = (side: string) => expect.objectContaining({ code: 'malformed', side, message: NOT_PLAIN_DATA });

  it('passes only plain JSON-like data to normalize: shared memory and other clonable objects are malformed', () => {
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
    expect(result.violations).toEqual([expect.objectContaining({ code: 'malformed', side: 'request' })]);
    const rootFailure = defineScopeGrammar({ provider: 'out', dimensions: two, normalize: () => ({ names: [], other: new Date(0) }) as never, riskOf });
    expect(rootFailure.normalize({}).violations).toEqual([
      expect.objectContaining({ code: 'malformed', side: 'request', message: `normalize result: ${NOT_PLAIN_DATA}` }),
    ]);
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
    const thrown = new Proxy(
      {},
      {
        get: () => {
          throw new Error('trap ran');
        },
      },
    );
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
    expect(Array.isArray(input.list)).toBe(true);
    expect(Object.getPrototypeOf(input.list)).not.toBe(Array.prototype);
  });

  describe('input arrays', () => {
    const grant = { permissions: ['test-write'] };
    /** Reads the first rule's permissions, as a provider normalize might. */
    const firstRule = defineScopeGrammar({
      provider: 'input-arrays',
      dimensions: { perms: { kind: 'exactSet', values: ['test-read', 'test-write'] } },
      normalize: ((input: { rules: { permissions?: string[] }[] }) => ({ perms: input.rules[0]?.permissions ?? [] })) as never,
      riskOf,
    });

    it.each([
      ['Object.prototype', Object.prototype],
      ['Array.prototype', Array.prototype],
    ])('grant nothing from an empty envelope array when %s[0] is polluted', (_label, target) => {
      const request = { rules: [grant] } as never;
      const emptyEnvelope = { rules: [] } as never;
      const before = firstRule.isSubset(request, emptyEnvelope).ok;
      const polluted = target as unknown as Record<number, unknown>;
      let during: { ok: boolean; perms: unknown };
      try {
        polluted[0] = grant;
        during = { ok: firstRule.isSubset(request, emptyEnvelope).ok, perms: firstRule.normalize(emptyEnvelope).scope?.perms };
      } finally {
        delete polluted[0];
      }
      expect(before).toBe(false);
      expect(during).toEqual({ ok: false, perms: [] });
    });

    it('stay working arrays at every depth, with a frozen null-prototype prototype and no constructor', () => {
      const seen: unknown[] = [];
      const g = defineScopeGrammar({
        provider: 'input-array-shape',
        dimensions: { names: { kind: 'exactSet' } },
        normalize: ((input: { names: string[]; nested: { lists: number[][] } }) => {
          const arrays = [input.names, input.nested.lists, input.nested.lists[0]!];
          const iterated: unknown[] = [];
          for (const name of input.names) iterated.push(name);
          seen.push(
            arrays.map(array => {
              const proto = Object.getPrototypeOf(array) as object;
              return [Array.isArray(array), Object.hasOwn(array, 'length'), Object.isFrozen(proto), Object.getPrototypeOf(proto), 'constructor' in array];
            }),
            input.names.map(name => name.toUpperCase()),
            input.names.filter(name => name !== 'b'),
            input.names.includes('b'),
            iterated,
            Array.isArray(input.names.map(name => name)) && Object.getPrototypeOf(input.names.map(name => name)) === Array.prototype,
          );
          return { names: input.names };
        }) as never,
        riskOf,
      });
      expect(g.normalize({ names: ['a', 'b'], nested: { lists: [[1], [2]] } } as never).ok).toBe(true);
      const shape = [true, true, true, null, false];
      expect(seen).toEqual([[shape, shape, shape], ['A', 'B'], ['a'], true, ['a', 'b'], true]);
    });

    it('copy only the standard Array.prototype method names at load, never data or a method added before load', async () => {
      const arrayPrototype = Array.prototype as unknown as Record<PropertyKey, unknown>;
      const pollutedSymbol = Symbol.for('test-polluted');
      // prettier-ignore
      const allowed = new Set<PropertyKey>([
        'at', 'concat', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find', 'findIndex', 'findLast',
        'findLastIndex', 'flat', 'flatMap', 'forEach', 'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map',
        'pop', 'push', 'reduce', 'reduceRight', 'reverse', 'shift', 'slice', 'some', 'sort', 'splice',
        'toLocaleString', 'toReversed', 'toSorted', 'toSpliced', 'toString', 'unshift', 'values', 'with',
        Symbol.iterator,
      ]);
      const prototypes: object[] = [];
      let results: { ok: boolean; perms: unknown };
      vi.resetModules();
      try {
        arrayPrototype[0] = { permissions: ['admin'] };
        arrayPrototype.testPollutedField = 'test-polluted';
        arrayPrototype.defaultPermissions = function defaultPermissions() {
          return ['admin'];
        };
        arrayPrototype[pollutedSymbol] = function testPolluted() {
          return ['admin'];
        };
        const fresh = await import('../../src/scopes/grammar.js');
        const g = fresh.defineScopeGrammar({
          provider: 'preload-arrays',
          dimensions: { perms: { kind: 'exactSet', values: ['test-read', 'admin'] } },
          normalize: ((input: { rules: (string | { permissions?: string[] })[] & Record<PropertyKey, unknown> }) => {
            prototypes.push(Object.getPrototypeOf(input.rules) as object);
            const first = input.rules[0];
            const perms = typeof first === 'object' ? (first.permissions ?? []) : input.rules.slice();
            if (input.rules.defaultPermissions || input.rules[pollutedSymbol]) (perms as string[]).push('admin');
            return { perms };
          }) as never,
          riskOf,
        });
        results = {
          ok: g.isSubset({ rules: [{ permissions: ['admin'] }] } as never, { rules: [] } as never).ok,
          perms: g.normalize({ rules: [] } as never).scope?.perms,
        };
      } finally {
        delete arrayPrototype[0];
        delete arrayPrototype.testPollutedField;
        delete arrayPrototype.defaultPermissions;
        delete arrayPrototype[pollutedSymbol];
        vi.resetModules();
      }
      expect(results).toEqual({ ok: false, perms: [] });
      expect(prototypes.length).toBeGreaterThan(0);
      for (const proto of prototypes) {
        expect(Reflect.ownKeys(proto).filter(key => !allowed.has(key))).toEqual([]);
        const nonFunctions = Reflect.ownKeys(proto).filter(key => typeof Object.getOwnPropertyDescriptor(proto, key)!.value !== 'function');
        expect(nonFunctions).toEqual([]);
        expect(Object.hasOwn(proto, 'map') && Object.hasOwn(proto, Symbol.iterator)).toBe(true);
      }
    });

    it('call the Array.prototype methods captured at load, not a later replacement', () => {
      const original = Array.prototype.map;
      const inputArrays = new Set<unknown>();
      const onInput: unknown[] = [];
      // Widens any input array it is called on; every other array is mapped as usual.
      const replacement = function (this: unknown[], ...args: Parameters<typeof original>) {
        if (!inputArrays.has(this)) return original.apply(this, args);
        onInput.push(this);
        return ['test-write'];
      };
      const g = defineScopeGrammar({
        provider: 'input-array-methods',
        dimensions: { perms: { kind: 'exactSet', values: ['test-read', 'test-write'] } },
        normalize: ((input: { perms: string[] }) => {
          inputArrays.add(input.perms);
          return { perms: input.perms.map(perm => perm) };
        }) as never,
        riskOf,
      });
      let result: boolean;
      try {
        Array.prototype.map = replacement as never;
        result = g.isSubset({ perms: ['test-write'] } as never, { perms: [] } as never).ok;
      } finally {
        Array.prototype.map = original;
      }
      expect(inputArrays.size).toBe(2);
      expect(onInput).toEqual([]);
      expect(result).toBe(false);
    });
  });
});

describe('isSubset captures the envelope before it reads or normalizes the request', () => {
  const g = defineScopeGrammar({ provider: 'order', dimensions: { perms: { kind: 'exactSet', values: ['test-read', 'test-write'] } }, riskOf });

  it('denies a request whose getter widens the envelope object', () => {
    expect(g.isSubset({ perms: ['test-write'] }, { perms: ['test-read'] }).ok).toBe(false);
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

  it('denies a request whose normalize call widens the captured envelope input', () => {
    const env = { side: 'envelope', perms: ['test-read'] };
    const n = defineScopeGrammar({
      provider: 'order',
      dimensions: { perms: { kind: 'exactSet', values: ['test-read', 'test-write'] } },
      normalize: ((input: { side: string; perms: string[] }) => {
        if (input.side === 'request') env.perms.push('test-write');
        return { perms: input.perms };
      }) as never,
      riskOf,
    });
    expect(n.isSubset({ side: 'request', perms: ['test-write'] } as never, env as never).ok).toBe(false);
  });
});

describe('the returned snapshot is the only thing classifyScope classifies (I4)', () => {
  it('classifies the frozen snapshot it judged, which later changes to the input cannot reach', () => {
    const request = { ...base, permissions: ['contents:read'] as string[] };
    const result = grammar.isSubset(request, envelope);
    request.permissions.push('admin');
    expect(result.scope?.permissions).toEqual(['contents:read']);
    expect(Object.isFrozen(result.scope)).toBe(true);
    expect(grammar.classifyScope(result.scope!)).toBe('read');
  });

  it('classifies only canonical snapshots this grammar returned', () => {
    const scope = grammar.isSubset(base, envelope).scope!;
    const other = defineScopeGrammar({ provider: 'other', dimensions: grammar.dimensions as never, riskOf });
    const dataOnly = defineScopeGrammar({ provider: 'data-only', dimensions: grammar.dimensions as never });
    const dataOnlyScope = dataOnly.normalize(base).scope!;
    expect(() => grammar.classifyScope({ ...scope })).toThrow(ScopeError);
    expect(() => grammar.classifyScope(Object.freeze(Object.assign(Object.create(null), scope)))).toThrow(ScopeError);
    expect(() => other.classifyScope(scope as never)).toThrow(ScopeError);
    expect(() => grammar.classifyScope(dataOnlyScope as never)).toThrow(ScopeError);
    for (const value of [null, undefined, 'scope', 1]) expect(() => grammar.classifyScope(value as never)).toThrow(ScopeError);
    const normalized = grammar.normalize({ ...base, permissions: ['admin'] });
    expect(normalized.ok && grammar.classifyScope(normalized.scope)).toBe('destructive');
  });

  it('accepts its own snapshot back as input', () => {
    const scope = grammar.isSubset(base, envelope).scope!;
    expect(grammar.isSubset(scope, envelope).ok).toBe(true);
    expect(grammar.classifyRisk(scope)).toBe('read');
  });
});

describe('every record a callback grammar hands out is its own (I7)', () => {
  const VIOLATION_FIELDS = ['code', 'side', 'dimension', 'item', 'limit', 'message'] as const;
  const pollution: Record<string, unknown> = {
    item: 'polluted-item',
    limit: 99,
    dimension: 'polluted-dimension',
    kind: 'polluted-kind',
    value: 'polluted-value',
    cause: 'polluted-cause',
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

  const items: object[] = [];
  const g = defineScopeGrammar({
    provider: 'own-records',
    dimensions: { ids: { kind: 'exactSet' }, paths: { kind: 'prefixGlobSet' }, rate: { kind: 'numericMax' }, ttl: { kind: 'ttlMax' } },
    riskOf: item => {
      items.push(item);
      return 'read';
    },
  });
  const fine = { ids: ['a'], paths: ['org/x'], rate: 1, ttl: 60 };

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
});

describe('classifyRisk', () => {
  it('returns the maximum risk over all requested items', () => {
    expect(grammar.classifyRisk(base)).toBe('read');
    expect(grammar.classifyRisk({ ...base, permissions: ['contents:read'] })).toBe('read');
    expect(grammar.classifyRisk({ ...base, permissions: ['contents:read', 'contents:write'] })).toBe('write');
    expect(grammar.classifyRisk({ ...base, permissions: ['admin', 'contents:read'] })).toBe('destructive');
    expect(grammar.classifyRisk({ ...base, permissions: ['contents:read', 'contents:write', 'admin'] })).toBe('destructive');
  });

  it('asks riskOf about every set member and scalar, in dimension order', () => {
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
    const caught = thrownBy(() => grammar.classifyRisk({ ...base, rate: -1 }));
    expect(caught).toBeInstanceOf(ScopeError);
    expect(caught.violations).toEqual([expect.objectContaining({ code: 'malformed', dimension: 'rate' })]);
    const proxy = new Proxy({ ...base }, {});
    expect(() => grammar.classifyRisk(proxy)).toThrow(expect.objectContaining({ name: 'ScopeError', cause: expect.objectContaining({ name: 'DataCloneError' }) }));
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
      const scope = levels.normalize({ names, size: 1 }).scope!;
      expect(() => levels.classifyScope(scope)).toThrow(ScopeError);
    }
    const laterScalar = defineScopeGrammar({
      provider: 'later-scalar',
      dimensions: { names: { kind: 'exactSet' }, size: { kind: 'numericMax' } },
      riskOf: ({ dimension }) => (dimension === 'names' ? 'destructive' : ('unknown' as never)),
    });
    expect(() => laterScalar.classifyRisk({ names: ['admin'], size: 1 })).toThrow(ScopeError);
    expect(levels.classifyRisk({ names: ['admin', 'x'], size: 1 })).toBe('destructive');
  });

  it('rejects every result outside the closed set of levels', () => {
    const results: unknown[] = ['admin', 'READ', '', undefined, null, 0, 2, new String('read'), { toString: () => 'read' }, ['read']];
    for (const result of results) {
      const broken = defineScopeGrammar({ provider: 'broken', dimensions: { names: { kind: 'exactSet' } }, riskOf: () => result as never });
      expect(() => broken.classifyRisk({ names: ['a'] }), String(result)).toThrow(/unknown risk/);
      expect(broken.classifyRisk({ names: [] })).toBe('read');
    }
  });

  describe('does not depend on the Array iteration protocol or call-time Array methods', () => {
    const iterator = Array.prototype[Symbol.iterator];
    const methods = { push: Array.prototype.push, map: Array.prototype.map };
    const isArray = Array.isArray;
    const tampers: Record<string, () => void> = {
      'an iterator that empties every array': () => {
        Array.prototype[Symbol.iterator] = function () {
          return iterator.call([]);
        };
      },
      'a push and map that do nothing, and an Array.isArray that is always false': () => {
        Array.prototype.push = function (this: unknown[]) {
          return this.length;
        };
        Array.prototype.map = function () {
          return [];
        } as never;
        Array.isArray = ((_: unknown) => false) as typeof Array.isArray;
      },
    };
    it.each(Object.keys(tampers))('still classifies every item with %s', name => {
      const scope = grammar.normalize({ ...base, permissions: ['contents:read', 'admin'] }).scope!;
      let risks: ScopeRisk[];
      try {
        tampers[name]!();
        risks = [grammar.classifyRisk({ ...base, permissions: ['contents:read', 'admin'] }), grammar.classifyScope(scope)];
      } finally {
        Array.prototype[Symbol.iterator] = iterator;
        Object.assign(Array.prototype, methods);
        Array.isArray = isArray;
      }
      expect(risks).toEqual(['destructive', 'destructive']);
    });
  });
});

describe('callbacks are synchronous and a returned promise is contained, never awaited (I5)', () => {
  const names = { names: { kind: 'exactSet' } } as const;
  const rejecting = (marker: string) => (input: { names: string[] }) => (input.names[0] === marker ? Promise.reject(new Error('normalize rejected')) : input);
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

  it('throws ScopeError for a resolved, rejected or async-thrown riskOf result, with no unhandled rejection', async () => {
    for (const result of [() => Promise.resolve('read'), () => Promise.reject(new Error('riskOf rejected')), () => asyncThrowing()]) {
      const g = defineScopeGrammar({ provider: 'p', dimensions: names, riskOf: result as never });
      const scope = g.normalize({ names: ['a'] }).scope!;
      const errors: unknown[] = [];
      const seen = await unhandledRejectionsOf(() => {
        errors.push(thrownBy(() => g.classifyRisk({ names: ['a', 'b'] })), thrownBy(() => g.classifyScope(scope)));
      });
      expect(seen).toEqual([]);
      for (const error of errors) {
        expect(error).toBeInstanceOf(ScopeError);
        expect((error as Error).message).toMatch(/unknown risk/);
      }
    }
  });

  it('keeps the promise its then derives from rejecting when a fulfilled value has a then that throws on a later read', async () => {
    // Promise.resolve reads `then` once (it is undefined then) and fulfills
    // with the object. Containment must not resolve the derived promise with
    // that object, which would read `then` again and reject it unhandled.
    const reads: number[] = [];
    const fulfilledWithLateThrowingThen = () => {
      const index = reads.length;
      reads.push(0);
      return Promise.resolve({
        get then() {
          reads[index]!++;
          if (reads[index]! > 1) throw new Error('then read again');
          return undefined;
        },
      });
    };
    const viaNormalize = defineScopeGrammar({ provider: 'p', dimensions: names, normalize: fulfilledWithLateThrowingThen as never, riskOf });
    const viaRisk = defineScopeGrammar({ provider: 'p', dimensions: names, riskOf: fulfilledWithLateThrowingThen as never });
    const scope = viaRisk.normalize({ names: ['a'] }).scope!;
    const results: unknown[] = [];
    const seen = await unhandledRejectionsOf(() => {
      results.push(viaNormalize.isSubset({ names: ['a'] }, { names: ['a'] }).violations);
      results.push(viaNormalize.normalize({ names: ['a'] }).ok);
      results.push(thrownBy(() => viaNormalize.classifyRisk({ names: ['a'] })) instanceof ScopeError);
      results.push(thrownBy(() => viaRisk.classifyRisk({ names: ['a'] })) instanceof ScopeError);
      results.push(thrownBy(() => viaRisk.classifyScope(scope)) instanceof ScopeError);
    });
    expect(seen).toEqual([]);
    expect(results).toEqual([
      [expect.objectContaining({ side: 'request', code: 'malformed' }), expect.objectContaining({ side: 'envelope', code: 'malformed' })],
      false,
      true,
      true,
      true,
    ]);
    expect(reads).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('reads Object.hasOwn captured at load, not through a replaced global Object', async () => {
    const RealObject = Object;
    const prototypeConstructor = RealObject.getOwnPropertyDescriptor(RealObject.prototype, 'constructor')!;
    let armed = false;
    const viaRisk = defineScopeGrammar({
      provider: 'p',
      dimensions: names,
      riskOf: (() => {
        armed = true;
        return RealObject.setPrototypeOf(Promise.reject(new Error('reparented rejected')), RealObject.prototype);
      }) as never,
    });
    // Reading `hasOwn` from the live global arms a throwing
    // Object.prototype.constructor getter that removes itself on first use,
    // so a check that read through it would wrongly skip the neutralization.
    const liveObject = new Proxy(RealObject, {
      get(target, key, receiver) {
        if (key === 'hasOwn' && armed) {
          armed = false;
          RealObject.defineProperty(RealObject.prototype, 'constructor', {
            configurable: true,
            get() {
              RealObject.defineProperty(RealObject.prototype, 'constructor', prototypeConstructor);
              throw new Error('species lookup threw');
            },
          });
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const results: unknown[] = [];
    const seen = await unhandledRejectionsOf(() => {
      (globalThis as { Object: unknown }).Object = liveObject;
      try {
        results.push(thrownBy(() => viaRisk.classifyRisk({ names: ['a'] })) instanceof ScopeError);
      } finally {
        (globalThis as { Object: unknown }).Object = RealObject;
        RealObject.defineProperty(RealObject.prototype, 'constructor', prototypeConstructor);
      }
    });
    expect(seen).toEqual([]);
    expect(results).toEqual([true]);
  });

  it('never reads or calls the own then of a returned native promise or a plain thenable', async () => {
    const ownThen = vi.fn();
    const thenReads = vi.fn();
    const withOwnThen = () => Object.defineProperty(Promise.reject(new Error('own then')), 'then', { value: ownThen });
    const thenable = () => ({ then: ownThen });
    // A non-enumerable getter, so structuredClone of the normalize result never reads it either.
    const thenGetter = () =>
      Object.defineProperty({}, 'then', {
        get() {
          thenReads();
          return ownThen;
        },
      });
    for (const make of [withOwnThen, thenable, thenGetter]) {
      const viaNormalize = defineScopeGrammar({ provider: 'p', dimensions: names, normalize: make as never, riskOf });
      const viaRisk = defineScopeGrammar({ provider: 'p', dimensions: names, riskOf: make as never });
      const results: unknown[] = [];
      const seen = await unhandledRejectionsOf(() => {
        results.push(viaNormalize.isSubset({ names: [] }, { names: [] }).ok);
        results.push(thrownBy(() => viaRisk.classifyRisk({ names: ['a'] })) instanceof ScopeError);
      });
      expect(seen).toEqual([]);
      expect(results).toEqual([make === thenGetter, true]);
    }
    expect(ownThen).not.toHaveBeenCalled();
    expect(thenReads).not.toHaveBeenCalled();
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
    /** A constructor value whose `Symbol.species` lookup throws. */
    const throwingSpeciesHolder = () =>
      Object.defineProperty({}, Symbol.species, {
        get() {
          throw new Error('species threw');
        },
      });
    const crossRealm = () => {
      const promise = runInNewContext('Promise.reject(new Error("cross-realm rejected"))') as object;
      Object.defineProperty(promise, 'constructor', {
        configurable: true,
        get() {
          throw new Error('constructor lookup threw');
        },
      });
      return promise;
    };
    const nonExtensibleConfigurable = () => Object.preventExtensions(throwingConstructor());
    const nonConfigurableWritable = () =>
      Object.defineProperty(Promise.reject(new Error('species rejected')), 'constructor', {
        value: throwingSpeciesHolder(),
        writable: true,
        configurable: false,
      });
    const makers: [string, () => object][] = [
      ['an own throwing constructor getter', throwingConstructor],
      ['a cross-realm promise with a configurable throwing constructor getter', crossRealm],
      ['a non-extensible promise with a configurable throwing constructor getter', nonExtensibleConfigurable],
      ['a non-configurable writable constructor whose species throws', nonConfigurableWritable],
      ['a subclass whose species getter throws', () => ThrowingSpecies.reject(new Error('species rejected'))],
      ['a subclass whose species is not a constructor', () => NonConstructorSpecies.reject(new Error('species rejected'))],
    ];

    type Made = [value: object, before: PropertyDescriptor | undefined];

    /** Every path: normalize on either side, normalize() and classifyRisk, and riskOf through classifyRisk and classifyScope. */
    function runAll(make: () => object, made: Made[]) {
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
      const scope = viaRisk.normalize({ names: ['a'] }).scope!;
      return [
        viaNormalize.isSubset({ names: ['reject'] }, { names: [] }).violations.map(v => v.side),
        viaNormalize.isSubset({ names: [] }, { names: ['reject'] }).violations.map(v => v.side),
        viaNormalize.normalize({ names: ['reject'] }).ok,
        thrownBy(() => viaRisk.classifyRisk({ names: ['a'] })) instanceof ScopeError,
        thrownBy(() => viaRisk.classifyScope(scope)) instanceof ScopeError,
      ];
    }

    /** What `runAll` returns when every path fails closed, and how many values it makes. */
    const FAILED_CLOSED = [['request'], ['envelope'], false, true, true];
    const PATHS = FAILED_CLOSED.length;

    /** How `value` settles, read through the intrinsic `then` once the ambient state is restored. */
    function settlement(value: object): Promise<unknown> {
      return new Promise(resolve => {
        Promise.prototype.then.call(
          value,
          () => resolve('fulfilled'),
          (reason: unknown) => resolve(reason),
        );
      });
    }

    it.each(makers)('contains %s on every path and restores the own constructor exactly', async (_label, make) => {
      const made: Made[] = [];
      let results: unknown[] = [];
      const seen = await unhandledRejectionsOf(() => {
        results = runAll(make, made);
      });
      expect(seen).toEqual([]);
      expect(results).toEqual(FAILED_CLOSED);
      expect(made).toHaveLength(PATHS);
      for (const [value, before] of made) {
        const after = Object.getOwnPropertyDescriptor(value, 'constructor');
        expect(after).toEqual(before);
        expect(after?.get).toBe(before?.get);
        expect(after?.value).toBe(before?.value);
      }
    });

    /**
     * Caller code that would run inside then's species lookup, change the
     * state a containment decision could read, and then throw. Each must still
     * leave no unhandled rejection: the decision is made before `then` runs,
     * and an own `constructor` is neutralized first, so its lookup never runs
     * and the descriptor is restored exactly.
     */
    interface StateChange {
      /** Applies ambient state for the call, returning its cleanup. */
      readonly ambient?: () => () => void;
      /** Makes one rejected promise. */
      readonly make: () => object;
      /** The own `constructor` the promise holds after containment, given the one it held before. */
      readonly expectOwn: (value: object, before: PropertyDescriptor | undefined) => void;
    }
    const reparented = () => Object.setPrototypeOf(Promise.reject(new Error('state-change rejected')), Object.prototype) as object;
    const objectConstructor = Object.getOwnPropertyDescriptor(Object.prototype, 'constructor')!;
    const functionPrototype = Object.getPrototypeOf(Object) as object;
    const replacementGetter = () => undefined;
    const stateChanges: Record<string, StateChange> = {
      'an Object.prototype.constructor getter that restores the intrinsic data property, then throws': {
        ambient: () => {
          Object.defineProperty(Object.prototype, 'constructor', {
            configurable: true,
            get() {
              Object.defineProperty(Object.prototype, 'constructor', objectConstructor);
              throw new Error('ambient constructor threw');
            },
          });
          return () => Object.defineProperty(Object.prototype, 'constructor', objectConstructor);
        },
        make: reparented,
        expectOwn: value => expect(Object.getOwnPropertyDescriptor(value, 'constructor')).toBeUndefined(),
      },
      'an Object[Symbol.species] getter that deletes itself, then throws': {
        ambient: () => {
          Object.defineProperty(Object, Symbol.species, {
            configurable: true,
            get() {
              delete (Object as unknown as Record<symbol, unknown>)[Symbol.species];
              throw new Error('ambient species threw');
            },
          });
          return () => {
            delete (Object as unknown as Record<symbol, unknown>)[Symbol.species];
          };
        },
        make: reparented,
        expectOwn: value => expect(Object.getOwnPropertyDescriptor(value, 'constructor')).toBeUndefined(),
      },
      'a Proxy in the ambient constructor chain that hides Symbol.species from descriptors and throws on get': {
        ambient: () => {
          const proxy = new Proxy(functionPrototype, {
            getOwnPropertyDescriptor: (target, key) => (key === Symbol.species ? undefined : Reflect.getOwnPropertyDescriptor(target, key)),
            get: (target, key, receiver) => {
              if (key === Symbol.species) throw new Error('proxy species threw');
              return Reflect.get(target, key, receiver) as unknown;
            },
          });
          Object.setPrototypeOf(Object, proxy);
          return () => Object.setPrototypeOf(Object, functionPrototype);
        },
        make: reparented,
        expectOwn: value => expect(Object.getOwnPropertyDescriptor(value, 'constructor')).toBeUndefined(),
      },
      'an own configurable constructor getter that deletes itself, then throws': {
        make: () => {
          const promise = reparented();
          Object.defineProperty(promise, 'constructor', {
            configurable: true,
            get() {
              delete (promise as { constructor?: unknown }).constructor;
              throw new Error('own constructor threw');
            },
          });
          return promise;
        },
        expectOwn: (value, before) => {
          const after = Object.getOwnPropertyDescriptor(value, 'constructor');
          expect(after).toEqual(before);
          expect(after?.get).toBe(before?.get);
          expect(after?.value).toBe(before?.value);
        },
      },
      'an own configurable constructor getter that replaces itself with another accessor, then throws': {
        make: () => {
          const promise = Promise.reject(new Error('state-change rejected'));
          Object.defineProperty(promise, 'constructor', {
            configurable: true,
            get() {
              Object.defineProperty(promise, 'constructor', { configurable: true, get: replacementGetter });
              throw new Error('own constructor threw');
            },
          });
          return promise;
        },
        expectOwn: (value, before) => {
          const after = Object.getOwnPropertyDescriptor(value, 'constructor');
          expect(after).toEqual(before);
          expect(after?.get).toBe(before?.get);
          expect(after?.value).toBe(before?.value);
        },
      },
      'an own constructor whose species getter deletes that constructor, then throws': {
        make: () => {
          const promise = Promise.reject(new Error('state-change rejected'));
          const holder = Object.defineProperty({}, Symbol.species, {
            get() {
              delete (promise as { constructor?: unknown }).constructor;
              throw new Error('species threw');
            },
          });
          Object.defineProperty(promise, 'constructor', { configurable: true, writable: true, value: holder });
          return promise;
        },
        expectOwn: (value, before) => {
          const after = Object.getOwnPropertyDescriptor(value, 'constructor');
          expect(after).toEqual(before);
          expect(after?.get).toBe(before?.get);
          expect(after?.value).toBe(before?.value);
        },
      },
    };

    it.each(Object.keys(stateChanges))(
      'leaves no unhandled rejection when %s, keeps the value rejected and the descriptor state',
      async name => {
        const change = stateChanges[name]!;
        const made: Made[] = [];
        let results: unknown[] = [];
        const seen = await unhandledRejectionsOf(() => {
          const cleanup = change.ambient?.();
          try {
            results = runAll(change.make, made);
          } finally {
            cleanup?.();
          }
        });
        expect(seen).toEqual([]);
        expect(results).toEqual(FAILED_CLOSED);
        expect(made).toHaveLength(PATHS);
        for (const [value, before] of made) {
          change.expectOwn(value, before);
          expect(await settlementWithDefaultSpecies(value)).toEqual(new Error('state-change rejected'));
        }
      },
    );

    /**
     * A species whose constructor completes but whose resolving functions
     * reject: `then` succeeds, yet the promise it derives would reject with no
     * handler. Containment neutralizes `constructor` before `then` runs, so
     * the intrinsic `Promise` derives that promise instead.
     */
    type Executor = (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => void;
    class RejectingResolve extends Promise<unknown> {
      constructor(executor: Executor) {
        super((_resolve, reject) => executor(() => reject(undefined), reject));
      }
    }
    /** A species constructor that hands `then` its own rejected promise as the derived one. */
    function RejectedCapability(executor: Executor) {
      executor(
        () => undefined,
        () => undefined,
      );
      return Promise.reject(new Error('species promise rejected'));
    }
    const ownSpecies = (species: unknown) => () =>
      Object.defineProperty(Promise.reject(new Error('species rejected')), 'constructor', {
        configurable: true,
        writable: true,
        value: { [Symbol.species]: species },
      });
    const customSpecies: [string, () => object][] = [
      ['an own constructor whose species resolves by rejecting', ownSpecies(RejectingResolve)],
      ['an own constructor whose species returns a rejected promise', ownSpecies(RejectedCapability)],
      ['a subclass instance (Evil.reject) whose species resolves by rejecting', () => RejectingResolve.reject(new Error('species rejected'))],
    ];

    /** `settlement` with `constructor` neutralized for the read, so the custom species never derives a promise. */
    function settlementWithDefaultSpecies(value: object): Promise<unknown> {
      const before = Object.getOwnPropertyDescriptor(value, 'constructor');
      Object.defineProperty(value, 'constructor', { configurable: true, writable: true, value: undefined });
      try {
        return settlement(value);
      } finally {
        if (before) Object.defineProperty(value, 'constructor', before);
        else delete (value as { constructor?: unknown }).constructor;
      }
    }

    it.each(customSpecies)(
      'leaves no unhandled rejection for %s, keeps the value rejected and restores the own constructor exactly',
      async (_label, make) => {
        const made: Made[] = [];
        let results: unknown[] = [];
        const seen = await unhandledRejectionsOf(() => {
          results = runAll(make, made);
        });
        expect(seen).toEqual([]);
        expect(results).toEqual(FAILED_CLOSED);
        expect(made).toHaveLength(PATHS);
        for (const [value, before] of made) {
          const after = Object.getOwnPropertyDescriptor(value, 'constructor');
          expect(after).toEqual(before);
          expect(after?.value).toBe(before?.value);
          expect(await settlementWithDefaultSpecies(value)).toEqual(new Error('species rejected'));
        }
      },
    );

    /** A Proxy over a plain record that counts every defineProperty and deleteProperty trap. */
    function countingProxy(target: object, counter: { writes: number }) {
      return new Proxy(target, {
        defineProperty(t, key, descriptor) {
          counter.writes++;
          return Reflect.defineProperty(t, key, descriptor);
        },
        deleteProperty(t, key) {
          counter.writes++;
          return Reflect.deleteProperty(t, key);
        },
      });
    }

    it('keeps the fast path for a plain or null-prototype record: no property is ever defined on it', () => {
      for (const makeTarget of [() => ({ names: ['a'] }), () => Object.assign(Object.create(null) as object, { names: ['a'] })]) {
        const counter = { writes: 0 };
        expect(runAll(() => countingProxy(makeTarget(), counter), [])).toEqual(FAILED_CLOSED);
        expect(counter.writes).toBe(0);
      }
    });

    it('neutralizes constructor on a plain record only when the ambient state is not the default, and leaves the record unchanged', () => {
      const counter = { writes: 0 };
      const targets: object[] = [];
      let results: unknown[];
      Object.defineProperty(Object.prototype, 'constructor', { ...objectConstructor, value: 'test-not-a-constructor' });
      try {
        results = runAll(() => {
          const target = { names: ['a'] };
          targets.push(target);
          return countingProxy(target, counter);
        }, []);
      } finally {
        Object.defineProperty(Object.prototype, 'constructor', objectConstructor);
      }
      expect(results).toEqual(FAILED_CLOSED);
      expect(counter.writes).toBe(2 * PATHS);
      for (const target of targets) expect(Reflect.ownKeys(target)).toEqual(['names']);
      // A null-prototype record keeps the fast path even then.
      const nullCounter = { writes: 0 };
      Object.defineProperty(Object.prototype, 'constructor', { ...objectConstructor, value: 'test-not-a-constructor' });
      try {
        results = runAll(() => countingProxy(Object.assign(Object.create(null) as object, { names: ['a'] }), nullCounter), []);
      } finally {
        Object.defineProperty(Object.prototype, 'constructor', objectConstructor);
      }
      expect(results).toEqual(FAILED_CLOSED);
      expect(nullCounter.writes).toBe(0);
    });

    /** Restores every own descriptor `target` had for `key` when `run` started. */
    function withAmbient(target: object, key: PropertyKey, descriptor: PropertyDescriptor, run: () => void) {
      const original = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, key, descriptor);
      try {
        run();
      } finally {
        if (original === undefined) delete (target as Record<PropertyKey, unknown>)[key];
        else Object.defineProperty(target, key, original);
      }
    }

    it.each([
      ['Object.prototype.constructor is not a constructor', Object.prototype, 'constructor', { value: 'test-not-a-constructor', writable: true, configurable: true }],
      [
        'Object[Symbol.species] throws',
        Object,
        Symbol.species,
        {
          configurable: true,
          get() {
            throw new Error('species threw');
          },
        },
      ],
      ...[
        ['Function.prototype', Function.prototype],
        ['Object.prototype', Object.prototype],
      ].flatMap(([where, target]) => [
        [
          `${where as string}[Symbol.species] throws`,
          target,
          Symbol.species,
          {
            configurable: true,
            get() {
              throw new Error('inherited species threw');
            },
          },
        ],
        [`${where as string}[Symbol.species] is not a constructor`, target, Symbol.species, { value: 'test-not-a-constructor', writable: true, configurable: true }],
      ]),
    ] as [string, object, PropertyKey, PropertyDescriptor][])('contains a promise reparented to Object.prototype when %s', async (_label, target, key, descriptor) => {
      const made: Made[] = [];
      let results: unknown[] = [];
      const seen = await unhandledRejectionsOf(() => {
        withAmbient(target, key, descriptor, () => {
          results = runAll(reparented, made);
        });
      });
      expect(seen).toEqual([]);
      expect(results).toEqual(FAILED_CLOSED);
      expect(made).toHaveLength(PATHS);
      for (const [value] of made) expect(Object.hasOwn(value, 'constructor')).toBe(false);
    });

    it.each([
      [
        'restores a configurable own constructor',
        () =>
          Object.defineProperty(Object.create(Promise.prototype), 'constructor', {
            configurable: true,
            get() {
              throw new Error('constructor lookup threw');
            },
          }) as object,
      ],
      ['deletes the constructor it defined', () => Object.create(Promise.prototype) as object],
    ])('%s when a defineProperty trap applies the change and then throws', (_label, makeTarget) => {
      const targets: Made[] = [];
      let traps = 0;
      const proxied = () => {
        const target = makeTarget();
        targets.push([target, Object.getOwnPropertyDescriptor(target, 'constructor')]);
        return new Proxy(target, {
          defineProperty(t, key, descriptor) {
            traps++;
            Reflect.defineProperty(t, key, descriptor);
            throw new Error('defineProperty trap threw');
          },
        });
      };
      expect(runAll(proxied, [])).toEqual(FAILED_CLOSED);
      expect(traps).toBeGreaterThan(0);
      expect(targets).toHaveLength(PATHS);
      for (const [target, before] of targets) {
        const after = Object.getOwnPropertyDescriptor(target, 'constructor');
        expect(after).toEqual(before);
        expect(after?.get).toBe(before?.get);
      }
    });

    it('contains a plain rejected promise after Promise[Symbol.species] is redefined to throw', async () => {
      const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!;
      const made: Made[] = [];
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
      expect(results).toEqual(FAILED_CLOSED);
      expect(made).toHaveLength(PATHS);
      for (const [value] of made) expect(Object.hasOwn(value, 'constructor')).toBe(false);
    });

    it('still fails closed on the documented residual: a non-configurable accessor or read-only constructor, or a non-extensible promise without one', () => {
      const nonConfigurableAccessor = () =>
        Object.defineProperty(Promise.resolve('settled'), 'constructor', {
          get() {
            throw new Error('constructor lookup threw');
          },
        });
      const nonConfigurableReadOnly = () =>
        Object.defineProperty(Promise.resolve('settled'), 'constructor', { value: throwingSpeciesHolder(), writable: false, configurable: false });
      const nonExtensible = () => Object.preventExtensions(ThrowingSpecies.resolve('settled' as never));
      for (const make of [nonConfigurableAccessor, nonConfigurableReadOnly, nonExtensible]) {
        expect(runAll(make, [])).toEqual(FAILED_CLOSED);
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
