import { describe, expect, it, vi } from 'vitest';
import { UIFnError, assertContext, createUIFnError, runIfEnabled } from './errors';

describe('UIFnError utilities', () => {
  it('creates typed errors with canonical metadata', () => {
    const error = createUIFnError({
      code: 'UIFN_ERR_CONTEXT_MISSING',
      package: '@uifn/core',
      component: 'DialogTrigger',
      details: { provider: 'Dialog' },
    });

    expect(error).toBeInstanceOf(UIFnError);
    expect(error.name).toBe('UIFnError');
    expect(error.code).toBe('UIFN_ERR_CONTEXT_MISSING');
    expect(error.package).toBe('@uifn/core');
    expect(error.component).toBe('DialogTrigger');
    expect(error.recoverable).toBe(false);
  });

  it('throws UIFnError for missing context assertions', () => {
    expect(() =>
      assertContext(undefined, {
        package: '@uifn/core',
        component: 'DialogTrigger',
      })
    ).toThrowError(UIFnError);
  });

  it('no-ops disabled interactions without throwing', () => {
    const fn = vi.fn();
    expect(() => runIfEnabled(false, fn)).not.toThrow();
    expect(fn).not.toHaveBeenCalled();

    expect(runIfEnabled(true, fn)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
