import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import DropdownMenuTest from './testing/DropdownMenuTest.svelte';

describe('DropdownMenu (Svelte)', () => {
  it('opens from the keyboard and skips disabled items during navigation', async () => {
    render(DropdownMenuTest);

    const trigger = screen.getByText('Open Menu');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    expect(menu).toBeVisible();

    const item1 = screen.getByText('Item 1');
    const item3 = screen.getByText('Item 3');

    expect(item1).toHaveFocus();

    await fireEvent.keyDown(item1, { key: 'ArrowDown' });
    expect(item3).toHaveFocus();

    await fireEvent.keyDown(item3, { key: 'Home' });
    expect(item1).toHaveFocus();

    await fireEvent.click(item3);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
