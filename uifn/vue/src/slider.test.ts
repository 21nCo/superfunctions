import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { Slider, SliderTrack, SliderRange, SliderThumb } from './slider';

describe('Slider (Vue)', () => {
  it('renders correctly', async () => {
    const wrapper = mount(Slider, {
      props: {
        defaultValue: [50],
        min: 0,
        max: 100
      },
      slots: {
        default: () => [
          h(SliderTrack, () => h(SliderRange)),
          h(SliderThumb)
        ]
      }
    });

    const thumb = wrapper.find('[role="slider"]');
    expect(thumb.attributes('aria-valuenow')).toBe('50');
    expect(thumb.attributes('aria-valuemin')).toBe('0');
    expect(thumb.attributes('aria-valuemax')).toBe('100');
  });
});
