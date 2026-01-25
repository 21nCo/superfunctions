import React, { createContext, useContext } from 'react';
import { useControllableState } from './hooks/use-controllable-state';

/* -------------------------------------------------------------------------------------------------
 * Slider Root
 * -----------------------------------------------------------------------------------------------*/

interface SliderContextValue {
  value: number[];
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  orientation: 'horizontal' | 'vertical';
  onValueChange: (value: number[]) => void;
}

const SliderContext = createContext<SliderContextValue | undefined>(undefined);

export interface SliderProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'onChange' | 'defaultValue'> {
  value?: number[];
  defaultValue?: number[];
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  onValueChange?: (value: number[]) => void;
  name?: string;
}

export const Slider = React.forwardRef<HTMLSpanElement, SliderProps>(
  (props, ref) => {
    const {
      value: valueProp,
      defaultValue,
      min = 0,
      max = 100,
      step = 1,
      disabled = false,
      orientation = 'horizontal',
      onValueChange,
      name,
      children,
      ...domProps
    } = props;

    const [value, setValue] = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue ?? [min],
      onChange: onValueChange,
    });

    const contextValue = {
        value: value!,
        min,
        max,
        step,
        disabled,
        orientation,
        onValueChange: setValue
    };

    return (
      <SliderContext.Provider value={contextValue}>
        <span
          ref={ref}
          // role="slider" removed from root, thumb acts as slider
          data-orientation={orientation}
          data-disabled={disabled ? '' : undefined}
          style={{
              display: 'flex',
              touchAction: 'none',
              userSelect: 'none',
              position: 'relative',
              width: orientation === 'horizontal' ? '100%' : '20px',
              height: orientation === 'vertical' ? '100px' : '20px',
              alignItems: 'center',
              ...domProps.style
          }}
          {...domProps}
        >
          {children}
        </span>
      </SliderContext.Provider>
    );
  }
);

Slider.displayName = 'Slider';

/* -------------------------------------------------------------------------------------------------
 * SliderTrack
 * -----------------------------------------------------------------------------------------------*/

export interface SliderTrackProps extends React.HTMLAttributes<HTMLSpanElement> {}

export const SliderTrack = React.forwardRef<HTMLSpanElement, SliderTrackProps>(
  (props, ref) => {
    const context = useContext(SliderContext);
    if (!context) throw new Error('SliderTrack must be used within Slider');

    return (
      <span
        ref={ref}
        data-disabled={context.disabled ? '' : undefined}
        data-orientation={context.orientation}
        style={{
            position: 'relative',
            flexGrow: 1,
            backgroundColor: '#ddd',
            borderRadius: '9999px',
            height: context.orientation === 'horizontal' ? '3px' : '100%',
            width: context.orientation === 'vertical' ? '3px' : '100%',
            ...props.style
        }}
        {...props}
      >
        {props.children}
      </span>
    );
  }
);

SliderTrack.displayName = 'SliderTrack';

/* -------------------------------------------------------------------------------------------------
 * SliderRange
 * -----------------------------------------------------------------------------------------------*/

export interface SliderRangeProps extends React.HTMLAttributes<HTMLSpanElement> {}

export const SliderRange = React.forwardRef<HTMLSpanElement, SliderRangeProps>(
  (props, ref) => {
    const context = useContext(SliderContext);
    if (!context) throw new Error('SliderRange must be used within SliderTrack');

    // Calculate percentage based on value[0] if single thumb, or range if multiple?
    // Supporting only single thumb for simplicity first or range from 0 to value[0].
    // If multiple values (thumbs), range connects them.
    // Let's assume simplest case: single thumb, range from min to value.
    
    const percent = ((context.value[0] - context.min) / (context.max - context.min)) * 100;

    return (
      <span
        ref={ref}
        data-orientation={context.orientation}
        data-disabled={context.disabled ? '' : undefined}
        style={{
            position: 'absolute',
            backgroundColor: '#000',
            borderRadius: '9999px',
            width: context.orientation === 'horizontal' ? `${percent}%` : '100%',
            height: context.orientation === 'vertical' ? `${percent}%` : '100%',
            // For vertical, bottom 0
            bottom: context.orientation === 'vertical' ? 0 : undefined,
            ...props.style
        }}
        {...props}
      />
    );
  }
);

SliderRange.displayName = 'SliderRange';

/* -------------------------------------------------------------------------------------------------
 * SliderThumb
 * -----------------------------------------------------------------------------------------------*/

export interface SliderThumbProps extends React.HTMLAttributes<HTMLSpanElement> {
    index?: number; // Which value index this thumb controls
}

export const SliderThumb = React.forwardRef<HTMLSpanElement, SliderThumbProps>(
  (props, ref) => {
    const { index = 0, style, ...domProps } = props;
    const context = useContext(SliderContext);
    if (!context) throw new Error('SliderThumb must be used within Slider');

    const value = context.value[index] || context.min;
    const percent = ((value - context.min) / (context.max - context.min)) * 100;
    
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (context.disabled) return;
        let newValue = value;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            newValue = Math.min(value + context.step, context.max);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            newValue = Math.max(value - context.step, context.min);
        } else if (e.key === 'Home') {
            newValue = context.min;
        } else if (e.key === 'End') {
            newValue = context.max;
        } else {
            return;
        }
        
        e.preventDefault();
        const nextValues = [...context.value];
        nextValues[index] = newValue;
        context.onValueChange(nextValues);
    };

    return (
      <span
        ref={ref}
        role="slider"
        aria-valuenow={value}
        aria-valuemin={context.min}
        aria-valuemax={context.max}
        aria-orientation={context.orientation}
        data-disabled={context.disabled ? '' : undefined}
        tabIndex={context.disabled ? -1 : 0}
        onKeyDown={handleKeyDown}
        style={{
            position: 'absolute',
            left: context.orientation === 'horizontal' ? `${percent}%` : '50%',
            top: context.orientation === 'vertical' ? `${100 - percent}%` : '50%', // Top 0 is start for DOM, but usually slider vertical starts from bottom.
            // If vertical, 100% is bottom.
            transform: 'translate(-50%, -50%)',
            width: '20px',
            height: '20px',
            borderRadius: '50%',
            backgroundColor: 'white',
            border: '1px solid #999',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            ...style
        }}
        {...domProps}
      />
    );
  }
);

SliderThumb.displayName = 'SliderThumb';
