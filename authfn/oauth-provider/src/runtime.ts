import type { AuthFnPluginRuntimeContext, AuthFnRuntimeConfig } from 'authfn';
import { AuthFnConfigError } from 'authfn/core/errors';
import { readPluginRuntimeConfig } from 'authfn/core/plugin-runtime';
import { resolveEnvironment } from 'authfn/core/environment';
import { assertRegisteredScopes } from 'authfn/core/scopes';
import { isBearerCredential, OAuthError } from './http.js';
import type {
  OAuthProviderClient,
  OAuthProviderPluginRuntimeConfig,
  OAuthProviderResource
} from './types.js';

export const OAUTH_PROVIDER_PLUGIN_NAME = 'oauthProvider';

/** Shared state every endpoint reads: validated config, lookups and storage scope. */
export interface OAuthProviderRuntime {
  ctx: AuthFnPluginRuntimeContext;
  config: OAuthProviderPluginRuntimeConfig;
  store: { database: AuthFnRuntimeConfig['database']; namespace: string };
  now(): Date;
  findClient(clientId: string): OAuthProviderClient | undefined;
  findResource(resource: string): OAuthProviderResource | undefined;
}

export function createOAuthProviderRuntime(ctx: AuthFnPluginRuntimeContext): OAuthProviderRuntime {
  const config = readOAuthProviderRuntimeConfig(ctx.config);
  const clients = new Map(config.clients.map((client) => [client.clientId, client]));
  const resources = new Map(config.resources.map((resource) => [resource.resource, resource]));
  return {
    ctx,
    config,
    store: { database: ctx.config.database, namespace: ctx.namespace },
    now: () => config.now?.() ?? new Date(),
    findClient: (clientId) => clients.get(clientId),
    findResource: (resource) => resources.get(resource)
  };
}

/**
 * Reads and validates `pluginRuntime.oauthProvider`. Runs when the server is
 * created, so a misconfigured provider fails at startup with
 * `AUTHFN_CONFIG_INVALID` rather than on the first authorization.
 */
export function readOAuthProviderRuntimeConfig(config: AuthFnRuntimeConfig): OAuthProviderPluginRuntimeConfig {
  const runtime = readPluginRuntimeConfig<OAuthProviderPluginRuntimeConfig>(config, OAUTH_PROVIDER_PLUGIN_NAME);
  if (typeof runtime.loginRequired !== 'function' || typeof runtime.consent !== 'function') {
    throw configError('pluginRuntime.oauthProvider needs loginRequired and consent hooks');
  }
  if (!Array.isArray(runtime.clients) || !Array.isArray(runtime.resources) || runtime.resources.length === 0) {
    throw configError('pluginRuntime.oauthProvider needs clients and at least one resource');
  }

  const clientIds = new Set<string>();
  for (const client of runtime.clients) {
    validateClient(client, clientIds);
  }
  const resourceIds = new Set<string>();
  const introspectionSecrets = new Set<string>();
  for (const resource of runtime.resources) {
    validateResource(config, resource, resourceIds, introspectionSecrets);
  }
  return runtime as OAuthProviderPluginRuntimeConfig;
}

function validateClient(client: OAuthProviderClient, clientIds: Set<string>): void {
  if (typeof client?.clientId !== 'string' || client.clientId.length === 0 || clientIds.has(client.clientId)) {
    throw configError('Each OAuth client needs a unique clientId');
  }
  clientIds.add(client.clientId);
  if (!Array.isArray(client.redirectUris) || client.redirectUris.length === 0 ||
    !client.redirectUris.every(isAllowedRedirectUri)) {
    throw configError(
      `OAuth client ${client.clientId} needs absolute redirect URIs without a fragment, using https, an http ` +
      'loopback IP or a reverse-domain native app scheme, whose query has no OAuth response parameter'
    );
  }
  const method = client.tokenEndpointAuthMethod;
  if (method !== undefined && !['none', 'client_secret_basic', 'client_secret_post'].includes(method)) {
    throw configError(`OAuth client ${client.clientId} has an unsupported token endpoint auth method`);
  }
  if ((method === 'none' && client.clientSecret) || (method && method !== 'none' && !client.clientSecret)) {
    throw configError(`OAuth client ${client.clientId} auth method and clientSecret disagree`);
  }
}

