import React, { forwardRef } from 'react';

export type CanvasProps = React.CanvasHTMLAttributes<HTMLCanvasElement> & {
  width?: number;
  height?: number;
};

export const Canvas = forwardRef<HTMLCanvasElement, CanvasProps>(
  ({ width = 800, height = 600, style, ...props }, ref) => {
    return (
      <canvas
        ref={ref}
        width={width}
        height={height}
        style={{
          display: 'block',
          touchAction: 'none',
          ...style,
        }}
        {...props}
      />
    );
  }
);

Canvas.displayName = 'Canvas';
