import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { ScrollArea, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport } from './scroll-area';

function mockViewportMetrics(
  viewport: HTMLDivElement,
  metrics: {
    scrollHeight: number;
    scrollWidth: number;
    clientHeight: number;
    clientWidth: number;
    scrollTop?: number;
    scrollLeft?: number;
  }
) {
  let currentScrollTop = metrics.scrollTop ?? 0;
  let currentScrollLeft = metrics.scrollLeft ?? 0;

  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(viewport, 'scrollWidth', {
    configurable: true,
    get: () => metrics.scrollWidth,
  });
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(viewport, 'clientWidth', {
    configurable: true,
    get: () => metrics.clientWidth,
  });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = value;
    },
  });
  Object.defineProperty(viewport, 'scrollLeft', {
    configurable: true,
    get: () => currentScrollLeft,
    set: (value: number) => {
      currentScrollLeft = value;
    },
  });

  return {
    get scrollTop() {
      return currentScrollTop;
    },
    get scrollLeft() {
      return currentScrollLeft;
    },
  };
}

describe('ScrollArea', () => {
  it('updates scrollbar visibility and thumb metrics from viewport scrolling', async () => {
    render(
      <ScrollArea style={{ height: '200px', width: '250px' }}>
        <ScrollAreaViewport data-testid="viewport">
          <div style={{ height: '600px', width: '500px' }}>Scrollable content</div>
        </ScrollAreaViewport>
        <ScrollAreaScrollbar data-testid="vertical-scrollbar" orientation="vertical">
          <ScrollAreaThumb data-testid="vertical-thumb" />
        </ScrollAreaScrollbar>
        <ScrollAreaScrollbar data-testid="horizontal-scrollbar" orientation="horizontal">
          <ScrollAreaThumb data-testid="horizontal-thumb" />
        </ScrollAreaScrollbar>
      </ScrollArea>
    );

    const viewport = screen.getByTestId('viewport');
    const metrics = mockViewportMetrics(viewport, {
      scrollHeight: 600,
      scrollWidth: 500,
      clientHeight: 200,
      clientWidth: 250,
      scrollTop: 120,
      scrollLeft: 50,
    });

    fireEvent.scroll(viewport);

    await waitFor(() => {
      expect(screen.getByTestId('vertical-scrollbar')).toHaveAttribute('data-state', 'visible');
      expect(screen.getByTestId('horizontal-scrollbar')).toHaveAttribute('data-state', 'visible');
    });

    expect(metrics.scrollTop).toBe(120);
    expect(metrics.scrollLeft).toBe(50);
    expect(
      parseFloat(screen.getByTestId('vertical-thumb').getAttribute('data-thumb-size') ?? '0')
    ).toBeCloseTo(33.33, 1);
    expect(
      parseFloat(screen.getByTestId('horizontal-thumb').getAttribute('data-thumb-size') ?? '0')
    ).toBeCloseTo(50, 1);
    expect(
      parseFloat(screen.getByTestId('vertical-thumb').getAttribute('data-thumb-position') ?? '0')
    ).toBeGreaterThan(0);
    expect(
      parseFloat(screen.getByTestId('horizontal-thumb').getAttribute('data-thumb-position') ?? '0')
    ).toBeGreaterThan(0);
  });

  it('updates viewport scroll position when dragging the thumb', async () => {
    render(
      <ScrollArea style={{ height: '200px' }}>
        <ScrollAreaViewport data-testid="drag-viewport">
          <div style={{ height: '1000px' }}>Drag content</div>
        </ScrollAreaViewport>
        <ScrollAreaScrollbar data-testid="drag-scrollbar" orientation="vertical">
          <ScrollAreaThumb data-testid="drag-thumb" />
        </ScrollAreaScrollbar>
      </ScrollArea>
    );

    const viewport = screen.getByTestId('drag-viewport');
    const scrollbar = screen.getByTestId('drag-scrollbar');
    const thumb = screen.getByTestId('drag-thumb');
    const metrics = mockViewportMetrics(viewport, {
      scrollHeight: 1000,
      scrollWidth: 200,
      clientHeight: 200,
      clientWidth: 200,
      scrollTop: 100,
      scrollLeft: 0,
    });

    Object.defineProperty(scrollbar, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 10,
          bottom: 100,
          width: 10,
          height: 100,
          toJSON: () => ({}),
        }) as DOMRect,
    });

    fireEvent.scroll(viewport);

    fireEvent.pointerDown(thumb, { clientY: 10 });
    fireEvent.pointerMove(document, { clientY: 60 });
    fireEvent.pointerUp(document);

    await waitFor(() => {
      expect(metrics.scrollTop).toBeGreaterThan(100);
    });
  });
});
