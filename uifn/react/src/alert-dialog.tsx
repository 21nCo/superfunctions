import React, { createContext, useContext, useRef } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useComposedRefs } from './hooks/use-composed-refs';
import { useId } from './hooks/use-id';
import { Portal } from './portal';
import { useFocusTrap } from './hooks/use-focus-trap';
import { useEscapeKeydown } from './hooks/use-escape-keydown';
import { useBodyScrollLock } from './hooks/use-body-scroll-lock';
import { assertReactContext } from './utils/assert-context';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

/* -------------------------------------------------------------------------------------------------
 * AlertDialog Root
 * -----------------------------------------------------------------------------------------------*/

interface AlertDialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentId: string;
  triggerRef: React.RefObject<HTMLElement>;
  titleId?: string;
  descriptionId?: string;
  setTitleId: (id: string) => void;
  setDescriptionId: (id: string) => void;
}

const AlertDialogContext = createContext<AlertDialogContextValue | undefined>(undefined);

const useAlertDialogContext = () => {
  return assertReactContext(
    useContext(AlertDialogContext),
    'AlertDialog',
    'AlertDialog components must be used within an AlertDialog'
  );
};

export interface AlertDialogProps {
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const AlertDialog: React.FC<AlertDialogProps> = (props) => {
  const {
    children,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
  } = props;

  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  const contentId = useId(undefined, { prefix: 'alert-dialog', slot: 'content' });
  const triggerRef = useRef<HTMLElement>(null);

  const [titleId, setTitleId] = React.useState<string>();
  const [descriptionId, setDescriptionId] = React.useState<string>();
  const previousOpenRef = React.useRef(!!open);

  React.useEffect(() => {
    if (previousOpenRef.current && !open) {
      queueMicrotask(() => {
        triggerRef.current?.focus();
      });
    }

    previousOpenRef.current = !!open;
  }, [open]);

  return (
    <AlertDialogContext.Provider
      value={{
        open: !!open,
        onOpenChange: setOpen,
        contentId,
        triggerRef,
        titleId,
        descriptionId,
        setTitleId,
        setDescriptionId,
      }}
    >
      {children}
    </AlertDialogContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * AlertDialogTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface AlertDialogTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const AlertDialogTrigger = React.forwardRef<HTMLButtonElement, AlertDialogTriggerProps>(
  (props, ref) => {
    const { children, onClick, ...domProps } = props;
    const context = useAlertDialogContext();
    const composedRef = useComposedRefs(ref, context.triggerRef);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        context.onOpenChange(true);
      }
    };

    return (
      <button
        ref={composedRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={context.open}
        aria-controls={context.open ? context.contentId : undefined}
        data-state={context.open ? 'open' : 'closed'}
        onClick={handleClick}
        {...domProps}
      >
        {children}
      </button>
    );
  }
);

AlertDialogTrigger.displayName = 'AlertDialogTrigger';

/* -------------------------------------------------------------------------------------------------
 * AlertDialogPortal
 * -----------------------------------------------------------------------------------------------*/

export interface AlertDialogPortalProps {
  children?: React.ReactNode;
  container?: HTMLElement | null;
  forceMount?: boolean;
}

export const AlertDialogPortal: React.FC<AlertDialogPortalProps> = ({
  children,
  container,
  forceMount,
}) => {
  const context = useAlertDialogContext();
  if (!context.open && !forceMount) return null;

  return (
    <Portal container={container}>
      {children}
    </Portal>
  );
};

/* -------------------------------------------------------------------------------------------------
 * AlertDialogOverlay
 * -----------------------------------------------------------------------------------------------*/

export interface AlertDialogOverlayProps extends React.HTMLAttributes<HTMLDivElement> {}

export const AlertDialogOverlay = React.forwardRef<HTMLDivElement, AlertDialogOverlayProps>(
  (props, ref) => {
    const context = useAlertDialogContext();
    return (
      <div
        ref={ref}
        data-state={context.open ? 'open' : 'closed'}
        {...props}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 50,
          backgroundColor: 'rgba(0,0,0,0.5)',
          ...props.style
        }}
      />
    );
  }
);

AlertDialogOverlay.displayName = 'AlertDialogOverlay';

