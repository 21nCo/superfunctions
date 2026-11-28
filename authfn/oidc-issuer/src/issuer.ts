import type { JwksKey, SigningKeyRing } from '@secfn/keys';
import { describeName, OidcIssuerError, type OidcIssuerErrorCode } from './errors.js';

/** Upper bound, in seconds, on the lifetime of a minted ID token (`exp - iat`). */
export const MAX_ID_TOKEN_TTL_SECONDS = 3600;

/** Lifetime, in seconds, used when neither `defaultTtl` nor a per-token `ttl` is given. */
export const DEFAULT_ID_TOKEN_TTL_SECONDS = 300;

/** `Cache-Control` value of the discovery and JWKS responses. */
export const OIDC_CACHE_CONTROL = 'public, max-age=300';

/** Registered claims the issuer sets on every token; `claims` may not name them. */
export const RESERVED_CLAIMS: readonly string[] = Object.freeze(['iss', 'sub', 'aud', 'iat', 'nbf', 'exp', 'jti']);

const RESERVED_CLAIM_SET: ReadonlySet<string> = new Set(RESERVED_CLAIMS);
const DISCOVERY_SUFFIX = '/.well-known/openid-configuration';
const DEFAULT_JWKS_SUFFIX = '/.well-known/jwks.json';
const MAX_SUBJECT_LENGTH = 255;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const CLAIM_NAME = /^[\x21-\x7E]+$/;
/** JWK members that only a private or symmetric key carries (RFC 7518 §6.2.2, §6.3.2, §6.4). */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/** The key ring members the issuer uses. A `SigningKeyRing` from `@secfn/keys` satisfies it. */
export type OidcKeyRing = Pick<SigningKeyRing, 'activeKid' | 'sign' | 'jwks'>;

export interface OidcIssuerOptions {
  /**
   * The issuer identifier, published as `issuer` and signed as `iss`: an absolute `https` URL with no query, fragment
   * or user info, written in its canonical form (lowercase scheme and host, no default port, no dot segments).
   */
  readonly issuer: string;
  /**
   * Signs tokens and supplies the published keys. It is read once, here: rotating keys means building a new key ring
   * and a new issuer, so the JWKS served always matches the key that signs.
   */
  readonly keyRing: OidcKeyRing;
  /** Lifetime in whole seconds of a token minted without `ttl`; 1 to `MAX_ID_TOKEN_TTL_SECONDS`. Defaults to 300. */
  readonly defaultTtl?: number;
  /** Published `jwks_uri`: an absolute `https` URL with no fragment. Defaults to `<issuer>/.well-known/jwks.json`. */
  readonly jwksUri?: string;
  /** Names of custom claims to list in `claims_supported` after the registered ones. */
  readonly claimsSupported?: readonly string[];
  /** Current time in milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface MintIdTokenInput {
  /** Subject identifier: 1 to 255 printable ASCII characters, without leading or trailing spaces. */
  readonly sub: string;
  /** One audience, or a non-empty list of distinct audiences. */
  readonly aud: string | readonly string[];
  /** Lifetime in whole seconds, 1 to `MAX_ID_TOKEN_TTL_SECONDS`. Defaults to the issuer's `defaultTtl`. */
  readonly ttl?: number;
  /** Additional claims: a JSON-serializable plain object that names none of `RESERVED_CLAIMS`. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/** The OpenID Provider metadata this issuer publishes (OpenID Connect Discovery 1.0 §3). */
export interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly jwks_uri: string;
  readonly response_types_supported: readonly ['id_token'];
  readonly subject_types_supported: readonly ['public'];
  readonly id_token_signing_alg_values_supported: readonly ['ES256'];
  readonly claims_supported: readonly string[];
}

export interface OidcIssuer {
  readonly issuer: string;
  readonly jwksUri: string;
  /** `<issuer>/.well-known/openid-configuration`, where `discoveryHandler` is expected to be mounted. */
  readonly discoveryUrl: string;
  /** The published metadata, as `discoveryHandler` serves it. */
  readonly discovery: OidcDiscoveryDocument;
  /** Serves the discovery document for GET and HEAD; any other method gets 405. It does not route by path. */
  discoveryHandler(request: Request): Response;
  /** Serves the JWK Set of the key ring's published keys for GET and HEAD; any other method gets 405. */
  jwksHandler(request: Request): Response;
  /** Mints an ES256 ID token signed by the key ring's active key. */
  mintIdToken(input: MintIdTokenInput): Promise<string>;
}

/**
 * Creates a framework-neutral OpenID Connect issuer: the discovery document and JWKS as `Request → Response`
 * handlers, and an ID-token minter. Every option is validated and read once, here.
 */
