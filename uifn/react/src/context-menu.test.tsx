import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './context-menu';

describe('ContextMenu', () => {
  it('opens at pointer coordinates and supports keyboard navigation plus escape dismissal', async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Right click me</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled>Disabled</ContextMenuItem>
          <ContextMenuItem>Edit</ContextMenuItem>
          <ContextMenuItem>Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );

    fireEvent.contextMenu(screen.getByText('Right click me'), {
      clientX: 120,
      clientY: 240,
    });

    const menu = await screen.findByRole('menu');
    const edit = screen.getByText('Edit');
    const deleteItem = screen.getByText('Delete');

    expect(menu.style.left).toBe('120px');
    expect(menu.style.top).toBe('240px');

    await waitFor(() => {
      expect(edit).toHaveFocus();
    });

    fireEvent.keyDown(menu, { key: 'End' });
    expect(deleteItem).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Home' });
    expect(edit).toHaveFocus();

    fireEvent.keyDown(deleteItem, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});
