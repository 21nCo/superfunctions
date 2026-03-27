import React, { createContext, useContext, useRef } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useComposedRefs } from './hooks/use-composed-refs';
import { usePosition, Side, Align } from './hooks/use-position';
import { useOutsideClick } from './hooks/use-outside-click';
import { useEscapeKeydown } from './hooks/use-escape-keydown';
import { Portal } from './portal';
import { assertReactContext } from './utils/assert-context';
import { useId } from './hooks/use-id';

/* -------------------------------------------------------------------------------------------------
 * DropdownMenu Root
 * -----------------------------------------------------------------------------------------------*/

interface DropdownMenuContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentId: string;
  triggerRef: React.RefObject<HTMLElement>;
  contentRef: React.RefObject<HTMLElement>;
}

const DropdownMenuContext = createContext<DropdownMenuContextValue | undefined>(undefined);

const useDropdownMenuContext = () => {
  return assertReactContext(
    useContext(DropdownMenuContext),
    'DropdownMenu',
    'DropdownMenu components must be used within a DropdownMenu'
  );
};

export interface DropdownMenuProps {
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const DropdownMenu: React.FC<DropdownMenuProps> = (props) => {
  const {
    children,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
  } = props;

  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  const contentId = useId(undefined, { prefix: 'dropdown-menu', slot: 'content' });

  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);

  return (
    <DropdownMenuContext.Provider
      value={{
        open: !!open,
        onOpenChange: setOpen,
        contentId,
        triggerRef,
        contentRef,
      }}
    >
      {children}
    </DropdownMenuContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * DropdownMenuTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface DropdownMenuTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const DropdownMenuTrigger = React.forwardRef<HTMLButtonElement, DropdownMenuTriggerProps>(
  (props, ref) => {
    const { children, onClick, onKeyDown, ...domProps } = props;
    const context = useDropdownMenuContext();
    const composedRef = useComposedRefs(ref, context.triggerRef);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        context.onOpenChange(!context.open);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(e);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!context.open) context.onOpenChange(true);
        }
    };

    return (
      <button
        ref={composedRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={context.open}
        aria-controls={context.open ? context.contentId : undefined}
        data-state={context.open ? 'open' : 'closed'}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        {...domProps}
      >
        {children}
      </button>
    );
  }
);

DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

/* -------------------------------------------------------------------------------------------------
 * DropdownMenuContent
 * -----------------------------------------------------------------------------------------------*/

export interface DropdownMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  forceMount?: boolean;
}

export const DropdownMenuContent = React.forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  (props, ref) => {
    const {
      children,
      side = 'bottom',
      align = 'center',
      sideOffset = 5,
      alignOffset = 0,
      forceMount,
      style,
      onKeyDown,
      ...domProps
    } = props;

    const context = useDropdownMenuContext();
    // const composedRef = useComposedRefs(ref, context.contentRef); <- Removing this line effectively by replacing context block

    const { style: positionStyle } = usePosition(context.triggerRef, context.contentRef, {
      side,
      align,
      sideOffset,
      alignOffset,
    });

    // Click Outside
    useOutsideClick(context.contentRef, (event) => {
        if (context.triggerRef.current?.contains(event.target as Node)) return;
        context.onOpenChange(false);
    }, context.open);

    // Escape Key
    useEscapeKeydown((_) => {
        if (!context.open) return;
        context.onOpenChange(false);
        context.triggerRef.current?.focus();
    });

    // Menu Navigation
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;

        const content = context.contentRef.current;
        if (!content) return;

        const items = Array.from(
          content.querySelectorAll(
            '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"])'
          )
        ) as HTMLElement[];
        if (!items.length) return;
        const currentIndex = items.indexOf(document.activeElement as HTMLElement);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const nextIndex = (currentIndex + 1) % items.length;
            items[nextIndex]?.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prevIndex = (currentIndex - 1 + items.length) % items.length;
            items[prevIndex]?.focus();
        } else if (e.key === 'Home') {
            e.preventDefault();
            items[0]?.focus();
        } else if (e.key === 'End') {
            e.preventDefault();
            items[items.length - 1]?.focus();
        }
    };

    // Auto focus first item on open - using callback ref to ensure DOM is ready
    const focusRef = React.useCallback((node: HTMLDivElement) => {
        if (node && context.open) {
             requestAnimationFrame(() => {
                 const items = node.querySelectorAll(
                   '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"])'
                 );
                 if (items.length > 0) {
                     (items[0] as HTMLElement).focus();
                 } else {
                     node.focus();
                 }
             });
        }
    }, [context.open]);

    const composedRef = useComposedRefs(ref, context.contentRef, focusRef);

    if (!context.open && !forceMount) return null;

    return (
      <Portal>
        <div
          ref={composedRef}
          role="menu"
          id={context.contentId}
          tabIndex={-1} // Allow focus
          data-state={context.open ? 'open' : 'closed'}
          data-side={side}
          data-align={align}
          style={{
            ...positionStyle,
            zIndex: 50,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '5px 0',
            minWidth: '150px',
            ...style
          }}
          onKeyDown={handleKeyDown}
          {...domProps}
        >
          {children}
        </div>
      </Portal>
    );
  }
);

