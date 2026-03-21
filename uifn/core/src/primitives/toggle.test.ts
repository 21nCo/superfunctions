import { describe, expect, it } from 'vitest';
import { createToggle } from './toggle';

describe('toggle primitive', () => {
  it('supports pointer and keyboard toggles', () => {
    const machine = createToggle({ defaultPressed: false });
    machine.actions.toggle();
    expect(machine.state.pressed).toBe(true);

    machine.actions.handleKeyDown(' ');
    expect(machine.state.pressed).toBe(false);
  });

  it('no-ops when disabled', () => {
    const machine = createToggle({ disabled: true, defaultPressed: false });
    machine.actions.toggle();
    expect(machine.state.pressed).toBe(false);
    expect(machine.state.lastError?.code).toBe('UIFN_ERR_DISABLED_INTERACTION');
  });
});
