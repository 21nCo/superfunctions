import React, { createContext, useContext, useRef, useEffect } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useComposedRefs } from './hooks/use-composed-refs';
import { usePosition, Side, Align } from './hooks/use-position';
import { useId } from './hooks/use-id';
import { Portal } from './portal';
import { Slot } from './utils/slot';

/* -------------------------------------------------------------------------------------------------
 * Tooltip Root
 * -----------------------------------------------------------------------------------------------*/

interface TooltipContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement>;
  contentRef: React.RefObject<HTMLElement>;
  openWithDelay: () => void;
  close: () => void;
  contentId: string;
}

const TooltipContext = createContext<TooltipContextValue | undefined>(undefined);

const useTooltipContext = () => {
  const context = useContext(TooltipContext);
  if (!context) {
    throw new Error('Tooltip components must be used within a Tooltip');
  }
  return context;
};

export interface TooltipProps {
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
}

export const Tooltip: React.FC<TooltipProps> = (props) => {
  const {
    children,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    delayDuration = 700,
  } = props;

  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  
  const contentId = useId();
  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  
  // We use a ref to store the machine instance or logic to avoid recreating it
  // But since we are inside React component, we can just use effects/refs.
  const timeoutRef = useRef<any>();

  const openWithDelay = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (delayDuration <= 0) {
      setOpen(true);
    } else {
      timeoutRef.current = setTimeout(() => {
        setOpen(true);
      }, delayDuration);
    }
  };

  const close = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <TooltipContext.Provider
      value={{
        open: !!open,
        onOpenChange: setOpen,
        triggerRef,
        contentRef,
        openWithDelay,
        close,
        contentId: contentId || 'tooltip-content',
      }}
    >
      {children}
    </TooltipContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * TooltipTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface TooltipTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

export const TooltipTrigger = React.forwardRef<HTMLButtonElement, TooltipTriggerProps>(
  (props, ref) => {
    const {
      children,
      onMouseEnter,
      onMouseLeave,
      onFocus,
      onBlur,
      onClick,
      asChild = false,
      ...domProps
    } = props;
    const context = useTooltipContext();
    const composedRef = useComposedRefs(ref, context.triggerRef);
    const TriggerComp = asChild ? Slot : 'button';

    return (
      <TriggerComp
        ref={composedRef}
        {...(!asChild ? { type: 'button' as const } : undefined)}
        aria-describedby={context.open ? context.contentId : undefined}
        data-state={context.open ? 'delayed-open' : 'closed'} // Simplified state
        onMouseEnter={(e) => {
          onMouseEnter?.(e);
          context.openWithDelay();
        }}
        onMouseLeave={(e) => {
          onMouseLeave?.(e);
          context.close();
        }}
        onFocus={(e) => {
            onFocus?.(e);
            context.openWithDelay();
        }}
        onBlur={(e) => {
            onBlur?.(e);
            context.close();
        }}
        onClick={(e) => {
            onClick?.(e);
            // Tooltips sometimes close on click or stay open. 
            // Often if it's a button, clicking performs action and tooltip might persist or close.
            // Let's keep it simple: do nothing special on click regarding tooltip state.
        }}
        {...domProps}
      >
        {children}
      </TriggerComp>
    );
  }
);

TooltipTrigger.displayName = 'TooltipTrigger';

/* -------------------------------------------------------------------------------------------------
 * TooltipContent
 * -----------------------------------------------------------------------------------------------*/

export interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  forceMount?: boolean;
}

export const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  (props, ref) => {
    const {
      children,
      side = 'top',
      align = 'center',
      sideOffset = 5,
      alignOffset = 0,
      forceMount,
      style,
      onMouseEnter,
      onMouseLeave,
      ...domProps
    } = props;

    const context = useTooltipContext();
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
          role="tooltip"
          id={context.contentId}
          data-state={context.open ? 'delayed-open' : 'closed'}
          data-side={side}
          data-align={align}
          style={{
            ...positionStyle,
            zIndex: 60,
            pointerEvents: 'none', // Tooltips usually don't capture pointer events
            backgroundColor: 'black',
            color: 'white',
            borderRadius: '4px',
            padding: '5px 10px',
            fontSize: '12px',
            ...style
          }}
          onMouseEnter={(e) => {
              onMouseEnter?.(e);
              // If we want hoverable content, we would clear timeout here
          }}
          onMouseLeave={(e) => {
              onMouseLeave?.(e);
          }}
          {...domProps}
        >
          {children}
        </div>
      </Portal>
    );
  }
);

TooltipContent.displayName = 'TooltipContent';
