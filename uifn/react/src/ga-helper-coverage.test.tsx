import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Avatar, AvatarFallback, AvatarImage } from './avatar';
import { Badge } from './badge';
import { Label } from './label';
import { Separator } from './separator';
import { VirtualizedList } from './virtualized-list';

afterEach(() => {
  vi.useRealTimers();
});

describe('GA adapter helpers (React)', () => {
  it('delays AvatarFallback rendering deterministically while the image is still loading', () => {
    vi.useFakeTimers();

    const OriginalImage = window.Image;
    class PendingImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      src = '';
    }

    Object.defineProperty(window, 'Image', {
      configurable: true,
      writable: true,
      value: PendingImage,
    });

    try {
      render(
        <Avatar>
          <AvatarImage src="/avatar.png" alt="Profile image" />
          <AvatarFallback delayMs={50}>Fallback</AvatarFallback>
        </Avatar>
      );

      expect(screen.queryByText('Fallback')).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(49);
      });
      expect(screen.queryByText('Fallback')).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByText('Fallback')).toBeVisible();
    } finally {
      Object.defineProperty(window, 'Image', {
        configurable: true,
        writable: true,
        value: OriginalImage,
      });
    }
  });

  it('throws when AvatarImage is rendered outside Avatar context', () => {
    expect(() => render(<AvatarImage src="/avatar.png" alt="Broken" />)).toThrow(
      'Avatar components must be used within an Avatar'
    );
  });

  it('renders Badge with stable role and variant metadata', () => {
    render(<Badge variant="destructive">Critical</Badge>);

    const badge = screen.getByText('Critical');
    expect(badge).toHaveAttribute('role', 'status');
    expect(badge).toHaveAttribute('data-variant', 'destructive');
  });

  it('defaults Badge variant when none is provided', () => {
    render(<Badge>Default badge</Badge>);

    const badge = screen.getByText('Default badge');
    expect(badge).toHaveAttribute('role', 'status');
    expect(badge).toHaveAttribute('data-variant', 'default');
  });

  it('renders Label and prevents double-click text selection', () => {
    render(
      <div>
        <input id="email" />
        <Label htmlFor="email">Email</Label>
      </div>
    );

    const label = screen.getByText('Email');
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      detail: 2,
    });

    label.dispatchEvent(event);

    expect(label).toHaveAttribute('for', 'email');
    expect(event.defaultPrevented).toBe(true);
  });

  it('omits separator semantics when decorative', () => {
    render(<Separator decorative orientation="vertical" data-testid="sep" />);

    const separator = screen.getByTestId('sep');
    expect(separator).not.toHaveAttribute('role');
    expect(separator).not.toHaveAttribute('aria-orientation');
    expect(separator).toHaveAttribute('data-orientation', 'vertical');
  });

  it('virtualizes large collections with the default overscan of 3', () => {
    const items = Array.from({ length: 10_000 }, (_, index) => `Row ${index}`);

    render(
      <VirtualizedList
        data-testid="virtualized-root"
        items={items}
        itemHeight={20}
        height={100}
        renderItem={(item) => <div data-testid="virt-row">{item}</div>}
      />
    );

    expect(screen.getByText('Row 0')).toBeInTheDocument();
    expect(screen.queryByText('Row 5000')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('virt-row').length).toBeLessThan(20);
    expect(screen.getAllByTestId('virt-row').length).toBeGreaterThan(0);

    fireEvent.scroll(screen.getByTestId('virtualized-root'), {
      target: { scrollTop: 1000 },
    });

    expect(screen.getByText('Row 50')).toBeInTheDocument();
    expect(screen.queryByText('Row 0')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('virt-row').length).toBeLessThan(20);
  });
});
