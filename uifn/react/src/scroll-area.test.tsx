import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { ScrollArea, ScrollAreaViewport, ScrollAreaScrollbar, ScrollAreaThumb } from './scroll-area';

describe('ScrollArea', () => {
  it('renders correctly', () => {
    render(
      <ScrollArea style={{ height: '200px' }}>
        <ScrollAreaViewport>
            <div style={{ height: '1000px' }}>Content</div>
        </ScrollAreaViewport>
        <ScrollAreaScrollbar orientation="vertical">
            <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      </ScrollArea>
    );

    expect(screen.getByText('Content')).toBeVisible();
  });
});
