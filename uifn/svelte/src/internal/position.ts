export type Side = 'top' | 'right' | 'bottom' | 'left';
export type Align = 'start' | 'center' | 'end';

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

    const triggerRect = trigger.getBoundingClientRect();
    const contentRect = node.getBoundingClientRect();
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    let finalSide = side;
    let top = 0;
    let left = 0;

    const calculatePos = (s: Side) => {
        let t = 0;
        let l = 0;
        switch (s) {
            case 'top':
                t = triggerRect.top + scrollY - contentRect.height - sideOffset;
                break;
            case 'bottom':
                t = triggerRect.bottom + scrollY + sideOffset;
                break;
            case 'left':
                l = triggerRect.left + scrollX - contentRect.width - sideOffset;
                break;
            case 'right':
                l = triggerRect.right + scrollX + sideOffset;
                break;
        }

        if (s === 'top' || s === 'bottom') {
            switch (align) {
                case 'start':
                    l = triggerRect.left + scrollX + alignOffset;
                    break;
                case 'center':
                    l = triggerRect.left + scrollX + (triggerRect.width / 2) - (contentRect.width / 2);
                    break;
                case 'end':
                    l = triggerRect.right + scrollX - contentRect.width - alignOffset;
                    break;
            }
        } else {
            switch (align) {
                case 'start':
                    t = triggerRect.top + scrollY + alignOffset;
                    break;
                case 'center':
                    t = triggerRect.top + scrollY + (triggerRect.height / 2) - (contentRect.height / 2);
                    break;
                case 'end':
                    t = triggerRect.bottom + scrollY - contentRect.height - alignOffset;
                    break;
            }
        }
        return { top: t, left: l };
    };

    let pos = calculatePos(side);

    if (collisionDetection) {
        const overflowsBottom = (side === 'bottom') && (pos.top + contentRect.height - scrollY > viewportHeight);
        const overflowsTop = (side === 'top') && (pos.top - scrollY < 0);

        if (overflowsBottom) {
             const flippedPos = calculatePos('top');
             if (flippedPos.top - scrollY >= 0) {
                 pos = flippedPos;
                 finalSide = 'top';
             }
        } else if (overflowsTop) {
             const flippedPos = calculatePos('bottom');
             if (flippedPos.top + contentRect.height - scrollY <= viewportHeight) {
                 pos = flippedPos;
                 finalSide = 'bottom';
             }
        }
    }
    
    if (pos.left - scrollX < 0) pos.left = scrollX + 5;
    if (pos.left + contentRect.width - scrollX > viewportWidth) pos.left = scrollX + viewportWidth - contentRect.width - 5;

    if (finalSide === 'left' || finalSide === 'right') {
         if (pos.top - scrollY < 0) pos.top = scrollY + 5;
         if (pos.top + contentRect.height - scrollY > viewportHeight) pos.top = scrollY + viewportHeight - contentRect.height - 5;
    }

    node.style.position = 'absolute';
    node.style.top = `${Math.round(pos.top)}px`;
    node.style.left = `${Math.round(pos.left)}px`;
    node.setAttribute('data-side', finalSide);
    node.setAttribute('data-align', align);
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
