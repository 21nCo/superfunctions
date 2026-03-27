import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import {
  MenuBar,
  MenuBarContent,
  MenuBarItem,
  MenuBarMenu,
  MenuBarTrigger,
} from './menu-bar';

describe('DropdownMenu', () => {
  it('skips disabled items and handles home, end, and escape', async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled>Disabled item</DropdownMenuItem>
          <DropdownMenuItem>First action</DropdownMenuItem>
          <DropdownMenuItem>Last action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const trigger = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    const firstAction = screen.getByText('First action');
    const lastAction = screen.getByText('Last action');

    await waitFor(() => {
      expect(firstAction).toHaveFocus();
    });

    fireEvent.keyDown(menu, { key: 'End' });
    expect(lastAction).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Home' });
    expect(firstAction).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(lastAction).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it('assigns unique content ids across multiple open instances', () => {
    render(
      <>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Menu alpha</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Alpha item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Menu beta</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Beta item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );

    const alphaTrigger = screen.getByRole('button', { name: 'Menu alpha' });
    const betaTrigger = screen.getByRole('button', { name: 'Menu beta' });
    const menus = screen.getAllByRole('menu');

    expect(alphaTrigger).toHaveAttribute('aria-controls', menus[0]?.id);
    expect(betaTrigger).toHaveAttribute('aria-controls', menus[1]?.id);
    expect(menus[0]?.id).not.toBe(menus[1]?.id);
  });
});

describe('MenuBar', () => {
  it('switches open menus with arrow keys and closes with escape from content', async () => {
    render(
      <MenuBar>
        <MenuBarMenu value="file">
          <MenuBarTrigger>File</MenuBarTrigger>
          <MenuBarContent>
            <MenuBarItem>New</MenuBarItem>
          </MenuBarContent>
        </MenuBarMenu>
        <MenuBarMenu value="edit">
          <MenuBarTrigger>Edit</MenuBarTrigger>
          <MenuBarContent>
            <MenuBarItem>Undo</MenuBarItem>
          </MenuBarContent>
        </MenuBarMenu>
      </MenuBar>
    );

    const fileTrigger = screen.getByText('File');
    const editTrigger = screen.getByText('Edit');

    fireEvent.click(fileTrigger);
    await screen.findByText('New');

    fireEvent.keyDown(screen.getByText('New'), { key: 'ArrowRight' });

    await waitFor(() => {
      expect(screen.getByText('Undo')).toBeVisible();
      expect(editTrigger).toHaveFocus();
    });

    fireEvent.keyDown(screen.getByText('Undo'), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByText('Undo')).not.toBeInTheDocument();
      expect(editTrigger).toHaveFocus();
    });
  });
});
