import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import DialogTest from './testing/DialogTest.svelte';

describe('Dialog (Svelte)', () => {
  it('locks body scroll, focuses content, and restores the trigger on close', async () => {
    render(DialogTest, {
      defaultOpen: false
    });

    const trigger = screen.getByText('Open Dialog');
    expect(screen.queryByText('Dialog Title')).not.toBeInTheDocument();

    await fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    expect(screen.getByText('Dialog Title')).toBeVisible();
    expect(document.body.style.overflow).toBe('hidden');
    expect(dialog).toHaveFocus();

    await fireEvent.keyDown(dialog, { key: 'Escape' });
    await Promise.resolve();

    expect(screen.queryByText('Dialog Title')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
    expect(trigger).toHaveFocus();
  });
});
