import { describe, expect, it } from 'vitest';
import { createSlider } from './slider';

describe('slider primitive', () => {
  it('supports multi-thumb stepping with stable ordering', () => {
    const slider = createSlider({
      defaultValue: [20, 80],
      min: 0,
      max: 100,
      step: 10,
    });

    slider.actions.stepThumb(0, 'ArrowRight');
    expect(slider.state.value).toEqual([30, 80]);

    slider.actions.setValue([90, 10]);
    expect(slider.state.value).toEqual([10, 90]);
  });

  it('clamps out-of-bounds values deterministically', () => {
    const slider = createSlider({
      defaultValue: [20, 80],
      min: 0,
      max: 100,
      step: 10,
    });

    slider.actions.setValue([-5, 135]);
    expect(slider.state.value).toEqual([0, 100]);
    expect(slider.state.lastError?.code).toBe('UIFN_ERR_RANGE_OUT_OF_BOUNDS');
  });

  it('supports Home and End keyboard stepping', () => {
    const slider = createSlider({
      defaultValue: [20, 80],
      min: 0,
      max: 100,
      step: 10,
    });

    slider.actions.stepThumb(0, 'Home');
    slider.actions.stepThumb(1, 'End');
    expect(slider.state.value).toEqual([0, 100]);
  });
});
