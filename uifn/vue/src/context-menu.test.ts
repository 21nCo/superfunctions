import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from './context-menu';

describe('ContextMenu (Vue)', () => {
  it('opens on right click', async () => {
    const wrapper = mount(ContextMenu, {
      slots: {
        default: () => [
          h(ContextMenuTrigger, () => h('div', 'Right click me')),
          h(ContextMenuContent, () => [
            h(ContextMenuItem, () => 'Item 1'),
            h(ContextMenuItem, () => 'Item 2')
          ])
        ]
      },
      attachTo: document.body
    });

    const trigger = wrapper.find('div'); // The inner div
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await trigger.trigger('contextmenu');
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
