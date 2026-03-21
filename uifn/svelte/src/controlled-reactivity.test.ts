import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ControlledAccordionTest from './testing/ControlledAccordionTest.svelte';

describe('Svelte controlled reactivity', () => {
  it('reflects controlled Accordion value updates after mount', async () => {
    const view = render(ControlledAccordionTest, { value: 'item-1' });

    expect(screen.getByText('Content 1')).toBeVisible();
    expect(screen.getByText('Content 2')).not.toBeVisible();

    await view.rerender({ value: 'item-2' });

    expect(screen.getByText('Content 1')).not.toBeVisible();
    expect(screen.getByText('Content 2')).toBeVisible();
  });
});
