import React, { createContext, useContext, useRef } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useComposedRefs } from './hooks/use-composed-refs';
import { usePosition, Side, Align } from './hooks/use-position';
import { useOutsideClick } from './hooks/use-outside-click';
import { useEscapeKeydown } from './hooks/use-escape-keydown';
import { useFocusTrap } from './hooks/use-focus-trap';
import { Portal } from './portal';

/* -------------------------------------------------------------------------------------------------
 * Popover Root
 * -----------------------------------------------------------------------------------------------*/

interface PopoverContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement>;
  contentRef: React.RefObject<HTMLElement>;
  modal: boolean;
}

const PopoverContext = createContext<PopoverContextValue | undefined>(undefined);

const usePopoverContext = () => {
  const context = useContext(PopoverContext);
  if (!context) {
    throw new Error('Popover components must be used within a Popover');
  }
  return context;
};

export interface PopoverProps {
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
}

export const Popover: React.FC<PopoverProps> = (props) => {
  const {
    children,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    modal = false,
  } = props;

  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });

  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);

  return (
    <PopoverContext.Provider
      value={{
        open: !!open,
        onOpenChange: setOpen,
        triggerRef,
        contentRef,
        modal,
      }}
    >
      {children}
    </PopoverContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * PopoverTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface PopoverTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const PopoverTrigger = React.forwardRef<HTMLButtonElement, PopoverTriggerProps>(
  (props, ref) => {
    const { children, onClick, ...domProps } = props;
    const context = usePopoverContext();
    const composedRef = useComposedRefs(ref, context.triggerRef);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        context.onOpenChange(!context.open);
      }
    };

    return (
      <button
        ref={composedRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={context.open}
        aria-controls={context.open ? 'popover-content' : undefined}
        data-state={context.open ? 'open' : 'closed'}
        onClick={handleClick}
        {...domProps}
      >
        {children}
      </button>
    );
  }
);

PopoverTrigger.displayName = 'PopoverTrigger';

/* -------------------------------------------------------------------------------------------------
 * PopoverContent
 * -----------------------------------------------------------------------------------------------*/

export interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPointerDownOutside?: (event: PointerEvent) => void;
  forceMount?: boolean;
}

export const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  (props, ref) => {
    const {
      children,
      side = 'bottom',
      align = 'center',
      sideOffset = 5,
      alignOffset = 0,
      onEscapeKeyDown,
      forceMount,
      style,
      ...domProps
    } = props;

    const context = usePopoverContext();
    const composedRef = useComposedRefs(ref, context.contentRef);

    const { style: positionStyle } = usePosition(context.triggerRef, context.contentRef, {
      side,
      align,
      sideOffset,
      alignOffset,
    });

    // Focus Trap if modal
    useFocusTrap(context.contentRef, context.open && context.modal);

    // Click Outside
    useOutsideClick(context.contentRef, (e) => {
        // Also ignore if clicked on trigger
        if (context.triggerRef.current?.contains(e.target as Node)) return;
        context.onOpenChange(false);
    }, context.open);

    // Escape Key
    useEscapeKeydown((e) => {
        if (!context.open) return;
        onEscapeKeyDown?.(e);
        if (!e.defaultPrevented) {
            context.onOpenChange(false);
        }
    });

    if (!context.open && !forceMount) return null;

    return (
      <Portal>
        <div
          ref={composedRef}
          role="dialog"
          id="popover-content"
          data-state={context.open ? 'open' : 'closed'}
          data-side={side}
          data-align={align}
          style={{
            ...positionStyle,
            zIndex: 50,
            backgroundColor: 'white',
            border: '1px solid #ccc', // Default simplistic style
            borderRadius: '4px',
            padding: '10px',
            ...style
          }}
          {...domProps}
        >
          {children}
        </div>
      </Portal>
    );
  }
);

PopoverContent.displayName = 'PopoverContent';

/* -------------------------------------------------------------------------------------------------
 * PopoverClose
 * -----------------------------------------------------------------------------------------------*/

export interface PopoverCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const PopoverClose = React.forwardRef<HTMLButtonElement, PopoverCloseProps>(
  (props, ref) => {
    const { onClick, ...domProps } = props;
    const context = usePopoverContext();

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        context.onOpenChange(false);
      }
    };

    return (
      <button ref={ref} type="button" onClick={handleClick} {...domProps}>
        {props.children}
      </button>
    );
  }
);

PopoverClose.displayName = 'PopoverClose';
