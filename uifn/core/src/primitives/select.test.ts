import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UIFnError } from '../errors';
import { resetIdCounters } from '../utils/id';
import { createSelect } from './select';

describe('select primitive', () => {
  beforeEach(() => {
    resetIdCounters();
  });

  it('supports grouped options, keyboard nav, and typeahead selection', () => {
    const select = createSelect({
      groups: {
        Fruits: ['Apple', 'Apricot'],
        Vegetables: ['Beet'],
      },
      defaultValue: 'Apple',
      name: 'food',
    });

    const afterArrow = select.actions.handleKeyDown('ArrowDown');
    expect(afterArrow).toBe('Apricot');
    expect(select.state.highlightedItem).toBe('Apricot');

    const afterTypeahead = select.actions.handleKeyDown('A');
    expect(afterTypeahead).toBe('Apricot');
    expect(select.state.highlightedItem).toBe('Apricot');

    select.actions.handleKeyDown('Enter');
    expect(select.state.value).toBe('Apricot');
    expect(select.state.selectedIndicator).toBe('Apricot');
    expect(select.state.ids.contentId).toBe('uifn-select-1-content');
    expect(select.state.ids.groupIds.Fruits).toBe('uifn-select-1-group-fruits');
    expect(select.state.ids.optionIds.Apricot).toBe('uifn-select-1-option-apricot');
    expect(select.actions.getHiddenInput()).toEqual({
      name: 'food',
      value: 'Apricot',
    });
  });

  it('throws deterministic invalid-value errors for unknown controlled values', () => {
    expect(() =>
      createSelect({
        value: 'Dragonfruit',
        items: ['Apple', 'Apricot', 'Beet'],
      })
    ).toThrowError(UIFnError);
  });

  it('keeps controlled value and open state stable until sync actions are applied', () => {
    const onValueChange = vi.fn();
    const onOpenChange = vi.fn();
    const select = createSelect({
      value: 'Apple',
      open: false,
      onValueChange,
      onOpenChange,
      items: ['Apple', 'Apricot', 'Beet'],
    });

    select.actions.handleKeyDown('ArrowDown');
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(select.state.open).toBe(false);

    select.actions.syncOpen(true);
    expect(select.state.open).toBe(true);

    select.actions.handleKeyDown('Enter');
    expect(onValueChange).toHaveBeenCalledWith('Apricot');
    expect(select.state.value).toBe('Apple');

    select.actions.syncValue('Apricot');
    expect(select.state.value).toBe('Apricot');
  });

  it('derives unique ids across instances and rejects duplicate fixed bases', () => {
    const first = createSelect({
      items: ['Apple', 'Apricot'],
    });
    const second = createSelect({
      items: ['Apple', 'Apricot'],
    });

    expect(first.state.ids.contentId).not.toBe(second.state.ids.contentId);

    createSelect({
      idBase: 'shared-select',
      items: ['Apple'],
    });
    expect(() =>
      createSelect({
        idBase: 'shared-select',
        items: ['Apple'],
      })
    ).toThrowError(UIFnError);
  });
});
