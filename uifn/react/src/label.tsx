import React from 'react';

/* -------------------------------------------------------------------------------------------------
 * Label
 * -----------------------------------------------------------------------------------------------*/

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {}

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  (props, ref) => {
    return (
      <label
        ref={ref}
        onMouseDown={(event) => {
          // prevent text selection when double clicking label
          if (!event.defaultPrevented && event.detail > 1) event.preventDefault();
          props.onMouseDown?.(event);
        }}
        {...props}
      />
    );
  }
);

Label.displayName = 'Label';
