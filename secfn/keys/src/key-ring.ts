import { base64UrlDecode, base64UrlEncode, copyBytes, isArrayBuffer, isUint8Array, utf8Decode, utf8Encode } from './encoding.js';
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

/**
 * Payload bytes (an `ArrayBuffer`, `SharedArrayBuffer` or any `ArrayBufferView`, from any realm, signed as its viewed
 * bytes), a UTF-8 string, or a plain object or array that is serialized with `JSON.stringify` and must serialize to a
 * JSON object or array. Other objects (`Map`, `Date`, class instances) are rejected rather than signed as `{}`, and a
 * detached buffer or a view over one is rejected with `invalid-sign-input`.
 */
export type JwsPayload = ArrayBuffer | SharedArrayBuffer | ArrayBufferView | string | Record<string, unknown> | readonly unknown[];

export interface VerifiedJws {
  readonly kid: string;
  readonly header: Readonly<Record<string, unknown>>;
  /** The payload bytes as signed. */
  readonly payload: Uint8Array;
}

export interface SigningKeyRing {
  readonly activeKid: string;
  /**
   * Signs a compact JWS (RFC 7515 §7.1) with the active key; the protected header always carries `alg` and `kid`.
   * Rejects with `invalid-sign-input`, before the signer runs, when the token would exceed `MAX_JWS_LENGTH`.
   */
  sign(header: JwsHeader, payload: JwsPayload): Promise<string>;
  /** Verifies a compact JWS against the active and verify-only keys; throws `KeyRingError` when it does not. */
  verify(jws: string): Promise<VerifiedJws>;
  /** The public JWK Set of the active and verify-only keys, without private members. Each call returns a new copy. */
  jwks(): Jwks;
}

/** A key ring entry as captured at construction: the entry and its signer are read once and never again. */
interface RingKey {
  readonly kid: string;
  readonly status: KeyStatus;
  /** The signer's `sign` function as read at construction, bound to the signer. */
  readonly sign: ((data: Uint8Array) => unknown) | undefined;
  readonly publicJwk: Es256PublicJwk | undefined;
}

/**
 * Upper bound, in characters, on a compact JWS: `verify` rejects a longer input before any decoding, and `sign`
 * refuses to produce one, so every token the ring signs is one it can verify.
 */
export const MAX_JWS_LENGTH = 256 * 1024;

/** Length of the base64url encoding of a 64-byte ES256 signature. */
const ENCODED_SIGNATURE_LENGTH = Math.ceil((2 * P256_FIELD_BYTES * 4) / 3);

/** The largest byte count whose unpadded base64url encoding fits in `characters` characters. */
function maxEncodableBytes(characters: number): number {
  return Math.max(0, Math.floor((characters * 3) / 4));
}

/**
 * Creates an ES256 key ring for staged rotation. The key set is validated here, before any key is used: exactly
 * one `active` key, unique kids, ES256 only, and each signer's own `kid` (if any) equal to its entry's.
 */