export function createOidcIssuer(options: OidcIssuerOptions): OidcIssuer {
  if (!isRecord(options)) throw new OidcIssuerError('invalid-options', 'createOidcIssuer needs an options object');
  const { issuer, keyRing, defaultTtl, jwksUri: jwksUriOption, claimsSupported, now: nowOption } = options;
  checkIssuer(issuer);
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const jwksUri = jwksUriOption === undefined ? `${base}${DEFAULT_JWKS_SUFFIX}` : checkJwksUri(jwksUriOption);
  const lifetime = defaultTtl === undefined ? DEFAULT_ID_TOKEN_TTL_SECONDS : checkTtl(defaultTtl, 'invalid-options', 'defaultTtl');
  if (nowOption !== undefined && typeof nowOption !== 'function') {
    throw new OidcIssuerError('invalid-options', 'now must be a function returning milliseconds since the epoch');
  }
  const now = nowOption ?? Date.now;

  if (!isRecord(keyRing)) throw new OidcIssuerError('invalid-options', 'keyRing must be a signing key ring');
  const { activeKid, sign, jwks } = keyRing;
  if (typeof activeKid !== 'string' || activeKid === '' || typeof sign !== 'function' || typeof jwks !== 'function') {
    throw new OidcIssuerError('invalid-options', 'keyRing needs an activeKid, a sign function and a jwks function');
  }
  const jwksBody = JSON.stringify({ keys: publishedKeys(() => Reflect.apply(jwks, keyRing, []), activeKid) });
  const signToken = (payload: string): Promise<string> => Reflect.apply(sign, keyRing, [{ typ: 'JWT' }, payload]);

  const discovery: OidcDiscoveryDocument = deepFreeze({
    issuer,
    jwks_uri: jwksUri,
    response_types_supported: ['id_token'] as const,
    subject_types_supported: ['public'] as const,
    id_token_signing_alg_values_supported: ['ES256'] as const,
    claims_supported: supportedClaims(claimsSupported),
  });

  const mintIdToken = async (input: MintIdTokenInput): Promise<string> => {
    if (!isRecord(input)) throw new OidcIssuerError('invalid-options', 'mintIdToken needs an input object');
    const { sub, aud, ttl, claims } = input;
    checkSubject(sub);
    const audience = checkAudience(aud);
    const seconds = ttl === undefined ? lifetime : checkTtl(ttl, 'invalid-ttl', 'ttl');
    const custom = snapshotClaims(claims);
    const millis: unknown = now();
    if (typeof millis !== 'number' || !Number.isFinite(millis) || millis < 0) {
      throw new OidcIssuerError('invalid-options', 'now() must return a non-negative finite number of milliseconds');
    }
    const iat = Math.floor(millis / 1000);
    // The registered claims are written last, so even a reserved name that slipped past the checks cannot replace them.
    const payload = { ...custom, iss: issuer, sub, aud: audience, iat, nbf: iat, exp: iat + seconds, jti: crypto.randomUUID() };
    return signToken(JSON.stringify(payload));
  };

  return Object.freeze({
    issuer,
    jwksUri,
    discoveryUrl: `${base}${DISCOVERY_SUFFIX}`,
    discovery,
    discoveryHandler: jsonHandler(JSON.stringify(discovery)),
    jwksHandler: jsonHandler(jwksBody),
    mintIdToken,
  });
}

function jsonHandler(body: string): (request: Request) => Response {
  return (request: Request): Response => {
    const method: unknown = isRecord(request) ? request.method : undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
    }
    return new Response(method === 'HEAD' ? null : body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': OIDC_CACHE_CONTROL },
    });
  };
}

/** Rejects anything but an absolute https URL given in canonical form, so `iss` matches `issuer` byte for byte. */
function checkIssuer(issuer: unknown): asserts issuer is string {
  const url = parseHttpsUrl(issuer, 'issuer');
  if (url.search !== '' || (issuer as string).includes('?')) {
    throw new OidcIssuerError('invalid-options', 'issuer must not have a query component');
  }
  const canonical = url.href;
  if (issuer !== canonical && !(url.pathname === '/' && `${issuer as string}/` === canonical)) {
    throw new OidcIssuerError('invalid-options', 'issuer must be written in canonical URL form (lowercase scheme and host, no default port)');
  }
}

function checkJwksUri(value: unknown): string {
  return parseHttpsUrl(value, 'jwksUri').href;
}

