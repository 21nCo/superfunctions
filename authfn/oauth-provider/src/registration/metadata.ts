import { OAuthError } from '../http.js';
import { isAllowedRedirectUri } from '../runtime.js';

/** The most redirect URIs one registered client may list. */
export const MAX_REGISTERED_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 100;

export const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];

/** What a self-registered public client is allowed to keep. */
export interface PublicClientMetadata {
  name?: string;
  redirectUris: string[];
}

/**
 * A redirect URI a self-registered client may use: one the configuration
 * would accept (visible ASCII, no fragment, no response parameter in the
 * query, origin written out) that is `https`, or `http` to `127.0.0.1` on any
 * port. Native private-use schemes and `[::1]` are for configured clients only.
 */
export function isRegistrableRedirectUri(value: unknown): value is string {
  if (!isAllowedRedirectUri(value) || value.length > MAX_REDIRECT_URI_LENGTH) {
    return false;
  }
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1');
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidMetadata(description: string): OAuthError {
  return new OAuthError('invalid_client_metadata', description);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Validates client metadata (RFC 7591 2) for a public client: from a dynamic
 * registration request or a Client ID Metadata Document. Only
 * `token_endpoint_auth_method: none` is accepted, and nothing that carries a
 * secret. `grant_types` and `response_types` may only name what this server
 * supports. Other metadata is ignored. Throws `invalid_redirect_uri` or
 * `invalid_client_metadata`.
 */
export function readPublicClientMetadata(body: unknown): PublicClientMetadata {
  if (!isPlainObject(body)) {
    throw invalidMetadata('Client metadata must be a JSON object');
  }
  const method = body.token_endpoint_auth_method;
  if ((method !== undefined && method !== 'none') || 'client_secret' in body || 'client_secret_expires_at' in body) {
    throw invalidMetadata('Only public clients (token_endpoint_auth_method none, no client secret) can register');
  }

  const redirectUris = body.redirect_uris;
  if (!isStringArray(redirectUris) || redirectUris.length === 0 ||
    redirectUris.length > MAX_REGISTERED_REDIRECT_URIS || !redirectUris.every(isRegistrableRedirectUri)) {
    throw new OAuthError(
      'invalid_redirect_uri',
      `redirect_uris must list 1 to ${MAX_REGISTERED_REDIRECT_URIS} https or http://127.0.0.1 URIs without a fragment`
    );
  }

  const grantTypes = body.grant_types;
  if (grantTypes !== undefined && (!isStringArray(grantTypes) || !grantTypes.includes('authorization_code') ||
    !grantTypes.every((grant) => SUPPORTED_GRANT_TYPES.includes(grant)))) {
    throw invalidMetadata('grant_types must include authorization_code and may add only refresh_token');
  }
  const responseTypes = body.response_types;
  if (responseTypes !== undefined &&
    (!isStringArray(responseTypes) || responseTypes.length === 0 || !responseTypes.every((type) => type === 'code'))) {
    throw invalidMetadata('response_types may only be code');
  }

  const name = body.client_name;
  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0 ||
    name.length > MAX_CLIENT_NAME_LENGTH || /\p{Cc}/u.test(name))) {
    throw invalidMetadata(`client_name must be 1 to ${MAX_CLIENT_NAME_LENGTH} characters without control characters`);
  }

  return { ...(name === undefined ? {} : { name }), redirectUris: [...new Set(redirectUris)] };
}
