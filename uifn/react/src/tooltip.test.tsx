import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent
} from './tooltip';

describe('Tooltip', () => {
  it('opens on hover with delay', () => {
    vi.useFakeTimers();

    render(
      <Tooltip delayDuration={500}>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );

    expect(screen.queryByText('Tooltip text')).not.toBeInTheDocument();

    // Mouse enter
    fireEvent.mouseEnter(screen.getByText('Hover me'));

    // Should not be visible yet
    expect(screen.queryByText('Tooltip text')).not.toBeInTheDocument();

    // Fast forward
    act(() => {
        vi.advanceTimersByTime(500);
    });

    expect(screen.getByText('Tooltip text')).toBeVisible();

    // Mouse leave
    fireEvent.mouseLeave(screen.getByText('Hover me'));
    expect(screen.queryByText('Tooltip text')).not.toBeInTheDocument();

    vi.useRealTimers();
  });
});
