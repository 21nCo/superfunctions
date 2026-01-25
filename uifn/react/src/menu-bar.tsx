import React, { createContext, useContext, useRef } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useRovingFocus } from './hooks/use-roving-focus';
import { useComposedRefs } from './hooks/use-composed-refs';
import { useId } from './hooks/use-id';
import { useOutsideClick } from './hooks/use-outside-click';
import { usePosition, Side, Align } from './hooks/use-position';
import { Portal } from './portal';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel } from './dropdown-menu';

/* -------------------------------------------------------------------------------------------------
 * MenuBar Root
 * -----------------------------------------------------------------------------------------------*/

interface MenuBarContextValue {
  value: string;
  onValueChange: (value: string) => void;
  autoSelect: boolean; // if true, moving focus to trigger opens it
  rootRef: React.RefObject<HTMLDivElement>;
}

const MenuBarContext = createContext<MenuBarContextValue | undefined>(undefined);

const useMenuBarContext = () => {
  const context = useContext(MenuBarContext);
  if (!context) {
    throw new Error('MenuBar components must be used within a MenuBar');
  }
  return context;
};

export interface MenuBarProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  loop?: boolean;
}

export const MenuBar = React.forwardRef<HTMLDivElement, MenuBarProps>(
  (props, ref) => {
    const {
      value: valueProp,
      defaultValue,
      onValueChange,
      loop = true,
      children,
      ...domProps
    } = props;

    const [value, setValue] = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue ?? '',
      onChange: onValueChange,
    });

    const rootRef = useRef<HTMLDivElement>(null);
    const composedRef = useComposedRefs(ref, rootRef);

    const { handleKeyDown } = useRovingFocus({
      getItems: () => {
        if (!rootRef.current) return [];
        return Array.from(rootRef.current.querySelectorAll('[role="menuitem"]'));
      },
      orientation: 'horizontal',
      loop,
    });

    return (
      <MenuBarContext.Provider
        value={{
          value: value!,
          onValueChange: setValue,
          autoSelect: !!value, // if a menu is open, hovering/focusing others might open them
          rootRef,
        }}
      >
        <div
          ref={composedRef}
          role="menubar"
          tabIndex={0} // The bar itself might take focus or delegate? Actually usually triggers take focus.
          // Roving focus will manage tabIndex on triggers.
          onKeyDown={handleKeyDown}
          {...domProps}
        >
          {children}
        </div>
      </MenuBarContext.Provider>
    );
  }
);

MenuBar.displayName = 'MenuBar';

/* -------------------------------------------------------------------------------------------------
 * MenuBarMenu
 * -----------------------------------------------------------------------------------------------*/

interface MenuBarMenuContextValue {
  value: string;
  triggerId: string;
  contentId: string;
  open: boolean;
  triggerRef: React.RefObject<HTMLButtonElement>;
  contentRef: React.RefObject<HTMLDivElement>;
}

const MenuBarMenuContext = createContext<MenuBarMenuContextValue | undefined>(undefined);

export interface MenuBarMenuProps {
  value?: string;
  children?: React.ReactNode;
}

