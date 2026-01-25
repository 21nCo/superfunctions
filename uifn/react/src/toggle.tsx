import React from 'react';
import { useControllableState } from './hooks/use-controllable-state';

/* -------------------------------------------------------------------------------------------------
 * Toggle
 * -----------------------------------------------------------------------------------------------*/

export interface ToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  pressed?: boolean;
  defaultPressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
}

export const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(
  (props, ref) => {
    const {
      pressed: pressedProp,
      defaultPressed,
      onPressedChange,
      disabled = false,
      onClick,
      ...domProps
    } = props;

    const [pressed, setPressed] = useControllableState({
      prop: pressedProp,
      defaultProp: defaultPressed ?? false,
      onChange: onPressedChange,
    });

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (disabled) return;
      if (!e.defaultPrevented) {
        setPressed(!pressed);
      }
    };

    return (
      <button
        type="button"
        aria-pressed={pressed}
        data-state={pressed ? 'on' : 'off'}
        data-disabled={disabled ? '' : undefined}
        disabled={disabled}
        ref={ref}
        onClick={handleClick}
        {...domProps}
      />
    );
  }
);

Toggle.displayName = 'Toggle';
