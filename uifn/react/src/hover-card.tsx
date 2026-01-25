import React, { createContext, useContext, useRef, useEffect, useCallback } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useComposedRefs } from './hooks/use-composed-refs';
import { usePosition, Side, Align } from './hooks/use-position';
import { Portal } from './portal';

/* -------------------------------------------------------------------------------------------------
 * HoverCard Root
 * -----------------------------------------------------------------------------------------------*/

interface HoverCardContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement>;
  contentRef: React.RefObject<HTMLElement>;
  openWithDelay: () => void;
  closeWithDelay: () => void;
  cancelClose: () => void;
  openDelay: number;
  closeDelay: number;
}

const HoverCardContext = createContext<HoverCardContextValue | undefined>(undefined);

const useHoverCardContext = () => {
  const context = useContext(HoverCardContext);
  if (!context) {
    throw new Error('HoverCard components must be used within a HoverCard');
  }
  return context;
};

export interface HoverCardProps {
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  openDelay?: number;
  closeDelay?: number;
}

export const HoverCard: React.FC<HoverCardProps> = (props) => {
  const {
    children,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    openDelay = 700,
    closeDelay = 300,
  } = props;

  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });

  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const openTimerRef = useRef<any>();
  const closeTimerRef = useRef<any>();

  const openWithDelay = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    
    if (openDelay <= 0) {
      setOpen(true);
    } else {
      openTimerRef.current = setTimeout(() => {
        setOpen(true);
      }, openDelay);
    }
  }, [openDelay, setOpen]);

  const closeWithDelay = useCallback(() => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);

    if (closeDelay <= 0) {
      setOpen(false);
    } else {
      closeTimerRef.current = setTimeout(() => {
        setOpen(false);
      }, closeDelay);
    }
  }, [closeDelay, setOpen]);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    return () => {
      if (openTimerRef.current) clearTimeout(openTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  return (
    <HoverCardContext.Provider
      value={{
        open: !!open,
        onOpenChange: setOpen,
        triggerRef,
        contentRef,
        openWithDelay,
        closeWithDelay,
        cancelClose,
        openDelay,
        closeDelay,
      }}
    >
      {children}
    </HoverCardContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * HoverCardTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface HoverCardTriggerProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  asChild?: boolean; // Placeholder for polymorphism support in future
}

// HoverCardTrigger is often a link
export const HoverCardTrigger = React.forwardRef<HTMLAnchorElement, HoverCardTriggerProps>(
  (props, ref) => {
    const { children, onMouseEnter, onMouseLeave, onFocus, onBlur, ...domProps } = props;
    const context = useHoverCardContext();
    const composedRef = useComposedRefs(ref, context.triggerRef);

    return (
      <a
        ref={composedRef}
        data-state={context.open ? 'open' : 'closed'}
        onMouseEnter={(e) => {
          onMouseEnter?.(e);
          context.openWithDelay();
        }}
        onMouseLeave={(e) => {
          onMouseLeave?.(e);
          context.closeWithDelay();
        }}
        onFocus={(e) => {
            onFocus?.(e);
            // HoverCard usually only opens on hover, but focus support is good for a11y if content is relevant
            context.openWithDelay();
        }}
        onBlur={(e) => {
            onBlur?.(e);
            context.closeWithDelay();
        }}
        {...domProps}
      >
        {children}
      </a>
    );
  }
);

HoverCardTrigger.displayName = 'HoverCardTrigger';

/* -------------------------------------------------------------------------------------------------
 * HoverCardContent
 * -----------------------------------------------------------------------------------------------*/

export interface HoverCardContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  forceMount?: boolean;
}

export const HoverCardContent = React.forwardRef<HTMLDivElement, HoverCardContentProps>(
  (props, ref) => {
    const {
      children,
      side = 'bottom',
      align = 'center',
      sideOffset = 5,
      alignOffset = 0,
      forceMount,
      style,
      onMouseEnter,
      onMouseLeave,
      ...domProps
    } = props;

    const context = useHoverCardContext();
    const composedRef = useComposedRefs(ref, context.contentRef);

    const { style: positionStyle } = usePosition(context.triggerRef, context.contentRef, {
      side,
      align,
      sideOffset,
      alignOffset,
    });

    if (!context.open && !forceMount) return null;

    return (
      <Portal>
        <div
          ref={composedRef}
          data-state={context.open ? 'open' : 'closed'}
          data-side={side}
          data-align={align}
          style={{
            ...positionStyle,
            zIndex: 50,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '10px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
            ...style
          }}
          onMouseEnter={(e) => {
              onMouseEnter?.(e);
              context.cancelClose();
          }}
          onMouseLeave={(e) => {
              onMouseLeave?.(e);
              context.closeWithDelay();
          }}
          {...domProps}
        >
          {children}
        </div>
      </Portal>
    );
  }
);

HoverCardContent.displayName = 'HoverCardContent';
