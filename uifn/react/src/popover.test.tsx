import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './popover';

describe('Popover', () => {
  it('assigns unique content ids across multiple open instances', () => {
    render(
      <>
        <Popover defaultOpen>
          <PopoverTrigger>Toggle alpha</PopoverTrigger>
          <PopoverContent>Alpha content</PopoverContent>
        </Popover>
        <Popover defaultOpen>
          <PopoverTrigger>Toggle beta</PopoverTrigger>
          <PopoverContent>Beta content</PopoverContent>
        </Popover>
      </>
    );

    const alphaTrigger = screen.getByRole('button', { name: 'Toggle alpha' });
    const betaTrigger = screen.getByRole('button', { name: 'Toggle beta' });
    const dialogs = screen.getAllByRole('dialog');

    expect(alphaTrigger).toHaveAttribute('aria-controls', dialogs[0]?.id);
    expect(betaTrigger).toHaveAttribute('aria-controls', dialogs[1]?.id);
    expect(dialogs[0]?.id).not.toBe(dialogs[1]?.id);
  });

  it('closes on outside click', async () => {
    render(
      <div>
        <button type="button">Outside target</button>
        <Popover defaultOpen>
          <PopoverTrigger>Toggle</PopoverTrigger>
          <PopoverContent>Popover content</PopoverContent>
        </Popover>
      </div>
    );

    expect(screen.getByText('Popover content')).toBeVisible();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside target' }));

    await waitFor(() => {
      expect(screen.queryByText('Popover content')).not.toBeInTheDocument();
    });
  });

  it('closes via PopoverClose', async () => {
    render(
      <Popover>
        <PopoverTrigger>Toggle popover</PopoverTrigger>
        <PopoverContent>
          <span>Closeable content</span>
          <PopoverClose>Close</PopoverClose>
        </PopoverContent>
      </Popover>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle popover' }));
    expect(screen.getByText('Closeable content')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByText('Closeable content')).not.toBeInTheDocument();
    });
  });
});
