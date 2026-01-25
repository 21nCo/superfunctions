import React, { createContext, useContext, useRef } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useComposedRefs } from './hooks/use-composed-refs';
import { usePosition, Side, Align } from './hooks/use-position';
import { useOutsideClick } from './hooks/use-outside-click';
import { useEscapeKeydown } from './hooks/use-escape-keydown';
import { Portal } from './portal';

/* -------------------------------------------------------------------------------------------------
 * Select Root
 * -----------------------------------------------------------------------------------------------*/

interface SelectContextValue {
  value: string;
  onValueChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement>;
  contentRef: React.RefObject<HTMLElement>;
  disabled: boolean;
  required: boolean;
  name?: string;
}

const SelectContext = createContext<SelectContextValue | undefined>(undefined);

const useSelectContext = () => {
  const context = useContext(SelectContext);
  if (!context) {
    throw new Error('Select components must be used within a Select');
  }
  return context;
};

export interface SelectProps {
  children?: React.ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
}

export const Select: React.FC<SelectProps> = (props) => {
  const {
    children,
    value: valueProp,
    defaultValue,
    onValueChange,
    open: openProp,
    defaultOpen,
    onOpenChange,
    disabled = false,
    required = false,
    name,
  } = props;

  const [value, setValue] = useControllableState({
    prop: valueProp,
    defaultProp: defaultValue ?? '',
    onChange: onValueChange,
  });

  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
  });

  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);

  return (
    <SelectContext.Provider
      value={{
        value: value!,
        onValueChange: setValue,
        open: !!open,
        onOpenChange: setOpen,
        triggerRef,
        contentRef,
        disabled,
        required,
        name,
      }}
    >
      {children}
    </SelectContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * SelectTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface SelectTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const SelectTrigger = React.forwardRef<HTMLButtonElement, SelectTriggerProps>(
  (props, ref) => {
    const { children, onClick, onKeyDown, ...domProps } = props;
    const context = useSelectContext();
    const composedRef = useComposedRefs(ref, context.triggerRef);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (context.disabled) return;
      if (!e.defaultPrevented) {
        context.onOpenChange(!context.open);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(e);
        if (context.disabled) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (!context.open) context.onOpenChange(true);
        }
    };

    return (
      <button
        ref={composedRef}
        type="button"
        role="combobox"
        aria-controls={context.open ? 'select-content' : undefined}
        aria-expanded={context.open}
        aria-required={context.required}
        aria-disabled={context.disabled}
        data-state={context.open ? 'open' : 'closed'}
        data-disabled={context.disabled ? '' : undefined}
        disabled={context.disabled}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        {...domProps}
      >
        {children}
      </button>
    );
  }
);

SelectTrigger.displayName = 'SelectTrigger';

/* -------------------------------------------------------------------------------------------------
 * SelectValue
 * -----------------------------------------------------------------------------------------------*/

export interface SelectValueProps extends React.HTMLAttributes<HTMLSpanElement> {
  placeholder?: React.ReactNode;
}

export const SelectValue = React.forwardRef<HTMLSpanElement, SelectValueProps>(
  (props, ref) => {
    const { children, placeholder, ...domProps } = props;
    const context = useSelectContext();

    // If we have children, we just render them.
    // But typically SelectValue renders the textual representation of selected item.
    // This simple implementation requires user to pass text or we can try to find selected item label if we had a registry.
    // For now, let's behave like Radix: if children are present, render them. If not, and we have a value, render value (or placeholder).
    // Note: Radix SelectValue is smarter, it mirrors the text content of the selected item. 
    // Implementing that requires Context to store item labels map.
    
    // Simplification: Display value directly if children not provided.
    const content = children || (context.value ? context.value : placeholder);

    return (
      <span ref={ref} style={{ pointerEvents: 'none' }} {...domProps}>
        {content}
      </span>
    );
  }
);

SelectValue.displayName = 'SelectValue';

/* -------------------------------------------------------------------------------------------------
 * SelectContent
 * -----------------------------------------------------------------------------------------------*/

