import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import ComboboxTest from './testing/ComboboxTest.svelte';

describe('Combobox (Svelte)', () => {
  it('filters, highlights, and selects from the input keyboard flow', async () => {
    render(ComboboxTest);

    const input = screen.getByRole('combobox');
    expect(input).toHaveValue('');

    await fireEvent.input(input, { target: { value: 'b' } });
    expect(input).toHaveValue('b');

    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeVisible();
    expect(screen.queryByText('Apple')).not.toBeInTheDocument();
    expect(screen.getByText('Banana')).toBeInTheDocument();

    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    const activeId = input.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    expect(screen.getByText('Banana')).toHaveAttribute('id', activeId ?? '');

    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(input).toHaveValue('banana');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps content ids unique across multiple combobox instances', async () => {
    render(ComboboxTest);
    render(ComboboxTest);

    const inputs = screen.getAllByRole('combobox');
    await fireEvent.click(inputs[0]);
    await fireEvent.click(inputs[1]);

    expect(inputs[0].getAttribute('aria-controls')).toBeTruthy();
    expect(inputs[1].getAttribute('aria-controls')).toBeTruthy();
    expect(inputs[0].getAttribute('aria-controls')).not.toBe(inputs[1].getAttribute('aria-controls'));
  });
});
