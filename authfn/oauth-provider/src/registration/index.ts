import type { Route } from '@superfunctions/http';
import { AuthFnConfigError } from 'authfn/core/errors';
import { createAuthFnRouteMeta } from 'authfn/http/router';
import { handleOAuth, OAuthError, oauthJson } from '../http.js';
import type { OAuthProviderRuntime } from '../runtime.js';
import type { OAuthClientRegistrationConfig, OAuthProviderClient } from '../types.js';
import {
  declaresMoreThan,
  fetchMetadataDocument,
  isMetadataDocumentClientId,
  readCappedText
} from './document.js';
import { isPlainObject, readPublicClientMetadata, SUPPORTED_GRANT_TYPES } from './metadata.js';
import {
  admitRegistrationEvent,
  findRegisteredClient,
  insertRegisteredClient,
  REGISTERED_CLIENT_ID_PREFIX,
  type RegistrationEventKind,
  type RegistrationLimits
} from './store.js';

export { createRegistrationSchema } from './store.js';

export const OAUTH_REGISTRATION_PATH = '/oauth/register';

const MAX_REGISTRATION_BODY_BYTES = 64 * 1024;
const DEFAULT_LIMITS: RegistrationLimits = { perIp: 20, global: 200, windowSeconds: 3600 };
/** A fetched metadata document is reused for 5 minutes, by up to 1000 clients per process. */
const DOCUMENT_CACHE_MS = 5 * 60 * 1000;
const DOCUMENT_CACHE_ENTRIES = 1000;

/** Rejects a malformed `pluginRuntime.oauthProvider.registration` at startup. */
export function validateRegistrationConfig(registration: unknown): void {
  if (registration === undefined) {
    return;
  }
  const invalid = (message: string) => new AuthFnConfigError(`pluginRuntime.oauthProvider.registration ${message}`);
  if (!isPlainObject(registration)) {
    throw invalid('must be an object');
  }
  const { rateLimit, resolveClientIp, fetch: fetchImpl } = registration as OAuthClientRegistrationConfig;
  for (const name of ['dynamic', 'metadataDocuments'] as const) {
    if (registration[name] !== undefined && typeof registration[name] !== 'boolean') {
      throw invalid(`${name} must be a boolean`);
    }
  }
  if ((resolveClientIp !== undefined && typeof resolveClientIp !== 'function') ||
    (fetchImpl !== undefined && typeof fetchImpl !== 'function')) {
    throw invalid('resolveClientIp and fetch must be functions');
  }
  if (rateLimit !== undefined && (!isPlainObject(rateLimit) || !Object.entries(rateLimit).every(([name, value]) =>
    ['perIp', 'global', 'windowSeconds'].includes(name) &&
    (value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0))))) {
    throw invalid('rateLimit takes positive integers perIp, global and windowSeconds');
  }
}

function limitsOf(registration: OAuthClientRegistrationConfig | undefined): RegistrationLimits {
  return { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(registration?.rateLimit ?? {}).filter(([, value]) => value !== undefined)) };
}

async function clientIp(runtime: OAuthProviderRuntime, request: Request): Promise<string | undefined> {
  const resolve = runtime.config.registration?.resolveClientIp ?? runtime.ctx.config.rateLimit?.resolveClientIp;
  const ip = (await resolve?.(request))?.trim();
  return ip ? ip : undefined;
}

/** Admits one registration event or throws a 429 `temporarily_unavailable`. */
async function admit(runtime: OAuthProviderRuntime, request: Request, kind: RegistrationEventKind): Promise<void> {
  const result = await admitRegistrationEvent(runtime.store, {
    kind,
    ip: await clientIp(runtime, request),
    now: runtime.now(),
    limits: limitsOf(runtime.config.registration)
  });
  if (!result.admitted) {
    throw new OAuthError('temporarily_unavailable', 'Too many client registrations; try again later', 429, {
      'retry-after': String(result.retryAfterSeconds)
    });
  }
}

function publicClient(clientId: string, name: string | null | undefined, redirectUris: string[]): OAuthProviderClient {
  return { clientId, name: name ?? clientId, redirectUris, trusted: false, tokenEndpointAuthMethod: 'none' };
}

/**
 * Extends `resolveClient` with self-registered clients. A configured client
 * always wins. A `client_id` with the registration prefix is looked up in
 * storage (also after `dynamic` is turned off, which only stops new
 * registrations). With `metadataDocuments`, an `https` URL `client_id` is
 * resolved from the document it serves: the document must name that exact
 * URL as its `client_id` and pass the same public client rules as a
 * registration. Each fetch counts toward the registration rate limit; a
 * document is reused for 5 minutes, and one that cannot be used makes the
 * client unknown.
 */
