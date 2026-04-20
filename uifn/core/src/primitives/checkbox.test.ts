import { describe, expect, it, vi } from 'vitest';
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

  it('keeps controlled checked state stable until syncChecked is applied', () => {
    const onCheckedChange = vi.fn();
    const checkbox = createCheckbox({
      checked: false,
      name: 'terms',
      onCheckedChange,
    });

    checkbox.actions.toggle();
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(checkbox.state.checked).toBe(false);
    expect(checkbox.actions.getFormValue()).toEqual({});

    checkbox.actions.syncChecked(true);
    expect(checkbox.state.checked).toBe(true);
    expect(checkbox.actions.getFormValue()).toEqual({ terms: 'on' });
  });
});
