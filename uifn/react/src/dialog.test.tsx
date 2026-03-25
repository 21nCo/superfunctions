import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './dialog';

describe('Dialog', () => {
  it('locks scroll, focuses content, closes on outside click, and restores focus', async () => {
    render(
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
        <DialogPortal>
          <DialogOverlay data-testid="overlay" />
          <DialogContent>
            <DialogTitle>Dialog title</DialogTitle>
            <DialogDescription>Dialog description</DialogDescription>
            <button>Primary action</button>
            <DialogClose>Close dialog</DialogClose>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    );

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeVisible();
      expect(document.body.style.overflow).toBe('hidden');
      expect(screen.getByRole('button', { name: 'Primary action' })).toHaveFocus();
    });

    fireEvent.mouseDown(screen.getByTestId('overlay'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe('');
      expect(trigger).toHaveFocus();
    });
  });

  it('syncs controlled open state through onOpenChange and escape', async () => {
    const ControlledDialog = () => {
      const [open, setOpen] = React.useState(false);

      return (
        <>
          <span data-testid="dialog-state">{open ? 'open' : 'closed'}</span>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger>Open controlled dialog</DialogTrigger>
            <DialogPortal>
              <DialogContent>
                <DialogTitle>Controlled title</DialogTitle>
              </DialogContent>
            </DialogPortal>
          </Dialog>
        </>
      );
    };

    render(<ControlledDialog />);

    fireEvent.click(screen.getByRole('button', { name: 'Open controlled dialog' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeVisible();
      expect(screen.getByTestId('dialog-state')).toHaveTextContent('open');
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('dialog-state')).toHaveTextContent('closed');
    });
  });

  it('supports asChild trigger semantics and forwards the underlying ref target', async () => {
    const anchorRef = React.createRef<HTMLAnchorElement>();

    render(
      <Dialog>
        <DialogTrigger asChild ref={anchorRef as unknown as React.Ref<HTMLButtonElement>}>
          <a href="#docs">Open docs</a>
        </DialogTrigger>
        <DialogPortal>
          <DialogContent>
            <DialogTitle>AsChild dialog</DialogTitle>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    );

    const trigger = screen.getByRole('link', { name: 'Open docs' });
    expect(trigger.tagName).toBe('A');
    expect(anchorRef.current?.tagName).toBe('A');

    fireEvent.click(trigger);

    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('AsChild dialog')).toBeVisible();
  });
});
