import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Toolbar, ToolbarButton } from './toolbar';

describe('Toolbar', () => {
  it('renders correctly', () => {
    render(
      <Toolbar>
        <ToolbarButton>Cut</ToolbarButton>
        <ToolbarButton>Copy</ToolbarButton>
        <ToolbarButton>Paste</ToolbarButton>
      </Toolbar>
    );

    expect(screen.getByRole('toolbar')).toBeVisible();
    expect(screen.getByText('Cut')).toBeVisible();
  });
});
