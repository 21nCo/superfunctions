import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import AccordionTest from './testing/AccordionTest.svelte';

describe('Accordion (Svelte)', () => {
  it('renders and toggles content', async () => {
    render(AccordionTest, {
      type: 'single',
      defaultValue: 'item-1'
    });

    // Content 1 should be visible (by default implementation of primitives, 
    // often simple conditional rendering or hidden attribute).
    // Let's check for visibility or existence.
    // Note: If using `hidden` attribute, generic matcher might consider it visible in some contexts 
    // unless checking specific styles or attributes.
    // The core primitive often uses `hidden` attribute or removes from DOM.
    // Looking at AccordionContent.svelte: `hidden: !itemContext.open.value`.
    
    // So we can check for existence and visibility.
    const content1 = screen.getByText('Content 1');
    const content2 = screen.getByText('Content 2');

    expect(content1).toBeVisible();
    expect(content2).not.toBeVisible();

    const trigger2 = screen.getByText('Trigger 2');
    await fireEvent.click(trigger2);

    expect(content1).not.toBeVisible();
    expect(content2).toBeVisible();
  });
});
