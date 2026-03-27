import * as React from 'react';
import { createEscapeKeyListener } from '@uifn/core/utils/escape-key';

export function useEscapeKeydown(
  onEscape: (event: KeyboardEvent) => void,
  ownerDocument?: Document
) {
  const resolvedOwnerDocument =
    ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
  const onEscapeRef = React.useRef(onEscape);

  React.useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  React.useEffect(() => {
    if (!resolvedOwnerDocument) {
      return;
    }

    const escapeKeyListener = createEscapeKeyListener((event) => onEscapeRef.current(event), {
      ownerDocument: resolvedOwnerDocument,
    });
    return () => escapeKeyListener.destroy();
  }, [resolvedOwnerDocument]);
}
