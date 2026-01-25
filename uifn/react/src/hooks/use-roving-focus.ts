import React, { useState, useCallback } from 'react';
import { K } from '@uifn/core/aria/keys';

export interface UseRovingFocusProps {
  getItems: () => HTMLElement[];
  orientation?: 'horizontal' | 'vertical' | undefined;
  loop?: boolean;
}

export function useRovingFocus({ getItems, orientation, loop = true }: UseRovingFocusProps) {
  const [currentInfo, setCurrentInfo] = useState<{ id: string | null; index: number }>({
    id: null,
    index: 0,
  });

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const items = getItems();
      if (!items.length) return;

      const currentIndex = items.findIndex((item) => item === event.target || item.contains(event.target as Node));
      if (currentIndex === -1) return;

      let nextIndex = currentIndex;

      const isHorizontal = orientation !== 'vertical';
      const isVertical = orientation !== 'horizontal';

      switch (event.key) {
        case K.ARROW_DOWN:
          if (isVertical) nextIndex = currentIndex + 1;
          break;
        case K.ARROW_UP:
          if (isVertical) nextIndex = currentIndex - 1;
          break;
        case K.ARROW_RIGHT:
          if (isHorizontal) nextIndex = currentIndex + 1;
          break;
        case K.ARROW_LEFT:
          if (isHorizontal) nextIndex = currentIndex - 1;
          break;
        case K.HOME:
          nextIndex = 0;
          break;
        case K.END:
          nextIndex = items.length - 1;
          break;
        default:
          return;
      }

      if (nextIndex !== currentIndex) {
        event.preventDefault();

        if (loop) {
          nextIndex = (nextIndex + items.length) % items.length;
        } else {
          nextIndex = Math.max(0, Math.min(nextIndex, items.length - 1));
        }

        const nextItem = items[nextIndex];
        nextItem?.focus();
        setCurrentInfo({ id: nextItem.id, index: nextIndex });
      }
    },
    [getItems, orientation, loop]
  );

  return {
    handleKeyDown,
    currentInfo,
  };
}
