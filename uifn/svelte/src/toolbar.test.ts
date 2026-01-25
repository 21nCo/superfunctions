import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ToolbarTest from './testing/ToolbarTest.svelte';

describe('Toolbar (Svelte)', () => {
  it('renders correctly', async () => {
    render(ToolbarTest);

    const toolbar = screen.getByRole('toolbar');
    expect(toolbar).toHaveAttribute('aria-orientation', 'horizontal');

    expect(screen.getByText('Bold')).toBeVisible();
    expect(screen.getByRole('separator')).toBeVisible();
    expect(screen.getByText('Link')).toBeVisible();
  });
});
