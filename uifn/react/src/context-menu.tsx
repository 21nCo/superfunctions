import React, { createContext, useContext, useRef, useState } from 'react';
import { useComposedRefs } from './hooks/use-composed-refs';
import { useOutsideClick } from './hooks/use-outside-click';
import { useEscapeKeydown } from './hooks/use-escape-keydown';
import { Portal } from './portal';

/* -------------------------------------------------------------------------------------------------
 * ContextMenu Root
 * -----------------------------------------------------------------------------------------------*/

interface ContextMenuContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  point: { x: number; y: number };
  onPointChange: (point: { x: number; y: number }) => void;
  contentRef: React.RefObject<HTMLElement>;
}

const ContextMenuContext = createContext<ContextMenuContextValue | undefined>(undefined);

const useContextMenuContext = () => {
  const context = useContext(ContextMenuContext);
  if (!context) {
    throw new Error('ContextMenu components must be used within a ContextMenu');
  }
  return context;
};

export interface ContextMenuProps {
  children?: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

export const ContextMenu: React.FC<ContextMenuProps> = (props) => {
  const { children, onOpenChange, disabled = false } = props;
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const contentRef = useRef<HTMLElement>(null);

  const handleOpenChange = (nextOpen: boolean) => {
      if (disabled) return;
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
  };

  return (
    <ContextMenuContext.Provider
      value={{
        open,
        onOpenChange: handleOpenChange,
        point,
        onPointChange: setPoint,
        contentRef,
      }}
    >
      {children}
    </ContextMenuContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * ContextMenuTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface ContextMenuTriggerProps extends React.HTMLAttributes<HTMLDivElement> {
    disabled?: boolean;
}

export const ContextMenuTrigger = React.forwardRef<HTMLDivElement, ContextMenuTriggerProps>(
  (props, ref) => {
    const { onContextMenu, ...domProps } = props;
    const context = useContextMenuContext();

    const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        onContextMenu?.(e);
        if (props.disabled) return;
        
        e.preventDefault();
        context.onPointChange({ x: e.clientX, y: e.clientY });
        context.onOpenChange(true);
    };

    return (
      <div
        ref={ref}
        onContextMenu={handleContextMenu}
        data-state={context.open ? 'open' : 'closed'}
        {...domProps}
      />
    );
  }
);

ContextMenuTrigger.displayName = 'ContextMenuTrigger';

/* -------------------------------------------------------------------------------------------------
 * ContextMenuContent
 * -----------------------------------------------------------------------------------------------*/

export interface ContextMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ContextMenuContent = React.forwardRef<HTMLDivElement, ContextMenuContentProps>(
  (props, ref) => {
    const { children, style, ...domProps } = props;
    const context = useContextMenuContext();
    const composedRef = useComposedRefs(ref, context.contentRef);

    useOutsideClick(context.contentRef, () => {
        context.onOpenChange(false);
    }, context.open);

    useEscapeKeydown((_) => {
        if (!context.open) return;
        context.onOpenChange(false);
    });

    if (!context.open) return null;

    return (
      <Portal>
        <div
          ref={composedRef}
          role="menu"
          style={{
            position: 'fixed',
            left: context.point.x,
            top: context.point.y,
            zIndex: 50,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '5px 0',
            minWidth: '150px',
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

ContextMenuContent.displayName = 'ContextMenuContent';

/* -------------------------------------------------------------------------------------------------
 * ContextMenuItem
 * -----------------------------------------------------------------------------------------------*/

// Reuse logic from DropdownMenuItem if possible, or duplicate for now
export interface ContextMenuItemProps extends React.HTMLAttributes<HTMLDivElement> {
    disabled?: boolean;
}

export const ContextMenuItem = React.forwardRef<HTMLDivElement, ContextMenuItemProps>(
    (props, ref) => {
        const { children, disabled, onClick, ...domProps } = props;
        const context = useContextMenuContext();

        const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
            onClick?.(e);
            if (disabled) return;
            if (!e.defaultPrevented) {
                context.onOpenChange(false);
            }
        };

        return (
            <div
                ref={ref}
                role="menuitem"
                aria-disabled={disabled}
                onClick={handleClick}
                style={{
                    padding: '5px 10px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.5 : 1,
                    ...props.style
                }}
                {...domProps}
            >
                {children}
            </div>
        );
    }
);

ContextMenuItem.displayName = 'ContextMenuItem';
