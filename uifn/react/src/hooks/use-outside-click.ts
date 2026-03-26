import * as React from 'react';
import {
  createOutsideClickListener,
  type OutsideClickEvent,
  type OutsideClickEventName,
} from '@uifn/core/utils/outside-click';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

function getOutsideClickEvents(ownerDocument: Document): OutsideClickEventName[] {
  const view = ownerDocument.defaultView;
  return view && typeof view.PointerEvent === 'function'
    ? ['pointerdown']
    : ['mousedown', 'touchstart'];
}

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

    const ownerDocument = ref.current.ownerDocument;

    const outsideClick = createOutsideClickListener(
      ref.current,
      (event) => handlerRef.current(event),
      {
        enabled: true,
        ownerDocument,
        events: getOutsideClickEvents(ownerDocument),
      }
    );

    return () => outsideClick.destroy();
  }, [enabled, ref]);
}
