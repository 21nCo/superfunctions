import { copyBytes, utf8Encode } from './encoding.js';
import { KeyRingError } from './errors.js';
import {
  checkEcJwkMembers,
  ECDSA_P256,
  ECDSA_SHA256,
  ES256,
  type Es256PublicJwk,
  importPublicKey,
  isEncodedBytes,
  isRecord,
  P256_FIELD_BYTES,
  toPublicJwk,
} from './jwk.js';

/**
 * Produces ES256 signatures for a key ring entry. `sign` returns the 64-byte JWS form of the signature (r || s,
 * RFC 7518 §3.4), not DER. A signer exposes only its public key: private key material is never a property or a
 * return value. Signers other than `createWebCryptoSigner` (for example a KMS signer) implement this interface.
 */
export interface Es256Signer {
  readonly alg: 'ES256';
  /** The key id the key material declares, if any. A key ring rejects an entry whose `kid` differs from it. */
  readonly kid?: string;
  /** The public half of the signing key. It never has a `d` member. */
  readonly publicJwk: Es256PublicJwk;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** A P-256 private key JWK: `kty` "EC", `crv` "P-256", `d`, `x`, `y`, and optionally `kid`, `alg` ES256 and `use` sig. */
export type Es256PrivateJwk = JsonWebKey & { readonly kid?: string | undefined };

export interface PrivateJwkSignerOptions {
  readonly privateJwk: Es256PrivateJwk;
  readonly pkcs8?: never;
  /** Expected key id. When the JWK also has a `kid`, the two must match. */
  readonly kid?: string;
}

/** A P-256 private key in PKCS #8 form: DER bytes or a PEM string with a `PRIVATE KEY` label (RFC 7468 §10). */
export interface Pkcs8SignerOptions {
  readonly pkcs8: string | ArrayBuffer | ArrayBufferView;
  readonly privateJwk?: never;
  readonly kid?: string;
}

export type WebCryptoSignerOptions = PrivateJwkSignerOptions | Pkcs8SignerOptions;

// The PEM boundaries are assembled from parts so the pattern itself does not read as an encapsulated key block.
const PEM_LABEL = ['PRIVATE', 'KEY'].join(' ');
const PEM_DASHES = '-'.repeat(5);
const PEM_PRIVATE_KEY = new RegExp(
  `^${PEM_DASHES}BEGIN ${PEM_LABEL}${PEM_DASHES}([A-Za-z0-9+/=\\s]+)${PEM_DASHES}END ${PEM_LABEL}${PEM_DASHES}$`,
);
const SELF_TEST_DATA = utf8Encode('secfn-keys signer self-test');

interface ImportedKeyPair {
  privateKey: CryptoKey;
  publicJwk: Es256PublicJwk;
  jwkKid: string | undefined;
}

/**
 * Creates an ES256 signer from a P-256 private key using WebCrypto only, so it runs on Node and on Workers. The
 * private key is imported as non-extractable and kept out of the returned object; the signer is checked to
 * produce signatures its published public key verifies before it is returned.
 */
export async function createWebCryptoSigner(options: WebCryptoSignerOptions): Promise<Es256Signer> {
  if (!isRecord(options)) throw new KeyRingError('invalid-options', 'createWebCryptoSigner needs an options object');
  const hasJwk = options.privateJwk !== undefined;
  const hasPkcs8 = options.pkcs8 !== undefined;
  if (hasJwk === hasPkcs8) {
    throw new KeyRingError('invalid-options', 'createWebCryptoSigner needs exactly one of privateJwk or pkcs8');
  }
  if (options.kid !== undefined && (typeof options.kid !== 'string' || options.kid === '')) {
    throw new KeyRingError('invalid-options', 'createWebCryptoSigner kid must be a non-empty string when present');
  }

  const imported = hasJwk ? await importPrivateJwk(options.privateJwk) : await importPkcs8(options.pkcs8 as Pkcs8SignerOptions['pkcs8']);
  if (options.kid !== undefined && imported.jwkKid !== undefined && imported.jwkKid !== options.kid) {
    throw new KeyRingError('kid-mismatch', 'createWebCryptoSigner kid differs from the kid of the private key JWK');
  }
  await assertKeyPair(imported.privateKey, imported.publicJwk);

  const { privateKey } = imported;
  const kid = options.kid ?? imported.jwkKid;
  const sign = async (data: Uint8Array): Promise<Uint8Array> => {
    if (!(data instanceof Uint8Array)) throw new KeyRingError('invalid-sign-input', 'signer input must be a Uint8Array');
    try {
      return new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256, privateKey, copyBytes(data)));
    } catch {
      throw new KeyRingError('signing-failed', 'WebCrypto ES256 signing failed');
    }
  };
  return Object.freeze({ alg: ES256, ...(kid === undefined ? {} : { kid }), publicJwk: imported.publicJwk, sign });
}

