import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  isTerminalState,
  getValidTransitions,
} from '../src/validators/state-machine.js';
import { RecFnError } from '../src/errors.js';
import type { BotStatus } from '../src/types.js';

describe('canTransition', () => {
  it('allows forward transitions through the happy path (TV-BOT-003)', () => {
    expect(canTransition('creating', 'joining')).toBe(true);
    expect(canTransition('joining', 'joined')).toBe(true);
    expect(canTransition('joined', 'recording')).toBe(true);
    expect(canTransition('joined', 'leaving')).toBe(true);
    expect(canTransition('recording', 'leaving')).toBe(true);
    expect(canTransition('leaving', 'left')).toBe(true);
    expect(canTransition('left', 'done')).toBe(true);
  });

  it('allows transition to error from any non-terminal state', () => {
    const nonTerminal: BotStatus[] = [
      'creating', 'joining', 'joined', 'recording', 'leaving', 'left',
    ];
    for (const status of nonTerminal) {
      expect(canTransition(status, 'error')).toBe(true);
    }
  });

  it('rejects backward transitions', () => {
    expect(canTransition('recording', 'joined')).toBe(false);
    expect(canTransition('joined', 'joining')).toBe(false);
    expect(canTransition('left', 'leaving')).toBe(false);
    expect(canTransition('done', 'recording')).toBe(false);
  });

  it('rejects transitions from terminal states (done, error)', () => {
    expect(canTransition('done', 'creating')).toBe(false);
    expect(canTransition('done', 'error')).toBe(false);
    expect(canTransition('error', 'creating')).toBe(false);
    expect(canTransition('error', 'joining')).toBe(false);
  });

  it('rejects skipping states', () => {
    expect(canTransition('creating', 'joined')).toBe(false);
    expect(canTransition('creating', 'recording')).toBe(false);
    expect(canTransition('joining', 'recording')).toBe(false);
    expect(canTransition('recording', 'done')).toBe(false);
  });
});

describe('assertTransition', () => {
  it('does not throw for valid transition', () => {
    expect(() => assertTransition('creating', 'joining')).not.toThrow();
  });

  it('throws RecFnError for invalid transition', () => {
    expect(() => assertTransition('done', 'creating')).toThrow(RecFnError);
    try {
      assertTransition('recording', 'joined');
    } catch (e) {
      const err = e as RecFnError;
      expect(err.code).toBe('INVALID_TRANSITION');
      expect(err.message).toContain('recording');
      expect(err.message).toContain('joined');
    }
  });
});

describe('isTerminalState', () => {
  it('identifies done and error as terminal', () => {
    expect(isTerminalState('done')).toBe(true);
    expect(isTerminalState('error')).toBe(true);
  });

  it('identifies non-terminal states', () => {
    const nonTerminal: BotStatus[] = [
      'creating', 'joining', 'joined', 'recording', 'leaving', 'left',
    ];
    for (const status of nonTerminal) {
      expect(isTerminalState(status)).toBe(false);
    }
  });
});

describe('getValidTransitions', () => {
  it('returns valid next states', () => {
    expect(getValidTransitions('creating')).toEqual(['joining', 'error']);
    expect(getValidTransitions('joined')).toEqual(['recording', 'leaving', 'error']);
    expect(getValidTransitions('recording')).toEqual(['leaving', 'error']);
    expect(getValidTransitions('done')).toEqual([]);
    expect(getValidTransitions('error')).toEqual([]);
  });
});
