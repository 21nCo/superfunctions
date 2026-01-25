import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import RadioGroupTest from './testing/RadioGroupTest.svelte';

describe('RadioGroup (Svelte)', () => {
  it('selects items', async () => {
    render(RadioGroupTest, {
      defaultValue: '1'
    });

    const item1 = screen.getByRole('radio', { name: /Item 1/ });
    const item2 = screen.getByRole('radio', { name: /Item 2/ });

    expect(item1).toHaveAttribute('aria-checked', 'true');
    expect(item2).toHaveAttribute('aria-checked', 'false');

    await fireEvent.click(item2);

    expect(item1).toHaveAttribute('aria-checked', 'false');
    expect(item2).toHaveAttribute('aria-checked', 'true');
  });
});
