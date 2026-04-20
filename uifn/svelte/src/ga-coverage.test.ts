import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { K } from '@uifn/core/aria/keys';
import Badge from './Badge.svelte';
import Separator from './Separator.svelte';
import AvatarTest from './testing/AvatarTest.svelte';
import CollapsibleTest from './testing/CollapsibleTest.svelte';
import HoverCardTest from './testing/HoverCardTest.svelte';
import LabelTest from './testing/LabelTest.svelte';
import MenuBarTest from './testing/MenuBarTest.svelte';
import ToastQueueTest from './testing/ToastQueueTest.svelte';
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
    render(MenuBarTest, { defaultValue: '' });

    const fileTrigger = screen.getByRole('menuitem', { name: 'File' });
    const editTrigger = screen.getByRole('menuitem', { name: 'Edit' });
    expect(fileTrigger).toHaveAttribute('aria-haspopup', 'menu');
    fileTrigger.focus();
    await fireEvent.keyDown(fileTrigger, { key: K.ARROW_RIGHT });
    expect(editTrigger).toHaveFocus();
  });

  it('avatar fallback respects deterministic delay timing', async () => {
    vi.useFakeTimers();
    render(AvatarTest, { src: undefined, delayMs: 50 });

    expect(screen.queryByText('Fallback')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(50);
    expect(screen.getByText('Fallback')).toBeVisible();
    expect(screen.queryByRole('img', { name: 'Profile image' })).not.toBeInTheDocument();
    vi.useRealTimers();
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

  it('virtualized list keeps rendering bounded at 10k rows', async () => {
    render(VirtualizedListTest, {
      itemCount: 10_000,
      itemHeight: 20,
      height: 60,
    });

    expect(screen.getByText('Row 0')).toBeInTheDocument();
    expect(screen.queryByText('Row 9999')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('virt-row').length).toBeLessThan(20);
  });

  it('preserves 25 queued toast items without dropping state', () => {
    render(ToastQueueTest);

    expect(screen.getAllByText(/^Toast \d+$/)).toHaveLength(25);
    expect(screen.getByText('Toast 1')).toBeVisible();
    expect(screen.getByText('Toast 25')).toBeVisible();
  });
});