DropdownMenuContent.displayName = 'DropdownMenuContent';

/* -------------------------------------------------------------------------------------------------
 * DropdownMenuItem
 * -----------------------------------------------------------------------------------------------*/

export interface DropdownMenuItemProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  disabled?: boolean;
  onSelect?: (event: Event) => void;
}

export const DropdownMenuItem = React.forwardRef<HTMLDivElement, DropdownMenuItemProps>(
  (props, ref) => {
    const { children, disabled, onSelect, onClick, onKeyDown, style, ...domProps } = props;
    const context = useDropdownMenuContext();

    const handleSelect = (e: React.MouseEvent | React.KeyboardEvent) => {
        if (disabled) return;
        onSelect?.(e.nativeEvent);
        onClick?.(e as any); // Cast for compatibility
        if (!e.defaultPrevented) {
            context.onOpenChange(false);
        }
    };

    return (
      <div
        ref={ref}
        role="menuitem"
        aria-disabled={disabled ? 'true' : undefined}
        tabIndex={disabled ? -1 : 0} // Roving focus usually sets -1 on inactive, but 0 is easier for basic implementation
        data-disabled={disabled ? '' : undefined}
        onClick={handleSelect}
        onKeyDown={(e) => {
            onKeyDown?.(e);
            if (e.key === 'Enter' || e.key === ' ') {
                handleSelect(e);
                e.preventDefault();
            }
        }}
        style={{
            padding: '5px 10px',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            outline: 'none',
            ...style
        }}
        {...domProps}
      >
        {children}
      </div>
    );
  }
);

DropdownMenuItem.displayName = 'DropdownMenuItem';

/* -------------------------------------------------------------------------------------------------
 * DropdownMenuLabel
 * -----------------------------------------------------------------------------------------------*/

export interface DropdownMenuLabelProps extends React.HTMLAttributes<HTMLDivElement> {}

export const DropdownMenuLabel = React.forwardRef<HTMLDivElement, DropdownMenuLabelProps>(
  (props, ref) => {
    return (
      <div
        ref={ref}
        {...props}
        style={{
            padding: '5px 10px',
            fontSize: '12px',
            color: '#666',
            fontWeight: 'bold',
            ...props.style
        }}
      />
    );
  }
);

DropdownMenuLabel.displayName = 'DropdownMenuLabel';

/* -------------------------------------------------------------------------------------------------
 * DropdownMenuSeparator
 * -----------------------------------------------------------------------------------------------*/

export interface DropdownMenuSeparatorProps extends React.HTMLAttributes<HTMLDivElement> {}

export const DropdownMenuSeparator = React.forwardRef<HTMLDivElement, DropdownMenuSeparatorProps>(
  (props, ref) => {
    return (
      <div
        ref={ref}
        role="separator"
        {...props}
        style={{
            height: '1px',
            backgroundColor: '#eee',
            margin: '5px 0',
            ...props.style
        }}
      />
    );
  }
);

DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';
