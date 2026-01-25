import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Progress, ProgressIndicator } from './progress';

describe('Progress', () => {
  it('renders with correct values', () => {
    render(
      <Progress value={50} max={100}>
        <ProgressIndicator />
      </Progress>
    );

    const progress = screen.getByRole('progressbar');
    expect(progress).toHaveAttribute('aria-valuenow', '50');
    expect(progress).toHaveAttribute('aria-valuemax', '100');
    expect(progress).toHaveAttribute('data-state', 'loading');
  });

  it('renders indeterminate state', () => {
    render(
      <Progress value={null}>
        <ProgressIndicator />
      </Progress>
    );

    const progress = screen.getByRole('progressbar');
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(progress).toHaveAttribute('data-state', 'indeterminate');
  });
});