export function createSigningKeyRing(options: SigningKeyRingOptions): SigningKeyRing {
  const keys: unknown = isRecord(options) ? options.keys : undefined;
  const count = Array.isArray(keys) ? keys.length : 0;
  if (count === 0) throw new KeyRingError('invalid-options', 'createSigningKeyRing needs a non-empty keys array');
  const ring = new Map<string, RingKey>();
  for (let index = 0; index < count; index += 1) {
    const key = toRingKey((keys as readonly unknown[])[index], index);
    if (ring.has(key.kid)) throw new KeyRingError('duplicate-kid', `key ring lists kid ${describeKid(key.kid)} more than once`);
    ring.set(key.kid, key);
  }
  const active = [...ring.values()].filter((key) => key.status === 'active');
  if (active.length !== 1) {
    throw new KeyRingError('active-key-count', `key ring needs exactly one active key, found ${active.length}`);
  }
  const activeKey = active[0] as RingKey & { sign: (data: Uint8Array) => unknown };
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
    const encodedHeader = base64UrlEncode(utf8Encode(buildHeader(header, activeKey.kid)));
    // The payload budget is what remains of MAX_JWS_LENGTH after the header, two dots and the signature; it is
    // applied to the payload's bytes before they are copied or encoded, so an oversized payload costs nothing.
    const payloadBudget = maxEncodableBytes(MAX_JWS_LENGTH - encodedHeader.length - 2 - ENCODED_SIGNATURE_LENGTH);
    const signingInput = `${encodedHeader}.${base64UrlEncode(payloadBytes(payload, payloadBudget))}`;
    if (signingInput.length + 1 + ENCODED_SIGNATURE_LENGTH > MAX_JWS_LENGTH) {
      throw new KeyRingError('invalid-sign-input', `JWS would exceed the ${MAX_JWS_LENGTH}-character limit verify accepts`);
    }
    let returned: unknown;
    try {
      returned = await activeKey.sign(utf8Encode(signingInput));
    } catch {
      throw new KeyRingError('signing-failed', `signer for kid ${describeKid(activeKey.kid)} failed`);
    }
    // Copy the signature once, by its internal slots, and check and encode only that copy: a subclass cannot
    // report one length and yield different bytes, and a Uint8Array from another realm is accepted.
    const signature = isUint8Array(returned) ? copyBytes(returned) : undefined;
    if (typeof signature !== 'object' || signature.length !== 2 * P256_FIELD_BYTES) {
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
    rejectUnsupportedParameters(header);
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
      valid = await crypto.subtle.verify(ECDSA_SHA256, publicKey, signature, signingInput);
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

/**
 * Captures one entry: each member of the entry and of its signer is read exactly once, and validation, the JWKS,
 * verification and signing use only those captured values.
 */
function toRingKey(entry: unknown, index: number): RingKey {
  const label = `key ring entry ${index}`;
  if (!isRecord(entry)) throw new KeyRingError('invalid-options', `${label} must be an object`);
  const { kid, alg, status, signer } = entry;
  if (typeof kid !== 'string' || kid === '') {
    throw new KeyRingError('invalid-options', `${label} needs a non-empty string kid`);
  }
  if (alg !== ES256) {
    throw new KeyRingError('unsupported-algorithm', `kid ${describeKid(kid)} must declare alg ES256`);
  }
  if (typeof status !== 'string' || !KEY_STATUSES.has(status)) {
    throw new KeyRingError('invalid-options', `kid ${describeKid(kid)} status must be active, verify-only or retired`);
  }
  if (signer === undefined && status === 'retired') return Object.freeze({ kid, status, sign: undefined, publicJwk: undefined });
  if (!isRecord(signer)) {
    throw new KeyRingError('invalid-options', `kid ${describeKid(kid)} needs a signer with a sign function`);
  }
  const { sign, alg: signerAlg, kid: signerKid, publicJwk: signerPublicJwk } = signer as Partial<Record<keyof Es256Signer, unknown>>;
  if (typeof sign !== 'function') {
    throw new KeyRingError('invalid-options', `kid ${describeKid(kid)} needs a signer with a sign function`);
  }
  if (signerAlg !== ES256) {
    throw new KeyRingError('unsupported-algorithm', `signer of kid ${describeKid(kid)} must use ES256`);
  }
  const publicJwk = toPublicJwk(signerPublicJwk, `public key of kid ${describeKid(kid)}`);
  for (const declared of [signerKid, publicJwk.kid]) {
    if (declared !== undefined && declared !== kid) {
      throw new KeyRingError('kid-mismatch', `signer of kid ${describeKid(kid)} declares a different kid`);
    }
  }
  const boundSign = (data: Uint8Array): unknown => Reflect.apply(sign, signer, [data]);
  return Object.freeze({ kid, status: status as KeyStatus, sign: boundSign, publicJwk });
}

/**
 * Serializes the caller's header once and validates that serialization, not the live object: a `toJSON` method,
 * getter or nested value cannot change the header after the checks. `alg` and the active `kid` are written last.
 */
function buildHeader(header: JwsHeader, activeKid: string): string {
  if (!isRecord(header)) throw new KeyRingError('invalid-sign-input', 'JWS header must be an object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(JSON.stringify(header));
  } catch {
    throw new KeyRingError('invalid-sign-input', 'JWS header must be JSON-serializable');
  }
  if (!isRecord(parsed)) throw new KeyRingError('invalid-sign-input', 'JWS header must serialize to a JSON object');
  if (parsed.alg !== undefined && parsed.alg !== ES256) {
    throw new KeyRingError('unsupported-algorithm', 'JWS header alg must be ES256 when given');
  }
  if (parsed.kid !== undefined && parsed.kid !== activeKid) {
    throw new KeyRingError('kid-mismatch', `JWS header kid must be the active kid ${describeKid(activeKid)} when given`);
  }
  rejectUnsupportedParameters(parsed);
  // `parsed` is plain JSON data, so this second serialization has no caller code left to run.
  const rest = Object.fromEntries(Object.entries(parsed).filter(([name]) => name !== 'alg' && name !== 'kid'));
  return JSON.stringify({ alg: ES256, kid: activeKid, ...rest });
}

function payloadTooLarge(): KeyRingError {
  return new KeyRingError('invalid-sign-input', `JWS would exceed the ${MAX_JWS_LENGTH}-character limit verify accepts`);
}

/**
 * The payload as bytes, rejected with `invalid-sign-input` once it is known to exceed `maxBytes`: a binary payload's
 * observed length is checked before it is copied, and a string (whose UTF-8 form is never shorter than its length in
 * UTF-16 code units) before it is encoded.
 */
function payloadBytes(payload: JwsPayload, maxBytes: number): Uint8Array {
  // `ArrayBuffer.isView` and the `isArrayBuffer` brand checks test internal slots, so they also hold for values from
  // another realm (node:vm, an iframe, a test environment) where `instanceof` fails.
  if (ArrayBuffer.isView(payload) || isArrayBuffer(payload)) {
    const bytes = copyBytes(payload, maxBytes);
    if (bytes === 'too-large') throw payloadTooLarge();
    if (bytes === 'unreadable') throw new KeyRingError('invalid-sign-input', 'JWS payload buffer is detached or out of bounds');
    return bytes;
  }
  let text: string | undefined;
  if (typeof payload === 'string') {
    text = payload;
  } else if (Array.isArray(payload) || isPlainObject(payload)) {
    try {
      const json: unknown = JSON.stringify(payload);
      if (typeof json === 'string' && (json.startsWith('{') || json.startsWith('['))) text = json;
    } catch {
      text = undefined;
    }
  }
  if (text === undefined) {
    throw new KeyRingError('invalid-sign-input', 'JWS payload must be bytes, a string, or a JSON-serializable plain object or array');
  }
  if (text.length > maxBytes) throw payloadTooLarge();
  return utf8Encode(text);
}

const functionToString = Function.prototype.toString;
const NATIVE_OBJECT_CONSTRUCTOR = /^function Object\(\) \{\s*\[native code\]\s*\}$/;

/**
 * True for an object whose prototype is `null` or the `Object.prototype` of some realm, recognized by its own
 * `constructor` data property: the built-in `Object` constructor, whose `prototype` is that same object. A custom
 * null-rooted prototype (`Object.create(Object.create(null))`) and class instances such as `Map`, `Set`, `Date` or a
 * `Blob` are not plain objects: `JSON.stringify` would sign them as `{}` or a string.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null || prototype === Object.prototype) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  if (typeof constructor !== 'function') return false;
  try {
    return (
      Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value === prototype &&
      NATIVE_OBJECT_CONSTRUCTOR.test(functionToString.call(constructor))
    );
  } catch {
    return false;
  }
}

/**
 * `crit` (RFC 7515 §4.1.11) and `b64` (RFC 7797, unencoded payload) change how a token must be processed; this ring
 * implements neither, so a header that carries one is refused on both sign and verify.
 */
function rejectUnsupportedParameters(header: Record<string, unknown>): void {
  for (const name of ['crit', 'b64']) {
    if (Object.hasOwn(header, name)) {
      throw new KeyRingError('unsupported-header', `JWS ${name} header parameter is not supported`);
    }
  }
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
