import React from 'react';

type AnyProps = Record<string, unknown>;

export interface SlotProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}

function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (node: T | null) => {
    refs.forEach((ref) => {
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        (ref as React.MutableRefObject<T | null>).current = node;
      }
    });
  };
}

function mergeProps(slotProps: AnyProps, childProps: AnyProps): AnyProps {
  const merged: AnyProps = { ...childProps };

  Object.keys(slotProps).forEach((propName) => {
    const slotValue = slotProps[propName];
    const childValue = childProps[propName];
    const isHandler = /^on[A-Z]/.test(propName);

    if (isHandler && typeof slotValue === 'function' && typeof childValue === 'function') {
      merged[propName] = (...args: unknown[]) => {
        (childValue as (...params: unknown[]) => void)(...args);
        (slotValue as (...params: unknown[]) => void)(...args);
      };
      return;
    }

    if (propName === 'style' && typeof slotValue === 'object' && slotValue) {
      merged[propName] = {
        ...(childValue as object),
        ...(slotValue as object),
      };
      return;
    }

    if (propName === 'className') {
      merged[propName] = [childValue, slotValue].filter(Boolean).join(' ');
      return;
    }

    merged[propName] = slotValue;
  });

  return merged;
}

export const Slot = React.forwardRef<HTMLElement, SlotProps>((props, forwardedRef) => {
  const { children, ...slotProps } = props;

  if (!React.isValidElement(children)) {
    return React.Children.count(children) > 1 ? React.Children.only(children) : null;
  }

  const child = children as React.ReactElement<AnyProps>;
  const childRef = (child as unknown as { ref?: React.Ref<HTMLElement> }).ref;

  return React.cloneElement(child, {
    ...mergeProps(slotProps as AnyProps, child.props as AnyProps),
    ref: composeRefs(forwardedRef, childRef),
  });
});

Slot.displayName = 'Slot';

export const Slottable = ({ children }: { children: React.ReactNode }) => <>{children}</>;
