import { clamp } from '../primitives/shared';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type Align = 'start' | 'center' | 'end';

export interface RectLike {
  top: number;
  right?: number;
  bottom?: number;
  left: number;
  width: number;
  height: number;
}

export interface ComputePositionOptions {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  collisionDetection?: boolean;
  collisionPadding?: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollX?: number;
  scrollY?: number;
}

export interface PositionResult {
  top: number;
  left: number;
  side: Side;
  align: Align;
  collisionResolved: boolean;
  overflow: boolean;
  overflowSides: Array<'top' | 'right' | 'bottom' | 'left'>;
}

export interface PointLike {
  x: number;
  y: number;
}

function withEdges(rect: RectLike): Required<RectLike> {
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    right: rect.right ?? rect.left + rect.width,
    bottom: rect.bottom ?? rect.top + rect.height,
  };
}

function getOppositeSide(side: Side): Side {
  switch (side) {
    case 'top':
      return 'bottom';
    case 'bottom':
      return 'top';
    case 'left':
      return 'right';
    case 'right':
      return 'left';
  }
}

function calculateAlignedPosition(
  side: Side,
  align: Align,
  triggerRect: Required<RectLike>,
  contentRect: Required<RectLike>,
  scrollX: number,
  scrollY: number,
  sideOffset: number,
  alignOffset: number
): { top: number; left: number } {
  let top = 0;
  let left = 0;

  switch (side) {
    case 'top':
      top = triggerRect.top + scrollY - contentRect.height - sideOffset;
      break;
    case 'bottom':
      top = triggerRect.bottom + scrollY + sideOffset;
      break;
    case 'left':
      left = triggerRect.left + scrollX - contentRect.width - sideOffset;
      break;
    case 'right':
      left = triggerRect.right + scrollX + sideOffset;
      break;
  }

  if (side === 'top' || side === 'bottom') {
    if (align === 'start') {
      left = triggerRect.left + scrollX + alignOffset;
    } else if (align === 'center') {
      left = triggerRect.left + scrollX + triggerRect.width / 2 - contentRect.width / 2;
    } else {
      left = triggerRect.right + scrollX - contentRect.width - alignOffset;
    }
  } else {
    if (align === 'start') {
      top = triggerRect.top + scrollY + alignOffset;
    } else if (align === 'center') {
      top = triggerRect.top + scrollY + triggerRect.height / 2 - contentRect.height / 2;
    } else {
      top = triggerRect.bottom + scrollY - contentRect.height - alignOffset;
    }
  }

  return { top, left };
}

function getOverflowSides(
  position: { top: number; left: number },
  contentRect: Required<RectLike>,
  viewportWidth: number,
  viewportHeight: number,
  scrollX: number,
  scrollY: number,
  collisionPadding: number
): Array<'top' | 'right' | 'bottom' | 'left'> {
  const overflow: Array<'top' | 'right' | 'bottom' | 'left'> = [];
  const minLeft = scrollX + collisionPadding;
  const minTop = scrollY + collisionPadding;
  const maxRight = scrollX + viewportWidth - collisionPadding;
  const maxBottom = scrollY + viewportHeight - collisionPadding;

  if (position.left < minLeft) {
    overflow.push('left');
  }

  if (position.left + contentRect.width > maxRight) {
    overflow.push('right');
  }

  if (position.top < minTop) {
    overflow.push('top');
  }

  if (position.top + contentRect.height > maxBottom) {
    overflow.push('bottom');
  }

  return overflow;
}

function clampPosition(
  position: { top: number; left: number },
  contentRect: Required<RectLike>,
  viewportWidth: number,
  viewportHeight: number,
  scrollX: number,
  scrollY: number,
  collisionPadding: number
): { top: number; left: number } {
  const minLeft = scrollX + collisionPadding;
  const maxLeft = scrollX + viewportWidth - contentRect.width - collisionPadding;
  const minTop = scrollY + collisionPadding;
  const maxTop = scrollY + viewportHeight - contentRect.height - collisionPadding;

  return {
    left: clamp(position.left, minLeft, Math.max(minLeft, maxLeft)),
    top: clamp(position.top, minTop, Math.max(minTop, maxTop)),
  };
}

export function computePosition(
  triggerRectLike: RectLike,
  contentRectLike: RectLike,
  options: ComputePositionOptions
): PositionResult {
  const triggerRect = withEdges(triggerRectLike);
  const contentRect = withEdges(contentRectLike);
  const side = options.side ?? 'bottom';
  const align = options.align ?? 'center';
  const sideOffset = options.sideOffset ?? 0;
  const alignOffset = options.alignOffset ?? 0;
  const collisionDetection = options.collisionDetection ?? true;
  const collisionPadding = options.collisionPadding ?? 5;
  const scrollX = options.scrollX ?? 0;
  const scrollY = options.scrollY ?? 0;
  const viewportWidth = options.viewportWidth;
  const viewportHeight = options.viewportHeight;

  let finalSide = side;
  let collisionResolved = false;

  let position = calculateAlignedPosition(
    side,
    align,
    triggerRect,
    contentRect,
    scrollX,
    scrollY,
    sideOffset,
    alignOffset
  );

  let overflowSides = getOverflowSides(
    position,
    contentRect,
    viewportWidth,
    viewportHeight,
    scrollX,
    scrollY,
    collisionPadding
  );

  if (collisionDetection && overflowSides.length > 0) {
    const oppositeSide = getOppositeSide(side);
    const flippedPosition = calculateAlignedPosition(
      oppositeSide,
      align,
      triggerRect,
      contentRect,
      scrollX,
      scrollY,
      sideOffset,
      alignOffset
    );

    const flippedOverflow = getOverflowSides(
      flippedPosition,
      contentRect,
      viewportWidth,
      viewportHeight,
      scrollX,
      scrollY,
      collisionPadding
    );

    if (flippedOverflow.length < overflowSides.length) {
      position = flippedPosition;
      overflowSides = flippedOverflow;
      finalSide = oppositeSide;
      collisionResolved = true;
    }
  }

  const clamped = clampPosition(
    position,
    contentRect,
    viewportWidth,
    viewportHeight,
    scrollX,
    scrollY,
    collisionPadding
  );

  if (clamped.top !== position.top || clamped.left !== position.left) {
    collisionResolved = true;
  }

  position = clamped;
  overflowSides = getOverflowSides(
    position,
    contentRect,
    viewportWidth,
    viewportHeight,
    scrollX,
    scrollY,
    collisionPadding
  );

  return {
    top: Math.round(position.top),
    left: Math.round(position.left),
    side: finalSide,
    align,
    collisionResolved,
    overflow: overflowSides.length > 0,
    overflowSides,
  };
}

export function computePositionAtPoint(
  point: PointLike,
  contentRectLike: RectLike,
  options: ComputePositionOptions
): PositionResult {
  return computePosition(
    {
      top: point.y,
      left: point.x,
      width: 0,
      height: 0,
      right: point.x,
      bottom: point.y,
    },
    contentRectLike,
    options
  );
}

export function toPositionStyle(result: Pick<PositionResult, 'top' | 'left'>): {
  position: 'absolute';
  top: number;
  left: number;
  opacity: 1;
} {
  return {
    position: 'absolute',
    top: result.top,
    left: result.left,
    opacity: 1,
  };
}

export function applyPositionDataAttributes(
  node: HTMLElement,
  result: Pick<PositionResult, 'side' | 'align' | 'collisionResolved'>
): void {
  node.setAttribute('data-side', result.side);
  node.setAttribute('data-align', result.align);
  node.setAttribute('data-collision-resolved', result.collisionResolved ? 'true' : 'false');
}
