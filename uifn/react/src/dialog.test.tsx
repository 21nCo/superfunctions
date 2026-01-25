import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogPortal,
  DialogOverlay
} from './dialog';

describe('Dialog', () => {
  it('renders and opens via trigger', async () => {
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogPortal>
          <DialogOverlay />
          <DialogContent>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
            <DialogClose>Close</DialogClose>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    );

    // Initial state: Content not visible
    expect(screen.queryByText('Title')).not.toBeInTheDocument();

    // Click trigger
    fireEvent.click(screen.getByText('Open Dialog'));

    // Content visible
    expect(screen.getByText('Title')).toBeVisible();
    expect(screen.getByText('Description')).toBeVisible();
  });

  it('closes via close button', async () => {
    render(
      <Dialog defaultOpen>
        <DialogPortal>
          <DialogContent>
            <DialogTitle>Title</DialogTitle>
            <DialogClose>Close</DialogClose>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    );

    expect(screen.getByText('Title')).toBeVisible();
    
    fireEvent.click(screen.getByText('Close'));

    await waitFor(() => {
        expect(screen.queryByText('Title')).not.toBeInTheDocument();
    });
  });

  it('closes via escape key', async () => {
    render(
      <Dialog defaultOpen>
        <DialogPortal>
          <DialogContent>
            <DialogTitle>Title</DialogTitle>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
        expect(screen.queryByText('Title')).not.toBeInTheDocument();
    });
  });

  it('closes via outside click', async () => {
    render(
      <Dialog defaultOpen>
        <DialogPortal>
            <DialogOverlay data-testid="overlay" />
            <DialogContent>
                <DialogTitle>Title</DialogTitle>
            </DialogContent>
        </DialogPortal>
      </Dialog>
    );

    // Clicking the overlay is effectively clicking outside the content (but inside the overlay div)
    // My implementation detects clicks on document.
    // If I click the overlay (which is in the portal, but outside content), it should trigger.
    
    // Actually, my useOutsideClick attaches to document.
    // If I fire mousedown on the overlay, useOutsideClick checks if target is contained in Content ref.
    // Overlay is sibling to Content in Portal (usually).
    
    const overlay = screen.getByTestId('overlay');
    fireEvent.mouseDown(overlay);

    await waitFor(() => {
        expect(screen.queryByText('Title')).not.toBeInTheDocument();
    });
  });
  
  it('traps focus', async () => {
    // This is hard to test perfectly in JSDOM, but we can check if the first element is focused on open
    const { getByText } = render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogPortal>
          <DialogContent>
            <button>First</button>
            <button>Second</button>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    );

    fireEvent.click(getByText('Open'));
    
    await waitFor(() => {
        expect(getByText('First')).toHaveFocus();
    });
  });
});
