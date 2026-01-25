import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from './dropdown-menu';

describe('DropdownMenu', () => {
  it('opens and navigates with keyboard', async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
          <DropdownMenuItem>Item 2</DropdownMenuItem>
          <DropdownMenuItem>Item 3</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const trigger = screen.getByText('Open Menu');
    
    // Open via Enter (or Space/Click)
    fireEvent.click(trigger);
    
    await waitFor(() => {
        expect(screen.getByText('Item 1')).toBeVisible();
    });

    // Check focus on first item
    expect(screen.getByText('Item 1')).toHaveFocus();

    // Arrow Down
    fireEvent.keyDown(screen.getByText('Item 1'), { key: 'ArrowDown' });
    expect(screen.getByText('Item 2')).toHaveFocus();

    // Arrow Down again
    fireEvent.keyDown(screen.getByText('Item 2'), { key: 'ArrowDown' });
    expect(screen.getByText('Item 3')).toHaveFocus();

    // Loop around
    fireEvent.keyDown(screen.getByText('Item 3'), { key: 'ArrowDown' });
    expect(screen.getByText('Item 1')).toHaveFocus();

    // Select Item 1
    fireEvent.keyDown(screen.getByText('Item 1'), { key: 'Enter' });
    
    // Should close
    await waitFor(() => {
        expect(screen.queryByText('Item 1')).not.toBeInTheDocument();
    });
  });
});
