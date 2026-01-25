import { watch, Ref, onBeforeUnmount } from 'vue';

export function useBodyScrollLock(active: Ref<boolean>) {
  watch(active, (val) => {
    if (val) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  }, { immediate: true });

  onBeforeUnmount(() => {
    document.body.style.overflow = '';
  });
}
