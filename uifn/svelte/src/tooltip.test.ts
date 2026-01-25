import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import TooltipTest from './testing/TooltipTest.svelte';

describe('Tooltip (Svelte)', () => {
  it('opens on hover', async () => {
    vi.useFakeTimers();

    render(TooltipTest, {
      delayDuration: 0 // Immediate for test
    });

    const trigger = screen.getByText('Hover me');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await fireEvent.mouseEnter(trigger);
    
    // Wait for timer if any (using fake timers to run simple immediate tasks or flush)
    vi.runAllTimers();

    expect(screen.getByRole('tooltip')).toBeVisible();
    expect(screen.getByText('Tooltip Content')).toBeVisible();

    await fireEvent.mouseLeave(trigger);
    
    vi.runAllTimers();

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    
    vi.useRealTimers();
  });
});
