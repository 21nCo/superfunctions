import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Slider, SliderRange, SliderThumb, SliderTrack } from './slider';

describe('Slider', () => {
  it('supports home, end, and clamps arrow navigation to the allowed range', () => {
    render(
      <Slider defaultValue={[50]} min={0} max={100} step={25}>
        <SliderTrack>
          <SliderRange />
        </SliderTrack>
        <SliderThumb />
      </Slider>
    );

    const thumb = screen.getByRole('slider');
    expect(thumb).toHaveAttribute('aria-valuenow', '50');

    fireEvent.keyDown(thumb, { key: 'End' });
    expect(thumb).toHaveAttribute('aria-valuenow', '100');

    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    expect(thumb).toHaveAttribute('aria-valuenow', '100');

    fireEvent.keyDown(thumb, { key: 'Home' });
    expect(thumb).toHaveAttribute('aria-valuenow', '0');

    fireEvent.keyDown(thumb, { key: 'ArrowLeft' });
    expect(thumb).toHaveAttribute('aria-valuenow', '0');
  });
});
