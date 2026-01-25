import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { ScrollArea, ScrollAreaViewport, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaCorner } from './scroll-area';

describe('ScrollArea (Vue)', () => {
  it('renders correctly', async () => {
    const wrapper = mount(ScrollArea, {
      slots: {
        default: () => [
          h(ScrollAreaViewport, () => h('div', { style: 'height: 200px' }, 'Content')),
          h(ScrollAreaScrollbar, { orientation: 'vertical' }, () => h(ScrollAreaThumb)),
          h(ScrollAreaCorner)
        ]
      }
    });

    expect(wrapper.text()).toContain('Content');
    const scrollbar = wrapper.find('[role="scrollbar"]');
    expect(scrollbar.attributes('data-orientation')).toBe('vertical');
  });
});
