import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import DropdownMenuTest from './testing/DropdownMenuTest.svelte';

describe('DropdownMenu (Svelte)', () => {
  it('opens and selects items', async () => {
    render(DropdownMenuTest);

    const trigger = screen.getByText('Open Menu');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeVisible();

    const item1 = screen.getByText('Item 1');
    await fireEvent.click(item1);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
