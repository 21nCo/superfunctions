import React, { createContext, useContext, useRef } from 'react';
import { assertReactContext } from './utils/assert-context';

interface ScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

interface ScrollAreaContextValue {
  viewportRef: React.RefObject<HTMLDivElement>;
  scrollbarXRef: React.RefObject<HTMLDivElement>;
  scrollbarYRef: React.RefObject<HTMLDivElement>;
  metrics: ScrollMetrics;
  updateMetrics: (node?: HTMLDivElement | null) => void;
}

interface ScrollbarContextValue {
  orientation: 'horizontal' | 'vertical';
}

const EMPTY_METRICS: ScrollMetrics = {
  scrollTop: 0,
  scrollLeft: 0,
  scrollHeight: 0,
  scrollWidth: 0,
  clientHeight: 0,
  clientWidth: 0,
};

const ScrollAreaContext = createContext<ScrollAreaContextValue | undefined>(undefined);
const ScrollbarContext = createContext<ScrollbarContextValue | undefined>(undefined);

function measureScrollMetrics(node?: HTMLDivElement | null): ScrollMetrics {
  if (!node) {
    return EMPTY_METRICS;
  }

  return {
    scrollTop: node.scrollTop,
    scrollLeft: node.scrollLeft,
    scrollHeight: node.scrollHeight,
    scrollWidth: node.scrollWidth,
    clientHeight: node.clientHeight,
    clientWidth: node.clientWidth,
  };
}

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  (props, ref) => {
    const { children, ...domProps } = props;
    const viewportRef = useRef<HTMLDivElement>(null);
    const scrollbarXRef = useRef<HTMLDivElement>(null);
    const scrollbarYRef = useRef<HTMLDivElement>(null);
    const [metrics, setMetrics] = React.useState<ScrollMetrics>(EMPTY_METRICS);

    const updateMetrics = React.useCallback((node?: HTMLDivElement | null) => {
      setMetrics(measureScrollMetrics(node ?? viewportRef.current));
    }, []);

    return (
      <ScrollAreaContext.Provider
        value={{ viewportRef, scrollbarXRef, scrollbarYRef, metrics, updateMetrics }}
      >
        <div
          ref={ref}
          style={{
            position: 'relative',
            overflow: 'hidden',
            ...domProps.style,
          }}
          {...domProps}
        >
          {children}
        </div>
      </ScrollAreaContext.Provider>
    );
  }
);

ScrollArea.displayName = 'ScrollArea';

export interface ScrollAreaViewportProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ScrollAreaViewport = React.forwardRef<HTMLDivElement, ScrollAreaViewportProps>(
  (props, ref) => {
    const { onScroll, children, style, ...domProps } = props;
    const context = assertReactContext(
      useContext(ScrollAreaContext),
      'ScrollAreaViewport',
      'ScrollAreaViewport must be used within ScrollArea'
    );

    const composedRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        (context.viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        if (typeof ref === 'function') {
          ref(node);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [context, ref]
    );

    React.useEffect(() => {
      context.updateMetrics(context.viewportRef.current);
    }, [children, context.updateMetrics, context.viewportRef, style]);

    return (
      <div
        ref={composedRef}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'scroll',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          ...style,
        }}
        onScroll={(event) => {
          context.updateMetrics(event.currentTarget);
          onScroll?.(event);
        }}
        {...domProps}
      >
        <div style={{ minWidth: '100%', display: 'table' }}>{children}</div>
      </div>
    );
  }
);

ScrollAreaViewport.displayName = 'ScrollAreaViewport';

export interface ScrollAreaScrollbarProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
}

