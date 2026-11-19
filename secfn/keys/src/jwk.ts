import { base64UrlDecode } from './encoding.js';
import { KeyRingError } from './errors.js';

export const ES256 = 'ES256';

/** The algorithm parameters WebCrypto uses for ES256 (RFC 7518 §3.4: ECDSA with P-256 and SHA-256). */
export const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
export const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Length in bytes of a P-256 coordinate, private scalar and each half of an ES256 signature. */
export const P256_FIELD_BYTES = 32;

/** An ES256 public key as a JSON Web Key (RFC 7517, RFC 7518 §6.2.1). It never has a `d` member. */
export interface Es256PublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly kid?: string;
  readonly alg?: 'ES256';
  readonly use?: 'sig';
}

/** One entry of the JWK Set returned by `jwks()`. */
export interface JwksKey {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly alg: 'ES256';
  readonly use: 'sig';
}

/** A JWK Set (RFC 7517 §5). */
export interface Jwks {
  readonly keys: JwksKey[];
}

/** JWK members that hold private or symmetric key material for any key type (RFC 7518 §6). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasPrivateMembers(jwk: Record<string, unknown>): boolean {
  return PRIVATE_MEMBERS.some((member) => Object.hasOwn(jwk, member));
}

/** True when a JWK member is a base64url string that decodes to exactly `length` bytes. */
export function isEncodedBytes(value: unknown, length: number): value is string {
  return typeof value === 'string' && base64UrlDecode(value)?.length === length;
}

/**
 * Checks the members shared by ES256 public and private JWKs: `kty`, `crv`, the coordinates and the optional
 * `alg`, `use` and `kid`. Messages name the member, never its value.
 */
export function checkEcJwkMembers(jwk: Record<string, unknown>, code: 'invalid-public-key' | 'invalid-private-key', label: string): void {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw new KeyRingError(code, `${label} must be an EC key on the P-256 curve (kty "EC", crv "P-256")`);
  }
  if (!isEncodedBytes(jwk.x, P256_FIELD_BYTES) || !isEncodedBytes(jwk.y, P256_FIELD_BYTES)) {
    throw new KeyRingError(code, `${label} must have x and y as unpadded base64url encodings of 32 bytes`);
  }
  if (jwk.alg !== undefined && jwk.alg !== ES256) {
    throw new KeyRingError('unsupported-algorithm', `${label} declares an algorithm other than ES256`);
  }
  if (jwk.use !== undefined && jwk.use !== 'sig') {
    throw new KeyRingError(code, `${label} declares a use other than "sig"`);
  }
  if (jwk.kid !== undefined && (typeof jwk.kid !== 'string' || jwk.kid === '')) {
    throw new KeyRingError(code, `${label} kid must be a non-empty string when present`);
  }
}

/**
 * Validates an ES256 public JWK and returns a frozen copy holding only the public members. A JWK with any
 * private member is rejected without echoing it, so a private JWK passed by mistake cannot reach a JWKS.
 */
export function toPublicJwk(value: unknown, label: string): Es256PublicJwk {
  if (!isRecord(value)) throw new KeyRingError('invalid-public-key', `${label} must be a JWK object`);
  if (hasPrivateMembers(value)) {
    throw new KeyRingError('invalid-public-key', `${label} must not contain private key members`);
  }
  checkEcJwkMembers(value, 'invalid-public-key', label);
  return Object.freeze({
    kty: 'EC',
    crv: 'P-256',
    x: value.x as string,
    y: value.y as string,
    ...(value.kid === undefined ? {} : { kid: value.kid as string }),
    ...(value.alg === undefined ? {} : { alg: ES256 }),
    ...(value.use === undefined ? {} : { use: 'sig' as const }),
  });
}

export async function importPublicKey(jwk: Es256PublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, ECDSA_P256, false, ['verify']);
}
