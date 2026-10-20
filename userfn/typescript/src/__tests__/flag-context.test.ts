import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { UserFnClient } from '../index';
import { FlagEvaluator } from '../core/flags';
import { SegmentEvaluator } from '../core/segments';
import type { FlagConfig, FlagValue } from '../types';
const flag = (key: string, extra: Partial<FlagConfig> = {}): FlagConfig => ({ key, enabled: true, defaultValue: true, variations: [], rules: [], ...extra });
const evaluator = (flags: FlagConfig[], environment?: string) => new FlagEvaluator(flags, new SegmentEvaluator(), environment);

describe('flag prerequisites', () => {
  it.each([
    [false, false, true], [0, 0, true], ['', '', true], [true, 1, false], [0, false, false],
    ['1', 1, false], [9007199254740991, 9007199254740992, false], [9007199254740992, Number('9007199254740993'), true], [[1, false], [1, false], true], [[1, 2], [2, 1], false],
    [{ b: [false, 0], a: 'x' }, { a: 'x', b: [false, 0] }, true],
  ])('compares JSON values without truthiness or type coercion', (value, expected, matches) => {
    const engine = evaluator([flag('dependency', { defaultValue: value as FlagValue }), flag('target', { prerequisites: [{ key: 'dependency', expectedValue: expected as FlagValue }] })]);
    expect(engine.getFlag('target', 'unavailable')).toBe(matches ? true : 'unavailable');
  });

  it('fails closed for missing, disabled, unmet and cyclic dependencies rather than comparing fallbacks', () => {
    const cases: FlagConfig[][] = [
      [flag('target', { prerequisites: [{ key: 'missing', expectedValue: false }] })],
      [flag('off', { enabled: false, defaultValue: false }), flag('target', { prerequisites: [{ key: 'off', expectedValue: false }] })],
      [flag('target', { prerequisites: [{ key: 'target', expectedValue: true }] })],
      [flag('target', { prerequisites: [{ key: 'other', expectedValue: false }] }), flag('other', { defaultValue: false, prerequisites: [{ key: 'target', expectedValue: true }] })],
      [flag('one'), flag('two', { defaultValue: false }), flag('target', { prerequisites: [{ key: 'one', expectedValue: true }, { key: 'two', expectedValue: true }] })],
    ];
    for (const flags of cases) expect(evaluator(flags).getFlag('target', 'unavailable')).toBe('unavailable');
  });

  it('resolves long dependency chains without recursion limits and does not depend on insertion order', () => {
    const flags = Array.from({ length: 5000 }, (_, index) => flag(String(index), index === 4999 ? {} : { prerequisites: [{ key: String(index + 1), expectedValue: true }] }));
    expect(evaluator(flags.reverse()).getFlag('0', false)).toBe(true);
  });

  it('uses the same current user for dependencies and does not reuse outcomes across identities', () => {
    const client = new UserFnClient({ apiKey: 'unused' });
    client.setSegments([{ id: 'paid', name: 'Paid', rules: [{ id: 'plan', field: 'plan', operator: 'equals', value: 'pro' }] }]);
    client.setFlags([flag('gate', { defaultValue: false, variations: [{ id: 'on', value: true }], rules: [{ id: 'paid', segmentId: 'paid', variationId: 'on' }] }), flag('target', { prerequisites: [{ key: 'gate', expectedValue: true }] })]);
    expect(client.getFlag('target', false)).toBe(false);
    client.identify('user-a', { plan: 'pro' }); expect(client.getFlag('target', false)).toBe(true);
    client.identify('user-b', { plan: 'free' }); expect(client.getFlag('target', false)).toBe(false);
    client.reset(); expect(client.getFlag('target', false)).toBe(false);
  });
});

describe('environment overrides', () => {
  it('applies the environment across dependencies, inherits omitted fields and preserves global kills', () => {
    const flags = [flag('gate', { defaultValue: false, environmentOverrides: { production: { defaultValue: true } } }), flag('target', { defaultValue: 'base', prerequisites: [{ key: 'gate', expectedValue: true }], environmentOverrides: { production: { defaultValue: 'production' }, disabled: { enabled: false } } })];
    const production = new UserFnClient({ apiKey: 'unused', environment: 'production' }); production.setFlags(flags);
    expect(production.getFlag('target', 'fallback')).toBe('production');
    expect(evaluator(flags).getFlag('target', 'fallback')).toBe('fallback');
    expect(evaluator(flags, 'Production').getFlag('target', 'fallback')).toBe('fallback');
    expect(evaluator(flags, 'disabled').getFlag('target', 'fallback')).toBe('fallback');
    flags[1].enabled = false; flags[1].environmentOverrides!.production.enabled = true;
    expect(evaluator(flags, 'production').getFlag('target', 'fallback')).toBe('fallback');
    expect(production.getFlag('target', 'fallback')).toBe('production'); // Loaded snapshot is isolated.
  });

  it('replaces ordered rules and can explicitly clear inherited default variation', () => {
    const definition = flag('target', { defaultValue: 'base', defaultVariationId: 'variant', variations: [{ id: 'variant', value: 'variation' }], rules: [{ id: 'base', variationId: 'variant' }], environmentOverrides: {
      inherit: {}, empty: { rules: [] }, cleared: { rules: [], defaultVariationId: null, defaultValue: '' },
      zero: { rules: [], defaultVariationId: null, defaultValue: 0 }, off: { enabled: false },
    } });
    expect(evaluator([definition], 'inherit').getFlag('target', false)).toBe('variation');
    expect(evaluator([definition], 'empty').getFlag('target', false)).toBe('variation');
    expect(evaluator([definition], 'cleared').getFlag('target', false)).toBe('');
    expect(evaluator([definition], 'zero').getFlag('target', false)).toBe(0);
    expect(evaluator([definition], 'off').getFlag('target', 'fallback')).toBe('fallback');
  });

  it('uses only own environment entries, including prototype-like literal names', () => {
    const definition = flag('target', { defaultValue: 'base', environmentOverrides: JSON.parse('{"__proto__":{"defaultValue":"literal"}}') });
    expect(evaluator([definition], '__proto__').getFlag('target', false)).toBe('literal');
    expect(evaluator([definition], 'toString').getFlag('target', false)).toBe('base');
    expect(evaluator([definition], 'constructor').getFlag('target', false)).toBe('base');
  });
});

