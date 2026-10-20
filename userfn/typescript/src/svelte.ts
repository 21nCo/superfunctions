import type { UserFnClient } from './index';
import type { FlagValue } from './types';

/** Svelte readable-store contract, without requiring a Svelte runtime in the vanilla SDK. */
export function flagStore(client: UserFnClient, key: string, fallback: FlagValue = false): {
  subscribe(run: (value: FlagValue) => void): () => void;
} {
  const observation = client.observeFlag(key, fallback);
  return {
    subscribe(run) {
      const update = () => {
        const snapshot = observation.getSnapshot();
        run(snapshot.value);
        // SSR subscriptions do not represent a browser impression.
        if (typeof window !== 'undefined') observation.track(snapshot);
      };
      const unsubscribe = observation.subscribe(update);
      try { update(); } catch (error) { unsubscribe(); throw error; }
      return unsubscribe;
    },
  };
}
