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
  readCappedJson
} from './document.js';
import { isPlainObject, readPublicClientMetadata, SUPPORTED_GRANT_TYPES } from './metadata.js';
import {
  admitRegistrationEvent,
  claimDocumentRefetch,
  createDocumentClient,
  deleteDocumentClient,
  documentClaimId,
  documentClaimTime,
  findDocumentClient,
  findRegisteredClient,
  insertRegisteredClient,
  REGISTERED_CLIENT_ID_PREFIX,
  updateDocumentClient,
  type DocumentClientRecord,
  type RegistrationEventKind,
  type RegistrationLimits
} from './store.js';

export { createRegistrationSchema } from './store.js';

export const OAUTH_REGISTRATION_PATH = '/oauth/register';

const MAX_REGISTRATION_BODY_BYTES = 64 * 1024;
const DEFAULT_LIMITS: RegistrationLimits = { perIp: 20, global: 200, windowSeconds: 3600 };
/**
 * A metadata document is refetched at most once per 5 minutes across all
 * instances, and kept in memory for up to 1000 clients per process.
 */
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
 * registration.
 *
 * The first fetch of an unknown `client_id` counts toward the registration
 * rate limit, and its usable document is stored. A known client is refetched
 * at most once per 5 minutes across all instances, outside that limit, so
 * flooding refuses only new clients and known clients still pick up changed
 * documents. When its host gives no usable answer (network error, timeout,
 * 5xx, 408 or 429), a known client keeps its stored document; any other
 * answer that is not a usable document makes it unknown and drops the row.
 */
export function withClientRegistration(runtime: OAuthProviderRuntime): OAuthProviderRuntime {
  const documents = new Map<string, { client: OAuthProviderClient; expiresAt: number }>();
  const pending = new Map<string, Promise<OAuthProviderClient | undefined>>();
  const fetchDocument = (clientId: string) => fetchMetadataDocument(runtime.config.registration?.fetch ?? fetch, clientId);

  const resolveDocumentClient = (clientId: string, request: Request) => {
    const cached = documents.get(clientId);
    if (cached && cached.expiresAt > runtime.now().getTime()) {
      return Promise.resolve(cached.client);
    }
    // Concurrent requests for one document share a single load.
    let loading = pending.get(clientId);
    if (!loading) {
      loading = loadDocumentClient(clientId, request).finally(() => pending.delete(clientId));
      pending.set(clientId, loading);
    }
    return loading;
  };

  const remember = (clientId: string, client: OAuthProviderClient, expiresAt: number) => {
    if (documents.size >= DOCUMENT_CACHE_ENTRIES) {
      documents.delete(documents.keys().next().value!);
    }
    documents.set(clientId, { client, expiresAt });
    return client;
  };

  const loadDocumentClient = async (clientId: string, request: Request) => {
    documents.delete(clientId);
    const stored = await findDocumentClient(runtime.store, clientId);
    return stored ? loadKnownClient(stored) : loadNewClient(clientId, request);
  };

  const loadKnownClient = async (stored: DocumentClientRecord) => {
    const clientId = stored.id;
    const known = publicClient(clientId, stored.name, stored.redirectUris);
    const now = runtime.now();
    // Another request claimed the refetch within 5 minutes: use the stored
    // document until that claim runs out.
    const claimedUntil = documentClaimTime(stored.claimId) + DOCUMENT_CACHE_MS;
    if (claimedUntil > now.getTime() || !await claimDocumentRefetch(runtime.store, clientId, now, DOCUMENT_CACHE_MS)) {
      return remember(clientId, known, Math.max(claimedUntil, now.getTime() + 1000));
    }
    const expiresAt = now.getTime() + DOCUMENT_CACHE_MS;
    const fetched = await fetchDocument(clientId);
    if (fetched.status === 'unavailable') {
      return remember(clientId, known, expiresAt);
    }
    const metadata = fetched.status === 'ok' ? readDocumentMetadata(clientId, fetched.document) : undefined;
    if (!metadata) {
      await deleteDocumentClient(runtime.store, clientId);
      return undefined;
    }
    await updateDocumentClient(runtime.store, { id: clientId, name: metadata.name ?? null, redirectUris: metadata.redirectUris, fetchedAt: now });
    return remember(clientId, publicClient(clientId, metadata.name, metadata.redirectUris), expiresAt);
  };

  const loadNewClient = async (clientId: string, request: Request) => {
    await admit(runtime, request, 'document');
    const now = runtime.now();
    const fetched = await fetchDocument(clientId);
    const metadata = fetched.status === 'ok' ? readDocumentMetadata(clientId, fetched.document) : undefined;
    if (!metadata) {
      return undefined;
    }
    await createDocumentClient(runtime.store, {
      id: clientId,
      name: metadata.name ?? null,
      redirectUris: metadata.redirectUris,
      fetchedAt: now,
      // This fetch is the client's refetch for the next 5 minutes.
      claimId: documentClaimId(now)
    });
    return remember(clientId, publicClient(clientId, metadata.name, metadata.redirectUris), now.getTime() + DOCUMENT_CACHE_MS);
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
    const parsed = await readCappedJson(request.body.getReader(), MAX_REGISTRATION_BODY_BYTES);
    if (parsed) {
      return parsed.value;
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
