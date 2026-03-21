import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIdFactory,
  createIdScope,
  generateId,
  getIdCounterSnapshot,
  resetIdCounters,
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

  it('supports server/client matching sequences with isolated scopes', () => {
    const serverFactory = createIdFactory();
    const clientFactory = createIdScope();
    const sequence = ['dialog-title', 'dialog-description', 'dialog-title'];

    expect(sequence.map((token) => serverFactory.next(token))).toEqual(
      sequence.map((token) => clientFactory.next(token))
    );
  });

  it('keeps global counters namespaced and resettable', () => {
    expect(generateId()).toBe('uifn-1');
    expect(generateId('uifn-dialog-title')).toBe('uifn-dialog-title-1');
    expect(getIdCounterSnapshot()).toEqual({
      uifn: 1,
      'uifn-dialog-title': 1,
    });

    resetIdCounters('uifn-dialog-title');
    expect(generateId('dialog-title')).toBe('uifn-dialog-title-1');
  });
});
