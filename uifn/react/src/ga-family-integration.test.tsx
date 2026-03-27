import { UIFnError } from '@uifn/core/errors';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { K } from '@uifn/core/aria/keys';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';
import { Dialog, DialogContent, DialogPortal, DialogTitle, DialogTrigger } from './dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card';
import {
  MenuBar,
  MenuBarContent,
  MenuBarMenu,
  MenuBarTrigger,
} from './menu-bar';
import { Toast, ToastProvider, ToastTitle, ToastViewport } from './toast';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

const selectionVector = ['left', 'right'] as const;

describe('React GA integration coverage', () => {
  it('collapsible toggles open/closed state via trigger', () => {
    render(
      <Collapsible defaultOpen={false}>
        <CollapsibleTrigger>Toggle section</CollapsibleTrigger>
        <CollapsibleContent>Hidden details</CollapsibleContent>
      </Collapsible>
    );

    const trigger = screen.getByRole('button', { name: 'Toggle section' });
    const content = screen.getByText('Hidden details');

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(content).toHaveAttribute('hidden');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(content).not.toHaveAttribute('hidden');
  });

  it('toggle-group supports deterministic single-value selection semantics', () => {
    render(
      <ToggleGroup type="single" defaultValue={selectionVector[0]}>
        <ToggleGroupItem value={selectionVector[0]}>Left</ToggleGroupItem>
        <ToggleGroupItem value={selectionVector[1]}>Right</ToggleGroupItem>
      </ToggleGroup>
    );

    const left = screen.getByRole('radio', { name: 'Left' });
    const right = screen.getByRole('radio', { name: 'Right' });

    expect(left).toHaveAttribute('data-state', 'on');
    expect(right).toHaveAttribute('data-state', 'off');

    fireEvent.click(right);
    expect(left).toHaveAttribute('data-state', 'off');
    expect(right).toHaveAttribute('data-state', 'on');

    const group = screen.getByRole('group');
    left.focus();
    fireEvent.keyDown(group, { key: K.ARROW_RIGHT });
    expect(right).toHaveAttribute('data-state', 'on');
  });

  it('hover-card renders controlled-open content', () => {
    render(
      <HoverCard open>
        <HoverCardTrigger href="/docs">Hover me</HoverCardTrigger>
        <HoverCardContent>Hover content</HoverCardContent>
      </HoverCard>
    );

    expect(screen.getByRole('link', { name: 'Hover me' })).toBeInTheDocument();
    expect(screen.getByText('Hover content')).toBeInTheDocument();
  });

  it('menu-bar renders controlled-open content and exposes menu trigger semantics', () => {
    render(
      <MenuBar value="file">
        <MenuBarMenu value="file">
          <MenuBarTrigger>File</MenuBarTrigger>
          <MenuBarContent>
            <div role="menuitem">New File</div>
          </MenuBarContent>
        </MenuBarMenu>
      </MenuBar>
    );

    const trigger = screen.getByRole('menuitem', { name: 'File' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.getByText('New File')).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: K.ARROW_DOWN });
    expect(screen.getByText('New File')).toBeInTheDocument();
  });

  it('preserves documented DialogTrigger asChild refs and behavior', async () => {
    const anchorRef = React.createRef<HTMLAnchorElement>();

    render(
      <Dialog>
        <DialogTrigger asChild ref={anchorRef as unknown as React.Ref<HTMLButtonElement>}>
          <a href="/docs">Open docs</a>
        </DialogTrigger>
        <DialogPortal>
          <DialogContent>
            <DialogTitle>AsChild Dialog</DialogTitle>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    );

    const trigger = screen.getByRole('link', { name: 'Open docs' });
    expect(trigger.tagName).toBe('A');
    expect(anchorRef.current).toBe(trigger);

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('AsChild Dialog')).toBeVisible();
    });
  });

  it('throws canonical UIFN errors for adapter misuse', () => {
    let thrown: unknown;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      render(<DialogTrigger>Broken trigger</DialogTrigger>);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UIFnError);
    expect((thrown as UIFnError).code).toBe('UIFN_ERR_CONTEXT_MISSING');
    expect((thrown as UIFnError).message).toBe('Dialog components must be used within a Dialog');
    errorSpy.mockRestore();
  });

  it('preserves 25 queued toast items without dropping state', () => {
    render(
      <ToastProvider>
        <ToastViewport />
        {Array.from({ length: 25 }, (_, index) => (
          <Toast key={index} defaultOpen duration={Infinity}>
            <ToastTitle>{`Toast ${index + 1}`}</ToastTitle>
          </Toast>
        ))}
      </ToastProvider>
    );

    expect(screen.getAllByText(/^Toast \d+$/)).toHaveLength(25);
    expect(screen.getByText('Toast 1')).toBeVisible();
    expect(screen.getByText('Toast 25')).toBeVisible();
  });
});
