import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { K } from '@uifn/core/aria/keys';
import Badge from './Badge.svelte';
import Separator from './Separator.svelte';
import AvatarTest from './testing/AvatarTest.svelte';
import CollapsibleTest from './testing/CollapsibleTest.svelte';
import HoverCardTest from './testing/HoverCardTest.svelte';
import LabelTest from './testing/LabelTest.svelte';
import MenuBarTest from './testing/MenuBarTest.svelte';
import ToggleGroupTest from './testing/ToggleGroupTest.svelte';
import VirtualizedListTest from './testing/VirtualizedListTest.svelte';

describe('Missing GA family and helper coverage (Svelte)', () => {
  it('collapsible toggles open/closed state from trigger interaction', async () => {
    render(CollapsibleTest, { defaultOpen: false });

    const trigger = screen.getByRole('button', { name: 'Toggle section' });
    const content = screen.getByText('Hidden details');

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(content).toHaveAttribute('hidden');

    await fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(content).not.toHaveAttribute('hidden');
  });

  it('toggle-group applies deterministic single-selection behavior from shared keyboard vector', async () => {
    render(ToggleGroupTest, {
      type: 'single',
      defaultValue: 'left',
    });

    const left = screen.getByRole('radio', { name: 'Left' });
    const right = screen.getByRole('radio', { name: 'Right' });

    expect(left).toHaveAttribute('data-state', 'on');
    expect(right).toHaveAttribute('data-state', 'off');

    right.focus();
    await fireEvent.keyDown(right, { key: K.ENTER });

    expect(left).toHaveAttribute('data-state', 'off');
    expect(right).toHaveAttribute('data-state', 'on');
  });

  it('hover-card renders controlled-open content', async () => {
    render(HoverCardTest, {
      open: true,
    });

    expect(screen.getByRole('link', { name: 'Hover me' })).toBeInTheDocument();
    expect(screen.getByText('Hover content')).toBeInTheDocument();
  });

  it('menu-bar opens and closes content from trigger interactions', async () => {
    render(MenuBarTest, { value: 'file' });

    const trigger = screen.getByRole('menuitem', { name: 'File' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.getByText('New File')).toBeInTheDocument();
    await fireEvent.keyDown(trigger, { key: K.ARROW_DOWN });
    expect(screen.getByText('New File')).toBeInTheDocument();
  });

  it('avatar fallback renders when image source is missing', () => {
    render(AvatarTest, { src: undefined });

    expect(screen.getByText('Fallback')).toBeVisible();
    expect(screen.queryByRole('img', { name: 'Profile image' })).not.toBeInTheDocument();
  });

  it('badge emits deterministic role and variant metadata', () => {
    render(Badge, { variant: 'destructive', 'data-testid': 'badge' });

    const badge = screen.getByTestId('badge');
    expect(badge).toHaveAttribute('role', 'status');
    expect(badge).toHaveAttribute('data-variant', 'destructive');
  });

  it('label prevents double-click text selection and keeps explicit association', async () => {
    const { container } = render(LabelTest);

    const label = screen.getByText('Email');
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      detail: 2,
    });

    label.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(label).toHaveAttribute('for', 'email');
    expect(container.querySelector('label')).not.toBeNull();
  });

  it('separator decorative mode suppresses separator semantics', () => {
    render(Separator, {
      decorative: true,
      orientation: 'vertical',
      'data-testid': 'sep',
    });

    const separator = screen.getByTestId('sep');
    expect(separator).toHaveAttribute('role', 'none');
    expect(separator).not.toHaveAttribute('aria-orientation');
    expect(separator).toHaveAttribute('data-orientation', 'vertical');
  });

  it('virtualized list renders only a bounded window of rows', async () => {
    render(VirtualizedListTest, {
      itemCount: 200,
      itemHeight: 20,
      height: 60,
      overscan: 3,
    });

    expect(screen.getByText('Row 0')).toBeInTheDocument();
    expect(screen.queryByText('Row 150')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('virt-row').length).toBeLessThan(200);
  });
});
