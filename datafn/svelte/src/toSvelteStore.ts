/**
 * Convert DataFn signal to Svelte store
 */

import type { DatafnSignal } from "@datafn/core";
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

/**
 * Store type that wraps signal value with state properties
 */
export type DatafnSvelteStore<T> = Readable<{
  data: T;
  loading: boolean;
  error: import("@datafn/core").DatafnError | null;
  refreshing: boolean;
}>;

/**
 * Convert a DataFn signal to a Svelte readable store with state properties
 */
export function toSvelteStore<T>(signal: DatafnSignal<T>): DatafnSvelteStore<T> {
  return readable(
    {
      data: signal.get(),
      loading: signal.loading,
      error: signal.error,
      refreshing: signal.refreshing,
    },
    (set) => {
      // Subscribe to signal changes and update the store with current state
      const unsubscribe = signal.subscribe((value: T) => {
        set({
          data: value,
          loading: signal.loading,
          error: signal.error,
          refreshing: signal.refreshing,
        });
      });

      // Return unsubscribe function
      return unsubscribe;
    }
  );
}
