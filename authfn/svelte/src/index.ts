export {
  createAuthFnSessionStore,
  type AuthFnSessionStore
} from './session-store.js';

import type { AuthFnClient } from '@authfn/client';
import { getContext, setContext } from 'svelte';

const AUTHFN_CLIENT_CONTEXT = Symbol('authfn-client');

export function createAuthFnClientContext(client: AuthFnClient): { client: AuthFnClient } {
  const value = { client };
  setContext(AUTHFN_CLIENT_CONTEXT, value);
  return value;
}

export function getAuthFnClientContext(): { client: AuthFnClient } {
  return getContext(AUTHFN_CLIENT_CONTEXT);
}