/* -------------------------------------------------------------------------------------------------
 * AlertDialogContent
 * -----------------------------------------------------------------------------------------------*/

export interface AlertDialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

export const AlertDialogContent = React.forwardRef<HTMLDivElement, AlertDialogContentProps>(
  (props, ref) => {
    const {
      onOpenAutoFocus,
      onCloseAutoFocus,
      onEscapeKeyDown,
      style,
      ...domProps
    } = props;

    const context = useAlertDialogContext();
    const contentRef = useRef<HTMLDivElement>(null);
    const composedRef = useComposedRefs(ref, contentRef);

    // Focus Trap
    useFocusTrap(contentRef, context.open, { returnFocus: true });

    // Scroll Lock
    useBodyScrollLock(context.open);

    // Alert Dialog usually does NOT close on outside click
    // But we still track it to maybe shake or warn?
    // For now, no close on outside click.

    // Escape Key
    useEscapeKeydown((e) => {
        if (!context.open) return;
        onEscapeKeyDown?.(e);
        if (!e.defaultPrevented) {
            context.onOpenChange(false);
        }
    });

    if (!context.open) return null;

    return (
      <div
        ref={composedRef}
        role="alertdialog"
        id={context.contentId}
        aria-describedby={context.descriptionId}
        aria-labelledby={context.titleId}
        aria-modal="true"
        data-state={context.open ? 'open' : 'closed'}
        style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 51,
            backgroundColor: 'white',
            padding: '20px',
            borderRadius: '4px',
            ...style
        }}
        {...domProps}
      >
        {props.children}
      </div>
    );
  }
);

AlertDialogContent.displayName = 'AlertDialogContent';

/* -------------------------------------------------------------------------------------------------
 * AlertDialogTitle
 * -----------------------------------------------------------------------------------------------*/

export interface AlertDialogTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}

export const AlertDialogTitle = React.forwardRef<HTMLHeadingElement, AlertDialogTitleProps>(
  (props, ref) => {
    const context = useAlertDialogContext();
    const id = useId(props.id);
    
    useIsomorphicLayoutEffect(() => {
        if (id) context.setTitleId(id);
    }, [id, context]);

    return (
      <h2 ref={ref} id={id} {...props}>
        {props.children}
      </h2>
    );
  }
);

AlertDialogTitle.displayName = 'AlertDialogTitle';

/* -------------------------------------------------------------------------------------------------
 * AlertDialogDescription
 * -----------------------------------------------------------------------------------------------*/

export interface AlertDialogDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {}

export const AlertDialogDescription = React.forwardRef<HTMLParagraphElement, AlertDialogDescriptionProps>(
  (props, ref) => {
    const context = useAlertDialogContext();
    const id = useId(props.id);

    useIsomorphicLayoutEffect(() => {
        if (id) context.setDescriptionId(id);
    }, [id, context]);

    return (
      <p ref={ref} id={id} {...props}>
        {props.children}
      </p>
    );
  }
);

AlertDialogDescription.displayName = 'AlertDialogDescription';

/* -------------------------------------------------------------------------------------------------
 * AlertDialogAction
 * -----------------------------------------------------------------------------------------------*/

export interface AlertDialogActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const AlertDialogAction = React.forwardRef<HTMLButtonElement, AlertDialogActionProps>(
  (props, ref) => {
    const { onClick, ...domProps } = props;
    const context = useAlertDialogContext();

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        context.onOpenChange(false);
      }
    };

    return (
      <button ref={ref} type="button" onClick={handleClick} {...domProps}>
        {props.children}
      </button>
    );
  }
);

AlertDialogAction.displayName = 'AlertDialogAction';

/* -------------------------------------------------------------------------------------------------
 * AlertDialogCancel
 * -----------------------------------------------------------------------------------------------*/

export interface AlertDialogCancelProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const AlertDialogCancel = React.forwardRef<HTMLButtonElement, AlertDialogCancelProps>(
  (props, ref) => {
    const { onClick, ...domProps } = props;
    const context = useAlertDialogContext();

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        context.onOpenChange(false);
      }
    };

    return (
      <button ref={ref} type="button" onClick={handleClick} {...domProps}>
        {props.children}
      </button>
    );
  }
);

AlertDialogCancel.displayName = 'AlertDialogCancel';
