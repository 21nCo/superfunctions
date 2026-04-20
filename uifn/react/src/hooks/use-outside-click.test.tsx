import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOutsideClick } from './use-outside-click';

function OutsideClickHarness({ onOutside }: { onOutside: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useOutsideClick(ref, onOutside);

  return (
    <div>
      <div ref={ref}>inside</div>
      <button type="button" data-testid="outside">
        outside
      </button>
    </div>
  );
}

describe('useOutsideClick', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires once for a pointer interaction even if mousedown also occurs', () => {
    const originalPointerEvent = window.PointerEvent;
    class TestPointerEvent extends MouseEvent {}

    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      writable: true,
      value: TestPointerEvent,
    });

    try {
      const onOutside = vi.fn();
      render(<OutsideClickHarness onOutside={onOutside} />);

      const outside = screen.getByTestId('outside');
      outside.dispatchEvent(new TestPointerEvent('pointerdown', { bubbles: true }));
      fireEvent.mouseDown(outside);

      expect(onOutside).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'PointerEvent', {
        configurable: true,
        writable: true,
        value: originalPointerEvent,
      });
    }
  });

  it('falls back to mousedown when PointerEvent is unavailable', () => {
    const originalPointerEvent = window.PointerEvent;

    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    try {
      const onOutside = vi.fn();
      render(<OutsideClickHarness onOutside={onOutside} />);

      fireEvent.mouseDown(screen.getByTestId('outside'));

      expect(onOutside).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'PointerEvent', {
        configurable: true,
        writable: true,
        value: originalPointerEvent,
      });
    }
  });
});
