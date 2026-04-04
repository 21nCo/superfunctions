import type { AuthFnClient, AuthFnSession } from '@authfn/client';
import { writable, type Readable } from 'svelte/store';

export interface AuthFnSessionStore extends Readable<AuthFnSession | null> {
  refresh(): Promise<AuthFnSession | null>;
  clear(): void;
}

export function createAuthFnSessionStore(client: AuthFnClient): AuthFnSessionStore {
  const store = writable<AuthFnSession | null>(null);
  let refreshVersion = 0;

  const refresh = async (): Promise<AuthFnSession | null> => {
    const currentVersion = ++refreshVersion;
    try {
      const result = await client.getSession();
      const session = result.ok ? result.data.session : null;
      if (currentVersion === refreshVersion) {
        store.set(session);
      }
      return session;
    } catch {
      if (currentVersion === refreshVersion) {
        store.set(null);
      }
      return null;
    }
  };

  void refresh();

  return {
    subscribe: store.subscribe,
    refresh,
    clear() {
      refreshVersion += 1;
      store.set(null);
    }
  };
}
