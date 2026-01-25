import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { Popover, PopoverTrigger, PopoverContent } from './popover';

describe('Popover (Vue)', () => {
  it('toggles open state', async () => {
    const wrapper = mount(Popover, {
      props: {
        defaultOpen: false
      },
      slots: {
        default: () => [
          h(PopoverTrigger, () => 'Open Popover'),
          h(PopoverContent, () => 'Popover Content')
        ]
      },
      attachTo: document.body
    });

    const trigger = wrapper.find('button');
    expect(document.body.innerHTML).not.toContain('Popover Content');

    await trigger.trigger('click');
    expect(document.body.innerHTML).toContain('Popover Content');

    // Click trigger again to close
    await trigger.trigger('click');
    expect(document.body.innerHTML).not.toContain('Popover Content');
  });
});