export interface SelectContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  forceMount?: boolean;
}

export const SelectContent = React.forwardRef<HTMLDivElement, SelectContentProps>(
  (props, ref) => {
    const {
      children,
      side = 'bottom',
      align = 'start', // Select usually aligns start
      sideOffset = 5,
      alignOffset = 0,
      forceMount,
      style,
      onKeyDown,
      ...domProps
    } = props;

    const context = useSelectContext();
    const { style: positionStyle } = usePosition(context.triggerRef, context.contentRef, {
      side,
      align,
      sideOffset,
      alignOffset,
    });

    useOutsideClick(context.contentRef, (_: MouseEvent | TouchEvent) => {
        if (context.triggerRef.current?.contains(_.target as Node)) return;
        context.onOpenChange(false);
    }, context.open);

    useEscapeKeydown((_) => {
        if (!context.open) return;
        context.onOpenChange(false);
        context.triggerRef.current?.focus();
    });
    
    // Auto focus first item or selected item on open
    const focusRef = React.useCallback((node: HTMLDivElement) => {
        if (node && context.open) {
             requestAnimationFrame(() => {
                 // Try to find selected item first
                 const selected = node.querySelector('[data-state="checked"]') as HTMLElement;
                 if (selected) {
                     selected.focus();
                 } else {
                     const items = node.querySelectorAll('[role="option"]:not([aria-disabled="true"])');
                     if (items.length > 0) {
                         (items[0] as HTMLElement).focus();
                     } else {
                         node.focus();
                     }
                 }
             });
        }
    }, [context.open, context.value]); // Re-run if value changes? mostly open.

    const composedRef = useComposedRefs(ref, context.contentRef, focusRef);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;

        const content = context.contentRef.current;
        if (!content) return;

        const items = Array.from(content.querySelectorAll('[role="option"]:not([aria-disabled="true"])')) as HTMLElement[];
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
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            // Trigger click on active element
            (document.activeElement as HTMLElement)?.click();
        }
    };

    if (!context.open && !forceMount) return null;

    return (
      <Portal>
        <div
          ref={composedRef}
          role="listbox"
          id="select-content"
          data-state={context.open ? 'open' : 'closed'}
          style={{
            ...positionStyle,
            zIndex: 50,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '5px 0',
            minWidth: 'var(--radix-select-trigger-width)', // User can set this var
            width: context.triggerRef.current?.offsetWidth, // Default match trigger width
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

SelectContent.displayName = 'SelectContent';

/* -------------------------------------------------------------------------------------------------
 * SelectItem
 * -----------------------------------------------------------------------------------------------*/

export interface SelectItemProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  disabled?: boolean;
}

export const SelectItem = React.forwardRef<HTMLDivElement, SelectItemProps>(
  (props, ref) => {
    const { children, value, disabled, onClick, onKeyDown, style, ...domProps } = props;
    const context = useSelectContext();
    const isSelected = context.value === value;

    const handleSelect = (e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled) return;
        onClick?.(e);
        if (!e.defaultPrevented) {
            context.onValueChange(value);
            context.onOpenChange(false);
            context.triggerRef.current?.focus();
        }
    };

    return (
      <div
        ref={ref}
        role="option"
        aria-selected={isSelected}
        aria-disabled={disabled}
        data-state={isSelected ? 'checked' : 'unchecked'}
        data-disabled={disabled ? '' : undefined}
        tabIndex={disabled ? -1 : 0} // Roving focus is handled manually above, but making items focusable is easiest
        onClick={handleSelect}
        style={{
            padding: '5px 10px',
            cursor: disabled ? 'not-allowed' : 'pointer',
            backgroundColor: isSelected ? '#eee' : 'transparent',
            outline: 'none',
            opacity: disabled ? 0.5 : 1,
            ...style
        }}
        {...domProps}
      >
        {children}
        {isSelected && <span style={{ marginLeft: 'auto' }}>✓</span>}
      </div>
    );
  }
);

SelectItem.displayName = 'SelectItem';
