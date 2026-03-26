import { describe, expect, it, vi } from 'vitest';
import { createTabs } from './tabs';

describe('tabs primitive', () => {
  it('supports automatic activation keyboard navigation with Arrow, Home, and End', () => {
    const tabs = createTabs({
      defaultValue: 'tab-1',
      orientation: 'horizontal',
      activationMode: 'automatic',
      items: ['tab-1', 'tab-2', 'tab-3'],
    });

    expect(tabs.actions.handleKeyDown('ArrowRight', 'tab-1')).toBe('tab-2');
    expect(tabs.state.value).toBe('tab-2');

    expect(tabs.actions.handleKeyDown('End', 'tab-2')).toBe('tab-3');
    expect(tabs.state.value).toBe('tab-3');

    expect(tabs.actions.handleKeyDown('Home', 'tab-3')).toBe('tab-1');
    expect(tabs.state.value).toBe('tab-1');
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

  it('skips disabled tabs during roving focus', () => {
    const tabs = createTabs({
      defaultValue: 'tab-1',
      orientation: 'horizontal',
      activationMode: 'automatic',
      items: ['tab-1', 'tab-2', 'tab-3'],
      disabledItems: ['tab-2'],
    });

    const nextItem = tabs.actions.handleKeyDown('ArrowRight', 'tab-1');
    expect(nextItem).toBe('tab-3');
    expect(tabs.state.value).toBe('tab-3');
  });

  it('keeps controlled value stable until syncValue is applied', () => {
    const onValueChange = vi.fn();
    const tabs = createTabs({
      value: 'tab-1',
      onValueChange,
      orientation: 'horizontal',
      activationMode: 'automatic',
      items: ['tab-1', 'tab-2'],
    });

    tabs.actions.handleKeyDown('ArrowRight', 'tab-1');
    expect(onValueChange).toHaveBeenCalledWith('tab-2');
    expect(tabs.state.value).toBe('tab-1');
    expect(tabs.state.focusedItem).toBe('tab-2');

    tabs.actions.syncValue('tab-2');
    expect(tabs.state.value).toBe('tab-2');
  });
});
