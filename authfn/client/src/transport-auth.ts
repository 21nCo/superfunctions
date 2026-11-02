import type {
  HttpTransportAuthOptions,
  HttpTransportAuthProvider,
} from '@superfunctions/http';
import { createAuthFnSessionTransportAuth } from './transport-auth-internal.js';

export type AuthFnTransportAuthOptions = Pick<
  HttpTransportAuthOptions,
  'headers' | 'plugins' | 'onUnauthorized'
> & {
  /** Reads the cookies visible to the client; defaults to `document.cookie`. */
  cookieAccessor?: () => string | undefined;
  /** AuthFn cookie prefix used to find the `<prefix>.csrf` cookie; inferred when omitted. */
  cookiePrefix?: string;
};

/**
 * Creates a generic HTTP transport auth provider backed by AuthFn session options.
 */
export function createAuthFnTransportAuth(
  options: AuthFnTransportAuthOptions = {},
): HttpTransportAuthProvider {
  return createAuthFnSessionTransportAuth(options);
}
