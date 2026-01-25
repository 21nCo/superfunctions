import * as React from 'react';

export function useControllableState<T>({
  prop,
  defaultProp,
  onChange = () => {},
}: {
  prop?: T;
  defaultProp?: T;
  onChange?: (state: T) => void;
}) {
  const [uncontrolledProp, setUncontrolledProp] = React.useState(defaultProp);
  const isControlled = prop !== undefined;
  const value = isControlled ? prop : uncontrolledProp;
  const handleChange = React.useCallback(
    (nextValue: T) => {
      if (isControlled) {
        onChange(nextValue);
      } else {
        setUncontrolledProp(nextValue);
      }
    },
    [isControlled, onChange]
  );
  return [value, handleChange] as const;
}
