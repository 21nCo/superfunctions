import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem } from './combobox';

describe('Combobox', () => {
  it('filters items from input text and selects from the filtered result set', async () => {
    render(
      <Combobox>
        <ComboboxInput placeholder="Search..." />
        <ComboboxContent>
          <ComboboxItem value="alpha">Alpha</ComboboxItem>
          <ComboboxItem value="beta">Beta</ComboboxItem>
          <ComboboxItem value="gamma">Gamma</ComboboxItem>
        </ComboboxContent>
      </Combobox>
    );

    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'ga' } });

    expect(screen.getByRole('listbox')).toBeVisible();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeVisible();

    fireEvent.click(screen.getByText('Gamma'));

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    expect(input).toHaveValue('gamma');
  });

  it('syncs controlled input, value, and open state', async () => {
    const ControlledCombobox = () => {
      const [value, setValue] = React.useState('');
      const [inputValue, setInputValue] = React.useState('');
      const [open, setOpen] = React.useState(false);

      return (
        <>
          <span data-testid="combobox-state">
            {`${value || 'empty'}|${inputValue || 'empty'}|${open ? 'open' : 'closed'}`}
          </span>
          <Combobox
            value={value}
            onValueChange={setValue}
            inputValue={inputValue}
            onInputValueChange={setInputValue}
            open={open}
            onOpenChange={setOpen}
          >
            <ComboboxInput placeholder="Controlled search..." />
            <ComboboxContent>
              <ComboboxItem value="alpha">Alpha</ComboboxItem>
              <ComboboxItem value="beta">Beta</ComboboxItem>
            </ComboboxContent>
          </Combobox>
        </>
      );
    };

    render(<ControlledCombobox />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'be' } });

    await waitFor(() => {
      expect(screen.getByTestId('combobox-state')).toHaveTextContent('empty|be|open');
    });

    fireEvent.click(screen.getByText('Beta'));

    await waitFor(() => {
      expect(screen.getByTestId('combobox-state')).toHaveTextContent('beta|beta|closed');
    });
  });

  it('keeps aria-controls unique across multiple open instances', () => {
    render(
      <>
        <Combobox defaultOpen>
          <ComboboxInput aria-label="Combobox alpha" />
          <ComboboxContent>
            <ComboboxItem value="alpha">Alpha</ComboboxItem>
          </ComboboxContent>
        </Combobox>
        <Combobox defaultOpen>
          <ComboboxInput aria-label="Combobox beta" />
          <ComboboxContent>
            <ComboboxItem value="beta">Beta</ComboboxItem>
          </ComboboxContent>
        </Combobox>
      </>
    );

    const alphaInput = screen.getByRole('combobox', { name: 'Combobox alpha' });
    const betaInput = screen.getByRole('combobox', { name: 'Combobox beta' });
    const listboxes = screen.getAllByRole('listbox');

    expect(alphaInput).toHaveAttribute('aria-controls', listboxes[0]?.id);
    expect(betaInput).toHaveAttribute('aria-controls', listboxes[1]?.id);
    expect(listboxes[0]?.id).not.toBe(listboxes[1]?.id);
  });
});
