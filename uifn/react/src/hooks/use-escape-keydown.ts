import * as React from 'react';

export function useEscapeKeydown(
  onEscape: (event: KeyboardEvent) => void,
  ownerDocument: Document = globalThis.document
) {
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onEscape(event);
      }
    };
    ownerDocument.addEventListener('keydown', handleKeyDown);
    return () => ownerDocument.removeEventListener('keydown', handleKeyDown);
  }, [onEscape, ownerDocument]);
}
