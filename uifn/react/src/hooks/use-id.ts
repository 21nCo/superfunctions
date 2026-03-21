import * as React from 'react';
import { generateId } from '@uifn/core/utils/id';

export const useId = (id?: string) => {
  const reactId = typeof React.useId === 'function' ? React.useId() : undefined;
  const fallbackRef = React.useRef<string | undefined>(
    id ?? (!reactId ? generateId('react-id') : undefined)
  );

  return id ?? reactId ?? fallbackRef.current;
};
