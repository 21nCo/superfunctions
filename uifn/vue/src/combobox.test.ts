import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { Combobox, ComboboxInput, ComboboxTrigger, ComboboxContent, ComboboxItem, ComboboxItemIndicator } from './combobox';

describe('Combobox (Vue)', () => {
  it('filters and selects item', async () => {
    const wrapper = mount(Combobox, {
      slots: {
        default: () => [
          h('div', [
             h(ComboboxInput),
             h(ComboboxTrigger, () => '▼')
          ]),
          h(ComboboxContent, () => [
            h(ComboboxItem, { value: 'apple' }, () => ['Apple', h(ComboboxItemIndicator)]),
            h(ComboboxItem, { value: 'banana' }, () => ['Banana', h(ComboboxItemIndicator)])
          ])
        ]
      },
      attachTo: document.body
    });

    const input = wrapper.find('input');
    expect(input.element.value).toBe('');

    await input.setValue('a');
    
    // Content should open
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    const items = Array.from(document.querySelectorAll('[role="option"]'));
    const banana = items.find(el => el.textContent?.includes('Banana'));
    
    if (banana) {
        const clickEvent = new MouseEvent('click', { bubbles: true });
        banana.dispatchEvent(clickEvent);
    }

    await wrapper.vm.$nextTick();

    expect(document.querySelector('[role="listbox"]')).toBeNull();
    // Input should have value 'banana'
    expect(input.element.value).toBe('banana');
  });
});
