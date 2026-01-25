import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import ContextMenuTest from './testing/ContextMenuTest.svelte';

describe('ContextMenu (Svelte)', () => {
  it('opens on right click', async () => {
    render(ContextMenuTest);

    const trigger = screen.getByText('Right click me');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await fireEvent.contextMenu(trigger);
    expect(screen.getByRole('menu')).toBeVisible();

    const item1 = screen.getByText('Item 1');
    await fireEvent.click(item1);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
