import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import SelectTest from './testing/SelectTest.svelte';

describe('Select (Svelte)', () => {
  it('opens from the keyboard, moves the highlight, and selects deterministically', async () => {
    render(SelectTest);

    const trigger = screen.getByRole('combobox');
    expect(screen.getByText('Select an item')).toBeVisible();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    const listbox = await screen.findByRole('listbox');
    const item1 = screen.getByText('Item 1');
    const item2 = screen.getByText('Item 2');

    expect(listbox).toBeVisible();
    await fireEvent.keyDown(item2, { key: 'Home' });
    expect(item1).toHaveFocus();

    await fireEvent.keyDown(item1, { key: 'ArrowDown' });
    expect(item2).toHaveFocus();

    await fireEvent.click(item2);
    await Promise.resolve();

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('listbox', { hidden: true })).not.toBeVisible();
    expect(screen.getByText('item2')).toBeVisible();
    expect(screen.queryByText('Select an item')).not.toBeInTheDocument();
  });

  it('keeps instance-scoped aria relationships unique', async () => {
    render(SelectTest);
    render(SelectTest);

    const triggers = screen.getAllByRole('combobox');
    await fireEvent.click(triggers[0]);
    await fireEvent.click(triggers[1]);

    expect(triggers[0].getAttribute('aria-controls')).toBeTruthy();
    expect(triggers[1].getAttribute('aria-controls')).toBeTruthy();
    expect(triggers[0].getAttribute('aria-controls')).not.toBe(triggers[1].getAttribute('aria-controls'));
  });
});
