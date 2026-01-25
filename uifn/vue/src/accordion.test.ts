import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './accordion';

describe('Accordion (Vue)', () => {
  it('renders and toggles content', async () => {
    const wrapper = mount(Accordion, {
      attachTo: document.body,
      props: {
        type: 'single',
        defaultValue: 'item-1',
        collapsible: true
      },
      slots: {
        default: () => [
          h(AccordionItem, { value: 'item-1' }, {
            default: () => [
              h(AccordionTrigger, () => 'Trigger 1'),
              h(AccordionContent, () => 'Content 1')
            ]
          }),
          h(AccordionItem, { value: 'item-2' }, {
            default: () => [
              h(AccordionTrigger, () => 'Trigger 2'),
              h(AccordionContent, () => 'Content 2')
            ]
          })
        ]
      }
    });

    // Check initial state
    const item1Content = wrapper.findAllComponents(AccordionContent)[0];
    const item2Content = wrapper.findAllComponents(AccordionContent)[1];

    expect(item1Content.isVisible()).toBe(true); // default 'item-1'
    expect(item2Content.isVisible()).toBe(false);

    // Click trigger 2
    const trigger2 = wrapper.findAllComponents(AccordionTrigger)[1].find('button');
    await trigger2.trigger('click');

    expect(item1Content.isVisible()).toBe(false);
    
    const updatedItem2Content = wrapper.findAllComponents(AccordionContent)[1];
    expect(updatedItem2Content.isVisible()).toBe(true);

    // Click trigger 2 again (collapsible)
    await trigger2.trigger('click');
    expect(item2Content.isVisible()).toBe(false);
  });
});
