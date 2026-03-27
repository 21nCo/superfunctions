import React, { createContext, useContext, useRef } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useRovingFocus } from './hooks/use-roving-focus';
import { ToggleGroupType } from '@uifn/core/primitives/toggle-group';
import { assertReactContext } from './utils/assert-context';

/* -------------------------------------------------------------------------------------------------
 * ToggleGroup
 * -----------------------------------------------------------------------------------------------*/

export interface ToggleGroupSingleProps {
  type: 'single';
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export interface ToggleGroupMultipleProps {
  type: 'multiple';
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
}

export type ToggleGroupProps = (ToggleGroupSingleProps | ToggleGroupMultipleProps) & {
  disabled?: boolean;
  rovingFocus?: boolean;
  orientation?: 'horizontal' | 'vertical';
  children?: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'>;

interface ToggleGroupContextValue {
  type: ToggleGroupType;
  value: string | string[];
  disabled: boolean;
  onItemActivate: (value: string) => void;
  rovingFocus: boolean;
  orientation: 'horizontal' | 'vertical';
}

const ToggleGroupContext = createContext<ToggleGroupContextValue | undefined>(undefined);

export const ToggleGroup = React.forwardRef<HTMLDivElement, ToggleGroupProps>(
  (props, ref) => {
    const {
      type,
      defaultValue,
      value: valueProp,
      onValueChange,
      disabled = false,
      rovingFocus = true,
      orientation = 'horizontal',
      children,
      ...domProps
    } = props as any;

    const [value, setValue] = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue !== undefined ? defaultValue : (type === 'multiple' ? [] : ''),
      onChange: onValueChange,
    });

    const refInternal = useRef<HTMLDivElement | null>(null);
    const composedRef = (node: HTMLDivElement) => {
      refInternal.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as any).current = node;
    };

    const { handleKeyDown } = useRovingFocus({
      getItems: () => {
        if (!refInternal.current) return [];
        return Array.from(refInternal.current.querySelectorAll('[data-uifn-toggle-group-item]'));
      },
      orientation,
    });

    const onItemActivate = React.useCallback(
      (itemValue: string) => {
        if (type === 'single') {
          setValue(itemValue === value ? '' : itemValue);
        } else {
          const current = (value as string[]) || [];
          if (current.includes(itemValue)) {
            setValue(current.filter((v) => v !== itemValue));
          } else {
            setValue([...current, itemValue]);
          }
        }
      },
      [type, value, setValue]
    );

    return (
      <ToggleGroupContext.Provider
        value={{
          type,
          value: value || (type === 'multiple' ? [] : ''),
          disabled,
          onItemActivate,
          rovingFocus,
          orientation,
        }}
      >
        <div
          role="group"
          data-orientation={orientation}
          ref={composedRef}
          onKeyDown={rovingFocus ? handleKeyDown : undefined}
          {...domProps}
        >
          {children}
        </div>
      </ToggleGroupContext.Provider>
    );
  }
);

ToggleGroup.displayName = 'ToggleGroup';

/* -------------------------------------------------------------------------------------------------
 * ToggleGroupItem
 * -----------------------------------------------------------------------------------------------*/

export interface ToggleGroupItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export const ToggleGroupItem = React.forwardRef<HTMLButtonElement, ToggleGroupItemProps>(
  (props, ref) => {
    const { value, disabled, children, onClick, ...domProps } = props;
    const context = assertReactContext(
      useContext(ToggleGroupContext),
      'ToggleGroupItem',
      'ToggleGroupItem must be used within ToggleGroup'
    );

    const pressed =
      context.type === 'single'
        ? context.value === value
        : (context.value as string[]).includes(value);

    const isDisabled = context.disabled || disabled;

    return (
      <button
        type="button"
        role={context.type === 'single' ? 'radio' : 'button'}
        aria-checked={context.type === 'single' ? pressed : undefined}
        aria-pressed={context.type === 'multiple' ? pressed : undefined}
        data-state={pressed ? 'on' : 'off'}
        data-disabled={isDisabled ? '' : undefined}
        data-uifn-toggle-group-item=""
        disabled={isDisabled}
        tabIndex={context.rovingFocus ? (pressed ? 0 : -1) : 0} // Simplistic roving tabIndex; ideally managed by focus hook state or "first checked" logic
        ref={ref}
        onClick={(e) => {
          if (!isDisabled) context.onItemActivate(value);
          onClick?.(e);
        }}
        {...domProps}
      >
        {children}
      </button>
    );
  }
);

ToggleGroupItem.displayName = 'ToggleGroupItem';
