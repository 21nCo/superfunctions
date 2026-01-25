import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { Toolbar, ToolbarButton, ToolbarSeparator, ToolbarLink } from './toolbar';

describe('Toolbar (Vue)', () => {
  it('renders correctly', async () => {
    const wrapper = mount(Toolbar, {
      slots: {
        default: () => [
          h(ToolbarButton, () => 'Bold'),
          h(ToolbarSeparator),
          h(ToolbarLink, { href: '#' }, () => 'Link')
        ]
      }
    });

    const toolbar = wrapper.find('[role="toolbar"]');
    expect(toolbar.attributes('aria-orientation')).toBe('horizontal');

    expect(wrapper.text()).toContain('Bold');
    expect(wrapper.find('[role="separator"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Link');
  });
});
