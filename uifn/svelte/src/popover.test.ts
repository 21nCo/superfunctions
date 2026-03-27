import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import PopoverTest from './testing/PopoverTest.svelte';

describe('Popover (Svelte)', () => {
  it('dismisses from outside interaction and Escape', async () => {
    render(PopoverTest, {
      defaultOpen: false
    });

    const trigger = screen.getByText('Open Popover');
    expect(screen.queryByText('Popover Content')).not.toBeInTheDocument();

    await fireEvent.click(trigger);
    const content = screen.getByText('Popover Content');
    expect(content).toBeVisible();

    await fireEvent.pointerDown(document.body);
    expect(screen.queryByText('Popover Content')).not.toBeInTheDocument();

    await fireEvent.click(trigger);
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByText('Popover Content')).not.toBeInTheDocument();
  });
});
