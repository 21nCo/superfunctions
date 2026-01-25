import React, { createContext, useContext } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { generateId } from '@uifn/core/utils/id';

/* -------------------------------------------------------------------------------------------------
 * Collapsible
 * -----------------------------------------------------------------------------------------------*/

export interface CollapsibleProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean;
  open?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface CollapsibleContextValue {
  contentId: string;
  disabled?: boolean;
  open: boolean;
  onOpenToggle: () => void;
}

const CollapsibleContext = createContext<CollapsibleContextValue | undefined>(undefined);

const useCollapsibleContext = () => {
  const context = useContext(CollapsibleContext);
  if (!context) {
    throw new Error('Collapsible components must be used within a Collapsible');
  }
  return context;
};

export const Collapsible = React.forwardRef<HTMLDivElement, CollapsibleProps>(
  (props, ref) => {
    const {
      open: openProp,
      defaultOpen,
      disabled,
      onOpenChange,
      children,
      ...domProps
    } = props;

    const [open = false, setOpen] = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });

    // Use React 18 useId if available, fallback to simple generation for older (though project seems modern)
    // Note: In a real app we'd want a unified useId hook that handles both.
    // For this file I'll assume React 18+ per typical modern setups or use a local fallback if needed.
    const _contentId = React.useId ? React.useId() : React.useMemo(() => generateId('collapsible-content'), []);
    const contentId = props.id || _contentId;

    return (
      <CollapsibleContext.Provider
        value={{
          contentId,
          disabled,
          open,
          onOpenToggle: React.useCallback(() => {
            if (!disabled) setOpen(!open);
          }, [disabled, setOpen, open]),
        }}
      >
        <div
          data-state={open ? 'open' : 'closed'}
          data-disabled={disabled ? '' : undefined}
          ref={ref}
          {...domProps}
        >
          {children}
        </div>
      </CollapsibleContext.Provider>
    );
  }
);

Collapsible.displayName = 'Collapsible';

/* -------------------------------------------------------------------------------------------------
 * CollapsibleTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface CollapsibleTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const CollapsibleTrigger = React.forwardRef<HTMLButtonElement, CollapsibleTriggerProps>(
  (props, ref) => {
    const { children, onClick, ...domProps } = props;
    const context = useCollapsibleContext();

    return (
      <button
        type="button"
        aria-controls={context.contentId}
        aria-expanded={context.open}
        data-state={context.open ? 'open' : 'closed'}
        data-disabled={context.disabled ? '' : undefined}
        disabled={context.disabled}
        ref={ref}
        onClick={(e) => {
          context.onOpenToggle();
          onClick?.(e);
        }}
        {...domProps}
      >
        {children}
      </button>
    );
  }
);

CollapsibleTrigger.displayName = 'CollapsibleTrigger';

/* -------------------------------------------------------------------------------------------------
 * CollapsibleContent
 * -----------------------------------------------------------------------------------------------*/

export interface CollapsibleContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export const CollapsibleContent = React.forwardRef<HTMLDivElement, CollapsibleContentProps>(
  (props, ref) => {
    const { children, ...domProps } = props;
    const context = useCollapsibleContext();

    return (
      <div
        id={context.contentId}
        data-state={context.open ? 'open' : 'closed'}
        data-disabled={context.disabled ? '' : undefined}
        hidden={!context.open}
        ref={ref}
        {...domProps}
      >
        {children}
      </div>
    );
  }
);

CollapsibleContent.displayName = 'CollapsibleContent';
