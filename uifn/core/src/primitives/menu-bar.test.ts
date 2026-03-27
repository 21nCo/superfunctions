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

  it('supports Home and End focus shortcuts across enabled items', () => {
    const menuBar = createMenuBar({
      items: [{ id: 'file' }, { id: 'edit', disabled: true }, { id: 'view' }],
    });

    expect(menuBar.actions.handleKeyDown('End', 'file')).toBe('view');
    expect(menuBar.actions.handleKeyDown('Home', 'view')).toBe('file');
  });
});
