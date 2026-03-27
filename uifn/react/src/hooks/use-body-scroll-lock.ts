import { useEffect } from 'react';

const bodyScrollLockState = new WeakMap<
  Document,
  {
    count: number;
    overflow: string;
  }
>();

export function useBodyScrollLock(lock: boolean = true) {
  useEffect(() => {
    if (!lock || typeof document === 'undefined') {
      return;
    }

    const ownerDocument = document;
    const body = ownerDocument.body;
    const existingState = bodyScrollLockState.get(ownerDocument);

    if (existingState) {
      existingState.count += 1;
    } else {
      bodyScrollLockState.set(ownerDocument, {
        count: 1,
        overflow: body.style.overflow,
      });
      body.style.overflow = 'hidden';
    }

    return () => {
      const state = bodyScrollLockState.get(ownerDocument);
      if (!state) {
        return;
      }

      state.count -= 1;
      if (state.count <= 0) {
        body.style.overflow = state.overflow;
        bodyScrollLockState.delete(ownerDocument);
      }
    };
  }, [lock]);
}
