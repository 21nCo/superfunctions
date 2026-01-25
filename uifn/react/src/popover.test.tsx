import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverClose
} from './popover';

describe('Popover', () => {
  it('renders and toggles content', () => {
    render(
      <Popover>
        <PopoverTrigger>Toggle Popover</PopoverTrigger>
        <PopoverContent>
          <p>Popover Content</p>
          <PopoverClose>Close</PopoverClose>
        </PopoverContent>
      </Popover>
    );

    expect(screen.queryByText('Popover Content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Toggle Popover'));
    expect(screen.getByText('Popover Content')).toBeVisible();

    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByText('Popover Content')).not.toBeInTheDocument();
  });

  it('closes on outside click', () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Toggle</PopoverTrigger>
        <PopoverContent>
          <p>Content</p>
        </PopoverContent>
      </Popover>
    );

    expect(screen.getByText('Content')).toBeVisible();
    
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });
});
