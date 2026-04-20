import React, { createContext, useContext, useRef } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useComposedRefs } from './hooks/use-composed-refs';
import { usePosition, Side, Align } from './hooks/use-position';
import { useEscapeKeydown } from './hooks/use-escape-keydown';
import { useFocusTrap } from './hooks/use-focus-trap';
import { Portal } from './portal';
import { useId } from './hooks/use-id';
import { assertReactContext } from './utils/assert-context';

/* -------------------------------------------------------------------------------------------------
 * Popover Root
 * -----------------------------------------------------------------------------------------------*/

interface PopoverContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentId: string;
  triggerRef: React.RefObject<HTMLElement>;
  contentRef: React.RefObject<HTMLElement>;
  modal: boolean;
}

const PopoverContext = createContext<PopoverContextValue | undefined>(undefined);

const usePopoverContext = () => {
  return assertReactContext(
    useContext(PopoverContext),
    'Popover',
    'Popover components must be used within a Popover'
  );
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
  const contentId = useId(undefined, { prefix: 'popover', slot: 'content' });

  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);

  return (
    <PopoverContext.Provider
      value={{
        open: !!open,
        onOpenChange: setOpen,
        contentId,
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
        aria-controls={context.open ? context.contentId : undefined}
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
    const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null);
    const composedRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        setContentNode(node);
        (context.contentRef as React.MutableRefObject<HTMLElement | null>).current = node;
        if (typeof ref === 'function') {
          ref(node);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [context.contentRef, ref]
    );

    const { style: positionStyle } = usePosition(context.triggerRef, context.contentRef, {
      side,
      align,
      sideOffset,
      alignOffset,
    });

    // Focus Trap if modal
    useFocusTrap(context.contentRef, context.open && context.modal);

    React.useEffect(() => {
      if (!context.open || !contentNode) {
        return;
      }

      const ownerDocument = contentNode.ownerDocument;

      const handlePointerDown = (event: MouseEvent | PointerEvent | TouchEvent) => {
        const target = event.target as Node | null;
        if (!target) {
          return;
        }

        if (contentNode.contains(target)) {
          return;
        }

        if (context.triggerRef.current?.contains(target)) {
          return;
        }

        context.onOpenChange(false);
      };

      ownerDocument.addEventListener('pointerdown', handlePointerDown);
      ownerDocument.addEventListener('mousedown', handlePointerDown);
      ownerDocument.addEventListener('touchstart', handlePointerDown);

      return () => {
        ownerDocument.removeEventListener('pointerdown', handlePointerDown);
        ownerDocument.removeEventListener('mousedown', handlePointerDown);
        ownerDocument.removeEventListener('touchstart', handlePointerDown);
      };
    }, [contentNode, context.onOpenChange, context.open, context.triggerRef]);

    // Escape Key
    useEscapeKeydown((e) => {
        if (!context.open) return;
        onEscapeKeyDown?.(e);
        if (!e.defaultPrevented) {
            context.onOpenChange(false);
            queueMicrotask(() => {
              context.triggerRef.current?.focus();
            });
        }
    });

    if (!context.open && !forceMount) return null;

    return (
      <Portal>
        <div
          ref={composedRef}
          role="dialog"
          id={context.contentId}
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
