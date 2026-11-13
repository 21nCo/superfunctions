/**
 * Minimal AWS Signature Version 4 signer for the S3 API, built on Web Crypto so
 * it runs unchanged on Cloudflare Workers, Node.js 20+ and browsers.
 *
 * S3 rules apply: the canonical URI is the request path encoded once (never
 * normalized or double-encoded), and the payload hash is either the hex SHA-256
 * of the body, `UNSIGNED-PAYLOAD`, or the empty-body hash.
 */

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const encoder = new TextEncoder();

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigV4Scope {
  region: string;
  service: string;
}

export interface SigV4Request {
  method: string;
  /** Absolute URL whose pathname is already S3-encoded (see `encodeS3Key`). */
  url: string;
  /** Header names are matched case-insensitively. `host` is derived from the URL. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body, `UNSIGNED-PAYLOAD`, or omitted for an empty body. */
  payloadHash?: string;
}

/** RFC 3986 percent-encoding as SigV4 requires: only unreserved characters stay literal. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Encode an object key for a URL path, keeping `/` separators literal. */
export function encodeS3Key(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

/** `YYYYMMDDTHHMMSSZ`, the SigV4 timestamp format. */
export function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([aName, aValue], [bName, bValue]) =>
      aName < bName ? -1 : aName > bName ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0
    )
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function canonicalHeaders(url: URL, headers: Record<string, string>): {
  canonical: string;
  signedHeaders: string;
} {
  const merged = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    merged.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
  }
  merged.set('host', url.host);
  const names = [...merged.keys()].sort();
  return {
    canonical: names.map((name) => `${name}:${merged.get(name)}\n`).join(''),
    signedHeaders: names.join(';'),
  };
}

async function computeSignature(
  credentials: SigV4Credentials,
  scope: SigV4Scope,
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
  amzDate: string
): Promise<{ signature: string; signedHeaders: string; credentialScope: string }> {
  const date = amzDate.slice(0, 8);
  const credentialScope = `${date}/${scope.region}/${scope.service}/aws4_request`;
  const { canonical, signedHeaders } = canonicalHeaders(url, headers);
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname || '/',
    canonicalQuery(url.searchParams),
    canonical,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [ALGORITHM, amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

  let key: ArrayBuffer = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), date);
  key = await hmac(key, scope.region);
  key = await hmac(key, scope.service);
  key = await hmac(key, 'aws4_request');
  const signature = toHex(await hmac(key, stringToSign));
  return { signature, signedHeaders, credentialScope };
}

/**
 * Sign a request with an `Authorization` header. Returns the headers to send:
 * the caller's headers plus `x-amz-date`, `x-amz-content-sha256` and
 * `authorization`.
 */
export async function signRequest(
  credentials: SigV4Credentials,
  scope: SigV4Scope,
  request: SigV4Request,
  now: Date = new Date()
): Promise<Record<string, string>> {
  const url = new URL(request.url);
  const payloadHash = request.payloadHash ?? EMPTY_PAYLOAD_SHA256;
  const amzDate = toAmzDate(now);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  delete headers.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = payloadHash;

  const { signature, signedHeaders, credentialScope } = await computeSignature(
    credentials,
    scope,
    request.method,
    url,
    headers,
    payloadHash,
    amzDate
  );
  headers.authorization =
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

/**
 * Presign a URL (query-string authentication). Headers passed here are signed
 * and must be sent unchanged by whoever uses the URL; `host` is always signed.
 */
export async function presignUrl(
  credentials: SigV4Credentials,
  scope: SigV4Scope,
  request: Omit<SigV4Request, 'payloadHash'> & { expiresInSeconds: number },
  now: Date = new Date()
): Promise<string> {
  const url = new URL(request.url);
  const amzDate = toAmzDate(now);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  delete headers.host;
  const signedHeaders = [...new Set(['host', ...Object.keys(headers)])].sort().join(';');
  const credentialScope = `${amzDate.slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`;

  url.searchParams.set('X-Amz-Algorithm', ALGORITHM);
  url.searchParams.set('X-Amz-Credential', `${credentials.accessKeyId}/${credentialScope}`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(request.expiresInSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);

  const { signature } = await computeSignature(
    credentials,
    scope,
    request.method,
    url,
    headers,
    UNSIGNED_PAYLOAD,
    amzDate
  );
  // Rebuild the query with SigV4 encoding so the URL carries exactly the
  // canonical query that was signed (URLSearchParams encodes spaces as `+`).
  const query = canonicalQuery(url.searchParams);
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`;
}
