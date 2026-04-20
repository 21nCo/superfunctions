import * as React from 'react';

export function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
  isEqual = Object.is,
}: {
  prop?: T;
  defaultProp?: T;
  onChange?: (state: T) => void;
  isEqual?: (previousValue: T | undefined, nextValue: T) => boolean;
}) {
  const [uncontrolledProp, setUncontrolledProp] = React.useState(defaultProp);
  const isControlled = prop !== undefined;
  const value = isControlled ? prop : uncontrolledProp;
  const valueRef = React.useRef(value);
  const onChangeRef = React.useRef(onChange);

  React.useEffect(() => {
    valueRef.current = value;
  }, [value]);

  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const handleChange = React.useCallback(
    (nextValue: T) => {
      const previousValue = valueRef.current;
      if (isEqual(previousValue, nextValue)) {
        return previousValue;
      }

      if (!isControlled) {
        setUncontrolledProp(nextValue);
      }

      onChangeRef.current?.(nextValue);
      return nextValue;
    },
    [isControlled, isEqual]
  );

  return [value, handleChange] as const;
}
