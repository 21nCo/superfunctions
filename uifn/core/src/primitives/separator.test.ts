import { describe, expect, it } from 'vitest';
import { createSeparator } from './separator';

describe('separator primitive', () => {
  it('defaults to horizontal non-decorative semantics', () => {
    const separator = createSeparator({});

    expect(separator.state.orientation).toBe('horizontal');
    expect(separator.state.decorative).toBe(false);
  });

  it('supports explicit vertical decorative configuration', () => {
    const separator = createSeparator({
      orientation: 'vertical',
      decorative: true,
    });

    expect(separator.state.orientation).toBe('vertical');
    expect(separator.state.decorative).toBe(true);
  });
});
