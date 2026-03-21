import { describe, expect, it } from 'vitest';
import { createCombobox } from './combobox';

describe('combobox primitive', () => {
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
});
