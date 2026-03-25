import React, { createContext, useContext } from 'react';
import { assertReactContext } from './utils/assert-context';

/* -------------------------------------------------------------------------------------------------
 * Progress Root
 * -----------------------------------------------------------------------------------------------*/

interface ProgressContextValue {
  value: number | null;
  max: number;
}

const ProgressContext = createContext<ProgressContextValue | undefined>(undefined);

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number | null;
  max?: number;
  getValueLabel?: (value: number, max: number) => string;
}

export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  (props, ref) => {
    const {
      value: valueProp,
      max = 100,
      getValueLabel = (v, m) => `${Math.round((v / m) * 100)}%`,
      children,
      ...domProps
    } = props;

    // Progress is usually controlled, read-only
    const value = valueProp !== undefined ? valueProp : null;

    // Calculate percentage
    // If indeterminate (null), we don't calculate percent for ARIA, but maybe for animation styles
    
    return (
      <ProgressContext.Provider value={{ value, max }}>
        <div
          ref={ref}
          role="progressbar"
          aria-valuemax={max}
          aria-valuemin={0}
          aria-valuenow={value !== null ? value : undefined}
          aria-valuetext={value !== null ? getValueLabel(value, max) : undefined}
          data-state={value === null ? 'indeterminate' : (value === max ? 'complete' : 'loading')}
          data-value={value}
          data-max={max}
          {...domProps}
        >
          {children}
        </div>
      </ProgressContext.Provider>
    );
  }
);

Progress.displayName = 'Progress';

/* -------------------------------------------------------------------------------------------------
 * ProgressIndicator
 * -----------------------------------------------------------------------------------------------*/

export interface ProgressIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ProgressIndicator = React.forwardRef<HTMLDivElement, ProgressIndicatorProps>(
  (props, ref) => {
    const context = assertReactContext(
      useContext(ProgressContext),
      'ProgressIndicator',
      'ProgressIndicator must be used within Progress'
    );

    const percent = context.value !== null ? (context.value / context.max) * 100 : undefined;

    return (
      <div
        ref={ref}
        data-state={context.value === null ? 'indeterminate' : (context.value === context.max ? 'complete' : 'loading')}
        data-value={context.value}
        data-max={context.max}
        style={{
            width: '100%',
            height: '100%',
            transform: percent !== undefined ? `translateX(-${100 - percent}%)` : undefined, // Common technique: negative translate from full width
            // Or just width: percent%
            // transform is better for GPU
            ...props.style
        }}
        {...props}
      />
    );
  }
);

ProgressIndicator.displayName = 'ProgressIndicator';
