import { describe, expect, it } from 'vitest';
import { createPopover } from './popover';

describe('popover primitive', () => {
  it('derives collision-aware position from shared utility', () => {
    const popover = createPopover({
      defaultOpen: true,
      side: 'bottom',
      align: 'center',
      sideOffset: 8,
    });

    const position = popover.actions.computePosition(
      {
        top: 140,
        left: 100,
        width: 40,
        height: 20,
      },
      {
        top: 0,
        left: 0,
        width: 120,
        height: 60,
      },
      {
        width: 320,
        height: 180,
      }
    );

    expect(position.side).toBe('top');
    expect(popover.state.position?.side).toBe('top');
  });

  it('cleans up listeners and timers when dismissed', () => {
    const popover = createPopover({
      defaultOpen: true,
    });

    popover.actions.registerTimer();
    popover.actions.registerListener();
    expect(popover.state.cleanup.timers).toBe(1);
    expect(popover.state.cleanup.listeners).toBe(1);

    popover.actions.setOpen(false, 'close-outside-click');
    expect(popover.state.open).toBe(false);
    expect(popover.state.cleanup.timers).toBe(0);
    expect(popover.state.cleanup.listeners).toBe(0);
    expect(popover.state.cleanup.complete).toBe(true);
  });
});
