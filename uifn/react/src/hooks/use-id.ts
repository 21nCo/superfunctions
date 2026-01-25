import * as React from 'react';
import { generateId } from '@uifn/core/utils/id';

export const useId = (id?: string) => {
  const [generatedId, setGeneratedId] = React.useState<string | undefined>(id);
  
  // Use React.useId if available (React 18+)
  // @ts-ignore
  const reactId = typeof React.useId === 'function' ? React.useId() : undefined;

  React.useLayoutEffect(() => {
    if (!id && !reactId) {
      setGeneratedId(generateId());
    }
  }, [id, reactId]);

  return id || reactId || generatedId;
};
