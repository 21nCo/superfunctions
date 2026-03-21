import React, { useState, useCallback } from 'react';
import { moveRovingFocus } from '@uifn/core/utils/roving-focus';

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
      if (!items.length) {
        return;
      }

      const currentIndex = items.findIndex(
        (item) => item === event.target || item.contains(event.target as Node)
      );
      if (currentIndex === -1) {
        return;
      }

      const result = moveRovingFocus({
        items,
        key: event.key,
        itemCount: items.length,
        currentIndex,
        orientation,
        loop,
      });
      if (result.moved) {
        event.preventDefault();
        const nextItem = items[result.nextIndex];
        setCurrentInfo({ id: nextItem?.id ?? null, index: result.nextIndex });
      }
    },
    [getItems, orientation, loop]
  );

  return {
    handleKeyDown,
    currentInfo,
  };
}
