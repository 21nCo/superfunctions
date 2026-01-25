import { watch, Ref, onBeforeUnmount } from 'vue';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input[type="text"]:not([disabled]), input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(
  containerRef: Ref<HTMLElement | undefined>,
  active: Ref<boolean>,
  options: { returnFocus?: boolean } = { returnFocus: true }
) {
  let previousFocus: HTMLElement | null = null;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!active.value) return;
    if (e.key !== 'Tab') return;

    const el = containerRef.value;
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

  watch(active, (val) => {
    if (val) {
      previousFocus = document.activeElement as HTMLElement;
      document.addEventListener('keydown', handleKeyDown);
      // Focus first element
      requestAnimationFrame(() => {
        const el = containerRef.value;
        if (el) {
          const focusable = el.querySelectorAll(FOCUSABLE_SELECTOR);
          if (focusable.length > 0) {
            (focusable[0] as HTMLElement).focus();
          } else {
            el.focus();
          }
        }
      });
    } else {
      document.removeEventListener('keydown', handleKeyDown);
      if (options.returnFocus && previousFocus) {
        previousFocus.focus();
      }
    }
  });

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleKeyDown);
  });
}
