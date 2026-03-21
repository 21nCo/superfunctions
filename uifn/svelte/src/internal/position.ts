import {
  applyPositionDataAttributes,
  computePosition,
  type Align,
  type Side,
} from '@uifn/core/utils/position';

interface PositionOptions {
  trigger?: HTMLElement;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  collisionDetection?: boolean;
}

export function position(node: HTMLElement, options: PositionOptions) {
  let { trigger, side = 'bottom', align = 'center', sideOffset = 0, alignOffset = 0, collisionDetection = true } = options;

  function updatePosition() {
    if (!trigger || !node) return;

    const result = computePosition(trigger.getBoundingClientRect(), node.getBoundingClientRect(), {
      side,
      align,
      sideOffset,
      alignOffset,
      collisionDetection,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    });

    node.style.position = 'absolute';
    node.style.top = `${result.top}px`;
    node.style.left = `${result.left}px`;
    applyPositionDataAttributes(node, result);
  }

  updatePosition();
  window.addEventListener('resize', updatePosition);
  window.addEventListener('scroll', updatePosition, true);

  return {
    update(newOptions: PositionOptions) {
      trigger = newOptions.trigger;
      side = newOptions.side || 'bottom';
      align = newOptions.align || 'center';
      sideOffset = newOptions.sideOffset || 0;
      alignOffset = newOptions.alignOffset || 0;
      collisionDetection = newOptions.collisionDetection ?? true;
      updatePosition();
    },
    destroy() {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    }
  };
}
