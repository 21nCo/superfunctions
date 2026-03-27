import { K } from '../aria/keys';

export type RovingFocusOrientation = 'horizontal' | 'vertical';
export type RovingFocusDirection = 'ltr' | 'rtl';

export interface RovingFocusOptions {
  orientation?: RovingFocusOrientation;
  loop?: boolean;
  direction?: RovingFocusDirection;
}

export interface NextRovingFocusIndexOptions extends RovingFocusOptions {
  key: string;
  itemCount: number;
  currentIndex: number;
}

export interface NextEnabledRovingFocusIndexOptions extends NextRovingFocusIndexOptions {
  isItemEnabled?: (index: number) => boolean;
}

export function getNextRovingFocusIndex(options: NextRovingFocusIndexOptions): number {
  const { key, itemCount } = options;
  if (itemCount <= 0) {
    return -1;
  }

  const orientation = options.orientation;
  const loop = options.loop ?? true;
  const direction = options.direction ?? 'ltr';
  const isHorizontal = orientation !== 'vertical';
  const isVertical = orientation !== 'horizontal';
  const safeCurrentIndex = Math.max(0, Math.min(options.currentIndex, itemCount - 1));

  let nextIndex = safeCurrentIndex;

  switch (key) {
    case K.ARROW_DOWN:
      if (isVertical) {
        nextIndex = safeCurrentIndex + 1;
      }
      break;
    case K.ARROW_UP:
      if (isVertical) {
        nextIndex = safeCurrentIndex - 1;
      }
      break;
    case K.ARROW_RIGHT:
      if (isHorizontal) {
        nextIndex = safeCurrentIndex + (direction === 'rtl' ? -1 : 1);
      }
      break;
    case K.ARROW_LEFT:
      if (isHorizontal) {
        nextIndex = safeCurrentIndex + (direction === 'rtl' ? 1 : -1);
      }
      break;
    case K.HOME:
      nextIndex = 0;
      break;
    case K.END:
      nextIndex = itemCount - 1;
      break;
    default:
      return safeCurrentIndex;
  }

  if (nextIndex === safeCurrentIndex) {
    return safeCurrentIndex;
  }

  if (loop) {
    return (nextIndex + itemCount) % itemCount;
  }

  return Math.max(0, Math.min(nextIndex, itemCount - 1));
}

export function getNextEnabledRovingFocusIndex(
  options: NextEnabledRovingFocusIndexOptions
): number {
  const isItemEnabled = options.isItemEnabled ?? (() => true);
  const safeCurrentIndex = Math.max(0, Math.min(options.currentIndex, options.itemCount - 1));
  const initialIndex = getNextRovingFocusIndex(options);

  if (initialIndex < 0 || initialIndex === safeCurrentIndex) {
    return initialIndex;
  }

  if (isItemEnabled(initialIndex)) {
    return initialIndex;
  }

  let nextIndex = initialIndex;
  for (let visited = 0; visited < options.itemCount; visited += 1) {
    nextIndex = getNextRovingFocusIndex({
      ...options,
      currentIndex: nextIndex,
    });

    if (nextIndex === safeCurrentIndex) {
      return safeCurrentIndex;
    }

    if (nextIndex >= 0 && isItemEnabled(nextIndex)) {
      return nextIndex;
    }
  }

  return safeCurrentIndex;
}

export interface MoveRovingFocusOptions extends NextRovingFocusIndexOptions {
  items: HTMLElement[];
}

export function moveRovingFocus(options: MoveRovingFocusOptions): {
  previousIndex: number;
  nextIndex: number;
  moved: boolean;
} {
  const previousIndex = Math.max(0, Math.min(options.currentIndex, options.items.length - 1));
  const nextIndex = getNextRovingFocusIndex({
    key: options.key,
    itemCount: options.items.length,
    currentIndex: previousIndex,
    orientation: options.orientation,
    loop: options.loop,
    direction: options.direction,
  });

  if (nextIndex >= 0 && nextIndex !== previousIndex) {
    options.items[nextIndex]?.focus();
  }

  return {
    previousIndex,
    nextIndex,
    moved: nextIndex >= 0 && nextIndex !== previousIndex,
  };
}
