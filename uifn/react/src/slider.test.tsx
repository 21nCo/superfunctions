import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Slider, SliderTrack, SliderRange, SliderThumb } from './slider';

describe('Slider', () => {
  it('renders and moves with keyboard', () => {
    render(
      <Slider defaultValue={[50]} min={0} max={100} step={10}>
        <SliderTrack>
            <SliderRange />
        </SliderTrack>
        <SliderThumb />
      </Slider>
    );

    const thumb = screen.getByRole('slider');
    expect(thumb).toHaveAttribute('aria-valuenow', '50');

    // Move right
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    expect(thumb).toHaveAttribute('aria-valuenow', '60');

    // Move left
    fireEvent.keyDown(thumb, { key: 'ArrowLeft' });
    expect(thumb).toHaveAttribute('aria-valuenow', '50');
  });
});
