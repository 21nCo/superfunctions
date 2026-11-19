import { base64UrlDecode, base64UrlEncode, copyBytes, utf8Decode, utf8Encode } from './encoding.js';
import { describeKid, KeyRingError } from './errors.js';
import { ECDSA_SHA256, ES256, type Es256PublicJwk, importPublicKey, isRecord, type Jwks, type JwksKey, P256_FIELD_BYTES, toPublicJwk } from './jwk.js';
import type { Es256Signer } from './signer.js';

/**
 * Rotation stage of a key:
 * - `active` signs new tokens, verifies and is published (exactly one per ring);
 * - `verify-only` is published and verifies tokens it signed earlier, but never signs;
 * - `retired` is neither published nor accepted: a token naming it fails verification.
 */
export type KeyStatus = 'active' | 'verify-only' | 'retired';

const KEY_STATUSES: ReadonlySet<string> = new Set<KeyStatus>(['active', 'verify-only', 'retired']);

export interface SigningKeyEntry {
  readonly kid: string;
  readonly alg: 'ES256';
  readonly status: KeyStatus;
  /** Required for `active` and `verify-only` keys; optional for a `retired` key, which is never used. */
  readonly signer?: Es256Signer;
}

export interface SigningKeyRingOptions {
  readonly keys: readonly SigningKeyEntry[];
}

/** JOSE protected header. `alg` and `kid` are set by the ring; when given they must equal ES256 and the active kid. */
export interface JwsHeader {
  readonly alg?: string;
  readonly kid?: string;
  readonly typ?: string;
  readonly cty?: string;
  readonly [parameter: string]: unknown;
}

/** Payload bytes, a UTF-8 string, or a JSON value (object or array) that is serialized with `JSON.stringify`. */
export type JwsPayload = Uint8Array | string | Record<string, unknown> | readonly unknown[];

export interface VerifiedJws {
  readonly kid: string;
  readonly header: Readonly<Record<string, unknown>>;
  /** The payload bytes as signed. */
  readonly payload: Uint8Array;
}

export interface SigningKeyRing {
  readonly activeKid: string;
  /** Signs a compact JWS (RFC 7515 §7.1) with the active key; the protected header always carries `alg` and `kid`. */
  sign(header: JwsHeader, payload: JwsPayload): Promise<string>;
  /** Verifies a compact JWS against the active and verify-only keys; throws `KeyRingError` when it does not. */
  verify(jws: string): Promise<VerifiedJws>;
  /** The public JWK Set of the active and verify-only keys, without private members. Each call returns a new copy. */
  jwks(): Jwks;
}

interface RingKey {
  readonly kid: string;
  readonly status: KeyStatus;
  readonly signer: Es256Signer | undefined;
  readonly publicJwk: Es256PublicJwk | undefined;
}

/** Upper bound on the compact JWS length `verify` parses, so an oversized input fails before any decoding. */
const MAX_JWS_LENGTH = 256 * 1024;

/**
 * Creates an ES256 key ring for staged rotation. The key set is validated here, before any key is used: exactly
 * one `active` key, unique kids, ES256 only, and each signer's own `kid` (if any) equal to its entry's.
 */