describe('runtime configuration validation', () => {
  it('rejects malformed/nonfinite/cyclic configuration atomically', () => {
    const engine = evaluator([flag('stable')]); const cyclic: any = {}; cyclic.self = cyclic;
    const invalid = [
      [flag('bad', { defaultValue: NaN })], [flag('bad', { prerequisites: [{ key: 'x', expectedValue: Infinity }] })],
      [flag('bad', { prerequisites: [{ key: 'x' }] as any })], [flag('bad', { prerequisites: [{ key: 'x', expectedValue: cyclic }] })],
      [flag('bad', { defaultValue: new Date() })], [flag('duplicate'), flag('duplicate')],
      [flag('bad', { environmentOverrides: { production: { prerequisites: [] } as any } })],
      [flag('bad', { rules: [{ id: 'bad', rolloutPercentage: -1 }] })],
      [flag('bad', { defaultVariationId: 'missing' })],
    ];
    for (const replacement of invalid) { expect(() => engine.setFlags(replacement)).toThrow(TypeError); expect(engine.getFlag('stable', false)).toBe(true); }
    expect(() => evaluator([], '')).toThrow(TypeError);
    engine.setFlags([]); expect(engine.getFlag('stable', false)).toBe(false);
  });
});

const rolloutVectors = JSON.parse(readFileSync(new URL('../../../python/tests/fixtures/hash-vectors.json', import.meta.url), 'utf8')) as Array<{key: string; userId: string; bucket: number}>;
it.each(rolloutVectors)('evaluates environment rollout prerequisites for shared vector $key / $userId', vector => {
  const client = new UserFnClient({ apiKey: 'unused', environment: 'production' });
  client.setFlags([
    flag(vector.key, { defaultValue: false, variations: [{ id: 'on', value: true }], rules: [{ id: 'base', rolloutPercentage: 100, variationId: 'on' }], environmentOverrides: { production: { rules: [{ id: 'production', rolloutPercentage: 25, variationId: 'on' }] } } }),
    flag('dependent', { defaultValue: 'enabled', prerequisites: [{ key: vector.key, expectedValue: true }] }),
  ]);
  client.identify(vector.userId);
  expect(client.getFlag('dependent', 'disabled')).toBe(vector.bucket < 25 ? 'enabled' : 'disabled');
});

it('isolates returned structured values from later prerequisite evaluations', () => {
  const engine = evaluator([flag('gate', { defaultValue: { ready: false } }), flag('target', { prerequisites: [{ key: 'gate', expectedValue: { ready: false } }] })]);
  const returned = engine.getFlag('gate', false) as { ready: boolean }; returned.ready = true;
  expect(engine.getFlag('target', false)).toBe(true);
  expect(engine.getFlag('gate', false)).toEqual({ ready: false });
});


it('rejects config accessors and serialization hooks without invoking them or replacing state', () => {
  const engine = evaluator([flag('stable')]);
  let calls = 0;
  const accessor = flag('changed');
  Object.defineProperty(accessor, 'enabled', { enumerable: true, get() { calls++; return true; } });
  const hook = { ...flag('changed'), toJSON() { calls++; return flag('changed', { enabled: false }); } };
  const ruleHook = flag('changed', { rules: [{ id: 'rule', toJSON() { calls++; return {}; } } as any] });
  for (const replacement of [[accessor], [hook], [ruleHook]]) {
    expect(() => engine.setFlags(replacement)).toThrow(TypeError);
    expect(engine.getFlag('stable', false)).toBe(true);
  }
  expect(calls).toBe(0);
  engine.setFlags([flag('optional', { defaultVariationId: undefined, environmentOverrides: { prod: { enabled: undefined } } })]);
  expect(engine.getFlag('optional', false)).toBe(true);
});
