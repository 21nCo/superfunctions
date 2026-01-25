import { onMounted, onBeforeUnmount, Ref } from 'vue';

export function useOutsideClick(
  elementRef: Ref<HTMLElement | undefined>,
  handler: (e: MouseEvent | TouchEvent) => void,
  active: Ref<boolean>
) {
  const listener = (event: MouseEvent | TouchEvent) => {
    if (!active.value) return;
    const el = elementRef.value;
    if (!el || el.contains(event.target as Node)) return;
    handler(event);
  };

  onMounted(() => {
    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);
  });

  onBeforeUnmount(() => {
    document.removeEventListener('mousedown', listener);
    document.removeEventListener('touchstart', listener);
  });
}
