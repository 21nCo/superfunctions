import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Combobox, ComboboxInput, ComboboxContent, ComboboxItem } from './combobox';

describe('Combobox', () => {
  it('updates input and selects value', () => {
    render(
      <Combobox>
        <ComboboxInput placeholder="Search..." />
        <ComboboxContent>
            <ComboboxItem value="apple">Apple</ComboboxItem>
            <ComboboxItem value="banana">Banana</ComboboxItem>
        </ComboboxContent>
      </Combobox>
    );

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'a' } });
    expect(input).toHaveValue('a');

    // Open list
    fireEvent.click(input);
    expect(screen.getByRole('listbox')).toBeVisible();

    // Select item
    fireEvent.click(screen.getByText('Apple'));
    expect(input).toHaveValue('apple');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