export function withClientRegistration(runtime: OAuthProviderRuntime): OAuthProviderRuntime {
  const documents = new Map<string, { client: OAuthProviderClient; expiresAt: number }>();
  const pending = new Map<string, Promise<OAuthProviderClient | undefined>>();

  const resolveDocumentClient = (clientId: string, request: Request) => {
    const cached = documents.get(clientId);
    if (cached && cached.expiresAt > runtime.now().getTime()) {
      return Promise.resolve(cached.client);
    }
    // Concurrent requests for one document share a single fetch.
    let loading = pending.get(clientId);
    if (!loading) {
      loading = loadDocumentClient(clientId, request).finally(() => pending.delete(clientId));
      pending.set(clientId, loading);
    }
    return loading;
  };

  const loadDocumentClient = async (clientId: string, request: Request) => {
    documents.delete(clientId);
    await admit(runtime, request, 'document');
    const document = await fetchMetadataDocument(runtime.config.registration?.fetch ?? fetch, clientId);
    if (!isPlainObject(document) || document.client_id !== clientId) {
      return undefined;
    }
    let client: OAuthProviderClient;
    try {
      const metadata = readPublicClientMetadata(document);
      client = publicClient(clientId, metadata.name, metadata.redirectUris);
    } catch {
      return undefined;
    }
    if (documents.size >= DOCUMENT_CACHE_ENTRIES) {
      documents.delete(documents.keys().next().value!);
    }
    documents.set(clientId, { client, expiresAt: runtime.now().getTime() + DOCUMENT_CACHE_MS });
    return client;
  };

  return {
    ...runtime,
    resolveClient: async (clientId, request) => {
      const configured = runtime.findClient(clientId);
      if (configured) {
        return configured;
      }
      if (clientId.startsWith(`${REGISTERED_CLIENT_ID_PREFIX}_`)) {
        const record = await findRegisteredClient(runtime.store, clientId);
        return record ? publicClient(record.id, record.name, record.redirectUris) : undefined;
      }
      if (runtime.config.registration?.metadataDocuments && isMetadataDocumentClientId(clientId)) {
        return resolveDocumentClient(clientId, request);
      }
      return undefined;
    }
  };
}

function invalidBody(description: string): OAuthError {
  return new OAuthError('invalid_client_metadata', description);
}

async function readRegistrationRequest(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw invalidBody('Request body must be application/json');
  }
  if (!request.body || declaresMoreThan(request.headers, MAX_REGISTRATION_BODY_BYTES)) {
    throw invalidBody('Request body must be a JSON object of at most 64 KB');
  }
  try {
    const text = await readCappedText(request.body.getReader(), MAX_REGISTRATION_BODY_BYTES);
    if (text !== null) {
      return JSON.parse(text) as unknown;
    }
  } catch {
    // Invalid UTF-8 or JSON.
  }
  throw invalidBody('Request body must be a JSON object of at most 64 KB');
}

/**
 * RFC 7591 dynamic client registration, when `registration.dynamic` is on.
 * Registers a public client (`token_endpoint_auth_method: none`, no secret)
 * and answers 201 with its metadata. Rate-limited per IP and overall.
 * RFC 7592 client management is not offered.
 */
export function createRegistrationRoutes(runtime: OAuthProviderRuntime): Route[] {
  if (!runtime.config.registration?.dynamic) {
    return [];
  }
  return [{
    method: 'POST',
    path: OAUTH_REGISTRATION_PATH,
    meta: createAuthFnRouteMeta('oauthRegister', 'OAuth 2.0 dynamic client registration', { mode: 'none' }),
    handler: (request) => handleOAuth(async () => {
      const metadata = readPublicClientMetadata(await readRegistrationRequest(request));
      await admit(runtime, request, 'register');
      const now = runtime.now();
      const record = await insertRegisteredClient(runtime.store, { ...metadata, now });
      return oauthJson({
        client_id: record.id,
        client_id_issued_at: Math.floor(now.getTime() / 1000),
        ...(metadata.name === undefined ? {} : { client_name: metadata.name }),
        redirect_uris: record.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: SUPPORTED_GRANT_TYPES,
        response_types: ['code']
      }, 201);
    })
  }];
}
