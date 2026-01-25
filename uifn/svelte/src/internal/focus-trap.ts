const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input[type="text"]:not([disabled]), input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusTrap(node: HTMLElement, options: { active: boolean; returnFocus?: boolean } = { active: true, returnFocus: true }) {
  let previousFocus: HTMLElement | null = null;
  let active = options.active;

  function activate() {
    if (active) {
      previousFocus = document.activeElement as HTMLElement;
      const focusable = node.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusable.length > 0) {
        (focusable[0] as HTMLElement).focus();
      } else {
        node.focus();
      }
      document.addEventListener('keydown', handleKeyDown);
    }
  }

  function deactivate() {
    document.removeEventListener('keydown', handleKeyDown);
    if (options.returnFocus && previousFocus) {
      previousFocus.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!active) return;
    if (e.key !== 'Tab') return;

    const focusable = Array.from(node.querySelectorAll(FOCUSABLE_SELECTOR)) as HTMLElement[];
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        last.focus();
        e.preventDefault();
      }
    } else {
      if (document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }
  }

  if (active) activate();

  return {
    update(newOptions: { active: boolean; returnFocus?: boolean }) {
      const wasActive = active;
      active = newOptions.active;
      options = newOptions;

      if (!wasActive && active) {
        activate();
      } else if (wasActive && !active) {
        deactivate();
      }
    },
    destroy() {
      if (active) deactivate();
    }
  };
}
