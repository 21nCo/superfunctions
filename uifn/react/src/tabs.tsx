import React, { createContext, useContext, useRef } from 'react';
import { useControllableState } from './hooks/use-controllable-state';
import { useId } from './hooks/use-id';
import { useRovingFocus } from './hooks/use-roving-focus';

/* -------------------------------------------------------------------------------------------------
 * Tabs Root
 * -----------------------------------------------------------------------------------------------*/

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  orientation: 'horizontal' | 'vertical';
  activationMode: 'automatic' | 'manual';
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | undefined>(undefined);

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'horizontal' | 'vertical';
  activationMode?: 'automatic' | 'manual';
}

export const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  (props, ref) => {
    const {
      value: valueProp,
      defaultValue,
      onValueChange,
      orientation = 'horizontal',
      activationMode = 'automatic',
      children,
      ...domProps
    } = props;

    const [value, setValue] = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue ?? '',
      onChange: onValueChange,
    });

    const baseId = useId();

    return (
      <TabsContext.Provider
        value={{
          value: value!,
          onValueChange: setValue,
          orientation,
          activationMode,
          baseId: baseId || ''
        }}
      >
        <div
          ref={ref}
          data-orientation={orientation}
          {...domProps}
        >
          {children}
        </div>
      </TabsContext.Provider>
    );
  }
);

Tabs.displayName = 'Tabs';

/* -------------------------------------------------------------------------------------------------
 * TabsList
 * -----------------------------------------------------------------------------------------------*/

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  loop?: boolean;
}

export const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  (props, ref) => {
    const { loop = true, ...domProps } = props;
    const context = useContext(TabsContext);
    if (!context) throw new Error('TabsList must be used within Tabs');

    const refInternal = useRef<HTMLDivElement | null>(null);
    const composedRef = (node: HTMLDivElement) => {
      refInternal.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as any).current = node;
    };

    const { handleKeyDown } = useRovingFocus({
      getItems: () => {
        if (!refInternal.current) return [];
        return Array.from(refInternal.current.querySelectorAll('[role="tab"]:not([disabled])'));
      },
      orientation: context.orientation,
      loop,
    });

    return (
      <div
        ref={composedRef}
        role="tablist"
        aria-orientation={context.orientation}
        onKeyDown={handleKeyDown}
        {...domProps}
      />
    );
  }
);

TabsList.displayName = 'TabsList';

/* -------------------------------------------------------------------------------------------------
 * TabsTrigger
 * -----------------------------------------------------------------------------------------------*/

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  (props, ref) => {
    const { value, disabled, onClick, onFocus, ...domProps } = props;
    const context = useContext(TabsContext);
    if (!context) throw new Error('TabsTrigger must be used within Tabs');

    const isSelected = context.value === value;
    const triggerId = `${context.baseId}-trigger-${value}`;
    const contentId = `${context.baseId}-content-${value}`;

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(e);
        if (!disabled) {
            context.onValueChange(value);
        }
    };

    const handleFocus = (e: React.FocusEvent<HTMLButtonElement>) => {
        onFocus?.(e);
        if (!disabled && context.activationMode === 'automatic') {
            context.onValueChange(value);
        }
    };

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        aria-selected={isSelected}
        aria-controls={contentId}
        id={triggerId}
        data-state={isSelected ? 'active' : 'inactive'}
        data-disabled={disabled ? '' : undefined}
        disabled={disabled}
        tabIndex={isSelected ? 0 : -1}
        onClick={handleClick}
        onFocus={handleFocus}
        {...domProps}
      />
    );
  }
);

TabsTrigger.displayName = 'TabsTrigger';

/* -------------------------------------------------------------------------------------------------
 * TabsContent
 * -----------------------------------------------------------------------------------------------*/

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  (props, ref) => {
    const { value, ...domProps } = props;
    const context = useContext(TabsContext);
    if (!context) throw new Error('TabsContent must be used within Tabs');

    const isSelected = context.value === value;
    const triggerId = `${context.baseId}-trigger-${value}`;
    const contentId = `${context.baseId}-content-${value}`;

    if (!isSelected) return null;

    return (
      <div
        ref={ref}
        role="tabpanel"
        id={contentId}
        aria-labelledby={triggerId}
        data-state={isSelected ? 'active' : 'inactive'}
        data-orientation={context.orientation}
        tabIndex={0}
        {...domProps}
      />
    );
  }
);

TabsContent.displayName = 'TabsContent';