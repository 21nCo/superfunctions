import { describe, expect, it } from 'vitest';
import { createRadioGroup } from './radio-group';

describe('radio-group primitive', () => {
  it('enforces single value semantics and keyboard navigation', () => {
    const group = createRadioGroup({
      defaultValue: 'item-1',
      orientation: 'vertical',
      name: 'size',
      items: ['item-1', 'item-2'],
    });

    const nextItem = group.actions.handleKeyDown('ArrowDown', 'item-1');
    expect(nextItem).toBe('item-2');
    expect(group.state.value).toBe('item-2');
    expect(group.actions.getFormValue()).toEqual({ size: 'item-2' });
  });

  it('skips disabled items during keyboard navigation', () => {
    const group = createRadioGroup({ defaultValue: 'item-1', orientation: 'horizontal' });
    group.actions.registerItem('item-1');
    group.actions.registerItem('item-2', true);
    group.actions.registerItem('item-3');

    const nextItem = group.actions.handleKeyDown('ArrowRight', 'item-1');
    expect(nextItem).toBe('item-3');
    expect(group.state.value).toBe('item-3');
  });
});
