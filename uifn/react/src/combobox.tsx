import React, { createContext, useContext, useRef } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useComposedRefs } from './hooks/use-composed-refs';
import { usePosition, Side, Align } from './hooks/use-position';
import { useOutsideClick } from './hooks/use-outside-click';
import { Portal } from './portal';
import { useId } from './hooks/use-id';
import { assertReactContext } from './utils/assert-context';

/* -------------------------------------------------------------------------------------------------
 * Combobox Root
 * -----------------------------------------------------------------------------------------------*/

interface ComboboxContextValue {
  value: string;
  onValueChange: (value: string) => void;
  inputValue: string;
  onInputValueChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentId: string;
  triggerRef: React.RefObject<HTMLElement>;
  contentRef: React.RefObject<HTMLElement>;
  inputRef: React.RefObject<HTMLInputElement>;
  disabled: boolean;
}

const ComboboxContext = createContext<ComboboxContextValue | undefined>(undefined);

const useComboboxContext = () => {
  return assertReactContext(
    useContext(ComboboxContext),
    'Combobox',
    'Combobox components must be used within a Combobox'
  );
};

export interface ComboboxProps {
  children?: React.ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  inputValue?: string;
  defaultInputValue?: string;
  onInputValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

export const Combobox: React.FC<ComboboxProps> = (props) => {
  const {
    children,
    value: valueProp,
    defaultValue,
    onValueChange,
    inputValue: inputValueProp,
    defaultInputValue,
    onInputValueChange,
    open: openProp,
    defaultOpen,
    onOpenChange,
    disabled = false,
  } = props;

  const [value, setValue] = useControllableState({
    prop: valueProp,
    defaultProp: defaultValue ?? '',
    onChange: onValueChange,
  });

  const [inputValue, setInputValue] = useControllableState({
    prop: inputValueProp,
    defaultProp: defaultInputValue ?? '',
    onChange: onInputValueChange,
  });

  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
  });
  const contentId = useId(undefined, { prefix: 'combobox', slot: 'content' });

  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // When value changes, update inputValue to match selection?
  // Typically yes, but sometimes we want custom display.
  // For simplicity, we won't auto-sync value -> inputValue here, leaving it to user or simpler behavior.
  // Actually standard combobox: typing changes input value. Selecting sets value AND input value.

  const handleValueChange = (newValue: string) => {
      setValue(newValue);
      setInputValue(newValue); // Auto-update input text
  };

  return (
    <ComboboxContext.Provider
      value={{
        value: value!,
        onValueChange: handleValueChange,
        inputValue: inputValue!,
        onInputValueChange: setInputValue,
        open: !!open,
        onOpenChange: setOpen,
        contentId,
        triggerRef,
        contentRef,
        inputRef,
        disabled,
      }}
    >
      {children}
    </ComboboxContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * ComboboxInput
 * -----------------------------------------------------------------------------------------------*/

export interface ComboboxInputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const ComboboxInput = React.forwardRef<HTMLInputElement, ComboboxInputProps>(
  (props, ref) => {
    const { onChange, onKeyDown, onClick, onFocus, onBlur, ...domProps } = props;
    const context = useComboboxContext();
    const composedRef = useComposedRefs(ref, context.inputRef, context.triggerRef as any); // Input acts as trigger anchor

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        onChange?.(e);
        if (context.disabled) return;
        context.onInputValueChange(e.target.value);
        if (!context.open) context.onOpenChange(true);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(e);
        if (context.disabled) return;
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!context.open) context.onOpenChange(true);
            // Focus moves to list? Usually yes or we manage active descendant.
            // For this simple impl, we can open and then focus first item.
            requestAnimationFrame(() => {
                const firstItem = context.contentRef.current?.querySelector('[role="option"]') as HTMLElement;
                firstItem?.focus();
            });
        } else if (e.key === 'Escape') {
            if (context.open) {
                e.preventDefault();
                context.onOpenChange(false);
            }
        } else if (e.key === 'Enter') {
            // If open and active descendant?
            // If we are just typing and hit enter, usually nothing happens unless we have highlighted item.
        }
    };

    return (
      <input
        ref={composedRef}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={context.open}
        aria-controls={context.open ? context.contentId : undefined}
        disabled={context.disabled}
        value={context.inputValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onClick={(e) => {
            onClick?.(e);
            if (!context.open) context.onOpenChange(true);
        }}
        {...domProps}
      />
    );
  }
);

ComboboxInput.displayName = 'ComboboxInput';

/* -------------------------------------------------------------------------------------------------
 * ComboboxContent
 * -----------------------------------------------------------------------------------------------*/

export interface ComboboxContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
}

export const ComboboxContent = React.forwardRef<HTMLDivElement, ComboboxContentProps>(
  (props, ref) => {
    const {
        children,
        side = 'bottom',
        align = 'start',
        sideOffset = 5,
        alignOffset = 0,
        style,
        ...domProps
    } = props;

    const context = useComboboxContext();
    const composedRef = useComposedRefs(ref, context.contentRef);
    
    const { style: positionStyle } = usePosition(context.triggerRef, context.contentRef, {
        side, align, sideOffset, alignOffset
    });

    useOutsideClick(context.contentRef, (e) => {
        // Ignore if clicking input
        if (context.inputRef.current?.contains(e.target as Node)) return;
        context.onOpenChange(false);
    }, context.open);

    if (!context.open) return null;

    return (
      <Portal>
        <div
            ref={composedRef}
            role="listbox"
            id={context.contentId}
            style={{
                ...positionStyle,
                zIndex: 50,
                backgroundColor: 'white',
                border: '1px solid #ccc',
                width: context.triggerRef.current?.offsetWidth,
                maxHeight: '300px',
                overflowY: 'auto',
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

ComboboxContent.displayName = 'ComboboxContent';

/* -------------------------------------------------------------------------------------------------
 * ComboboxItem
 * -----------------------------------------------------------------------------------------------*/

export interface ComboboxItemProps extends React.HTMLAttributes<HTMLDivElement> {
    value: string;
}

export const ComboboxItem = React.forwardRef<HTMLDivElement, ComboboxItemProps>(
    (props, ref) => {
        const { value, children, onClick, ...domProps } = props;
        const context = useComboboxContext();
        const isSelected = context.value === value;
        const textValue = React.useMemo(() => {
            const flattened = React.Children.toArray(children)
                .filter((child): child is string | number => typeof child === 'string' || typeof child === 'number')
                .join('');
            return flattened || value;
        }, [children, value]);
        const normalizedInput = context.inputValue.trim().toLowerCase();
        const isVisible =
            normalizedInput.length === 0 ||
            textValue.toLowerCase().includes(normalizedInput) ||
            value.toLowerCase().includes(normalizedInput);

        const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
            onClick?.(e);
            context.onValueChange(value);
            context.onOpenChange(false);
            context.inputRef.current?.focus();
        };

        const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleClick(e as any);
            }
        };

        if (!isVisible) {
            return null;
        }

        return (
            <div
                ref={ref}
                role="option"
                aria-selected={isSelected}
                tabIndex={-1} // Focusable via arrow keys management
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                style={{
                    padding: '5px 10px',
                    cursor: 'pointer',
                    backgroundColor: isSelected ? '#eee' : 'transparent',
                    ...props.style
                }}
                {...domProps}
            >
                {children}
            </div>
        );
    }
);

ComboboxItem.displayName = 'ComboboxItem';
