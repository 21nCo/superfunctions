import React, { createContext, useContext, useRef } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useComposedRefs } from './hooks/use-composed-refs';
import { useId } from './hooks/use-id';
import { Portal } from './portal';
import { Presence } from './presence';
import { useFocusTrap } from './hooks/use-focus-trap';
import { useOutsideClick } from './hooks/use-outside-click';
import { useEscapeKeydown } from './hooks/use-escape-keydown';
import { useBodyScrollLock } from './hooks/use-body-scroll-lock';
import { Slot } from './utils/slot';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

/* -------------------------------------------------------------------------------------------------
 * Dialog Root
 * -----------------------------------------------------------------------------------------------*/

interface DialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modal: boolean;
  titleId?: string;
  descriptionId?: string;
  setTitleId: (id: string) => void;
  setDescriptionId: (id: string) => void;
}

const DialogContext = createContext<DialogContextValue | undefined>(undefined);

const useDialogContext = () => {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error('Dialog components must be used within a Dialog');
  }
  return context;
};

export interface DialogProps {
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
}

export const Dialog: React.FC<DialogProps> = (props) => {
  const {
    children,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    modal = true,
  } = props;

  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });

  const [titleId, setTitleId] = React.useState<string>();
  const [descriptionId, setDescriptionId] = React.useState<string>();

  return (
    <DialogContext.Provider
      value={{
        open: !!open,
        onOpenChange: setOpen,
        modal,
        titleId,
        descriptionId,
        setTitleId,
        setDescriptionId,
      }}
    >
      {children}
    </DialogContext.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * DialogTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface DialogTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

export const DialogTrigger = React.forwardRef<HTMLButtonElement, DialogTriggerProps>(
  (props, ref) => {
    const { children, onClick, asChild = false, ...domProps } = props;
    const context = useDialogContext();
    const TriggerComp = asChild ? Slot : 'button';

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        context.onOpenChange(true);
      }
    };

    return (
      <TriggerComp
        ref={ref}
        {...(!asChild ? { type: 'button' as const } : undefined)}
        aria-haspopup="dialog"
        aria-expanded={context.open}
        aria-controls={context.open ? 'dialog-content' : undefined} // Ideally use generated ID
        data-state={context.open ? 'open' : 'closed'}
        onClick={handleClick}
        {...domProps}
      >
        {children}
      </TriggerComp>
    );
  }
);

DialogTrigger.displayName = 'DialogTrigger';

/* -------------------------------------------------------------------------------------------------
 * DialogPortal
 * -----------------------------------------------------------------------------------------------*/

export interface DialogPortalProps {
  children?: React.ReactNode;
  container?: HTMLElement | null;
  forceMount?: boolean;
}

export const DialogPortal: React.FC<DialogPortalProps> = ({
  children,
  container,
  forceMount,
}) => {
  const context = useDialogContext();
  // if (!context.open && !forceMount) return null; // Removed for Presence

  return (
    <Portal container={container}>
      <Presence present={context.open || !!forceMount}>
        <div style={{ display: 'contents' }}>{children}</div>
      </Presence>
    </Portal>
  );
};

/* -------------------------------------------------------------------------------------------------
 * DialogOverlay
 * -----------------------------------------------------------------------------------------------*/

export interface DialogOverlayProps extends React.HTMLAttributes<HTMLDivElement> {}

export const DialogOverlay = React.forwardRef<HTMLDivElement, DialogOverlayProps>(
  (props, ref) => {
    const context = useDialogContext();
    return (
      <div
        ref={ref}
        data-state={context.open ? 'open' : 'closed'}
        {...props}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 50,
          backgroundColor: 'rgba(0,0,0,0.5)', // Default simplistic style, usually overridden
          ...props.style
        }}
      />
    );
  }
);

DialogOverlay.displayName = 'DialogOverlay';

/* -------------------------------------------------------------------------------------------------
 * DialogContent
 * -----------------------------------------------------------------------------------------------*/

export interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPointerDownOutside?: (event: PointerEvent) => void;
  onInteractOutside?: (event: Event) => void;
}

export const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (props, ref) => {
    const {
      onOpenAutoFocus,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onPointerDownOutside,
      onInteractOutside,
      style,
      ...domProps
    } = props;

    const context = useDialogContext();
    const contentRef = useRef<HTMLDivElement>(null);
    const composedRef = useComposedRefs(ref, contentRef);

    // Focus Trap
    useFocusTrap(contentRef, context.open && context.modal, { returnFocus: true });

    // Scroll Lock
    useBodyScrollLock(context.open && context.modal);

    // Click Outside
    useOutsideClick(contentRef, () => {
        if (!context.modal) return;
        context.onOpenChange(false);
    }, context.open);

    // Escape Key
    useEscapeKeydown((e) => {
        if (!context.open) return;
        onEscapeKeyDown?.(e);
        if (!e.defaultPrevented) {
            context.onOpenChange(false);
        }
    });

    // if (!context.open) return null; // Handled by Presence

    return (
      <div
        ref={composedRef}
        role="dialog"
        id="dialog-content"
        aria-describedby={context.descriptionId}
        aria-labelledby={context.titleId}
        aria-modal={context.modal}
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

DialogContent.displayName = 'DialogContent';

/* -------------------------------------------------------------------------------------------------
 * DialogTitle
 * -----------------------------------------------------------------------------------------------*/

export interface DialogTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}

export const DialogTitle = React.forwardRef<HTMLHeadingElement, DialogTitleProps>(
  (props, ref) => {
    const context = useDialogContext();
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

DialogTitle.displayName = 'DialogTitle';

/* -------------------------------------------------------------------------------------------------
 * DialogDescription
 * -----------------------------------------------------------------------------------------------*/

export interface DialogDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {}

export const DialogDescription = React.forwardRef<HTMLParagraphElement, DialogDescriptionProps>(
  (props, ref) => {
    const context = useDialogContext();
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

DialogDescription.displayName = 'DialogDescription';

/* -------------------------------------------------------------------------------------------------
 * DialogClose
 * -----------------------------------------------------------------------------------------------*/

export interface DialogCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const DialogClose = React.forwardRef<HTMLButtonElement, DialogCloseProps>(
  (props, ref) => {
    const { onClick, ...domProps } = props;
    const context = useDialogContext();

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

DialogClose.displayName = 'DialogClose';
