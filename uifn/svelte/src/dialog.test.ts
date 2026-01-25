import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import DialogTest from './testing/DialogTest.svelte';

describe('Dialog (Svelte)', () => {
  it('opens and closes', async () => {
    render(DialogTest, {
      defaultOpen: false
    });

    const trigger = screen.getByText('Open Dialog');
    expect(screen.queryByText('Dialog Title')).not.toBeInTheDocument();

    await fireEvent.click(trigger);
    
    // Dialog content uses portals, so it might be attached to body
    // Test primitives usually render portals or fallback.
    // Let's see if we can find it.
    expect(screen.getByText('Dialog Title')).toBeVisible();

    const close = screen.getByText('Close');
    await fireEvent.click(close);

    expect(screen.queryByText('Dialog Title')).not.toBeInTheDocument();
  });
});
