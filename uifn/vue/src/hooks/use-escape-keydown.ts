import { onMounted, onBeforeUnmount } from 'vue';

export function useEscapeKeydown(handler: (e: KeyboardEvent) => void) {
  const listener = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      handler(event);
    }
  };

  onMounted(() => {
    document.addEventListener('keydown', listener);
  });

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', listener);
  });
}