export const MenuBarMenu: React.FC<MenuBarMenuProps> = ({ value: valueProp, children }) => {
  const context = useMenuBarContext();
  // If no value provided, generate one? Or require it? 
  // For simplicity, let's generate if missing, but usually MenuBar requires keyed items or index.
  const generatedId = useId();
  const value = valueProp || generatedId || 'menu';
  const open = context.value === value;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerId = useId();
  const contentId = useId();

  return (
    <MenuBarMenuContext.Provider
      value={{
        value,
        open,
        triggerRef,
        contentRef,
        triggerId: triggerId || `menubar-trigger-${value}`,
        contentId: contentId || `menubar-content-${value}`,
      }}
    >
      {children}
    </MenuBarMenuContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * MenuBarTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface MenuBarTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const MenuBarTrigger = React.forwardRef<HTMLButtonElement, MenuBarTriggerProps>(
  (props, ref) => {
    const { onClick, onFocus, onKeyDown, onMouseEnter, ...domProps } = props;
    const context = useMenuBarContext();
    const menuContext = useContext(MenuBarMenuContext);

    if (!menuContext) throw new Error('MenuBarTrigger must be used within MenuBarMenu');

    const composedRef = useComposedRefs(ref, menuContext.triggerRef);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        if (menuContext.open) {
          context.onValueChange('');
        } else {
          context.onValueChange(menuContext.value);
        }
      }
    };

    const handleFocus = (e: React.FocusEvent<HTMLButtonElement>) => {
        onFocus?.(e);
        if (context.autoSelect && !menuContext.open) {
            // If another menu is open (autoSelect=true implies context.value is set), switch to this one.
            context.onValueChange(menuContext.value);
        }
    };

    const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
        onMouseEnter?.(e);
        if (context.autoSelect && !menuContext.open) {
             context.onValueChange(menuContext.value);
             // Also focus it?
             e.currentTarget.focus();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(e);
        if (e.key === 'ArrowDown') {
            if (!menuContext.open) context.onValueChange(menuContext.value);
            e.preventDefault();
        }
    };

    return (
      <button
        ref={composedRef}
        type="button"
        role="menuitem" // Top level items in menubar are menuitems that open submenus
        aria-haspopup="menu"
        aria-expanded={menuContext.open}
        aria-controls={menuContext.open ? menuContext.contentId : undefined}
        id={menuContext.triggerId}
        data-state={menuContext.open ? 'open' : 'closed'}
        tabIndex={menuContext.open ? 0 : -1} // Roving focus manages this usually, but initial state?
        // Actually Roving Focus sets tabindex.
        onClick={handleClick}
        onFocus={handleFocus}
        onMouseEnter={handleMouseEnter}
        onKeyDown={handleKeyDown}
        {...domProps}
      >
        {props.children}
      </button>
    );
  }
);

MenuBarTrigger.displayName = 'MenuBarTrigger';

/* -------------------------------------------------------------------------------------------------
 * MenuBarContent
 * -----------------------------------------------------------------------------------------------*/

export interface MenuBarContentProps extends React.HTMLAttributes<HTMLDivElement> {
    side?: Side;
    align?: Align;
    sideOffset?: number;
    alignOffset?: number;
}

export const MenuBarContent = React.forwardRef<HTMLDivElement, MenuBarContentProps>(
    (props, ref) => {
        const {
            side = 'bottom',
            align = 'start',
            sideOffset = 5,
            alignOffset = 0,
            style,
            onKeyDown,
            ...domProps
        } = props;

        const context = useMenuBarContext();
        const menuContext = useContext(MenuBarMenuContext);
        if (!menuContext) throw new Error('MenuBarContent must be used within MenuBarMenu');

        const { style: positionStyle } = usePosition(menuContext.triggerRef, menuContext.contentRef, {
            side, align, sideOffset, alignOffset
        });

        // Click Outside
        useOutsideClick(menuContext.contentRef, (e) => {
             if (menuContext.triggerRef.current?.contains(e.target as Node)) return;
             // Close only this menu? actually close all usually.
             context.onValueChange('');
        }, menuContext.open);

        if (!menuContext.open) return null;

        return (
             <Portal>
                 <div
                     ref={useComposedRefs(ref, menuContext.contentRef)}
                     role="menu"
                     id={menuContext.contentId}
                     aria-labelledby={menuContext.triggerId}
                     data-state="open"
                     style={{
                         ...positionStyle,
                         zIndex: 50,
                         backgroundColor: 'white',
                         border: '1px solid #ccc',
                         minWidth: '150px',
                         ...style
                     }}
                     onKeyDown={(e) => {
                         onKeyDown?.(e);
                         // Handle Arrow Left/Right to switch menus?
                         if (e.key === 'ArrowRight') {
                             // Logic to switch to next menu in bar?
                             // requires access to all triggers or context.
                         }
                     }}
                     {...domProps}
                 >
                     {props.children}
                 </div>
             </Portal>
        );
    }
);

MenuBarContent.displayName = 'MenuBarContent';

// Re-export Items for convenience
export { DropdownMenuItem as MenuBarItem, DropdownMenuSeparator as MenuBarSeparator, DropdownMenuLabel as MenuBarLabel };
