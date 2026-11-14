import { timingSafeEqual } from 'node:crypto';
import type { OAuthProviderClient } from './types.js';
import type { OAuthProviderRuntime } from './runtime.js';

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'invalid_token'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'temporarily_unavailable';

/** An OAuth protocol error, rendered as RFC 6749 5.2 JSON or an error redirect. */
export class OAuthError extends Error {
  constructor(
    readonly error: OAuthErrorCode,
    readonly description: string,
    readonly status: number = error === 'invalid_client' || error === 'invalid_token' ? 401 : 400,
    readonly headers: Record<string, string> = {}
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...NO_STORE, ...headers }
  });
}

export function oauthErrorResponse(error: OAuthError): Response {
  return oauthJson(
    { error: error.error, error_description: error.description },
    error.status,
    error.headers
  );
}

/** Runs an endpoint body, rendering OAuth errors as RFC 6749 5.2 responses. */
export async function handleOAuth(body: () => Promise<Response>): Promise<Response> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof OAuthError) {
      return oauthErrorResponse(error);
    }
    throw error;
  }
}

/**
 * Reads a single-valued parameter set. A parameter sent more than once is an
 * `invalid_request` (RFC 6749 3.1, 3.2).
 */
export function readSingleParams(params: URLSearchParams): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of params) {
    if (values.has(name)) {
      throw new OAuthError('invalid_request', `Parameter ${name} must not be repeated`);
    }
    values.set(name, value);
  }
  return values;
}

/** Reads an `application/x-www-form-urlencoded` POST body (RFC 6749 3.2). */
export async function readFormBody(request: Request): Promise<Map<string, string>> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new OAuthError('invalid_request', 'Request body must be application/x-www-form-urlencoded');
  }
  return readSingleParams(new URLSearchParams(await request.text()));
}

export function requireParam(params: Map<string, string>, name: string): string {
  const value = params.get(name);
  if (!value) {
    throw new OAuthError('invalid_request', `Parameter ${name} is required`);
  }
  return value;
}

/** Compares two secrets in time that depends only on their lengths. */
export function secretsEqual(actual: string, expected: string): boolean {
  const presented = Buffer.from(actual, 'utf8');
  const stored = Buffer.from(expected, 'utf8');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

function clientAuthMethod(client: OAuthProviderClient): string {
  return client.tokenEndpointAuthMethod ?? (client.clientSecret ? 'client_secret_basic' : 'none');
}

/**
 * Authenticates the client at the token or revocation endpoint (RFC 6749
 * 2.3.1). A public client sends only `client_id`; a confidential client uses
 * the method it is registered with. Failures are `invalid_client`.
 */
export async function authenticateClient(
  runtime: OAuthProviderRuntime,
  request: Request,
  params: Map<string, string>
): Promise<OAuthProviderClient> {
  const basic = readBasicCredentials(request);
  // Any Authorization header is an attempt to authenticate with it (RFC 6749 5.2).
  const viaHeader = request.headers.has('authorization');
  const bodyId = params.get('client_id');
  const clientId = basic?.clientId ?? bodyId;
  if (!clientId || (basic && bodyId !== undefined && bodyId !== basic.clientId)) {
    throw invalidClient(viaHeader);
  }

  const client = await runtime.resolveClient(clientId, request);
  if (!client) {
    throw invalidClient(viaHeader);
  }

  const method = clientAuthMethod(client);
  let presented: string | undefined;
  if (method === 'client_secret_basic') {
    presented = basic?.clientSecret;
  } else if (method === 'client_secret_post') {
    presented = params.get('client_secret');
  }
  // A client not registered for Basic must not send an Authorization header
  // of any scheme, parsable or not (RFC 6749 2.3: one method per request).
  const sentOtherCredential = method === 'client_secret_basic'
    ? params.has('client_secret')
    : viaHeader || (method === 'none' && params.has('client_secret'));
  if (sentOtherCredential) {
    throw invalidClient(viaHeader);
  }
  if (method !== 'none' && (!presented || !client.clientSecret || !secretsEqual(presented, client.clientSecret))) {
    throw invalidClient(viaHeader);
  }

  return client;
}

/**
 * RFC 6749 5.2: 401 with a Basic challenge when the client tried the
 * Authorization header; otherwise 400, without a challenge.
 */
function invalidClient(viaHeader: boolean): OAuthError {
  return viaHeader
    ? new OAuthError('invalid_client', 'Client authentication failed', 401, { 'www-authenticate': 'Basic realm="oauth"' })
    : new OAuthError('invalid_client', 'Client authentication failed', 400);
}

function readBasicCredentials(request: Request): { clientId: string; clientSecret: string } | null {
  const header = request.headers.get('authorization')?.trim();
  if (!header || !/^basic /i.test(header)) {
    return null;
  }

  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0) {
    throw invalidClient(true);
  }

  // RFC 6749 2.3.1: both halves are form-urlencoded before Basic encoding.
  try {
    return {
      clientId: formDecode(decoded.slice(0, separator)),
      clientSecret: formDecode(decoded.slice(separator + 1))
    };
  } catch {
    throw invalidClient(true);
  }
}

function formDecode(value: string): string {
  return decodeURIComponent(value.replaceAll('+', ' '));
}

/** RFC 6750 2.1 `b64token`; the classes are disjoint, so matching is linear. */
const BEARER_CREDENTIAL = /^[A-Za-z0-9\-._~+/]+=*$/;

export function isBearerCredential(value: string): boolean {
  return BEARER_CREDENTIAL.test(value);
}

/** The credential of an `Authorization: Bearer 1*SP <b64token>` header (RFC 6750 2.1), or null. */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')?.trim() ?? '';
  const scheme = /^bearer +/i.exec(header);
  const token = scheme ? header.slice(scheme[0].length) : '';
  return isBearerCredential(token) ? token : null;
}
