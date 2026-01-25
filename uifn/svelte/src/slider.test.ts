import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import SliderTest from './testing/SliderTest.svelte';

describe('Slider (Svelte)', () => {
  it('renders correctly', async () => {
    render(SliderTest, {
      defaultValue: [50]
    });

    const thumb = screen.getByRole('slider');
    expect(thumb).toHaveAttribute('aria-valuenow', '50');
    expect(thumb).toHaveAttribute('aria-valuemin', '0');
    expect(thumb).toHaveAttribute('aria-valuemax', '100');
  });
});
