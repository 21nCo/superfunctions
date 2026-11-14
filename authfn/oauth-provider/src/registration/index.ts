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
  deleteDocumentClient,
  findDocumentClient,
  findRegisteredClient,
  insertRegisteredClient,
  REGISTERED_CLIENT_ID_PREFIX,
  saveDocumentClient,
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

/** The client metadata of a document that names `clientId` and passes the registration rules. */
function readDocumentMetadata(clientId: string, document: unknown) {
  if (!isPlainObject(document) || document.client_id !== clientId) {
    return undefined;
  }
  try {
    return readPublicClientMetadata(document);
  } catch {
    return undefined;
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
 * registration. A usable document is stored and reused for 5 minutes by
 * every instance; each fetch counts toward the registration rate limit. When
 * a refetch is refused by that limit or the host gives no usable answer, a
 * known client keeps its last usable document, so flooding only refuses new
 * clients. A host that answers with something other than a usable document
 * makes the client unknown and its stored document is dropped.
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

  const remember = (clientId: string, client: OAuthProviderClient) => {
    if (documents.size >= DOCUMENT_CACHE_ENTRIES) {
      documents.delete(documents.keys().next().value!);
    }
    documents.set(clientId, { client, expiresAt: runtime.now().getTime() + DOCUMENT_CACHE_MS });
    return client;
  };

  const loadDocumentClient = async (clientId: string, request: Request) => {
    documents.delete(clientId);
    const stored = await findDocumentClient(runtime.store, clientId);
    const known = stored ? publicClient(clientId, stored.name, stored.redirectUris) : undefined;
    if (known && runtime.now().getTime() - new Date(stored!.fetchedAt).getTime() < DOCUMENT_CACHE_MS) {
      return remember(clientId, known);
    }
    try {
      await admit(runtime, request, 'document');
    } catch (error) {
      // Flooding refuses new clients, never ones already known.
      if (known) {
        return remember(clientId, known);
      }
      throw error;
    }
    const fetched = await fetchMetadataDocument(runtime.config.registration?.fetch ?? fetch, clientId);
    if (fetched.status === 'unavailable') {
      return known && remember(clientId, known);
    }
    const metadata = fetched.status === 'ok' ? readDocumentMetadata(clientId, fetched.document) : undefined;
    if (!metadata) {
      if (stored) {
        await deleteDocumentClient(runtime.store, clientId);
      }
      return undefined;
    }
    await saveDocumentClient(runtime.store, {
      id: clientId,
      name: metadata.name ?? null,
      redirectUris: metadata.redirectUris,
      fetchedAt: runtime.now()
    });
    return remember(clientId, publicClient(clientId, metadata.name, metadata.redirectUris));
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
