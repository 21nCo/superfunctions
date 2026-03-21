import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from './avatar';
import { Badge } from './badge';
import { Label } from './label';
import { Separator } from './separator';
import { VirtualizedList } from './virtualized-list';

describe('GA adapter helpers (React)', () => {
  it('renders Avatar fallback deterministically when no image source is available', () => {
    render(
      <Avatar>
        <AvatarImage alt="Profile image" />
        <AvatarFallback>Fallback</AvatarFallback>
      </Avatar>
    );

    expect(screen.getByText('Fallback')).toBeVisible();
    expect(screen.queryByRole('img', { name: 'Profile image' })).not.toBeInTheDocument();
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

  it('virtualizes large collections with deterministic overscan behavior', () => {
    const items = Array.from({ length: 200 }, (_, i) => `Row ${i}`);

    render(
      <VirtualizedList
        data-testid="virtualized-root"
        items={items}
        itemHeight={20}
        height={60}
        renderItem={(item) => <div data-testid="virt-row">{item}</div>}
      />
    );

    expect(screen.getByText('Row 0')).toBeInTheDocument();
    expect(screen.queryByText('Row 150')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('virt-row').length).toBeLessThan(items.length);

    fireEvent.scroll(screen.getByTestId('virtualized-root'), {
      target: { scrollTop: 240 },
    });

    expect(screen.getByText('Row 12')).toBeInTheDocument();
  });
});
