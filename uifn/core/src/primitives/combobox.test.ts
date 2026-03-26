import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UIFnError } from '../errors';
import { resetIdCounters } from '../utils/id';
import { createCombobox } from './combobox';

describe('combobox primitive', () => {
  beforeEach(() => {
    resetIdCounters();
  });

  it('filters items and selects highlighted result by keyboard', () => {
    const combobox = createCombobox({
      items: ['Alpha', 'Beta', 'Gamma'],
      defaultInputValue: 'ga',
      defaultOpen: true,
    });

    expect(combobox.state.filteredItems).toEqual(['Gamma']);
    expect(combobox.state.emptyStateShown).toBe(false);

    combobox.actions.handleKeyDown('ArrowDown');
    combobox.actions.handleKeyDown('Enter');

    expect(combobox.state.value).toBe('Gamma');
    expect(combobox.state.highlightedItem).toBe('Gamma');
    expect(combobox.state.ids.contentId).toBe('uifn-combobox-1-content');
    expect(combobox.state.ids.optionIds.Gamma).toBe('uifn-combobox-1-option-gamma');
  });

  it('prevents selection when filtered result set is empty', () => {
    const combobox = createCombobox({
      items: ['Alpha', 'Beta', 'Gamma'],
      defaultInputValue: 'zz',
      defaultOpen: true,
    });

    combobox.actions.handleKeyDown('Enter');
    expect(combobox.state.value).toBe('');
    expect(combobox.state.lastError?.code).toBe('UIFN_ERR_COMBOBOX_FILTER_STATE');
  });

  it('computes virtualization window when enabled', () => {
    const combobox = createCombobox({
      items: Array.from({ length: 100 }, (_, index) => `Item ${index}`),
      virtualization: {
        enabled: true,
        itemHeight: 20,
        viewportHeight: 100,
        overscan: 1,
      },
    });

    combobox.actions.setScrollOffset(200);
    expect(combobox.state.virtualization?.enabled).toBe(true);
    expect(combobox.state.virtualization?.start).toBe(9);
    expect(combobox.state.virtualization?.end).toBe(15);
  });

  it('keeps controlled value, input value, and open state stable until sync actions run', () => {
    const onValueChange = vi.fn();
    const onInputValueChange = vi.fn();
    const onOpenChange = vi.fn();
    const combobox = createCombobox({
      value: 'Alpha',
      inputValue: 'ga',
      open: false,
      items: ['Alpha', 'Beta', 'Gamma'],
      onValueChange,
      onInputValueChange,
      onOpenChange,
    });

    expect(combobox.state.filteredItems).toEqual(['Gamma']);

    combobox.actions.setInputValue('ga');
    expect(onOpenChange).not.toHaveBeenCalled();

    combobox.actions.handleKeyDown('ArrowDown');
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(combobox.state.open).toBe(false);

    combobox.actions.syncOpen(true);
    combobox.actions.handleKeyDown('Enter');
    expect(onValueChange).toHaveBeenCalledWith('Gamma');
    expect(onInputValueChange).toHaveBeenCalledWith('Gamma');
    expect(combobox.state.value).toBe('Alpha');

    combobox.actions.syncValue('Gamma');
    combobox.actions.syncInputValue('Gamma');
    expect(combobox.state.value).toBe('Gamma');
    expect(combobox.state.inputValue).toBe('Gamma');
  });

  it('derives unique ids across instances and rejects duplicate fixed bases', () => {
    const first = createCombobox({
      items: ['Alpha', 'Beta'],
    });
    const second = createCombobox({
      items: ['Alpha', 'Beta'],
    });

    expect(first.state.ids.contentId).not.toBe(second.state.ids.contentId);

    createCombobox({
      idBase: 'shared-combobox',
      items: ['Alpha'],
    });
    expect(() =>
      createCombobox({
        idBase: 'shared-combobox',
        items: ['Alpha'],
      })
    ).toThrowError(UIFnError);
  });
});
