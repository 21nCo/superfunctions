import { describe, expect, it } from 'vitest';
import { createToggleGroup } from './toggle-group';

describe('toggle-group primitive', () => {
  it('supports single and multiple selection semantics', () => {
    const single = createToggleGroup({ type: 'single', defaultValue: 'item-1' });
    single.actions.toggleItem('item-1');
    expect(single.state.value).toBe('');
    single.actions.toggleItem('item-2');
    expect(single.state.value).toBe('item-2');

    const multiple = createToggleGroup({ type: 'multiple', defaultValue: ['item-1'] });
    multiple.actions.toggleItem('item-2');
    expect(multiple.state.value).toEqual(['item-1', 'item-2']);
    multiple.actions.toggleItem('item-1');
    expect(multiple.state.value).toEqual(['item-2']);
  });

  it('skips disabled items during roving focus navigation', () => {
    const group = createToggleGroup({ type: 'single', orientation: 'horizontal' });
    group.actions.registerItem('item-1');
    group.actions.registerItem('item-2', true);
    group.actions.registerItem('item-3');

    const nextItem = group.actions.handleKeyDown('ArrowRight', 'item-1');
    expect(nextItem).toBe('item-3');
  });
});
