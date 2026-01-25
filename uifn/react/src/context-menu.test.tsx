import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from './context-menu';

describe('ContextMenu', () => {
  it('opens on right click', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Right click me</ContextMenuTrigger>
        <ContextMenuContent>
            <ContextMenuItem>Item 1</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );

    expect(screen.queryByText('Item 1')).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText('Right click me'));

    expect(screen.getByText('Item 1')).toBeVisible();
  });
});
