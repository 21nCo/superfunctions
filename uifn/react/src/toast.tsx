import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useComposedRefs } from './hooks/use-composed-refs';
import { Portal } from './portal';
import { Presence } from './presence';
import { assertReactContext } from './utils/assert-context';

/* -------------------------------------------------------------------------------------------------
 * ToastProvider
 * -----------------------------------------------------------------------------------------------*/

interface ToastProviderContextValue {
  // Global config if needed
}

const ToastProviderContext = createContext<ToastProviderContextValue | undefined>(undefined);

export interface ToastProviderProps {
  children?: React.ReactNode;
  swipeDirection?: 'right' | 'left' | 'up' | 'down';
  duration?: number;
}

export const ToastProvider: React.FC<ToastProviderProps> = (props) => {
  return (
    <ToastProviderContext.Provider value={{}}>
      {props.children}
    </ToastProviderContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * ToastViewport
 * -----------------------------------------------------------------------------------------------*/

export interface ToastViewportProps extends React.HTMLAttributes<HTMLDivElement> {
    // Positioning handled by CSS usually
}

export const ToastViewport = React.forwardRef<HTMLDivElement, ToastViewportProps>(
  (props, ref) => {
    return (
      <Portal>
        <div
          ref={ref}
          role="region"
          aria-label="Notifications (Alt+T)"
          style={{
              position: 'fixed',
              bottom: 0,
              right: 0,
              display: 'flex',
              flexDirection: 'column',
              padding: '25px',
              gap: '10px',
              width: '390px',
              maxWidth: '100vw',
              margin: 0,
              zIndex: 2147483647,
              outline: 'none',
              ...props.style
          }}
          {...props}
        />
      </Portal>
    );
  }
);

ToastViewport.displayName = 'ToastViewport';

/* -------------------------------------------------------------------------------------------------
 * Toast
 * -----------------------------------------------------------------------------------------------*/

interface ToastContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  swipeThreshold?: number;
  forceMount?: boolean;
}

export const Toast = React.forwardRef<HTMLDivElement, ToastProps>(
  (props, ref) => {
    const {
        open: openProp,
        defaultOpen = true,
        onOpenChange,
        duration = 5000,
        swipeThreshold = 50,
        forceMount,
        onMouseEnter,
        onMouseLeave,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        style,
        ...domProps
    } = props;

    const [open, setOpen] = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });

    const timerRef = useRef<any>(0);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [isSwiping, setIsSwiping] = useState(false);
    const startPosRef = useRef({ x: 0, y: 0 });
    const listRef = useRef<HTMLDivElement>(null);
    const composedRef = useComposedRefs(ref, listRef);

    const startTimer = React.useCallback(() => {
        if (!duration || duration === Infinity) return;
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            setOpen(false);
        }, duration);
    }, [duration, setOpen]);

    useEffect(() => {
        if (open) {
            startTimer();
        }
        return () => clearTimeout(timerRef.current);
    }, [open, startTimer]);

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        onPointerDown?.(e);
        if (e.button !== 0) return;
        setIsSwiping(true);
        startPosRef.current = { x: e.clientX, y: e.clientY };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        onPointerMove?.(e);
        if (!isSwiping) return;
        
        const deltaX = e.clientX - startPosRef.current.x;
        // const deltaY = e.clientY - startPosRef.current.y;
        
        // Assume right swipe dismissal
        if (deltaX > 0) {
            setOffset({ x: deltaX, y: 0 });
        }
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        onPointerUp?.(e);
        if (!isSwiping) return;
        setIsSwiping(false);
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);

        if (offset.x > swipeThreshold) {
            setOpen(false);
        } else {
            // Reset
            setOffset({ x: 0, y: 0 });
        }
    };

    return (
      <Presence present={open || !!forceMount}>
      <ToastContext.Provider value={{ open: !!open, onOpenChange: setOpen }}>
      <div
        ref={composedRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-state={open ? 'open' : 'closed'}
        data-swipe-direction="right"
        data-swiping={isSwiping ? 'true' : 'false'}
        style={{
            backgroundColor: 'white',
            borderRadius: '6px',
            boxShadow: '0 10px 38px -10px rgba(22, 23, 24, 0.35), 0 10px 20px -15px rgba(22, 23, 24, 0.2)',
            padding: '15px',
            display: 'grid',
            gridTemplateAreas: '"title action" "description action"',
            gridTemplateColumns: 'auto max-content',
            columnGap: '15px',
            alignItems: 'center',
            transform: isSwiping ? `translateX(${offset.x}px)` : 'none',
            opacity: isSwiping ? 1 - (offset.x / 150) : 1, // Fade out
            transition: isSwiping ? 'none' : 'transform 200ms ease-out, opacity 200ms ease-out',
            touchAction: 'none', // Critical for pointer events
            userSelect: 'none',
            ...style
        }}
        onMouseEnter={(e) => {
            onMouseEnter?.(e);
            clearTimeout(timerRef.current); // Pause
        }}
        onMouseLeave={(e) => {
            onMouseLeave?.(e);
            startTimer(); // Resume
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        {...domProps}
      >
        {props.children}
      </div>
      </ToastContext.Provider>
      </Presence>
    );
  }
);

Toast.displayName = 'Toast';

/* -------------------------------------------------------------------------------------------------
 * ToastTitle
 * -----------------------------------------------------------------------------------------------*/

export interface ToastTitleProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ToastTitle = React.forwardRef<HTMLDivElement, ToastTitleProps>(
  (props, ref) => {
    return (
      <div
        ref={ref}
        style={{ gridArea: 'title', marginBottom: '5px', fontWeight: 500, ...props.style }}
        {...props}
      />
    );
  }
);

ToastTitle.displayName = 'ToastTitle';

/* -------------------------------------------------------------------------------------------------
 * ToastDescription
 * -----------------------------------------------------------------------------------------------*/

export interface ToastDescriptionProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ToastDescription = React.forwardRef<HTMLDivElement, ToastDescriptionProps>(
  (props, ref) => {
    return (
      <div
        ref={ref}
        style={{ gridArea: 'description', margin: 0, opacity: 0.8, fontSize: '13px', ...props.style }}
        {...props}
      />
    );
  }
);

ToastDescription.displayName = 'ToastDescription';

/* -------------------------------------------------------------------------------------------------
 * ToastAction
 * -----------------------------------------------------------------------------------------------*/

export interface ToastActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    altText: string;
}

export const ToastAction = React.forwardRef<HTMLButtonElement, ToastActionProps>(
  (props, ref) => {
    const { altText, ...domProps } = props;
    return (
      <button
        ref={ref}
        type="button"
        style={{ gridArea: 'action', ...props.style }}
        {...domProps}
      />
    );
  }
);

ToastAction.displayName = 'ToastAction';

/* -------------------------------------------------------------------------------------------------
 * ToastClose
 * -----------------------------------------------------------------------------------------------*/

export interface ToastCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const ToastClose = React.forwardRef<HTMLButtonElement, ToastCloseProps>(
  (props, ref) => {
    const { onClick, ...domProps } = props;
    const context = assertReactContext(
      useContext(ToastContext),
      'ToastClose',
      'ToastClose must be used within Toast'
    );

    return (
      <button
        ref={ref}
        type="button"
        onClick={(e) => {
            onClick?.(e);
            if (!e.defaultPrevented) {
                context.onOpenChange(false);
            }
        }}
        {...domProps}
      />
    );
  }
);

ToastClose.displayName = 'ToastClose';
