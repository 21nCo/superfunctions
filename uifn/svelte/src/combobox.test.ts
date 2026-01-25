import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import ComboboxTest from './testing/ComboboxTest.svelte';

describe('Combobox (Svelte)', () => {
  it('filters and selects item', async () => {
    render(ComboboxTest);

    const input = screen.getByRole('combobox');
    expect(input).toHaveValue('');

    await fireEvent.input(input, { target: { value: 'a' } });
    expect(input).toHaveValue('a');
    
    // Content should open on input
    expect(screen.getByRole('listbox')).toBeVisible();

    const banana = screen.getByText('Banana');
    await fireEvent.click(banana);

    expect(input).toHaveValue('banana');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