export const ScrollAreaScrollbar = React.forwardRef<HTMLDivElement, ScrollAreaScrollbarProps>(
  (props, ref) => {
    const { orientation = 'vertical', style, children, ...domProps } = props;
    const context = assertReactContext(
      useContext(ScrollAreaContext),
      'ScrollAreaScrollbar',
      'ScrollAreaScrollbar must be used within ScrollArea'
    );

    const visible =
      orientation === 'vertical'
        ? context.metrics.scrollHeight > context.metrics.clientHeight
        : context.metrics.scrollWidth > context.metrics.clientWidth;

    const scrollbarRef =
      orientation === 'vertical' ? context.scrollbarYRef : context.scrollbarXRef;

    const composedRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        (scrollbarRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        if (typeof ref === 'function') {
          ref(node);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [ref, scrollbarRef]
    );

    return (
      <ScrollbarContext.Provider value={{ orientation }}>
        <div
          ref={composedRef}
          data-orientation={orientation}
          data-state={visible ? 'visible' : 'hidden'}
          style={{
            position: 'absolute',
            userSelect: 'none',
            touchAction: 'none',
            display: visible ? 'flex' : 'none',
            ...(orientation === 'vertical'
              ? { right: 0, top: 0, bottom: 0, width: '10px' }
              : { bottom: 0, left: 0, right: 0, height: '10px' }),
            ...style,
          }}
          {...domProps}
        >
          {children}
        </div>
      </ScrollbarContext.Provider>
    );
  }
);

ScrollAreaScrollbar.displayName = 'ScrollAreaScrollbar';

export interface ScrollAreaThumbProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ScrollAreaThumb = React.forwardRef<HTMLDivElement, ScrollAreaThumbProps>(
  (props, ref) => {
    const { onPointerDown, style, ...domProps } = props;
    const context = assertReactContext(
      useContext(ScrollAreaContext),
      'ScrollAreaThumb',
      'ScrollAreaThumb must be used within ScrollArea'
    );
    const scrollbarContext = assertReactContext(
      useContext(ScrollbarContext),
      'ScrollAreaThumb',
      'ScrollAreaThumb must be used within ScrollAreaScrollbar'
    );

    const orientation = scrollbarContext.orientation;
    const scrollSize =
      orientation === 'vertical' ? context.metrics.scrollHeight : context.metrics.scrollWidth;
    const clientSize =
      orientation === 'vertical' ? context.metrics.clientHeight : context.metrics.clientWidth;
    const scrollOffset =
      orientation === 'vertical' ? context.metrics.scrollTop : context.metrics.scrollLeft;
    const scrollableSize = Math.max(0, scrollSize - clientSize);
    const sizePercent =
      scrollSize > 0 ? Math.max((clientSize / scrollSize) * 100, 10) : 100;
    const offsetPercent =
      scrollableSize > 0 ? (scrollOffset / scrollableSize) * (100 - sizePercent) : 0;

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
      onPointerDown?.(event);
      if (event.defaultPrevented) {
        return;
      }

      const viewport = context.viewportRef.current;
      const track = event.currentTarget.parentElement as HTMLDivElement | null;
      if (!viewport || !track) {
        return;
      }

      event.preventDefault();

      const startPointer = orientation === 'vertical' ? event.clientY : event.clientX;
      const startScroll = orientation === 'vertical' ? viewport.scrollTop : viewport.scrollLeft;
      const trackRect = track.getBoundingClientRect();
      const trackSize = orientation === 'vertical' ? trackRect.height : trackRect.width;
      const thumbSizePx = Math.max((clientSize / Math.max(scrollSize, 1)) * trackSize, 16);
      const maxThumbTravel = Math.max(trackSize - thumbSizePx, 1);
      const maxScroll = Math.max(scrollSize - clientSize, 0);
      const ownerDocument = viewport.ownerDocument;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const delta =
          (orientation === 'vertical' ? moveEvent.clientY : moveEvent.clientX) - startPointer;
        const nextScroll = Math.max(
          0,
          Math.min(maxScroll, startScroll + delta * (maxScroll / maxThumbTravel))
        );

        if (orientation === 'vertical') {
          viewport.scrollTop = nextScroll;
        } else {
          viewport.scrollLeft = nextScroll;
        }

        context.updateMetrics(viewport);
      };

      const handlePointerUp = () => {
        ownerDocument.removeEventListener('pointermove', handlePointerMove);
        ownerDocument.removeEventListener('pointerup', handlePointerUp);
      };

      ownerDocument.addEventListener('pointermove', handlePointerMove);
      ownerDocument.addEventListener('pointerup', handlePointerUp);
    };

    return (
      <div
        ref={ref}
        data-thumb-position={offsetPercent.toFixed(2)}
        data-thumb-size={sizePercent.toFixed(2)}
        onPointerDown={handlePointerDown}
        style={{
          position: 'relative',
          backgroundColor: 'rgba(0,0,0,0.3)',
          borderRadius: '10px',
          flex: 'none',
          ...(orientation === 'vertical'
            ? {
                width: '100%',
                height: `${sizePercent}%`,
                transform: `translateY(${offsetPercent}%)`,
              }
            : {
                height: '100%',
                width: `${sizePercent}%`,
                transform: `translateX(${offsetPercent}%)`,
              }),
          ...style,
        }}
        {...domProps}
      />
    );
  }
);

ScrollAreaThumb.displayName = 'ScrollAreaThumb';
