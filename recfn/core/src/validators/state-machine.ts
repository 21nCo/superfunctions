import type { BotStatus } from '../types.js';
import { createError, ErrorCode } from '../errors.js';

const VALID_TRANSITIONS: Record<BotStatus, BotStatus[]> = {
  creating: ['joining', 'error'],
  joining: ['joined', 'error'],
  joined: ['recording', 'error'],
  recording: ['leaving', 'error'],
  leaving: ['left', 'error'],
  left: ['done', 'error'],
  done: [],
  error: [],
};

const TERMINAL_STATES: ReadonlySet<BotStatus> = new Set(['done', 'error']);

export function canTransition(from: BotStatus, to: BotStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: BotStatus, to: BotStatus): void {
  if (!canTransition(from, to)) {
    throw createError(
      ErrorCode.INVALID_TRANSITION,
      `Invalid bot status transition: ${from} → ${to}.`,
      { from, to },
    );
  }
}

export function isTerminalState(status: BotStatus): boolean {
  return TERMINAL_STATES.has(status);
}

export function getValidTransitions(from: BotStatus): BotStatus[] {
  return [...VALID_TRANSITIONS[from]];
}

export const BOT_STATUS_ORDER: readonly BotStatus[] = [
  'creating',
  'joining',
  'joined',
  'recording',
  'leaving',
  'left',
  'done',
];