function validateResource(
  config: AuthFnRuntimeConfig,
  resource: OAuthProviderResource,
  resourceIds: Set<string>,
  introspectionSecrets: Set<string>
): void {
  if (!isAbsoluteUriWithoutFragment(resource?.resource) || resourceIds.has(resource.resource)) {
    throw configError('Each OAuth resource must be a unique absolute URI without a fragment');
  }
  resourceIds.add(resource.resource);
  // Introspection identifies the calling resource server by its secret, so
  // a shared secret would make one resource answer for another's audience.
  // The secret is sent as a Bearer credential, so it must fit that grammar.
  const secret = resource.introspectionSecret;
  if (secret !== undefined) {
    if (typeof secret !== 'string' || !isBearerCredential(secret) || introspectionSecrets.has(secret)) {
      throw configError(`OAuth resource ${resource.resource} needs a unique Bearer-token introspectionSecret`);
    }
    introspectionSecrets.add(secret);
  }
  if (!Array.isArray(resource.scopes) || resource.scopes.length === 0) {
    throw configError(`OAuth resource ${resource.resource} needs at least one scope`);
  }
  try {
    assertRegisteredScopes(config.scopes, resource.scopes);
  } catch {
    throw configError(`OAuth resource ${resource.resource} scopes must be grantable by the AuthFn scope registry`);
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/** Parameters the authorization response adds to the redirect URI. */
const RESPONSE_PARAMETERS = ['code', 'state', 'iss', 'error', 'error_description', 'error_uri'];

/**
 * Only visible ASCII (RFC 3986 URIs, with non-ASCII hosts in punycode and
 * other characters percent-encoded): the redirect URI is sent as is in the
 * `Location` header, which carries no spaces, controls or raw Unicode.
 */
function isVisibleAscii(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value);
}

/**
 * A private-use URI scheme in reverse domain name form (RFC 8252 7.1), such
 * as `com.example.app:`. The dot is outside both character classes, so
 * matching is linear.
 */
const PRIVATE_USE_SCHEME = /^[a-z][a-z0-9+-]*(?:\.[a-z0-9+-]+)+:$/;

/**
 * A redirect URI that keeps the authorization response off plaintext
 * networks and out of the browser's own schemes (OAuth 2.1 2.3.1, RFC 8252
 * 7), written in visible ASCII: `https`, `http` only to a loopback IP literal, or a native app's
 * reverse-domain private-use scheme. Every other scheme (`javascript`,
 * `data`, `file`, `ws`, a dotless custom scheme, ...) is rejected. Its query
 * must not use a response parameter name, which the response would otherwise
 * duplicate.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (!isAbsoluteUriWithoutFragment(value) || !isVisibleAscii(value)) {
    return false;
  }
  const url = new URL(value);
  const allowedScheme = url.protocol === 'https:' ||
    (url.protocol === 'http:' ? LOOPBACK_HOSTS.has(url.hostname) : PRIVATE_USE_SCHEME.test(url.protocol));
  return allowedScheme && RESPONSE_PARAMETERS.every((name) => !url.searchParams.has(name));
}

function configError(message: string): AuthFnConfigError {
  return new AuthFnConfigError(message);
}

export function isAbsoluteUriWithoutFragment(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('#')) {
    return false;
  }
  try {
    return Boolean(new URL(value));
  } catch {
    return false;
  }
}


/**
 * Exact redirect URI matching (OAuth 2.1), except that an `http` loopback IP
 * redirect URI matches on any port (RFC 8252 7.3).
 */
export function matchesRedirectUri(client: OAuthProviderClient, redirectUri: string): boolean {
  // The URL parser drops tabs and newlines, so check the raw value first.
  if (!isVisibleAscii(redirectUri)) {
    return false;
  }
  if (client.redirectUris.includes(redirectUri)) {
    return true;
  }
  const requested = parseLoopback(redirectUri);
  return requested !== null && client.redirectUris.some((registered) => {
    const candidate = parseLoopback(registered);
    return candidate !== null &&
      candidate.hostname === requested.hostname &&
      candidate.pathname === requested.pathname &&
      candidate.search === requested.search;
  });
}

function parseLoopback(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && !value.includes('#') ? url : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the requested scopes for a resource (RFC 6749 3.3). An absent
 * `scope` asks for every scope the resource offers. Each requested scope must
 * be one the resource offers, compared exactly.
 */
export function resolveRequestedScopes(resource: OAuthProviderResource, scope: string | undefined): string[] {
  if (scope === undefined) {
    return [...resource.scopes];
  }
  const requested = scope.split(' ');
  if (requested.some((entry) => entry.length === 0)) {
    throw new OAuthError('invalid_scope', 'Scope must be space-delimited scope tokens');
  }
  const unknown = requested.filter((entry) => !resource.scopes.includes(entry));
  if (unknown.length > 0) {
    throw new OAuthError('invalid_scope', `Scope is not available for this resource: ${unknown.join(' ')}`);
  }
  return [...new Set(requested)];
}

/** Resolves the single resource (RFC 8707) a request is bound to. */
export function requireResource(runtime: OAuthProviderRuntime, value: string | undefined): OAuthProviderResource {
  if (!value) {
    throw new OAuthError('invalid_target', 'Parameter resource is required');
  }
  const resource = runtime.findResource(value);
  if (!resource) {
    throw new OAuthError('invalid_target', 'Resource is not served by this authorization server');
  }
  return resource;
}

export interface OAuthEndpoints {
  issuer: string;
  authorization: string;
  token: string;
  revocation: string;
  introspection: string;
}

/** Removes trailing slashes in linear time. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

export async function resolveEndpoints(runtime: OAuthProviderRuntime, request: Request): Promise<OAuthEndpoints> {
  const environment = await resolveEnvironment(runtime.ctx.config, request);
  const base = `${trimTrailingSlashes(environment.baseUrl)}${trimTrailingSlashes(runtime.ctx.basePath)}/oauth`;
  return {
    issuer: environment.issuer,
    authorization: `${base}/authorize`,
    token: `${base}/token`,
    revocation: `${base}/revoke`,
    introspection: `${base}/introspect`
  };
}
