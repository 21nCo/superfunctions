import React, { createContext, useContext } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { CheckedState } from '@uifn/core/primitives/checkbox';
import { assertReactContext } from './utils/assert-context';

/* -------------------------------------------------------------------------------------------------
 * Checkbox Root
 * -----------------------------------------------------------------------------------------------*/

interface CheckboxContextValue {
  checked: CheckedState;
  disabled: boolean;
}

const CheckboxContext = createContext<CheckboxContextValue | undefined>(undefined);

export interface CheckboxProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'defaultChecked'> {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  required?: boolean;
  onCheckedChange?: (checked: CheckedState) => void;
}

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  (props, ref) => {
    const {
      checked: checkedProp,
      defaultChecked,
      required,
      disabled = false,
      onCheckedChange,
      onClick,
      onKeyDown,
      children,
      value = 'on',
      ...domProps
    } = props;

    const [checked, setChecked] = useControllableState({
      prop: checkedProp,
      defaultProp: defaultChecked ?? false,
      onChange: onCheckedChange,
    });

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (disabled) return;
      if (!e.defaultPrevented) {
        setChecked(checked === 'indeterminate' ? true : !checked);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(e);
      if (e.key === 'Enter') {
          e.preventDefault(); // Prevent submitting form if inside one? Or default behavior?
          // Native checkbox toggles on space, not enter. But often button toggles on both.
          // Let's stick to Space (native button behavior handles click)
      }
    };

    return (
      <CheckboxContext.Provider value={{ checked: checked!, disabled }}>
        <button
          type="button"
          role="checkbox"
          aria-checked={checked === 'indeterminate' ? 'mixed' : checked}
          aria-required={required}
          aria-disabled={disabled}
          data-state={checked === 'indeterminate' ? 'indeterminate' : (checked ? 'checked' : 'unchecked')}
          data-disabled={disabled ? '' : undefined}
          disabled={disabled}
          ref={ref}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          value={value}
          {...domProps}
        >
          {children}
        </button>
        {/* Hidden input for form submission */}
        {checked && !disabled && (
           <input
             type="checkbox"
             aria-hidden
             defaultChecked
             disabled={disabled}
             name={props.name}
             value={value}
             style={{ transform: 'translateX(-100%)', position: 'absolute', pointerEvents: 'none', opacity: 0, margin: 0 }}
             tabIndex={-1}
           />
        )}
      </CheckboxContext.Provider>
    );
  }
);

Checkbox.displayName = 'Checkbox';

/* -------------------------------------------------------------------------------------------------
 * CheckboxIndicator
 * -----------------------------------------------------------------------------------------------*/

export interface CheckboxIndicatorProps extends React.HTMLAttributes<HTMLSpanElement> {
  forceMount?: boolean;
}

export const CheckboxIndicator = React.forwardRef<HTMLSpanElement, CheckboxIndicatorProps>(
  (props, ref) => {
    const { children, forceMount, ...domProps } = props;
    const context = assertReactContext(
      useContext(CheckboxContext),
      'CheckboxIndicator',
      'CheckboxIndicator must be used within Checkbox'
    );

    if (!forceMount && !context.checked) return null;

    return (
      <span
        data-state={context.checked === 'indeterminate' ? 'indeterminate' : (context.checked ? 'checked' : 'unchecked')}
        data-disabled={context.disabled ? '' : undefined}
        ref={ref}
        {...domProps}
        style={{ pointerEvents: 'none', ...domProps.style }}
      >
        {children}
      </span>
    );
  }
);

CheckboxIndicator.displayName = 'CheckboxIndicator';
