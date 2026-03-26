import { beforeEach, describe, expect, it } from 'vitest';
import { UIFnError } from '../errors';
import {
  assertUniquePublicId,
  composePublicId,
  createDeterministicIdFactory,
  createIdFactory,
  createIdScope,
  createPublicIdRegistry,
  generateId,
  getIdCounterSnapshot,
  getPublicIdSnapshot,
  resetIdCounters,
  reusePublicId,
} from './id';

describe('id utilities', () => {
  beforeEach(() => {
    resetIdCounters();
  });

  it('generates deterministic ids per token', () => {
    expect(generateId('dialog-title')).toBe('uifn-dialog-title-1');
    expect(generateId('dialog-description')).toBe('uifn-dialog-description-1');
    expect(generateId('dialog-title')).toBe('uifn-dialog-title-2');
  });

  it('supports per-instance prefixes and slot suffixes', () => {
    const factory = createDeterministicIdFactory();

    expect(factory.compose({ prefix: 'dialog-instance-1', slot: 'content' })).toBe(
      'uifn-dialog-instance-1-content'
    );
    expect(factory.create({ prefix: 'dialog-instance-1', slot: 'content' })).toBe(
      'uifn-dialog-instance-1-content-1'
    );
    expect(factory.create({ prefix: 'dialog-instance-1', slot: 'title' })).toBe(
      'uifn-dialog-instance-1-title-1'
    );
  });

  it('supports server/client matching sequences with isolated scopes', () => {
    const serverFactory = createIdFactory();
    const clientFactory = createIdScope();
    const sequence = ['dialog-title', 'dialog-description', 'dialog-title'];

    expect(sequence.map((token) => serverFactory.next(token))).toEqual(
      sequence.map((token) => clientFactory.next(token))
    );
  });

  it('supports hydration-safe reuse of existing ids', () => {
    const serverFactory = createDeterministicIdFactory();
    const serverId = serverFactory.create({ prefix: 'dialog-instance-2', slot: 'title' });

    const clientFactory = createDeterministicIdFactory();
    expect(clientFactory.reuse(serverId, { prefix: 'dialog-instance-2', slot: 'title' })).toBe(serverId);
  });

  it('detects duplicate public ids with canonical errors', () => {
    const registry = createPublicIdRegistry();

    expect(assertUniquePublicId('dialog-content', registry)).toBe('dialog-content');
    expect(() =>
      assertUniquePublicId('dialog-content', registry, {
        component: 'DialogContent',
      })
    ).toThrowError(UIFnError);

    try {
      assertUniquePublicId('dialog-content', registry, {
        component: 'DialogContent',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(UIFnError);
      expect((error as UIFnError).code).toBe('UIFN_ERR_DUPLICATE_PUBLIC_ID');
      expect((error as UIFnError).message).toBe(
        'GA surfaces MUST NOT share fixed instance-scoped IDs.'
      );
    }
  });

  it('keeps global counters namespaced and resettable', () => {
    expect(generateId()).toBe('uifn-id-1');
    expect(generateId('uifn-dialog-title')).toBe('uifn-dialog-title-1');
    expect(getIdCounterSnapshot()).toEqual({
      'uifn-dialog-title': 1,
      'uifn-id': 1,
    });

    resetIdCounters('uifn-dialog-title');
    expect(generateId('dialog-title')).toBe('uifn-dialog-title-1');
  });

  it('tracks issued ids and supports public helpers through the global scope', () => {
    const first = reusePublicId(undefined, { prefix: 'popover-instance-1', slot: 'content' });
    const second = reusePublicId(undefined, { prefix: 'popover-instance-1', slot: 'title' });

    expect(first).toBe('uifn-popover-instance-1-content-1');
    expect(second).toBe('uifn-popover-instance-1-title-1');
    expect(getPublicIdSnapshot()).toEqual({
      counters: {
        'uifn-popover-instance-1-content': 1,
        'uifn-popover-instance-1-title': 1,
      },
      issued: [first, second],
    });
  });

  it('composes stable public-id bases without generating counters', () => {
    expect(composePublicId('dialog-title')).toBe('uifn-dialog-title');
    expect(composePublicId({ prefix: 'dialog-instance-3', slot: 'description' })).toBe(
      'uifn-dialog-instance-3-description'
    );
  });
});
