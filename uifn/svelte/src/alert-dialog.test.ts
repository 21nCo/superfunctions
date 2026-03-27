import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import AlertDialogTest from './testing/AlertDialogTest.svelte';

describe('AlertDialog (Svelte)', () => {
  it('locks body scroll and ignores overlay dismissal', async () => {
    render(AlertDialogTest, {
      defaultOpen: false
    });

    const trigger = screen.getByText('Open Alert');
    expect(screen.queryByText('Alert Title')).not.toBeInTheDocument();

    await fireEvent.click(trigger);

    expect(screen.getByText('Alert Title')).toBeVisible();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    const overlay = document.querySelector('[aria-hidden="true"]');
    expect(overlay).not.toBeNull();
    if (overlay) {
      await fireEvent.click(overlay);
    }

    expect(screen.getByText('Alert Title')).toBeVisible();

    const cancel = screen.getByText('Cancel');
    await fireEvent.click(cancel);

    expect(screen.queryByText('Alert Title')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });
});
