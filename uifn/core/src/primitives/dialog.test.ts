import { describe, expect, it } from 'vitest';
import { createDialog } from './dialog';

describe('dialog primitive', () => {
  it('applies modal focus and escape dismissal semantics', () => {
    const dialog = createDialog({
      defaultOpen: false,
      modal: true,
      initialFocusId: 'dialog-content',
      returnFocusId: 'dialog-trigger',
    });

    dialog.actions.open('open-trigger');
    expect(dialog.state.open).toBe(true);
    expect(dialog.state.focusedElementId).toBe('dialog-content');
    expect(dialog.state.scrollLocked).toBe(true);

    const closed = dialog.actions.onEscapeKeyDown();
    expect(closed).toBe(true);
    expect(dialog.state.open).toBe(false);
    expect(dialog.state.focusedElementId).toBe('dialog-trigger');
    expect(dialog.state.lastChangeReason).toBe('close-escape');
    expect(dialog.state.scrollLocked).toBe(false);
  });

  it('closes on outside interaction when policy allows', () => {
    const dialog = createDialog({
      defaultOpen: true,
      outsideInteractionBehavior: 'close',
      returnFocusId: 'trigger',
    });

    const closed = dialog.actions.onOutsideInteraction();
    expect(closed).toBe(true);
    expect(dialog.state.open).toBe(false);
    expect(dialog.state.lastChangeReason).toBe('close-outside-click');
  });
});
