import { describe, expect, it } from 'vitest';
import { createTabs } from './tabs';

describe('tabs primitive', () => {
  it('supports automatic activation keyboard navigation', () => {
    const tabs = createTabs({
      defaultValue: 'tab-1',
      orientation: 'horizontal',
      activationMode: 'automatic',
      items: ['tab-1', 'tab-2'],
    });

    const nextItem = tabs.actions.handleKeyDown('ArrowRight', 'tab-1');
    expect(nextItem).toBe('tab-2');
    expect(tabs.state.value).toBe('tab-2');
  });

  it('supports manual activation without changing selected value on focus navigation', () => {
    const tabs = createTabs({
      defaultValue: 'tab-1',
      orientation: 'horizontal',
      activationMode: 'manual',
      items: ['tab-1', 'tab-2'],
    });

    const nextItem = tabs.actions.handleKeyDown('ArrowRight', 'tab-1');
    expect(nextItem).toBe('tab-2');
    expect(tabs.state.value).toBe('tab-1');
    expect(tabs.state.focusedItem).toBe('tab-2');
  });
});
