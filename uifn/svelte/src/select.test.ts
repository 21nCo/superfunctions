import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import SelectTest from './testing/SelectTest.svelte';

describe('Select (Svelte)', () => {
  it('opens and selects an item', async () => {
    render(SelectTest);

    const trigger = screen.getByRole('combobox');
    expect(screen.getByText('Select an item')).toBeVisible();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await fireEvent.click(trigger);

    expect(screen.getByRole('listbox')).toBeVisible();
    const item2 = screen.getByText('Item 2');
    await fireEvent.click(item2);

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByText('item2')).toBeVisible();
    expect(screen.queryByText('Select an item')).not.toBeInTheDocument();
  });
});
