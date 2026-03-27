import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

describe('Select', () => {
  it('supports keyboard selection and native hidden-input form integration', async () => {
    const { container } = render(
      <form>
        <Select defaultValue="apple" name="fruit" required>
          <SelectTrigger>
            <SelectValue placeholder="Select fruit" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="apple">Apple</SelectItem>
            <SelectItem value="banana">Banana</SelectItem>
            <SelectItem value="orange">Orange</SelectItem>
          </SelectContent>
        </Select>
      </form>
    );

    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('apple');

    fireEvent.click(trigger);

    const listbox = await screen.findByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'End' });
    expect(screen.getByText('Orange')).toHaveFocus();

    fireEvent.keyDown(listbox, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    expect(trigger).toHaveTextContent('orange');

    const hiddenInput = container.querySelector('input[type="hidden"][name="fruit"]');
    expect(hiddenInput).not.toBeNull();
    expect(hiddenInput).toHaveValue('orange');
    expect(hiddenInput).toHaveAttribute('required');
  });

  it('syncs controlled value and open state', async () => {
    const ControlledSelect = () => {
      const [value, setValue] = React.useState('apple');
      const [open, setOpen] = React.useState(false);

      return (
        <>
          <span data-testid="select-state">{`${value}:${open ? 'open' : 'closed'}`}</span>
          <Select value={value} onValueChange={setValue} open={open} onOpenChange={setOpen}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="apple">Apple</SelectItem>
              <SelectItem value="banana">Banana</SelectItem>
            </SelectContent>
          </Select>
        </>
      );
    };

    render(<ControlledSelect />);

    fireEvent.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('select-state')).toHaveTextContent('apple:open');
    });

    fireEvent.click(screen.getByText('Banana'));

    await waitFor(() => {
      expect(screen.getByTestId('select-state')).toHaveTextContent('banana:closed');
    });
  });

  it('keeps aria-controls unique across multiple open instances', () => {
    render(
      <>
        <Select defaultOpen>
          <SelectTrigger>
            <SelectValue placeholder="Alpha" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="alpha">Alpha</SelectItem>
          </SelectContent>
        </Select>
        <Select defaultOpen>
          <SelectTrigger>
            <SelectValue placeholder="Beta" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="beta">Beta</SelectItem>
          </SelectContent>
        </Select>
      </>
    );

    const triggers = screen.getAllByRole('combobox');
    const listboxes = screen.getAllByRole('listbox');

    expect(triggers[0]).toHaveAttribute('aria-controls', listboxes[0]?.id);
    expect(triggers[1]).toHaveAttribute('aria-controls', listboxes[1]?.id);
    expect(listboxes[0]?.id).not.toBe(listboxes[1]?.id);
  });
});
