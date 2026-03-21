import { describe, expect, it } from 'vitest';
import { UIFnError } from '../errors';
import { createSelect } from './select';

describe('select primitive', () => {
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
});
