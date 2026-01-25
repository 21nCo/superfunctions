import * as React from 'react';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input[type="text"]:not([disabled]), input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(
  ref: React.RefObject<HTMLElement>,
  active: boolean = true,
  options: { returnFocus?: boolean } = { returnFocus: true }
) {
  const previousFocus = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (active) {
      previousFocus.current = document.activeElement as HTMLElement;
      const el = ref.current;
      if (el) {
        const focusable = el.querySelectorAll(FOCUSABLE_SELECTOR);
        if (focusable.length > 0) {
          (focusable[0] as HTMLElement).focus();
        } else {
            el.focus();
        }
      }
    } else if (options.returnFocus && previousFocus.current) {
      previousFocus.current.focus();
    }
  }, [active, ref, options.returnFocus]);

  React.useEffect(() => {
    if (!active) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      const el = ref.current;
      if (!el) return;

      const focusable = Array.from(el.querySelectorAll(FOCUSABLE_SELECTOR)) as HTMLElement[];
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
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, ref]);
}
