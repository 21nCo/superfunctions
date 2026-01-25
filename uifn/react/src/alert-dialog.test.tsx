import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogPortal
} from './alert-dialog';

describe('AlertDialog', () => {
  it('opens and closes via buttons', () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger>Open Alert</AlertDialogTrigger>
        <AlertDialogPortal>
          <AlertDialogContent>
            <AlertDialogTitle>Alert Title</AlertDialogTitle>
            <AlertDialogDescription>Description</AlertDialogDescription>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Confirm</AlertDialogAction>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    );

    expect(screen.queryByText('Alert Title')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Open Alert'));
    expect(screen.getByText('Alert Title')).toBeVisible();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Alert Title')).not.toBeInTheDocument();
  });
});
