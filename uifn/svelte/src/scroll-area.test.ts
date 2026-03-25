import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ScrollAreaTest from './testing/ScrollAreaTest.svelte';

describe('ScrollArea (Svelte)', () => {
  it('syncs viewport scroll state into the scrollbar thumb', async () => {
    render(ScrollAreaTest);

    expect(screen.getByText('Content')).toBeVisible();

    const viewport = document.querySelector('[data-uifn-scroll-area-viewport]') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    if (!viewport) {
      return;
    }

    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 60 });
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 80 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 240 });
    Object.defineProperty(viewport, 'scrollWidth', { configurable: true, value: 80 });
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, writable: true, value: 30 });
    Object.defineProperty(viewport, 'scrollLeft', { configurable: true, writable: true, value: 0 });

    await fireEvent.scroll(viewport);

    const scrollbar = screen.getByRole('scrollbar');
    expect(scrollbar).toHaveAttribute('data-orientation', 'vertical');

    const thumb = scrollbar.querySelector('[data-thumb-size]') as HTMLElement | null;
    expect(thumb).not.toBeNull();
    expect(thumb?.getAttribute('data-thumb-offset')).toBe('7.5');

    await fireEvent.pointerDown(thumb as Element, { clientY: 10 });
    await fireEvent.pointerMove(document, { clientY: 20 });
    await fireEvent.pointerUp(document);

    expect(viewport.scrollTop).toBeGreaterThan(30);
  });
});
