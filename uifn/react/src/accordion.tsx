import React, { createContext, useContext, useMemo, useRef } from 'react';
import { AccordionType } from '@uifn/core/primitives/accordion';
import { useControllableState } from './hooks/use-controllable-state';
import { useRovingFocus } from './hooks/use-roving-focus';
import { useId } from './hooks/use-id';

// Types
export interface AccordionSingleProps {
  type: 'single';
  value?: string;
  defaultValue?: string;
  collapsible?: boolean;
  onValueChange?: (value: string) => void;
}

export interface AccordionMultipleProps {
  type: 'multiple';
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
}

export type AccordionProps = (AccordionSingleProps | AccordionMultipleProps) & {
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  rovingFocus?: boolean;
  children?: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>;

interface AccordionContextValue {
  value: string | string[];
  type: AccordionType;
  collapsible: boolean;
  disabled: boolean;
  orientation: 'horizontal' | 'vertical';
  onItemOpen: (value: string) => void;
  onItemClose: (value: string) => void;
  rovingFocus: boolean;
}

const AccordionContext = createContext<AccordionContextValue | undefined>(undefined);

const useAccordionContext = () => {
  const context = useContext(AccordionContext);
  if (!context) {
    throw new Error('Accordion components must be used within an Accordion');
  }
  return context;
};

export const Accordion = React.forwardRef<HTMLDivElement, AccordionProps>(
  (props, ref) => {
    const {
      type,
      defaultValue,
      value: valueProp,
      onValueChange,
      collapsible = false,
      disabled = false,
      orientation = 'vertical',
      rovingFocus = true,
      children,
      ...domProps
    } = props as any;

    const [value, setValue] = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue !== undefined ? defaultValue : (type === 'multiple' ? [] : ''),
      onChange: onValueChange as any,
    });

    const refInternal = useRef<HTMLDivElement | null>(null);
    const composedRef = (node: HTMLDivElement) => {
      refInternal.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as any).current = node;
    };

    const { handleKeyDown } = useRovingFocus({
      getItems: () => {
        if (!refInternal.current) return [];
        return Array.from(refInternal.current.querySelectorAll('[data-uifn-accordion-trigger]'));
      },
      orientation,
    });

    const contextValue = useMemo(() => {
      const onItemOpen = (itemValue: string) => {
        if (type === 'single') {
          setValue(itemValue);
        } else {
          setValue([...(value as string[] || []), itemValue]);
        }
      };

      const onItemClose = (itemValue: string) => {
        if (type === 'single') {
          if (collapsible) {
            setValue('');
          }
        } else {
          setValue((value as string[] || []).filter((v) => v !== itemValue));
        }
      };

      return {
        value: value || (type === 'multiple' ? [] : ''),
        type,
        collapsible,
        disabled,
        orientation,
        onItemOpen,
        onItemClose,
        rovingFocus,
      };
    }, [value, type, collapsible, disabled, orientation, rovingFocus, setValue]);

    return (
      <AccordionContext.Provider value={contextValue}>
        <div 
          ref={composedRef} 
          data-orientation={orientation} 
          onKeyDown={rovingFocus ? handleKeyDown : undefined}
          {...domProps}
        >
          {children}
        </div>
      </AccordionContext.Provider>
    );
  }
);

Accordion.displayName = 'Accordion';

/* -------------------------------------------------------------------------------------------------
 * AccordionItem
 * -----------------------------------------------------------------------------------------------*/

interface AccordionItemContextValue {
  value: string;
  open: boolean;
  disabled: boolean;
  triggerId: string;
  contentId: string;
}

const AccordionItemContext = createContext<AccordionItemContextValue | undefined>(undefined);

export interface AccordionItemProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  disabled?: boolean;
}

export const AccordionItem = React.forwardRef<HTMLDivElement, AccordionItemProps>(
  (props, ref) => {
    const { value, disabled = false, children, ...domProps } = props;
    const accordionContext = useAccordionContext();
    
    const open = accordionContext.type === 'single'
      ? accordionContext.value === value
      : (accordionContext.value as string[]).includes(value);
    
    const itemDisabled = accordionContext.disabled || disabled;

    const triggerId = useId();
    const contentId = useId();

    return (
      <AccordionItemContext.Provider 
        value={{ 
          value, 
          open, 
          disabled: itemDisabled,
          triggerId: triggerId || `accordion-trigger-${value}`,
          contentId: contentId || `accordion-content-${value}`
        }}
      >
        <div
          ref={ref}
          data-state={open ? 'open' : 'closed'}
          data-disabled={itemDisabled ? '' : undefined}
          data-orientation={accordionContext.orientation}
          {...domProps}
        >
          {children}
        </div>
      </AccordionItemContext.Provider>
    );
  }
);

AccordionItem.displayName = 'AccordionItem';

/* -------------------------------------------------------------------------------------------------
 * AccordionTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface AccordionTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const AccordionTrigger = React.forwardRef<HTMLButtonElement, AccordionTriggerProps>(
  (props, ref) => {
    const { children, onClick, ...domProps } = props;
    const itemContext = useContext(AccordionItemContext);
    const accordionContext = useAccordionContext();

    if (!itemContext) throw new Error('AccordionTrigger must be used within AccordionItem');

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (itemContext.disabled) return;
      if (itemContext.open) {
        accordionContext.onItemClose(itemContext.value);
      } else {
        accordionContext.onItemOpen(itemContext.value);
      }
      onClick?.(e);
    };

    return (
      <h3 style={{ margin: 0 }}>
        <button
          type="button"
          ref={ref}
          id={itemContext.triggerId}
          aria-expanded={itemContext.open}
          aria-disabled={itemContext.disabled}
          aria-controls={itemContext.contentId}
          data-state={itemContext.open ? 'open' : 'closed'}
          data-disabled={itemContext.disabled ? '' : undefined}
          data-uifn-accordion-trigger=""
          disabled={itemContext.disabled}
          onClick={handleClick}
          {...domProps}
        >
          {children}
        </button>
      </h3>
    );
  }
);

AccordionTrigger.displayName = 'AccordionTrigger';

/* -------------------------------------------------------------------------------------------------
 * AccordionContent
 * -----------------------------------------------------------------------------------------------*/

export interface AccordionContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export const AccordionContent = React.forwardRef<HTMLDivElement, AccordionContentProps>(
  (props, ref) => {
    const { children, ...domProps } = props;
    const itemContext = useContext(AccordionItemContext);
    const accordionContext = useAccordionContext();

    if (!itemContext) throw new Error('AccordionContent must be used within AccordionItem');

    return (
      <div
        ref={ref}
        role="region"
        id={itemContext.contentId}
        aria-labelledby={itemContext.triggerId}
        data-state={itemContext.open ? 'open' : 'closed'}
        data-disabled={itemContext.disabled ? '' : undefined}
        data-orientation={accordionContext.orientation}
        hidden={!itemContext.open}
        {...domProps}
      >
        {children}
      </div>
    );
  }
);

AccordionContent.displayName = 'AccordionContent';