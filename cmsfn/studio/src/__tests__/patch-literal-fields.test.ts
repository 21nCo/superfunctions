import { expect, it } from 'vitest';
import { buildPatchOps } from '../editor/save/buildPatchOps.js';
it('saves literal keys and nested objects without path collisions', () => {
  expect(buildPatchOps({ 'a.b': 'old', a: { b: 'nested', keep: true } }, { 'a.b': 'literal edit', a: { b: 'nested', keep: true, 'literal.asset': { _type: 'asset', _ref: 'asset-1' } } })).toEqual([
    { op: 'set', path: 'a', value: { b: 'nested', keep: true, 'literal.asset': { _type: 'asset', _ref: 'asset-1' } } },
    { op: 'set', path: ['a.b'], value: 'literal edit' },
  ]);
});
it('retains empty objects and custom underscore fields while excluding system metadata', () => {
  expect(buildPatchOps({ _rev: 'old', _custom: 'old', section: { _nested: 'old' }, removed: 1 }, { _rev: 'new', _custom: 'new', section: {} })).toEqual([
    { op: 'set', path: '_custom', value: 'new' },
    { op: 'unset', path: 'removed' },
    { op: 'set', path: 'section', value: {} },
  ]);
});
