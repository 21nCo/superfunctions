import type { HttpTransportAuthProvider } from '@superfunctions/http';
import { defaultCookieAccessor, readCsrfToken } from './cookies.js';
import type { AuthFnTransportAuthOptions } from './transport-auth.js';

export type AuthFnBearerTokenProvider =
  string | (() => string | undefined | null | Promise<string | undefined | null>);

interface AuthFnSessionTransportAuthOptions extends AuthFnTransportAuthOptions {
  bearerToken?: AuthFnBearerTokenProvider;
  credentials?: RequestCredentials;
}

/**
 * Creates an AuthFn transport auth provider from resolved session material.
 * When requests send cookies with `credentials: 'include'` and a readable
 * AuthFn CSRF cookie is present, its token is sent as `x-authfn-csrf` so
 * cookie-session mutations pass the server CSRF check. The provider cannot see
 * the request URL, so the header is not added automatically for
 * `'same-origin'` (it would also reach cross-origin targets) or `'omit'`;
 * same-origin callers can pass the header through `headers`.
 */
export function createAuthFnSessionTransportAuth(
  options: AuthFnSessionTransportAuthOptions = {},
): HttpTransportAuthProvider {
  const credentials: RequestCredentials =
    options.credentials ?? (options.bearerToken === undefined ? 'include' : 'omit');
  return {
    getCredentials: () => credentials,
    getRequestHeaders: async () => {
      const headers: Record<string, string> = {};
      const bearerToken = await resolveToken(options.bearerToken);
      if (bearerToken) {
        headers.authorization = `Bearer ${bearerToken}`;
      }
      const csrfToken = credentials === 'include'
        ? readCsrfToken(options.cookieAccessor ?? defaultCookieAccessor, options.cookiePrefix)
        : undefined;
      if (csrfToken) {
        headers['x-authfn-csrf'] = csrfToken;
      }
      new Headers((await resolveHeaders(options.headers)) ?? undefined).forEach((value, key) => {
        headers[key] = value;
      });
      for (const plugin of options.plugins ?? []) {
        new Headers((await plugin.getRequestHeaders?.()) ?? undefined).forEach((value, key) => {
          headers[key] = value;
        });
      }
      return headers;
    },
    onUnauthorized: options.onUnauthorized
  };
}

async function resolveHeaders(
  headers: HeadersInit | (() => HeadersInit | null | undefined | Promise<HeadersInit | null | undefined>) | undefined,
): Promise<HeadersInit | null | undefined> {
  return typeof headers === 'function' ? await headers() : headers;
}

async function resolveToken(
  token: AuthFnBearerTokenProvider | undefined,
): Promise<string | undefined> {
  const value = typeof token === 'function' ? await token() : token;
  return value?.trim() || undefined;
}
