import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './dropdown-menu';

describe('DropdownMenu (Vue)', () => {
  it('opens and selects items', async () => {
    const wrapper = mount(DropdownMenu, {
      slots: {
        default: () => [
          h(DropdownMenuTrigger, () => 'Open Menu'),
          h(DropdownMenuContent, () => [
            h(DropdownMenuLabel, () => 'Actions'),
            h(DropdownMenuSeparator),
            h(DropdownMenuItem, () => 'Item 1'),
            h(DropdownMenuItem, { disabled: true }, () => 'Item 2')
          ])
        ]
      },
      attachTo: document.body
    });

    const trigger = wrapper.find('button');
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await trigger.trigger('click');
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    const item1 = items.find(el => el.textContent === 'Item 1');
    
    if (item1) {
        const clickEvent = new MouseEvent('click', { bubbles: true });
        item1.dispatchEvent(clickEvent);
    }

    await wrapper.vm.$nextTick();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