async function importPrivateJwk(value: unknown): Promise<ImportedKeyPair> {
  if (!isRecord(value)) throw new KeyRingError('invalid-private-key', 'privateJwk must be a JWK object');
  checkEcJwkMembers(value, 'invalid-private-key', 'privateJwk');
  if (!isEncodedBytes(value.d, P256_FIELD_BYTES)) {
    throw new KeyRingError('invalid-private-key', 'privateJwk must have d as an unpadded base64url encoding of 32 bytes');
  }
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: value.x as string, y: value.y as string, d: value.d, ext: false };
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey('jwk', jwk, ECDSA_P256, false, ['sign']);
  } catch {
    throw new KeyRingError('invalid-private-key', 'privateJwk could not be imported as a P-256 ECDSA signing key');
  }
  return {
    privateKey,
    publicJwk: toPublicJwk({ kty: 'EC', crv: 'P-256', x: value.x, y: value.y }, 'privateJwk public members'),
    jwkKid: value.kid as string | undefined,
  };
}

async function importPkcs8(value: Pkcs8SignerOptions['pkcs8']): Promise<ImportedKeyPair> {
  const der = pkcs8Bytes(value);
  try {
    let extractable: CryptoKey;
    try {
      extractable = await crypto.subtle.importKey('pkcs8', der, ECDSA_P256, true, ['sign']);
    } catch {
      throw new KeyRingError('invalid-private-key', 'pkcs8 could not be imported as a P-256 ECDSA signing key');
    }
    // WebCrypto has no direct private-to-public derivation: export once to read the public coordinates, then
    // re-import the key as non-extractable so the signer never holds an exportable private key.
    let exported: JsonWebKey;
    let privateKey: CryptoKey;
    try {
      exported = await crypto.subtle.exportKey('jwk', extractable);
      privateKey = await crypto.subtle.importKey('pkcs8', der, ECDSA_P256, false, ['sign']);
    } catch {
      throw new KeyRingError('invalid-private-key', 'pkcs8 could not be imported as a P-256 ECDSA signing key');
    }
    return {
      privateKey,
      publicJwk: toPublicJwk({ kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y }, 'pkcs8 public key'),
      jwkKid: undefined,
    };
  } finally {
    der.fill(0);
  }
}

function pkcs8Bytes(value: Pkcs8SignerOptions['pkcs8']): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return copyBytes(value);
  if (typeof value !== 'string') {
    throw new KeyRingError('invalid-private-key', 'pkcs8 must be DER bytes or a PEM "PRIVATE KEY" string');
  }
  const match = PEM_PRIVATE_KEY.exec(value.trim());
  if (!match) {
    throw new KeyRingError(
      'invalid-private-key',
      'pkcs8 must be a PEM "PRIVATE KEY" (PKCS #8) block; convert SEC1 "EC PRIVATE KEY" keys to PKCS #8 first',
    );
  }
  let binary: string;
  try {
    binary = atob((match[1] as string).replace(/\s+/g, ''));
  } catch {
    throw new KeyRingError('invalid-private-key', 'pkcs8 PEM body is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function assertKeyPair(privateKey: CryptoKey, publicJwk: Es256PublicJwk): Promise<void> {
  let verified: boolean;
  try {
    const publicKey = await importPublicKey(publicJwk);
    const signature = await crypto.subtle.sign(ECDSA_SHA256, privateKey, SELF_TEST_DATA);
    verified = await crypto.subtle.verify(ECDSA_SHA256, publicKey, signature, SELF_TEST_DATA);
  } catch {
    throw new KeyRingError('invalid-private-key', 'the private key or its public coordinates are not a valid P-256 key');
  }
  if (!verified) throw new KeyRingError('key-pair-mismatch', 'the private key does not match its public coordinates');
}
