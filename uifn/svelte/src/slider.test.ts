import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import SliderTest from './testing/SliderTest.svelte';

describe('Slider (Svelte)', () => {
  it('renders multi-thumb ranges and clamps keyboard interaction', async () => {
    const { container } = render(SliderTest, {
      defaultValue: [25, 75]
    });

    const thumbs = screen.getAllByRole('slider');
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toHaveAttribute('aria-valuenow', '25');
    expect(thumbs[1]).toHaveAttribute('aria-valuenow', '75');

    const range = container.querySelector('span[data-orientation="horizontal"][style*="left: 25%"][style*="width: 50%"]');
    expect(range).not.toBeNull();

    thumbs[1].focus();
    await fireEvent.keyDown(thumbs[1], { key: 'End' });
    expect(thumbs[1]).toHaveAttribute('aria-valuenow', '100');
  });
});
