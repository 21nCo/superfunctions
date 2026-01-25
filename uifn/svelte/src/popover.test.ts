import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import PopoverTest from './testing/PopoverTest.svelte';

describe('Popover (Svelte)', () => {
  it('toggles open state', async () => {
    render(PopoverTest, {
      defaultOpen: false
    });

    const trigger = screen.getByText('Open Popover');
    expect(screen.queryByText('Popover Content')).not.toBeInTheDocument();

    await fireEvent.click(trigger);
    expect(screen.getByText('Popover Content')).toBeVisible();

    await fireEvent.click(trigger);
    expect(screen.queryByText('Popover Content')).not.toBeInTheDocument();
  });
});
