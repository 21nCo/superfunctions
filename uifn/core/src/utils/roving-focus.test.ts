import { describe, expect, it } from 'vitest';
import { K } from '../aria/keys';
import { getNextRovingFocusIndex } from './roving-focus';

describe('roving focus utilities', () => {
  it('moves focus in horizontal flow by default', () => {
    expect(
      getNextRovingFocusIndex({
        key: K.ARROW_RIGHT,
        itemCount: 4,
        currentIndex: 1,
      })
    ).toBe(2);
  });

  it('supports vertical-only movement', () => {
    expect(
      getNextRovingFocusIndex({
        key: K.ARROW_RIGHT,
        itemCount: 4,
        currentIndex: 1,
        orientation: 'vertical',
      })
    ).toBe(1);

    expect(
      getNextRovingFocusIndex({
        key: K.ARROW_DOWN,
        itemCount: 4,
        currentIndex: 1,
        orientation: 'vertical',
      })
    ).toBe(2);
  });

  it('clamps when loop is disabled', () => {
    expect(
      getNextRovingFocusIndex({
        key: K.ARROW_LEFT,
        itemCount: 4,
        currentIndex: 0,
        loop: false,
      })
    ).toBe(0);
  });

  it('supports rtl horizontal directions', () => {
    expect(
      getNextRovingFocusIndex({
        key: K.ARROW_RIGHT,
        itemCount: 4,
        currentIndex: 1,
        direction: 'rtl',
      })
    ).toBe(0);
  });
});
