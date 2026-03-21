import { describe, expect, it } from 'vitest';
import { createDropdownMenu } from './dropdown-menu';

describe('dropdown-menu primitive', () => {
  it('navigates nested items and skips disabled entries', () => {
    const menu = createDropdownMenu({
      defaultOpen: true,
      items: [
        { id: 'open' },
        { id: 'share' },
        { id: 'disabled-delete', disabled: true },
        { id: 'more-submenu' },
        { id: 'submenu-first-item', parentId: 'more-submenu' },
      ],
    });

    menu.actions.highlightItem(null);
    const focusSequence: string[] = [];

    focusSequence.push(menu.actions.handleKeyDown('ArrowDown') ?? '');
    focusSequence.push(menu.actions.handleKeyDown('ArrowDown') ?? '');
    focusSequence.push(menu.actions.handleKeyDown('ArrowDown') ?? '');
    focusSequence.push(menu.actions.handleKeyDown('ArrowRight') ?? '');
    focusSequence.push(menu.actions.handleKeyDown('Escape') ?? '');

    expect(focusSequence).toEqual([
      'open',
      'share',
      'more-submenu',
      'submenu-first-item',
      'more-submenu',
    ]);
    expect(menu.state.highlightedItem).toBe('more-submenu');
  });
});
