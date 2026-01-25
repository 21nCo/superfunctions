import { ref, onMounted, onBeforeUnmount, Ref } from 'vue';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type Align = 'start' | 'center' | 'end';

interface UsePositionOptions {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  collisionDetection?: boolean;
}

export function usePosition(
  triggerRef: Ref<HTMLElement | undefined>,
  contentRef: Ref<HTMLElement | undefined>,
  options: UsePositionOptions = {}
) {
  const style = ref({
    position: 'absolute',
    left: '0px',
    top: '0px',
    opacity: '0'
  });

  const updatePosition = () => {
    const trigger = triggerRef.value;
    const content = contentRef.value;

    if (!trigger || !content) return;

    const triggerRect = trigger.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    const side = options.side || 'bottom';
    const align = options.align || 'center';
    const sideOffset = options.sideOffset || 0;
    const alignOffset = options.alignOffset || 0;
    const collisionDetection = options.collisionDetection ?? true;

    let finalSide = side;

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
    
    // Clamp
    if (pos.left - scrollX < 0) pos.left = scrollX + 5;
    if (pos.left + contentRect.width - scrollX > viewportWidth) pos.left = scrollX + viewportWidth - contentRect.width - 5;

    if (finalSide === 'left' || finalSide === 'right') {
         if (pos.top - scrollY < 0) pos.top = scrollY + 5;
         if (pos.top + contentRect.height - scrollY > viewportHeight) pos.top = scrollY + viewportHeight - contentRect.height - 5;
    }

    style.value = {
      position: 'absolute',
      top: `${Math.round(pos.top)}px`,
      left: `${Math.round(pos.left)}px`,
      opacity: '1'
    };
  };

  onMounted(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('resize', updatePosition);
    window.removeEventListener('scroll', updatePosition, true);
  });

  return { style, updatePosition };
}
