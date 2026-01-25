import React from 'react';

/* -------------------------------------------------------------------------------------------------
 * Separator
 * -----------------------------------------------------------------------------------------------*/

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
  decorative?: boolean;
}

export const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  (props, ref) => {
    const { orientation = 'horizontal', decorative = false, ...domProps } = props;
    
    return (
      <div
        ref={ref}
        role={decorative ? undefined : 'separator'}
        aria-orientation={decorative ? undefined : orientation}
        data-orientation={orientation}
        style={{
            backgroundColor: '#eee',
            width: orientation === 'horizontal' ? '100%' : '1px',
            height: orientation === 'horizontal' ? '1px' : '100%',
            ...domProps.style
        }}
        {...domProps}
      />
    );
  }
);

Separator.displayName = 'Separator';
