import { describe, expect, it } from 'vitest';
import { createAlertDialog } from './alert-dialog';

describe('alert-dialog primitive', () => {
  it('disallows outside click and records documented error', () => {
    const alertDialog = createAlertDialog({
      defaultOpen: true,
      returnFocusId: 'alert-trigger',
    });

    const handled = alertDialog.actions.onOutsideInteraction();
    expect(handled).toBe(false);
    expect(alertDialog.state.open).toBe(true);
    expect(alertDialog.state.lastError?.code).toBe('UIFN_ERR_INVALID_VALUE');
  });

  it('supports escape dismissal and focus return', () => {
    const alertDialog = createAlertDialog({
      defaultOpen: true,
      returnFocusId: 'alert-trigger',
    });

    alertDialog.actions.onEscapeKeyDown();
    expect(alertDialog.state.open).toBe(false);
    expect(alertDialog.state.focusedElementId).toBe('alert-trigger');
    expect(alertDialog.state.lastChangeReason).toBe('close-escape');
  });
});
