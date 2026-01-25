import React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
    variant?: 'default' | 'secondary' | 'outline' | 'destructive';
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  (props, ref) => {
    const { variant = 'default', ...domProps } = props;
    return (
      <span
        ref={ref}
        role="status" // Or 'presentation' if just visual
        data-variant={variant}
        style={{
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: '9999px',
            padding: '2px 8px',
            fontSize: '12px',
            fontWeight: 600,
            // Styles usually come from CSS, but primitives provide hooks
            ...props.style
        }}
        {...domProps}
      />
    );
  }
);

Badge.displayName = 'Badge';
