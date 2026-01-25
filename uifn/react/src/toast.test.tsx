import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { ToastProvider, ToastViewport, Toast, ToastTitle, ToastDescription, ToastClose } from './toast';

describe('Toast', () => {
  it('renders and auto-dismisses', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastViewport />
        <Toast duration={1000}>
            <ToastTitle>Success</ToastTitle>
            <ToastDescription>Saved successfully</ToastDescription>
        </Toast>
      </ToastProvider>
    );

    expect(screen.getByText('Success')).toBeVisible();

    act(() => {
        vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByText('Success')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('closes via close button', () => {
    render(
      <ToastProvider>
        <ToastViewport />
        <Toast>
            <ToastTitle>Error</ToastTitle>
            <ToastClose>Close</ToastClose>
        </Toast>
      </ToastProvider>
    );

    expect(screen.getByText('Error')).toBeVisible();
    
    fireEvent.click(screen.getByText('Close'));
    
    expect(screen.queryByText('Error')).not.toBeInTheDocument();
  });
});
