import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import TabsTest from './testing/TabsTest.svelte';

describe('Tabs (Svelte)', () => {
  it('renders and switches tabs', async () => {
    render(TabsTest, {
      defaultValue: 'tab1'
    });

    const trigger1 = screen.getByRole('tab', { name: 'Tab 1' });
    const trigger2 = screen.getByRole('tab', { name: 'Tab 2' });
    
    expect(trigger1).toHaveAttribute('aria-selected', 'true');
    expect(trigger2).toHaveAttribute('aria-selected', 'false');

    expect(screen.getByText('Content 1')).toBeVisible();
    expect(screen.queryByText('Content 2')).not.toBeInTheDocument();

    await fireEvent.click(trigger2);

    expect(trigger1).toHaveAttribute('aria-selected', 'false');
    expect(trigger2).toHaveAttribute('aria-selected', 'true');

    expect(screen.queryByText('Content 1')).not.toBeInTheDocument();
    expect(screen.getByText('Content 2')).toBeVisible();
  });
});