export function createSigningKeyRing(options: SigningKeyRingOptions): SigningKeyRing {
  if (!isRecord(options) || !Array.isArray(options.keys) || options.keys.length === 0) {
    throw new KeyRingError('invalid-options', 'createSigningKeyRing needs a non-empty keys array');
  }
  const ring = new Map<string, RingKey>();
  for (const [index, entry] of (options.keys as readonly unknown[]).entries()) {
    const key = toRingKey(entry, index);
    if (ring.has(key.kid)) throw new KeyRingError('duplicate-kid', `key ring lists kid ${describeKid(key.kid)} more than once`);
    ring.set(key.kid, key);
  }
  const active = [...ring.values()].filter((key) => key.status === 'active');
  if (active.length !== 1) {
    throw new KeyRingError('active-key-count', `key ring needs exactly one active key, found ${active.length}`);
  }
  const activeKey = active[0] as RingKey & { signer: Es256Signer };
  const verificationKeys = new Map<string, Promise<CryptoKey>>();

  const verificationKey = (key: RingKey): Promise<CryptoKey> => {
    let pending = verificationKeys.get(key.kid);
    if (!pending) {
      pending = importPublicKey(key.publicJwk as Es256PublicJwk).catch(() => {
        verificationKeys.delete(key.kid);
        throw new KeyRingError('invalid-public-key', `public key of kid ${describeKid(key.kid)} is not a valid P-256 point`);
      });
      verificationKeys.set(key.kid, pending);
    }
    return pending;
  };

  const sign = async (header: JwsHeader, payload: JwsPayload): Promise<string> => {
    const protectedHeader = buildHeader(header, activeKey.kid);
    const signingInput = `${base64UrlEncode(utf8Encode(protectedHeader))}.${base64UrlEncode(payloadBytes(payload))}`;
    let signature: unknown;
    try {
      signature = await activeKey.signer.sign(utf8Encode(signingInput));
    } catch {
      throw new KeyRingError('signing-failed', `signer for kid ${describeKid(activeKey.kid)} failed`);
    }
    if (!(signature instanceof Uint8Array) || signature.length !== 2 * P256_FIELD_BYTES) {
      throw new KeyRingError('signing-failed', `signer for kid ${describeKid(activeKey.kid)} did not return a 64-byte ES256 signature`);
    }
    return `${signingInput}.${base64UrlEncode(signature)}`;
  };

  const verify = async (jws: string): Promise<VerifiedJws> => {
    if (typeof jws !== 'string' || jws.length > MAX_JWS_LENGTH) {
      throw new KeyRingError('malformed-jws', 'JWS must be a compact serialization string');
    }
    const parts = jws.split('.');
    if (parts.length !== 3) throw new KeyRingError('malformed-jws', 'JWS must have exactly three dot-separated parts');
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeHeader(encodedHeader);
    const payload = base64UrlDecode(encodedPayload);
    const signature = base64UrlDecode(encodedSignature);
    if (!payload) throw new KeyRingError('malformed-jws', 'JWS payload is not base64url');
    if (!signature) throw new KeyRingError('malformed-jws', 'JWS signature is not base64url');

    if (header.alg !== ES256) throw new KeyRingError('unsupported-algorithm', 'JWS alg must be ES256');
    if (Object.hasOwn(header, 'crit')) throw new KeyRingError('unsupported-header', 'JWS crit header parameters are not supported');
    if (typeof header.kid !== 'string' || header.kid === '') throw new KeyRingError('unknown-kid', 'JWS header has no kid');
    const key = ring.get(header.kid);
    if (!key) throw new KeyRingError('unknown-kid', `JWS kid ${describeKid(header.kid)} is not in the key ring`);
    if (key.status === 'retired') throw new KeyRingError('retired-kid', `JWS kid ${describeKid(key.kid)} has been retired`);
    if (signature.length !== 2 * P256_FIELD_BYTES) {
      throw new KeyRingError('invalid-signature', 'JWS signature is not a 64-byte ES256 signature');
    }

    const publicKey = await verificationKey(key);
    const signingInput = utf8Encode(`${encodedHeader}.${encodedPayload}`);
    let valid: boolean;
    try {
      valid = await crypto.subtle.verify(ECDSA_SHA256, publicKey, copyBytes(signature), copyBytes(signingInput));
    } catch {
      valid = false;
    }
    if (!valid) throw new KeyRingError('invalid-signature', `JWS signature does not verify for kid ${describeKid(key.kid)}`);
    return Object.freeze({ kid: key.kid, header: Object.freeze(header), payload });
  };

  const jwks = (): Jwks => ({
    keys: [...ring.values()]
      .filter((key) => key.status !== 'retired')
      .map((key): JwksKey => {
        const jwk = key.publicJwk as Es256PublicJwk;
        return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: key.kid, alg: ES256, use: 'sig' };
      }),
  });

  return Object.freeze({ activeKid: activeKey.kid, sign, verify, jwks });
}

