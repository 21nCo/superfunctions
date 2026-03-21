import { describe, expect, it } from 'vitest';
import { createCollapsible } from './collapsible';

describe('collapsible primitive', () => {
  it('supports open/close transitions', () => {
    const collapsible = createCollapsible({ defaultOpen: false });
    expect(collapsible.state.open).toBe(false);

    collapsible.actions.toggle();
    expect(collapsible.state.open).toBe(true);

    collapsible.actions.setOpen(false);
    expect(collapsible.state.open).toBe(false);
  });

  it('ignores interactions when disabled', () => {
    const collapsible = createCollapsible({ defaultOpen: false, disabled: true });
    collapsible.actions.toggle();

    expect(collapsible.state.open).toBe(false);
    expect(collapsible.state.lastError?.code).toBe('UIFN_ERR_DISABLED_INTERACTION');
  });
});
