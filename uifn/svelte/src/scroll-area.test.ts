import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ScrollAreaTest from './testing/ScrollAreaTest.svelte';

describe('ScrollArea (Svelte)', () => {
  it('renders correctly', async () => {
    render(ScrollAreaTest);

    expect(screen.getByText('Content')).toBeVisible();
    const scrollbar = screen.getByRole('scrollbar');
    expect(scrollbar).toHaveAttribute('data-orientation', 'vertical');
  });
});
