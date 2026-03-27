import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import TabsTest from './testing/TabsTest.svelte';

describe('Tabs (Svelte)', () => {
  it('renders, switches tabs, and follows roving keyboard focus', async () => {
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

    trigger1.focus();
    await fireEvent.keyDown(trigger1, { key: 'ArrowRight' });

    expect(trigger2).toHaveFocus();
    expect(trigger2).toHaveAttribute('aria-selected', 'true');

    await fireEvent.keyDown(trigger2, { key: 'Home' });
    expect(trigger1).toHaveFocus();
    expect(trigger1).toHaveAttribute('aria-selected', 'true');
  });
});
