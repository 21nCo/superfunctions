import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import Toggle from './Toggle.svelte';

describe('Toggle (Svelte)', () => {
  it('toggles state', async () => {
    render(Toggle, {
      defaultPressed: false
    });

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('data-state', 'off');
    expect(button).toHaveAttribute('aria-pressed', 'false');

    await fireEvent.click(button);

    expect(button).toHaveAttribute('data-state', 'on');
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });
});
