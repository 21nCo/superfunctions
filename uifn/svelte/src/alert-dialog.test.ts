import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import AlertDialogTest from './testing/AlertDialogTest.svelte';

describe('AlertDialog (Svelte)', () => {
  it('opens and closes', async () => {
    render(AlertDialogTest, {
      defaultOpen: false
    });

    const trigger = screen.getByText('Open Alert');
    expect(screen.queryByText('Alert Title')).not.toBeInTheDocument();

    await fireEvent.click(trigger);
    
    expect(screen.getByText('Alert Title')).toBeVisible();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    const cancel = screen.getByText('Cancel');
    await fireEvent.click(cancel);

    expect(screen.queryByText('Alert Title')).not.toBeInTheDocument();
  });
});
