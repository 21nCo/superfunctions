import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UIFnError } from '../errors';
import { resetIdCounters } from '../utils/id';
import { createDialog } from './dialog';

describe('dialog primitive', () => {
  beforeEach(() => {
    resetIdCounters();
  });

  it('applies modal focus and escape dismissal semantics', () => {
    const dialog = createDialog({
      defaultOpen: false,
      modal: true,
      returnFocusId: 'dialog-trigger',
      scrollLock: false,
    });

    dialog.actions.open('open-trigger');
    expect(dialog.state.open).toBe(true);
    expect(dialog.state.focusedElementId).toBe(dialog.state.ids.contentId);
    expect(dialog.state.scrollLocked).toBe(true);
    expect(dialog.state.ids.contentId).toBe('uifn-dialog-1-content');
    expect(dialog.state.ids.titleId).toBe('uifn-dialog-1-title');
    expect(dialog.state.ids.descriptionId).toBe('uifn-dialog-1-description');

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

  it('keeps controlled open state stable until syncOpen is applied', () => {
    const onOpenChange = vi.fn();
    const dialog = createDialog({
      open: false,
      onOpenChange,
      returnFocusId: 'dialog-trigger',
    });

    dialog.actions.open('open-trigger');
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(dialog.state.open).toBe(false);

    dialog.actions.syncOpen(true);
    expect(dialog.state.open).toBe(true);
  });

  it('rejects duplicate fixed dialog id bases', () => {
    createDialog({ idBase: 'shared-dialog' });
    expect(() => createDialog({ idBase: 'shared-dialog' })).toThrowError(UIFnError);
  });
});
