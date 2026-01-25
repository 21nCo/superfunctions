import React from 'react';

/* -------------------------------------------------------------------------------------------------
 * Slot
 * -----------------------------------------------------------------------------------------------*/

export interface SlotProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}

export const Slot = React.forwardRef<HTMLElement, SlotProps>((props, ref) => {
  const { children, ...slotProps } = props;
  const childrenArray = React.Children.toArray(children);
  const slottable = childrenArray.find((child) => React.isValidElement(child) && (child.type === Slottable));

  if (slottable) {
      // If Slottable is used, we need to inject props into it? 
      // Simplified: Just find the single child.
  }

  if (React.isValidElement(children)) {
    return React.cloneElement(children, {
      ...mergeProps(slotProps, children.props),
      // @ts-ignore
      ref: ref ? composeRefs(ref, (children as any).ref) : (children as any).ref,
    });
  }

  return React.Children.count(children) > 1 ? React.Children.only(children) : null;
});

Slot.displayName = 'Slot';

/* -------------------------------------------------------------------------------------------------
 * Slottable
 * -----------------------------------------------------------------------------------------------*/

export const Slottable = ({ children }: { children: React.ReactNode }) => {
  return <>{children}</>;
};

/* -------------------------------------------------------------------------------------------------
 * Utils
 * -----------------------------------------------------------------------------------------------*/

function mergeProps(slotProps: any, childProps: any) {
  // Override child props with slot props, but merge styles/classes/handlers
  const overrideProps = { ...childProps };

  for (const propName in slotProps) {
    const slotPropValue = slotProps[propName];
    const childPropValue = childProps[propName];

    const isHandler = /^on[A-Z]/.test(propName);
    if (isHandler) {
      // Chain handlers
      if (slotPropValue && childPropValue) {
        overrideProps[propName] = (...args: any[]) => {
          childPropValue(...args);
          slotPropValue(...args);
        };
      } else if (slotPropValue) {
        overrideProps[propName] = slotPropValue;
      }
    } else if (propName === 'style') {
      overrideProps[propName] = { ...childPropValue, ...slotPropValue };
    } else if (propName === 'className') {
      overrideProps[propName] = [childPropValue, slotPropValue].filter(Boolean).join(' ');
    } else {
      overrideProps[propName] = slotPropValue;
    }
  }

  return overrideProps;
}

function composeRefs<T>(...refs: (React.Ref<T> | undefined)[]) {
  return (node: T) => {
    refs.forEach((ref) => {
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref != null) {
        (ref as React.MutableRefObject<T>).current = node;
      }
    });
  };
}
