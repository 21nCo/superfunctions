import { describe, expect, it } from 'vitest';
import { createDropdownMenu } from './dropdown-menu';

describe('dropdown-menu primitive', () => {
  it('navigates nested items through three submenu levels and skips disabled entries', () => {
    const menu = createDropdownMenu({
      defaultOpen: true,
      items: [
        { id: 'open' },
        { id: 'share' },
        { id: 'disabled-delete', disabled: true },
        { id: 'more-submenu' },
        { id: 'submenu-first-item', parentId: 'more-submenu' },
        { id: 'submenu-second-item', parentId: 'submenu-first-item' },
        { id: 'submenu-third-item', parentId: 'submenu-second-item' },
      ],
    });

    menu.actions.highlightItem(null);
    const focusSequence: string[] = [];

    focusSequence.push(menu.actions.handleKeyDown('ArrowDown') ?? '');
    focusSequence.push(menu.actions.handleKeyDown('ArrowDown') ?? '');
    focusSequence.push(menu.actions.handleKeyDown('ArrowDown') ?? '');
    focusSequence.push(menu.actions.handleKeyDown('ArrowRight') ?? '');
    focusSequence.push(menu.actions.handleKeyDown('ArrowRight') ?? '');
    focusSequence.push(menu.actions.handleKeyDown('ArrowRight') ?? '');
    focusSequence.push(menu.actions.handleKeyDown('Escape') ?? '');

    expect(focusSequence).toEqual([
      'open',
      'share',
      'more-submenu',
      'submenu-first-item',
      'submenu-second-item',
      'submenu-third-item',
      'submenu-second-item',
    ]);
    expect(menu.state.highlightedItem).toBe('submenu-second-item');
  });

  it('supports Home and End navigation within the active menu', () => {
    const menu = createDropdownMenu({
      defaultOpen: true,
      items: [{ id: 'open' }, { id: 'share' }, { id: 'more' }],
    });

    expect(menu.actions.handleKeyDown('End', 'open')).toBe('more');
    expect(menu.actions.handleKeyDown('Home', 'more')).toBe('open');
  });

  it('enforces the configured submenu depth limit deterministically', () => {
    const menu = createDropdownMenu({
      defaultOpen: true,
      maxSubmenuDepth: 2,
      items: [
        { id: 'root-submenu' },
        { id: 'child-submenu', parentId: 'root-submenu' },
        { id: 'grandchild-submenu', parentId: 'child-submenu' },
        { id: 'leaf-item', parentId: 'grandchild-submenu' },
      ],
    });

    expect(menu.actions.openSubmenu('root-submenu')).toBe('child-submenu');
    expect(menu.actions.openSubmenu('child-submenu')).toBe('grandchild-submenu');
    expect(menu.actions.openSubmenu('grandchild-submenu')).toBe('grandchild-submenu');
    expect(menu.state.lastError?.code).toBe('UIFN_ERR_MENU_NAVIGATION');
  });
});
