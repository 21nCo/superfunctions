import * as React from 'react';
import { createEscapeKeyListener } from '@uifn/core/utils/escape-key';

export function useEscapeKeydown(
  onEscape: (event: KeyboardEvent) => void,
  ownerDocument?: Document
) {
  const resolvedOwnerDocument =
    ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);

  React.useEffect(() => {
    if (!resolvedOwnerDocument) {
      return;
    }

    const escapeKeyListener = createEscapeKeyListener(onEscape, {
      ownerDocument: resolvedOwnerDocument,
    });
    return () => escapeKeyListener.destroy();
  }, [onEscape, resolvedOwnerDocument]);
}
