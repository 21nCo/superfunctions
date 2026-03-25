import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './alert-dialog';

describe('AlertDialog', () => {
  it('locks scroll, ignores outside clicks, closes on escape, and restores focus', async () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger>Open alert</AlertDialogTrigger>
        <AlertDialogPortal>
          <AlertDialogOverlay data-testid="overlay" />
          <AlertDialogContent>
            <AlertDialogTitle>Alert title</AlertDialogTitle>
            <AlertDialogDescription>Alert description</AlertDialogDescription>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Confirm</AlertDialogAction>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    );

    const trigger = screen.getByRole('button', { name: 'Open alert' });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeVisible();
      expect(document.body.style.overflow).toBe('hidden');
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });

    fireEvent.mouseDown(screen.getByTestId('overlay'));
    expect(screen.getByRole('alertdialog')).toBeVisible();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe('');
      expect(trigger).toHaveFocus();
    });
  });

  it('closes via cancel and action buttons', async () => {
    const Example = () => {
      const [open, setOpen] = React.useState(true);
      return (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogPortal>
            <AlertDialogContent>
              <AlertDialogTitle>Confirm delete</AlertDialogTitle>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Delete</AlertDialogAction>
            </AlertDialogContent>
          </AlertDialogPortal>
        </AlertDialog>
      );
    };

    const { rerender } = render(<Example />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    rerender(
      <AlertDialog defaultOpen>
        <AlertDialogPortal>
          <AlertDialogContent>
            <AlertDialogTitle>Confirm delete</AlertDialogTitle>
            <AlertDialogAction>Delete</AlertDialogAction>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });
});
