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
  let frame = 0;

  function updatePosition() {
    if (!trigger || !node) return;
    const triggerRect = trigger.getBoundingClientRect();
    const contentRect = node.getBoundingClientRect();

    const result = computePosition(triggerRect, contentRect, {
      side,
      align,
      sideOffset,
      alignOffset,
      collisionDetection,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: 0,
      scrollY: 0,
    });

    node.style.position = 'fixed';
    node.style.top = `${result.top}px`;
    node.style.left = `${result.left}px`;
    applyPositionDataAttributes(node, result);
  }

  function schedulePositionUpdate() {
    if (frame) {
      cancelAnimationFrame(frame);
    }

    frame = requestAnimationFrame(() => {
      frame = 0;
      updatePosition();
    });
  }

  updatePosition();
  schedulePositionUpdate();
  window.addEventListener('resize', schedulePositionUpdate);
  window.addEventListener('scroll', schedulePositionUpdate, true);

  return {
    update(newOptions: PositionOptions) {
      trigger = newOptions.trigger;
      side = newOptions.side || 'bottom';
      align = newOptions.align || 'center';
      sideOffset = newOptions.sideOffset || 0;
      alignOffset = newOptions.alignOffset || 0;
      collisionDetection = newOptions.collisionDetection ?? true;
      schedulePositionUpdate();
    },
    destroy() {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      window.removeEventListener('resize', schedulePositionUpdate);
      window.removeEventListener('scroll', schedulePositionUpdate, true);
    }
  };
}
