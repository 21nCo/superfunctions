import { ref, onMounted, onBeforeUnmount, Ref } from 'vue';

export function useId(id?: string): string {
  if (id) return id;
  // Simple client-side ID generation for now. 
  // In Nuxt/SSR context, useId from vue 3.5+ is preferred but this is a library.
  // We can use a simple counter or random string.
  return `uifn-${Math.random().toString(36).substr(2, 9)}`;
}
