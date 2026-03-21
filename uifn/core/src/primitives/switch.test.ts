import { describe, expect, it } from 'vitest';
import { createSwitch } from './switch';

describe('switch primitive', () => {
  it('toggles checked state and serializes form values', () => {
    const machine = createSwitch({
      name: 'alerts',
      defaultChecked: false,
      value: 'on',
    });

    machine.actions.toggle();
    expect(machine.state.checked).toBe(true);
    expect(machine.actions.getFormValue()).toEqual({ alerts: 'on' });
  });

  it('ignores disabled interactions', () => {
    const machine = createSwitch({
      disabled: true,
      defaultChecked: false,
    });

    machine.actions.toggle();
    expect(machine.state.checked).toBe(false);
    expect(machine.state.lastError?.code).toBe('UIFN_ERR_DISABLED_INTERACTION');
  });
});
