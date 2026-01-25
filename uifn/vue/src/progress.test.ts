import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { Progress } from './progress';

describe('Progress (Vue)', () => {
  it('renders correctly', async () => {
    const wrapper = mount(Progress, {
      props: {
        value: 50,
        max: 100
      }
    });

    const progress = wrapper.find('[role="progressbar"]');
    expect(progress.attributes('aria-valuenow')).toBe('50');
    expect(progress.attributes('aria-valuemax')).toBe('100');
    // Note: Vue implementation uses 'loading' for state unless complete
    expect(progress.attributes('data-state')).toBe('loading');
  });
});
