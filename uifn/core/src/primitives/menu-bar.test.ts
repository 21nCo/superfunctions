import { describe, expect, it } from 'vitest';
import { createMenuBar } from './menu-bar';

describe('menu-bar primitive', () => {
  it('supports deterministic horizontal navigation and escape close', () => {
    const menuBar = createMenuBar({
      defaultValue: 'file',
      items: [
        { id: 'file' },
        { id: 'edit', disabled: true },
        { id: 'view' },
      ],
    });

    const next = menuBar.actions.handleKeyDown('ArrowRight', 'file');
    expect(next).toBe('view');
    expect(menuBar.state.focusedItem).toBe('view');
    expect(menuBar.state.value).toBe('view');

    const restored = menuBar.actions.handleEscape();
    expect(restored).toBe('view');
    expect(menuBar.state.value).toBe('');
  });
});
