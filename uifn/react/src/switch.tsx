import React, { createContext, useContext } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { assertReactContext } from './utils/assert-context';

/* -------------------------------------------------------------------------------------------------
 * Switch Root
 * -----------------------------------------------------------------------------------------------*/

interface SwitchContextValue {
  checked: boolean;
  disabled: boolean;
}

const SwitchContext = createContext<SwitchContextValue | undefined>(undefined);

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'defaultChecked'> {
  checked?: boolean;
  defaultChecked?: boolean;
  required?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (props, ref) => {
    const {
      checked: checkedProp,
      defaultChecked,
      required,
      disabled = false,
      onCheckedChange,
      onClick,
      value = 'on',
      children,
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
        setChecked(!checked);
      }
    };

    return (
      <SwitchContext.Provider value={{ checked: !!checked, disabled }}>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-required={required}
          aria-disabled={disabled}
          data-state={checked ? 'checked' : 'unchecked'}
          data-disabled={disabled ? '' : undefined}
          disabled={disabled}
          ref={ref}
          onClick={handleClick}
          value={value}
          {...domProps}
        >
          {children}
        </button>
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
      </SwitchContext.Provider>
    );
  }
);

Switch.displayName = 'Switch';

/* -------------------------------------------------------------------------------------------------
 * SwitchThumb
 * -----------------------------------------------------------------------------------------------*/

export interface SwitchThumbProps extends React.HTMLAttributes<HTMLSpanElement> {}

export const SwitchThumb = React.forwardRef<HTMLSpanElement, SwitchThumbProps>(
  (props, ref) => {
    const context = assertReactContext(
      useContext(SwitchContext),
      'SwitchThumb',
      'SwitchThumb must be used within Switch'
    );

    return (
      <span
        data-state={context.checked ? 'checked' : 'unchecked'}
        data-disabled={context.disabled ? '' : undefined}
        ref={ref}
        {...props}
      />
    );
  }
);

SwitchThumb.displayName = 'SwitchThumb';
