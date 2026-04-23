import { describe, expect, it } from 'vitest';
import { computePosition, computePositionAtPoint } from './position';

const triggerRect = {
  top: 100,
  left: 100,
  width: 80,
  height: 30,
  right: 180,
  bottom: 130,
};

const contentRect = {
  top: 0,
  left: 0,
  width: 120,
  height: 60,
  right: 120,
  bottom: 60,
};

describe('position utilities', () => {
  it('positions below trigger by default', () => {
    const result = computePosition(triggerRect, contentRect, {
      viewportWidth: 1024,
      viewportHeight: 768,
      sideOffset: 8,
    });

    expect(result.side).toBe('bottom');
    expect(result.top).toBe(138);
    expect(result.left).toBe(80);
  });

  it('normalizes DOMRect-like values with non-enumerable geometry fields', () => {
    const domTriggerRect = Object.create({});
    Object.defineProperties(domTriggerRect, {
      top: { value: 35 },
      left: { value: 1014 },
      width: { value: 150 },
      height: { value: 38 },
      right: { value: 1164 },
      bottom: { value: 73 },
    });

    const domContentRect = Object.create({});
    Object.defineProperties(domContentRect, {
      top: { value: 900 },
      left: { value: 0 },
      width: { value: 226 },
      height: { value: 117 },
      right: { value: 226 },
      bottom: { value: 1017 },
    });

    const result = computePosition(domTriggerRect, domContentRect, {
      viewportWidth: 1280,
      viewportHeight: 900,
      side: 'bottom',
      align: 'start',
      sideOffset: 6,
    });

    expect(result.top).toBe(79);
    expect(result.left).toBe(1014);
    expect(Number.isNaN(result.top)).toBe(false);
    expect(Number.isNaN(result.left)).toBe(false);
  });

  it('flips from bottom to top on overflow', () => {
    const result = computePosition(triggerRect, contentRect, {
      viewportWidth: 1024,
      viewportHeight: 160,
      side: 'bottom',
      sideOffset: 8,
      collisionDetection: true,
    });

    expect(result.side).toBe('top');
    expect(result.top).toBe(32);
  });

  it('clamps horizontal overflow to viewport bounds', () => {
    const nearEdgeTrigger = {
      top: 10,
      left: -10,
      width: 20,
      height: 20,
      right: 10,
      bottom: 30,
    };

    const result = computePosition(nearEdgeTrigger, contentRect, {
      viewportWidth: 150,
      viewportHeight: 200,
      side: 'bottom',
      align: 'start',
      collisionPadding: 4,
    });

    expect(result.left).toBe(4);
  });

  it('positions relative to invocation points for context menus', () => {
    const result = computePositionAtPoint(
      {
        x: 290,
        y: 190,
      },
      contentRect,
      {
        viewportWidth: 320,
        viewportHeight: 200,
        side: 'right',
        align: 'start',
        collisionPadding: 5,
      }
    );

    expect(result.left).toBeLessThanOrEqual(195);
    expect(result.top).toBeLessThanOrEqual(135);
    expect(result.overflow).toBe(false);
  });
});
