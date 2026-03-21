import { describe, expect, it } from 'vitest';
import { UIFnError } from '../errors';
import { createAccordion } from './accordion';

describe('accordion primitive', () => {
  it('supports deterministic disclosure transitions and roving focus', () => {
    const accordion = createAccordion({
      type: 'single',
      defaultValue: 'item-1',
      collapsible: true,
      items: ['item-1', 'item-2'],
    });

    const stateSequence: Array<string | string[]> = [accordion.state.value];
    const focusSequence: string[] = [accordion.state.focusedItem ?? ''];

    const nextItem = accordion.actions.handleKeyDown('ArrowDown', 'item-1');
    focusSequence.push(accordion.state.focusedItem ?? '');

    accordion.actions.toggleItem(nextItem ?? 'item-2');
    stateSequence.push(accordion.state.value);
    focusSequence.push(accordion.state.focusedItem ?? '');

    accordion.actions.toggleItem(nextItem ?? 'item-2');
    stateSequence.push(accordion.state.value);

    expect(stateSequence).toEqual(['item-1', 'item-2', '']);
    expect(focusSequence).toEqual(['item-1', 'item-2', 'item-2']);
  });

  it('throws deterministic invalid value errors for unknown controlled values', () => {
    expect(
      () =>
        createAccordion({
          type: 'single',
          value: 'item-9',
          items: ['item-1', 'item-2'],
        })
    ).toThrowError(UIFnError);
  });
});
