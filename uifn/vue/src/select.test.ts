import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectViewport, SelectItem, SelectItemIndicator } from './select';

describe('Select (Vue)', () => {
  it('opens and selects an item', async () => {
    const wrapper = mount(Select, {
      slots: {
        default: () => [
          h(SelectTrigger, () => h(SelectValue, { placeholder: 'Select an item' })),
          h(SelectContent, () => h(SelectViewport, () => [
            h(SelectItem, { value: 'item1' }, () => ['Item 1', h(SelectItemIndicator)]),
            h(SelectItem, { value: 'item2' }, () => ['Item 2', h(SelectItemIndicator)])
          ]))
        ]
      },
      attachTo: document.body
    });

    const trigger = wrapper.find('button');
    expect(trigger.text()).toBe('Select an item');
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    await trigger.trigger('click');
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    // Select item 2
    // We need to click the option. Since it's in a portal, we find it in document.
    const items = Array.from(document.querySelectorAll('[role="option"]'));
    const item2 = items.find(el => el.textContent?.includes('Item 2'));
    
    if (item2) {
        // Dispatch click
        const clickEvent = new MouseEvent('click', { bubbles: true });
        item2.dispatchEvent(clickEvent);
    }

    await wrapper.vm.$nextTick();

    expect(document.querySelector('[role="listbox"]')).toBeNull();
    // Trigger should now show Item 2 (value)
    expect(trigger.text()).toBe('item2');
  });
});
