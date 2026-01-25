import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import Progress from './Progress.svelte';

describe('Progress (Svelte)', () => {
  it('renders correctly', async () => {
    render(Progress, {
      value: 50,
      max: 100
    });

    const progress = screen.getByRole('progressbar');
    expect(progress).toHaveAttribute('aria-valuenow', '50');
    expect(progress).toHaveAttribute('aria-valuemax', '100');
    expect(progress).toHaveAttribute('data-state', 'loading');
  });
});
