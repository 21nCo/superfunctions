import { K } from '../aria/keys';

export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusTrapOptions {
  active?: boolean;
  returnFocus?: boolean;
  ownerDocument?: Document;
  focusableSelector?: string;
}

export interface FocusTrapController {
  activate: () => void;
  deactivate: () => void;
  update: (options: FocusTrapOptions) => void;
  destroy: () => void;
}

export interface FocusTrapSnapshot {
  active: boolean;
  trapped: boolean;
  entryFocusId: string | null;
  currentFocusId: string | null;
  returnFocusId: string | null;
}

export interface FocusTrapStateOptions {
  active?: boolean;
  entryFocusId?: string | null;
  returnFocusId?: string | null;
}

export interface FocusTrapStateController {
  getState: () => FocusTrapSnapshot;
  activate: (options?: Pick<FocusTrapStateOptions, 'entryFocusId' | 'returnFocusId'>) => FocusTrapSnapshot;
  deactivate: (options?: { restoreFocus?: boolean }) => FocusTrapSnapshot;
  setReturnFocus: (focusId: string | null) => FocusTrapSnapshot;
  recordFocus: (focusId: string | null) => FocusTrapSnapshot;
}

export function createFocusTrapState(
  options: FocusTrapStateOptions = {}
): FocusTrapStateController {
  let state: FocusTrapSnapshot = {
    active: options.active ?? false,
    trapped: options.active ?? false,
    entryFocusId: options.entryFocusId ?? null,
    currentFocusId: options.entryFocusId ?? null,
    returnFocusId: options.returnFocusId ?? null,
  };

  const getState = (): FocusTrapSnapshot => ({ ...state });

  return {
    getState,
    activate(nextOptions) {
      const entryFocusId = nextOptions?.entryFocusId ?? state.entryFocusId;
      const returnFocusId = nextOptions?.returnFocusId ?? state.returnFocusId;

      state = {
        ...state,
        active: true,
        trapped: true,
        entryFocusId,
        currentFocusId: entryFocusId ?? state.currentFocusId,
        returnFocusId,
      };

      return getState();
    },
    deactivate(nextOptions) {
      const shouldRestoreFocus = nextOptions?.restoreFocus ?? true;
      const nextFocus = shouldRestoreFocus ? state.returnFocusId : state.currentFocusId;

      state = {
        ...state,
        active: false,
        trapped: false,
        currentFocusId: nextFocus ?? state.currentFocusId,
      };

      return getState();
    },
    setReturnFocus(focusId) {
      state = {
        ...state,
        returnFocusId: focusId,
      };

      return getState();
    },
    recordFocus(focusId) {
      state = {
        ...state,
        currentFocusId: focusId,
      };

      return getState();
    },
  };
}

export function getFocusableElements(
  container: ParentNode,
  selector: string = FOCUSABLE_SELECTOR
): HTMLElement[] {
  return Array.from(container.querySelectorAll(selector)) as HTMLElement[];
}

export function createFocusTrap(
  container: HTMLElement,
  options: FocusTrapOptions = {}
): FocusTrapController {
  const ownerDocument = options.ownerDocument ?? container.ownerDocument;
  const focusableSelector = options.focusableSelector ?? FOCUSABLE_SELECTOR;
  let enabled = options.active ?? true;
  let isActive = false;
  let returnFocus = options.returnFocus ?? true;
  let previousFocus: HTMLElement | null = null;

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!isActive || event.key !== K.TAB) {
      return;
    }

    const focusable = getFocusableElements(container, focusableSelector);
    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = ownerDocument.activeElement;

    if (event.shiftKey && current === first) {
      last.focus();
      event.preventDefault();
      return;
    }

    if (!event.shiftKey && current === last) {
      first.focus();
      event.preventDefault();
    }
  };

  const activate = () => {
    if (isActive) {
      return;
    }

    isActive = true;
    previousFocus = ownerDocument.activeElement as HTMLElement | null;
    const focusable = getFocusableElements(container, focusableSelector);
    const target = focusable[0] ?? container;
    target.focus();
    ownerDocument.addEventListener('keydown', handleKeyDown);
  };

  const deactivate = () => {
    if (!isActive) {
      return;
    }

    isActive = false;
    ownerDocument.removeEventListener('keydown', handleKeyDown);

    if (returnFocus && previousFocus) {
      previousFocus.focus();
    }
  };

  if (enabled) {
    activate();
  }

  return {
    activate,
    deactivate,
    update(nextOptions) {
      const wasEnabled = enabled;
      enabled = nextOptions.active ?? enabled;
      returnFocus = nextOptions.returnFocus ?? returnFocus;

      if (!wasEnabled && enabled) {
        activate();
      } else if (wasEnabled && !enabled) {
        deactivate();
      }
    },
    destroy() {
      deactivate();
    },
  };
}
