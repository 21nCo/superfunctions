import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { Checkbox, CheckboxIndicator } from './checkbox';
import { Switch, SwitchThumb } from './switch';
import { RadioGroup, RadioGroupItem, RadioGroupIndicator } from './radio-group';

describe('Form Controls (Vue)', () => {
  describe('Checkbox', () => {
    it('toggles state', async () => {
      const wrapper = mount(Checkbox, {
        props: {
          defaultChecked: false
        },
        slots: {
          default: () => h(CheckboxIndicator, () => '✓')
        }
      });

      const button = wrapper.find('button');
      expect(button.attributes('data-state')).toBe('unchecked');
      expect(wrapper.text()).not.toContain('✓');

      await button.trigger('click');
      expect(button.attributes('data-state')).toBe('checked');
      expect(wrapper.text()).toContain('✓');
    });
  });

  describe('Switch', () => {
    it('toggles state', async () => {
      const wrapper = mount(Switch, {
        props: {
          defaultChecked: false
        },
        slots: {
          default: () => h(SwitchThumb)
        }
      });

      const button = wrapper.find('button');
      expect(button.attributes('data-state')).toBe('unchecked');

      await button.trigger('click');
      expect(button.attributes('data-state')).toBe('checked');
    });
  });

  describe('RadioGroup', () => {
    it('selects items', async () => {
      const wrapper = mount({
        components: { RadioGroup, RadioGroupItem, RadioGroupIndicator },
        template: `
          <RadioGroup defaultValue="1">
            <RadioGroupItem value="1">Item 1 <RadioGroupIndicator /></RadioGroupItem>
            <RadioGroupItem value="2">Item 2 <RadioGroupIndicator /></RadioGroupItem>
          </RadioGroup>
        `
      });

      const items = wrapper.findAll('button[role="radio"]');
      expect(items[0].attributes('data-state')).toBe('checked');
      expect(items[1].attributes('data-state')).toBe('unchecked');

      await items[1].trigger('click');
      expect(items[0].attributes('data-state')).toBe('unchecked');
      expect(items[1].attributes('data-state')).toBe('checked');
    });
  });
});