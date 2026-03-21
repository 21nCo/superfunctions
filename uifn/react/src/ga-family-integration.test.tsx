import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { K } from '@uifn/core/aria/keys';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card';
import {
  MenuBar,
  MenuBarContent,
  MenuBarMenu,
  MenuBarTrigger,
} from './menu-bar';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

const selectionVector = ['left', 'right'] as const;

describe('Missing GA family integration coverage (React)', () => {
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
});
