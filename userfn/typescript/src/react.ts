import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { UserFnClient } from './index';
import type { FlagValue } from './types';
import { canonicalJson } from './utils/json';

const Context = createContext<UserFnClient | null>(null);
/** The application owns client refresh, flushing and closing; this provider only supplies context. */
export function UserFnProvider({ client, children }: { client: UserFnClient; children?: ReactNode }) {
  return createElement(Context.Provider, { value: client }, children);
}
export function useUserFn(): UserFnClient {
  const client = useContext(Context);
  if (!client) throw new Error('UserFn hooks require a UserFnProvider');
  return client;
}
/** Exposures are emitted after commit, never while rendering or during server rendering. */
export function useFlag(key: string, fallback: FlagValue = false): FlagValue {
  const client = useUserFn();
  const fallbackJson = canonicalJson(fallback);
  const observation = useMemo(() => client.observeFlag(key, JSON.parse(fallbackJson)), [client, key, fallbackJson]);
  const snapshot = useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getSnapshot);
  useEffect(() => { observation.track(snapshot); }, [observation, snapshot]);
  return snapshot.value;
}