function toRingKey(entry: unknown, index: number): RingKey {
  const label = `key ring entry ${index}`;
  if (!isRecord(entry)) throw new KeyRingError('invalid-options', `${label} must be an object`);
  if (typeof entry.kid !== 'string' || entry.kid === '') {
    throw new KeyRingError('invalid-options', `${label} needs a non-empty string kid`);
  }
  const kid = entry.kid;
  if (entry.alg !== ES256) {
    throw new KeyRingError('unsupported-algorithm', `kid ${describeKid(kid)} must declare alg ES256`);
  }
  if (typeof entry.status !== 'string' || !KEY_STATUSES.has(entry.status)) {
    throw new KeyRingError('invalid-options', `kid ${describeKid(kid)} status must be active, verify-only or retired`);
  }
  const status = entry.status as KeyStatus;
  if (entry.signer === undefined && status === 'retired') return { kid, status, signer: undefined, publicJwk: undefined };
  const signer = entry.signer;
  if (!isRecord(signer) || typeof signer.sign !== 'function') {
    throw new KeyRingError('invalid-options', `kid ${describeKid(kid)} needs a signer with a sign function`);
  }
  if (signer.alg !== ES256) {
    throw new KeyRingError('unsupported-algorithm', `signer of kid ${describeKid(kid)} must use ES256`);
  }
  const publicJwk = toPublicJwk(signer.publicJwk, `public key of kid ${describeKid(kid)}`);
  for (const declared of [signer.kid, publicJwk.kid]) {
    if (declared !== undefined && declared !== kid) {
      throw new KeyRingError('kid-mismatch', `signer of kid ${describeKid(kid)} declares a different kid`);
    }
  }
  return { kid, status, signer: signer as unknown as Es256Signer, publicJwk };
}

function buildHeader(header: JwsHeader, activeKid: string): string {
  if (!isRecord(header)) throw new KeyRingError('invalid-sign-input', 'JWS header must be an object');
  if (header.alg !== undefined && header.alg !== ES256) {
    throw new KeyRingError('unsupported-algorithm', 'JWS header alg must be ES256 when given');
  }
  if (header.kid !== undefined && header.kid !== activeKid) {
    throw new KeyRingError('kid-mismatch', `JWS header kid must be the active kid ${describeKid(activeKid)} when given`);
  }
  if (Object.hasOwn(header, 'crit')) throw new KeyRingError('unsupported-header', 'JWS crit header parameters are not supported');
  const rest = Object.fromEntries(Object.entries(header).filter(([name]) => name !== 'alg' && name !== 'kid'));
  try {
    return JSON.stringify({ alg: ES256, kid: activeKid, ...rest });
  } catch {
    throw new KeyRingError('invalid-sign-input', 'JWS header must be JSON-serializable');
  }
}

function payloadBytes(payload: JwsPayload): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === 'string') return utf8Encode(payload);
  if (typeof payload === 'object' && payload !== null) {
    let json: string | undefined;
    try {
      json = JSON.stringify(payload);
    } catch {
      json = undefined;
    }
    if (json !== undefined) return utf8Encode(json);
  }
  throw new KeyRingError('invalid-sign-input', 'JWS payload must be bytes, a string or a JSON-serializable object');
}

function decodeHeader(encoded: string): Record<string, unknown> {
  const bytes = base64UrlDecode(encoded);
  const text = bytes && bytes.length > 0 ? utf8Decode(bytes) : undefined;
  if (text === undefined) throw new KeyRingError('malformed-jws', 'JWS protected header is not base64url-encoded UTF-8');
  let header: unknown;
  try {
    header = JSON.parse(text);
  } catch {
    throw new KeyRingError('malformed-jws', 'JWS protected header is not JSON');
  }
  if (!isRecord(header)) throw new KeyRingError('malformed-jws', 'JWS protected header must be a JSON object');
  return header;
}
