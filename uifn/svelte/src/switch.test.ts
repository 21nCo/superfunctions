import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import Switch from './Switch.svelte';

describe('Switch (Svelte)', () => {
  it('toggles state', async () => {
    render(Switch, {
      defaultChecked: false
    });

    const button = screen.getByRole('switch');
    expect(button).toHaveAttribute('data-state', 'unchecked');
    expect(button).toHaveAttribute('aria-checked', 'false');

    await fireEvent.click(button);

    expect(button).toHaveAttribute('data-state', 'checked');
    expect(button).toHaveAttribute('aria-checked', 'true');
  });

  it('respects disabled state', async () => {
    render(Switch, {
      disabled: true
    });

    const button = screen.getByRole('switch');
    expect(button).toBeDisabled();
    
    await fireEvent.click(button);
    expect(button).toHaveAttribute('data-state', 'unchecked');
  });
});
