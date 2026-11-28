/**
 * Shared by the Node and workerd suites, so WebCrypto only. Every key is
 * generated at run time; no key material is committed.
 */

export interface TestAppKeys {
  readonly pkcs8Pem: string;
  readonly pkcs1Pem: string;
  readonly publicKey: CryptoKey;
}

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function pem(label: string, der: Uint8Array): string {
  const lines = toBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** Reads one DER element header at `offset`: its tag, content offset and content length. */
function readElement(der: Uint8Array, offset: number): { tag: number; start: number; length: number } {
  const tag = der[offset]!;
  let length = der[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + der[start + i]!;
    start += count;
  }
  return { tag, start, length };
}

/**
 * Extracts the PKCS#1 `RSAPrivateKey` from a PKCS#8 `PrivateKeyInfo`, an
 * independent DER walk (not the code under test) used to build PKCS#1 vectors.
 */
export function pkcs8ToPkcs1(pkcs8: Uint8Array): Uint8Array {
  const outer = readElement(pkcs8, 0);
  if (outer.tag !== 0x30) throw new Error('not a SEQUENCE');
  const version = readElement(pkcs8, outer.start);
  const algorithm = readElement(pkcs8, version.start + version.length);
  const key = readElement(pkcs8, algorithm.start + algorithm.length);
  if (key.tag !== 0x04) throw new Error('no OCTET STRING');
  return pkcs8.slice(key.start, key.start + key.length);
}

export async function generateTestAppKeys(): Promise<TestAppKeys> {
  const pair = (await crypto.subtle.generateKey(
    { ...ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  return {
    pkcs8Pem: pem('PRIVATE KEY', pkcs8),
    pkcs1Pem: pem('RSA PRIVATE KEY', pkcs8ToPkcs1(pkcs8)),
    publicKey: pair.publicKey,
  };
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface DecodedJwt {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly valid: boolean;
}

/** Decodes a compact JWS and verifies its RS256 signature with `publicKey`. */
export async function verifyJwt(jwt: string, publicKey: CryptoKey): Promise<DecodedJwt> {
  const [header, claims, signature] = jwt.split('.');
  const decoder = new TextDecoder();
  const valid = await crypto.subtle.verify(
    ALGORITHM,
    publicKey,
    fromBase64Url(signature!),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return {
    header: JSON.parse(decoder.decode(fromBase64Url(header!))) as Record<string, unknown>,
    claims: JSON.parse(decoder.decode(fromBase64Url(claims!))) as Record<string, unknown>,
    valid,
  };
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/**
 * A recorded GitHub response, or a thrown network error. `bodyThrows` makes
 * reading the body fail after the status arrived (a connection reset mid-body).
 */
export type RecordedResponse =
  | { readonly status: number; readonly body?: unknown; readonly bodyThrows?: Error }
  | { readonly throws: Error };

/** A `fetch` that replays recorded responses in order and records every request. */
export function recordingFetch(responses: RecordedResponse[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fake = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : undefined });
    const next = queue.shift();
    if (!next) throw new Error('No recorded response left');
    if ('throws' in next) throw next.throws;
    const body = next.body === undefined ? null : typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    const response = new Response(next.status === 204 ? null : body, { status: next.status, headers: { 'content-type': 'application/json' } });
    const bodyError = next.bodyThrows;
    if (bodyError) Object.defineProperty(response, 'text', { value: () => Promise.reject(bodyError) });
    return response;
  };
  return { fetch: fake as typeof fetch, calls };
}

/** Obviously fake installation tokens, built at run time. */
export function fakeInstallationToken(n: number): string {
  return ['test', 'installation', 'token', String(n)].join('-');
}

export const NOW_MS = Date.UTC(2026, 10, 28, 12, 0, 0);
export const NOW_SECONDS = NOW_MS / 1000;
export const EXPIRES_AT = '2026-11-28T13:00:00Z';

/**
 * Recorded `POST /app/installations/{id}/access_tokens` 201 body, in the shape
 * GitHub documents for REST API version 2022-11-28, with a fake token.
 */
export function recordedAccessToken(token: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token,
    expires_at: EXPIRES_AT,
    permissions: { contents: 'read', issues: 'write' },
    repository_selection: 'selected',
    repositories: [
      { id: 1, name: 'app', full_name: 'example-org/app', private: true },
      { id: 2, name: 'lib', full_name: 'example-org/lib', private: true },
    ],
    ...overrides,
  };
}

/** Recorded GitHub error bodies for the statuses the minter maps. */
export const RECORDED_ERRORS = {
  401: { message: 'A JSON web token could not be decoded', documentation_url: 'https://docs.github.com/rest', status: '401' },
  404: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/apps/apps#create-an-installation-access-token-for-an-app', status: '404' },
  422: {
    message: 'There is at least one repository that does not exist or is not accessible to the parent installation.',
    documentation_url: 'https://docs.github.com/rest/apps/apps#create-an-installation-access-token-for-an-app',
    status: '422',
  },
  revoked401: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' },
} as const;
