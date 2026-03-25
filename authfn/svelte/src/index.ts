export {
  createAuthFnSessionStore,
  type AuthFnSessionStore
} from './session-store.js';

import type { AuthFnClient } from '@authfn/client';
export function createAuthFnClientContext(client: AuthFnClient): { client: AuthFnClient } {
  return { client };
}
