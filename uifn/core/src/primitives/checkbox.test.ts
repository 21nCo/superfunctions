import { describe, expect, it } from 'vitest';
import { createCheckbox } from './checkbox';

describe('checkbox primitive', () => {
  it('handles indeterminate state, aria mapping, and form serialization', () => {
    const checkbox = createCheckbox({
      name: 'terms',
      defaultChecked: 'indeterminate',
      value: 'on',
    });

    expect(checkbox.state.ariaChecked).toBe('mixed');
    checkbox.actions.handleKeyDown(' ');
    expect(checkbox.state.ariaChecked).toBe('true');
    expect(checkbox.actions.getFormValue()).toEqual({ terms: 'on' });
  });

  it('ignores state-changing input when disabled', () => {
    const checkbox = createCheckbox({
      disabled: true,
      defaultChecked: false,
    });

    checkbox.actions.handleKeyDown(' ');
    expect(checkbox.state.checked).toBe(false);
    expect(checkbox.state.lastError?.code).toBe('UIFN_ERR_DISABLED_INTERACTION');
  });
});
