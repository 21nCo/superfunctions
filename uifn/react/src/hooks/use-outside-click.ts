import * as React from 'react';
import {
  createOutsideClickListener,
  type OutsideClickEvent,
} from '@uifn/core/utils/outside-click';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export function useOutsideClick(
  ref: React.RefObject<HTMLElement>,
  handler: (event: OutsideClickEvent) => void,
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
      {
        enabled: true,
        ownerDocument: ref.current.ownerDocument,
        events: ['mousedown', 'touchstart', 'pointerdown'],
      }
    );

    return () => outsideClick.destroy();
  }, [enabled, ref]);
}
