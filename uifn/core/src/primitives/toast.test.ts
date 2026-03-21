import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToast } from './toast';

describe('toast primitive', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-dismisses after duration and notifies subscribers', () => {
    vi.useFakeTimers();

    const toast = createToast({
      defaultOpen: true,
      duration: 50,
    });

    const states: boolean[] = [];
    toast.subscribe((next) => {
      states.push(next.open);
    });

    vi.advanceTimersByTime(50);

    expect(states).toEqual([false]);
  });

  it('does not auto-dismiss while paused, then dismisses after resume', () => {
    vi.useFakeTimers();

    const toast = createToast({
      defaultOpen: true,
      duration: 100,
    });

    const states: boolean[] = [];
    toast.subscribe((next) => {
      states.push(next.open);
    });

    toast.actions.pauseTimer();
    vi.advanceTimersByTime(300);
    expect(states).toEqual([]);

    toast.actions.resumeTimer();
    vi.advanceTimersByTime(100);
    expect(states).toEqual([false]);
  });
});
