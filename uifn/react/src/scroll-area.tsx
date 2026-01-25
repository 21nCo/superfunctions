import React, { createContext, useContext, useRef } from 'react';

/* -------------------------------------------------------------------------------------------------
 * ScrollArea Root
 * -----------------------------------------------------------------------------------------------*/

interface ScrollAreaContextValue {
  viewportRef: React.RefObject<HTMLDivElement>;
  scrollbarXRef: React.RefObject<HTMLDivElement>;
  scrollbarYRef: React.RefObject<HTMLDivElement>;
}

const ScrollAreaContext = createContext<ScrollAreaContextValue | undefined>(undefined);

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  (props, ref) => {
    const { children, ...domProps } = props;
    const viewportRef = useRef<HTMLDivElement>(null);
    const scrollbarXRef = useRef<HTMLDivElement>(null);
    const scrollbarYRef = useRef<HTMLDivElement>(null);

    return (
      <ScrollAreaContext.Provider value={{ viewportRef, scrollbarXRef, scrollbarYRef }}>
        <div
          ref={ref}
          style={{
              position: 'relative',
              overflow: 'hidden',
              ...domProps.style
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

/* -------------------------------------------------------------------------------------------------
 * ScrollAreaViewport
 * -----------------------------------------------------------------------------------------------*/

export interface ScrollAreaViewportProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ScrollAreaViewport = React.forwardRef<HTMLDivElement, ScrollAreaViewportProps>(
  (props, _ref) => {
    const context = useContext(ScrollAreaContext);
    if (!context) throw new Error('ScrollAreaViewport must be used within ScrollArea');

    return (
      <div
        ref={context.viewportRef}
        style={{
            width: '100%',
            height: '100%',
            overflow: 'scroll',
            scrollbarWidth: 'none', // Hide native scrollbar
            msOverflowStyle: 'none',
            ...props.style
        }}
        {...props}
      >
        <div style={{ minWidth: '100%', display: 'table' }}>
            {props.children}
        </div>
      </div>
    );
  }
);

ScrollAreaViewport.displayName = 'ScrollAreaViewport';

/* -------------------------------------------------------------------------------------------------
 * ScrollAreaScrollbar
 * -----------------------------------------------------------------------------------------------*/

export interface ScrollAreaScrollbarProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
}

export const ScrollAreaScrollbar = React.forwardRef<HTMLDivElement, ScrollAreaScrollbarProps>(
  (props, _ref) => {
    const { orientation = 'vertical', ...domProps } = props;
    const context = useContext(ScrollAreaContext);
    if (!context) throw new Error('ScrollAreaScrollbar must be used within ScrollArea');

    // Implementation of custom scrollbar logic (thumb size, position)
    // requires tracking viewport scroll events and content size.
    // For this primitive, we provide the container. Logic is usually complex.
    
    return (
      <div
        ref={orientation === 'vertical' ? context.scrollbarYRef : context.scrollbarXRef}
        data-orientation={orientation}
        style={{
            position: 'absolute',
            userSelect: 'none',
            touchAction: 'none',
            display: 'flex',
            ...(orientation === 'vertical' ? {
                right: 0, top: 0, bottom: 0, width: '10px'
            } : {
                bottom: 0, left: 0, right: 0, height: '10px'
            }),
            ...domProps.style
        }}
        {...domProps}
      />
    );
  }
);

ScrollAreaScrollbar.displayName = 'ScrollAreaScrollbar';

/* -------------------------------------------------------------------------------------------------
 * ScrollAreaThumb
 * -----------------------------------------------------------------------------------------------*/

export interface ScrollAreaThumbProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ScrollAreaThumb = React.forwardRef<HTMLDivElement, ScrollAreaThumbProps>(
  (props, ref) => {
    return (
      <div
        ref={ref}
        style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.3)',
            borderRadius: '10px',
            position: 'relative',
            ...props.style
        }}
        {...props}
      />
    );
  }
);

ScrollAreaThumb.displayName = 'ScrollAreaThumb';
