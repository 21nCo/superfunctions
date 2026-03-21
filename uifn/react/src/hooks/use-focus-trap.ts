import * as React from 'react';
import { createFocusTrap } from '@uifn/core/utils/focus-trap';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export function useFocusTrap(
  ref: React.RefObject<HTMLElement>,
  active: boolean = true,
  options: { returnFocus?: boolean } = { returnFocus: true }
) {
  useIsomorphicLayoutEffect(() => {
    if (!active) {
      return;
    }

    const el = ref.current;
    if (!el) {
      return;
    }

    const focusTrap = createFocusTrap(el, {
      active,
      returnFocus: options.returnFocus,
    });

    return () => focusTrap.destroy();
  }, [active, ref, options.returnFocus]);
}
