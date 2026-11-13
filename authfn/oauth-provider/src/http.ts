import { createHash, timingSafeEqual } from 'node:crypto';
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
  | 'invalid_token';

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

/** Constant-time comparison of two secrets of any length. */
export function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest()
  );
}

function clientAuthMethod(client: OAuthProviderClient): string {
  return client.tokenEndpointAuthMethod ?? (client.clientSecret ? 'client_secret_basic' : 'none');
}

/**
 * Authenticates the client at the token or revocation endpoint (RFC 6749
 * 2.3.1). A public client sends only `client_id`; a confidential client uses
 * the method it is registered with. Failures are `invalid_client`.
 */
export function authenticateClient(
  runtime: OAuthProviderRuntime,
  request: Request,
  params: Map<string, string>
): OAuthProviderClient {
  const basic = readBasicCredentials(request);
  const bodyId = params.get('client_id');
  const clientId = basic?.clientId ?? bodyId;
  if (!clientId || (basic && bodyId !== undefined && bodyId !== basic.clientId)) {
    throw invalidClient(basic !== null);
  }

  const client = runtime.findClient(clientId);
  if (!client) {
    throw invalidClient(basic !== null);
  }

  const method = clientAuthMethod(client);
  const presented = method === 'client_secret_basic'
    ? basic?.clientSecret
    : method === 'client_secret_post' ? params.get('client_secret') : undefined;
  const sentOtherCredential = method === 'client_secret_basic'
    ? params.has('client_secret')
    : basic !== null || (method === 'none' && params.has('client_secret'));
  if (sentOtherCredential) {
    throw invalidClient(basic !== null);
  }
  if (method !== 'none' && (!presented || !client.clientSecret || !secretsEqual(presented, client.clientSecret))) {
    throw invalidClient(basic !== null);
  }

  return client;
}

function invalidClient(viaHeader: boolean): OAuthError {
  return new OAuthError(
    'invalid_client',
    'Client authentication failed',
    401,
    viaHeader ? { 'www-authenticate': 'Basic realm="oauth"' } : {}
  );
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
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')?.trim();
  if (!header || !/^bearer /i.test(header)) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}
