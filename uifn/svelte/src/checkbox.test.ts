import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import Checkbox from './Checkbox.svelte';

describe('Checkbox (Svelte)', () => {
  it('toggles state', async () => {
    const { component } = render(Checkbox, {
      defaultChecked: false
    });

    const button = screen.getByRole('checkbox');
    expect(button).toHaveAttribute('data-state', 'unchecked');
    expect(button).toHaveAttribute('aria-checked', 'false');

    await fireEvent.click(button);

    expect(button).toHaveAttribute('data-state', 'checked');
    expect(button).toHaveAttribute('aria-checked', 'true');
  });

  it('supports indeterminate state', async () => {
    render(Checkbox, {
      checked: 'indeterminate'
    });

    const button = screen.getByRole('checkbox');
    expect(button).toHaveAttribute('data-state', 'indeterminate');
    expect(button).toHaveAttribute('aria-checked', 'mixed');
  });
});
