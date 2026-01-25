import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';

describe('Tabs (Vue)', () => {
  it('renders and switches tabs', async () => {
    const wrapper = mount(Tabs, {
      props: {
        defaultValue: 'tab1'
      },
      slots: {
        default: () => [
          h(TabsList, () => [
            h(TabsTrigger, { value: 'tab1' }, () => 'Tab 1'),
            h(TabsTrigger, { value: 'tab2' }, () => 'Tab 2')
          ]),
          h(TabsContent, { value: 'tab1' }, () => 'Content 1'),
          h(TabsContent, { value: 'tab2' }, () => 'Content 2')
        ]
      }
    });

    const triggers = wrapper.findAll('button[role="tab"]');
    const trigger1 = triggers[0];
    const trigger2 = triggers[1];

    expect(trigger1.attributes('aria-selected')).toBe('true');
    expect(trigger2.attributes('aria-selected')).toBe('false');

    const content1 = wrapper.find('[role="tabpanel"]');
    expect(content1.text()).toBe('Content 1');
    expect(wrapper.text()).not.toContain('Content 2');

    await trigger2.trigger('click');

    expect(trigger1.attributes('aria-selected')).toBe('false');
    expect(trigger2.attributes('aria-selected')).toBe('true');

    const content2 = wrapper.findAll('[role="tabpanel"]').find(w => w.text() === 'Content 2');
    expect(content2).toBeDefined();
    expect(wrapper.text()).not.toContain('Content 1');
  });
});
