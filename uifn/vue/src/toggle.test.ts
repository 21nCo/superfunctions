import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { Toggle } from './toggle';

describe('Toggle (Vue)', () => {
  it('toggles state', async () => {
    const wrapper = mount(Toggle, {
      props: {
        defaultPressed: false
      },
      slots: {
        default: () => 'Bold'
      }
    });

    const button = wrapper.find('button');
    expect(button.attributes('aria-pressed')).toBe('false');
    expect(button.attributes('data-state')).toBe('off');

    await button.trigger('click');
    
    expect(button.attributes('aria-pressed')).toBe('true');
    expect(button.attributes('data-state')).toBe('on');
    expect(wrapper.emitted()).toHaveProperty('change');
  });
});
