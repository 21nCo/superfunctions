import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from './select';

describe('Select', () => {
  it('selects an item', async () => {
    render(
      <Select defaultValue="apple">
        <SelectTrigger>
            <SelectValue placeholder="Select fruit" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
          <SelectItem value="orange">Orange</SelectItem>
        </SelectContent>
      </Select>
    );

    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('apple');

    fireEvent.click(trigger);
    
    await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeVisible();
    });

    fireEvent.click(screen.getByText('Banana'));

    expect(trigger).toHaveTextContent('banana'); // Simple implementation displays value string
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