function parseHttpsUrl(value: unknown, label: string): URL {
  if (typeof value !== 'string' || value === '') throw new OidcIssuerError('invalid-options', `${label} must be an absolute https URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcIssuerError('invalid-options', `${label} must be an absolute https URL`);
  }
  if (url.protocol !== 'https:') throw new OidcIssuerError('invalid-options', `${label} must use the https scheme`);
  if (url.hash !== '' || value.includes('#')) throw new OidcIssuerError('invalid-options', `${label} must not have a fragment`);
  if (url.username !== '' || url.password !== '') {
    throw new OidcIssuerError('invalid-options', `${label} must not carry user info`);
  }
  return url;
}

function checkTtl(value: unknown, code: OidcIssuerErrorCode, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_ID_TOKEN_TTL_SECONDS) {
    throw new OidcIssuerError(code, `${label} must be a whole number of seconds from 1 to ${MAX_ID_TOKEN_TTL_SECONDS}`);
  }
  return value;
}

function checkSubject(sub: unknown): asserts sub is string {
  if (typeof sub !== 'string' || sub.length > MAX_SUBJECT_LENGTH || !PRINTABLE_ASCII.test(sub) || sub.trim() !== sub) {
    throw new OidcIssuerError(
      'invalid-subject',
      `sub must be 1 to ${MAX_SUBJECT_LENGTH} printable ASCII characters without leading or trailing spaces`,
    );
  }
}

function checkAudience(aud: unknown): string | string[] {
  if (typeof aud === 'string') {
    if (aud === '') throw new OidcIssuerError('invalid-audience', 'aud must not be empty');
    return aud;
  }
  if (!Array.isArray(aud) || aud.length === 0) {
    throw new OidcIssuerError('invalid-audience', 'aud must be a non-empty string or a non-empty array of strings');
  }
  const audiences = [...(aud as readonly unknown[])];
  if (!audiences.every((value): value is string => typeof value === 'string' && value !== '')) {
    throw new OidcIssuerError('invalid-audience', 'every aud entry must be a non-empty string');
  }
  if (new Set(audiences).size !== audiences.length) throw new OidcIssuerError('invalid-audience', 'aud entries must be distinct');
  return audiences;
}

/**
 * Serializes the caller's claims once and validates that serialization, so a `toJSON` method or getter cannot add a
 * reserved claim after the check. A reserved name is also refused when its value would serialize away (`undefined`).
 */
function snapshotClaims(claims: unknown): Record<string, unknown> {
  if (claims === undefined) return {};
  if (!isRecord(claims) || Array.isArray(claims) || !isPlainPrototype(claims)) {
    throw new OidcIssuerError('invalid-claims', 'claims must be a plain object');
  }
  for (const name of Object.keys(claims)) rejectReserved(name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(JSON.stringify(claims));
  } catch {
    throw new OidcIssuerError('invalid-claims', 'claims must be JSON-serializable');
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) throw new OidcIssuerError('invalid-claims', 'claims must serialize to a JSON object');
  for (const name of Object.keys(parsed)) {
    rejectReserved(name);
    if (name === '__proto__') throw new OidcIssuerError('invalid-claims', 'claims must not name __proto__');
  }
  return parsed;
}

function rejectReserved(name: string): void {
  if (RESERVED_CLAIM_SET.has(name)) {
    throw new OidcIssuerError('reserved-claim', `claim ${describeName(name)} is set by the issuer and cannot be overridden`);
  }
}

function supportedClaims(extra: unknown): string[] {
  if (extra === undefined) return [...RESERVED_CLAIMS];
  if (!Array.isArray(extra)) throw new OidcIssuerError('invalid-options', 'claimsSupported must be an array of claim names');
  const names = new Set(RESERVED_CLAIMS);
  for (const name of extra as readonly unknown[]) {
    if (typeof name !== 'string' || !CLAIM_NAME.test(name)) {
      throw new OidcIssuerError('invalid-options', 'claimsSupported entries must be non-empty claim names without spaces');
    }
    names.add(name);
  }
  return [...names];
}

/**
 * Copies only the public members of each published key, once, at construction. The active key must be published, so
 * every token the issuer mints verifies against the JWKS it serves.
 */
function publishedKeys(readJwks: () => unknown, activeKid: string): JwksKey[] {
  let jwks: unknown;
  try {
    jwks = readJwks();
  } catch {
    throw new OidcIssuerError('invalid-options', 'keyRing.jwks() failed');
  }
  const keys: unknown = isRecord(jwks) ? jwks.keys : undefined;
  if (!Array.isArray(keys)) throw new OidcIssuerError('invalid-options', 'keyRing.jwks() must return a JWK Set');
  const published = (keys as readonly unknown[]).map((key): JwksKey => {
    if (!isRecord(key)) throw new OidcIssuerError('invalid-options', 'keyRing.jwks() returned a key that is not an object');
    const { kty, crv, x, y, kid, alg, use } = key;
    const kidLabel = typeof kid === 'string' ? `key ${describeName(kid)}` : 'a published key';
    if (PRIVATE_JWK_MEMBERS.some((member) => Object.hasOwn(key, member))) {
      throw new OidcIssuerError('invalid-options', `${kidLabel} carries private key members`);
    }
    if (
      kty !== 'EC' ||
      crv !== 'P-256' ||
      typeof x !== 'string' ||
      x === '' ||
      typeof y !== 'string' ||
      y === '' ||
      typeof kid !== 'string' ||
      kid === '' ||
      (alg !== undefined && alg !== 'ES256') ||
      (use !== undefined && use !== 'sig')
    ) {
      throw new OidcIssuerError('invalid-options', `${kidLabel} is not an ES256 P-256 signing key with a kid`);
    }
    return { kty: 'EC', crv: 'P-256', x, y, kid, alg: 'ES256', use: 'sig' };
  });
  const kids = new Set(published.map((key) => key.kid));
  if (kids.size !== published.length) throw new OidcIssuerError('invalid-options', 'keyRing.jwks() lists a kid more than once');
  if (!kids.has(activeKid)) {
    throw new OidcIssuerError('invalid-options', `keyRing.jwks() does not publish the active kid ${describeName(activeKid)}`);
  }
  return published;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
}

function deepFreeze<T>(value: T): T {
  if (isRecord(value)) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}
