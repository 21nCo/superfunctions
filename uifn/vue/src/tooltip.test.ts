import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { Tooltip, TooltipTrigger, TooltipContent } from './tooltip';

describe('Tooltip (Vue)', () => {
  it('opens on hover', async () => {
    vi.useFakeTimers();

    const wrapper = mount(Tooltip, {
      props: {
        delayDuration: 0
      },
      slots: {
        default: () => [
          h(TooltipTrigger, () => 'Hover me'),
          h(TooltipContent, () => 'Tooltip Content')
        ]
      },
      attachTo: document.body
    });

    const trigger = wrapper.find('button');
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await trigger.trigger('mouseenter');
    
    vi.runAllTimers();
    await wrapper.vm.$nextTick();

    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toBe('Tooltip Content');

    await trigger.trigger('mouseleave');
    
    vi.runAllTimers();
    await wrapper.vm.$nextTick();

    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    
    vi.useRealTimers();
  });
});
