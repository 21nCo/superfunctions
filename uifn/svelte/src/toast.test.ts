import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import ToastTest from './testing/ToastTest.svelte';

describe('Toast (Svelte)', () => {
  it('renders and closes automatically', async () => {
    vi.useFakeTimers();

    render(ToastTest, {
      defaultOpen: true,
      duration: 1000
    });

    expect(screen.getByText('Toast Title')).toBeVisible();

    vi.advanceTimersByTime(1000);
    // Svelte state update might need a tick, but testing-library often handles it.
    // If element is removed from DOM via #if, it should disappear.
    
    // In Vitest + Svelte environment, sometimes we need to wait for next tick after timer run.
    await vi.runAllTimersAsync();

    expect(screen.queryByText('Toast Title')).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it('closes via close button', async () => {
     render(ToastTest, {
      defaultOpen: true,
      duration: 5000
    });
    
    expect(screen.getByText('Toast Title')).toBeVisible();
    const close = screen.getByText('Close');
    await fireEvent.click(close);
    
    expect(screen.queryByText('Toast Title')).not.toBeInTheDocument();
  });
});
