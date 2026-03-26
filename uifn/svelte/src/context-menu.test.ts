import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import ContextMenuTest from './testing/ContextMenuTest.svelte';

describe('ContextMenu (Svelte)', () => {
  it('opens at the pointer location and closes from Escape', async () => {
    render(ContextMenuTest);

    const trigger = screen.getByText('Right click me');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await fireEvent.contextMenu(trigger, { clientX: 12, clientY: 24 });
    const menu = screen.getByRole('menu');
    expect(menu).toBeVisible();
    expect(menu).toHaveStyle({ left: '12px', top: '24px' });

    const item1 = screen.getByText('Item 1');
    expect(item1).toHaveFocus();

    await fireEvent.keyDown(item1, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
