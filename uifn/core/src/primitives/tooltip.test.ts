import { describe, expect, it } from 'vitest';
import { createTooltip } from './tooltip';

describe('tooltip primitive', () => {
  it('opens after deterministic delay and cleans up resources on close', () => {
    const tooltip = createTooltip({
      delayDuration: 700,
      defaultOpen: false,
    });

    tooltip.actions.openWithDelay();
    expect(tooltip.state.open).toBe(false);
    expect(tooltip.state.pendingOpenMs).toBe(700);
    expect(tooltip.state.cleanup.timers).toBe(1);

    tooltip.actions.advanceTime(699);
    expect(tooltip.state.open).toBe(false);
    expect(tooltip.state.pendingOpenMs).toBe(1);

    tooltip.actions.advanceTime(1);
    expect(tooltip.state.open).toBe(true);
    expect(tooltip.state.pendingOpenMs).toBe(null);
    expect(tooltip.state.cleanup.timers).toBe(0);

    tooltip.actions.registerListener();
    expect(tooltip.state.cleanup.listeners).toBe(1);
    tooltip.actions.close();
    expect(tooltip.state.open).toBe(false);
    expect(tooltip.state.cleanup.listeners).toBe(0);
    expect(tooltip.state.cleanup.complete).toBe(true);
  });

  it('uses shared popup positioning with bottom preference', () => {
    const tooltip = createTooltip({
      side: 'bottom',
      delayDuration: 700,
    });

    const position = tooltip.actions.computePosition(
      {
        top: 10,
        left: 10,
        width: 40,
        height: 20,
      },
      {
        top: 0,
        left: 0,
        width: 100,
        height: 40,
      },
      {
        width: 320,
        height: 200,
      }
    );

    expect(position.side).toBe('bottom');
  });
});
