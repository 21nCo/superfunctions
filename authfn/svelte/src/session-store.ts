import type { AuthFnClient } from '@authfn/client';
import type { AuthFnSession } from '@authfn/core';
import { writable, type Readable } from 'svelte/store';

export interface AuthFnSessionStore extends Readable<AuthFnSession | null> {
  refresh(): Promise<AuthFnSession | null>;
  clear(): void;
}

export function createAuthFnSessionStore(client: AuthFnClient): AuthFnSessionStore {
  const store = writable<AuthFnSession | null>(null);

  const refresh = async (): Promise<AuthFnSession | null> => {
    try {
      const result = await client.getSession();
      const session = result.ok ? result.data.session : null;
      store.set(session);
      return session;
    } catch {
      store.set(null);
      return null;
    }
  };

  void refresh();

  return {
    subscribe: store.subscribe,
    refresh,
    clear() {
      store.set(null);
    }
  };
}
