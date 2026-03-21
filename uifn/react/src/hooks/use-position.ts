import { useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { computePosition, toPositionStyle } from '@uifn/core/utils/position';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type Align = 'start' | 'center' | 'end';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface UsePositionOptions {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  collisionDetection?: boolean;
}

export function usePosition(
  triggerRef: React.RefObject<HTMLElement>,
  contentRef: React.RefObject<HTMLElement>,
  options: UsePositionOptions = {}
) {
  const {
    side = 'bottom',
    align = 'center',
    sideOffset = 0,
    alignOffset = 0,
    collisionDetection = true
  } = options;

  const [style, setStyle] = useState<React.CSSProperties>({
    position: 'absolute',
    left: 0,
    top: 0,
    opacity: 1,
  });

  const updatePosition = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const trigger = triggerRef.current;
    const content = contentRef.current;

    if (!trigger || !content) return;

    const triggerRect = trigger.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    const result = computePosition(triggerRect, contentRect, {
      side,
      align,
      sideOffset,
      alignOffset,
      collisionDetection,
      viewportWidth,
      viewportHeight,
      scrollX,
      scrollY,
    });

    setStyle(toPositionStyle(result));
  }, [triggerRef, contentRef, side, align, sideOffset, alignOffset, collisionDetection]);

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition]);

  return { style, updatePosition };
}
