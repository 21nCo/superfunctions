import { describe, expect, it } from 'vitest';
import { createContextMenu } from './context-menu';

describe('context-menu primitive', () => {
  it('respects invocation coordinates and clamps to viewport bounds', () => {
    const menu = createContextMenu({
      items: [{ id: 'copy' }, { id: 'paste' }],
    });

    menu.actions.openAt({ x: 290, y: 190 });
    expect(menu.state.open).toBe(true);
    expect(menu.state.x).toBe(290);
    expect(menu.state.y).toBe(190);

    const position = menu.actions.computePosition(
      {
        top: 0,
        left: 0,
        width: 80,
        height: 60,
      },
      {
        width: 320,
        height: 200,
      }
    );

    expect(position.left).toBeLessThanOrEqual(235);
    expect(position.top).toBeLessThanOrEqual(135);
    expect(position.overflow).toBe(false);
  });
});
