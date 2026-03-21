import * as React from 'react';
import { createOutsideClickListener } from '@uifn/core/utils/outside-click';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export function useOutsideClick(
  ref: React.RefObject<HTMLElement>,
  handler: (event: MouseEvent | TouchEvent) => void,
  enabled: boolean = true
) {
  const handlerRef = React.useRef(handler);

  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useIsomorphicLayoutEffect(() => {
    if (!enabled || !ref.current) return;

    const outsideClick = createOutsideClickListener(
      ref.current,
      (event) => handlerRef.current(event),
      { enabled: true }
    );

    return () => outsideClick.destroy();
  }, [enabled, ref]);
}
