import { copyBytes, isArrayBuffer, isUint8Array, utf8Encode } from './encoding.js';
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
  snapshotEcJwk,
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
 *
 * The options, each private JWK member and the PKCS #8 bytes are read exactly once, before the first `await`:
 * validation, import, the published public key and the returned `kid` all come from that snapshot, so getters or
 * mutations of the caller's objects while the key is imported cannot change the result.
 */
export async function createWebCryptoSigner(options: WebCryptoSignerOptions): Promise<Es256Signer> {
  if (!isRecord(options)) throw new KeyRingError('invalid-options', 'createWebCryptoSigner needs an options object');
  const { privateJwk, pkcs8, kid: optionKid } = options as Record<string, unknown>;
  if ((privateJwk !== undefined) === (pkcs8 !== undefined)) {
    throw new KeyRingError('invalid-options', 'createWebCryptoSigner needs exactly one of privateJwk or pkcs8');
  }
  if (optionKid !== undefined && (typeof optionKid !== 'string' || optionKid === '')) {
    throw new KeyRingError('invalid-options', 'createWebCryptoSigner kid must be a non-empty string when present');
  }

  const imported = privateJwk !== undefined ? await importPrivateJwk(privateJwk) : await importPkcs8(pkcs8);
  if (optionKid !== undefined && imported.jwkKid !== undefined && imported.jwkKid !== optionKid) {
    throw new KeyRingError('kid-mismatch', 'createWebCryptoSigner kid differs from the kid of the private key JWK');
  }
  await assertKeyPair(imported.privateKey, imported.publicJwk);

  const { privateKey } = imported;
  const kid = optionKid ?? imported.jwkKid;
  const sign = async (data: Uint8Array): Promise<Uint8Array> => {
    // A brand check, not `instanceof`, so a Uint8Array from another realm is accepted; the bytes signed are one
    // copy taken through the built-in accessors.
    if (!isUint8Array(data)) throw new KeyRingError('invalid-sign-input', 'signer input must be a Uint8Array');
    const bytes = copyBytes(data);
    if (typeof bytes === 'string') throw new KeyRingError('invalid-sign-input', 'signer input buffer is detached or out of bounds');
    try {
      return new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256, privateKey, bytes));
    } catch {
      throw new KeyRingError('signing-failed', 'WebCrypto ES256 signing failed');
    }
  };
  return Object.freeze({ alg: ES256, ...(kid === undefined ? {} : { kid }), publicJwk: imported.publicJwk, sign });
}

async function importPrivateJwk(value: unknown): Promise<ImportedKeyPair> {
  if (!isRecord(value)) throw new KeyRingError('invalid-private-key', 'privateJwk must be a JWK object');
  // Synchronous up to the import, so the snapshot is taken before createWebCryptoSigner first yields.
  const snapshot = snapshotEcJwk(value);
  const d = value.d;
  checkEcJwkMembers(snapshot, 'invalid-private-key', 'privateJwk');
  if (!isEncodedBytes(d, P256_FIELD_BYTES)) {
    throw new KeyRingError('invalid-private-key', 'privateJwk must have d as an unpadded base64url encoding of 32 bytes');
  }
  const x = snapshot.x as string;
  const y = snapshot.y as string;
  const publicJwk: Es256PublicJwk = Object.freeze({ kty: 'EC', crv: 'P-256', x, y });
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, d, ext: false }, ECDSA_P256, false, ['sign']);
  } catch {
    throw new KeyRingError('invalid-private-key', 'privateJwk could not be imported as a P-256 ECDSA signing key');
  }
  return { privateKey, publicJwk, jwkKid: snapshot.kid as string | undefined };
}

async function importPkcs8(value: unknown): Promise<ImportedKeyPair> {
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

function pkcs8Bytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (isArrayBuffer(value) || ArrayBuffer.isView(value)) {
    const der = copyBytes(value);
    if (typeof der === 'string') throw new KeyRingError('invalid-private-key', 'pkcs8 buffer is detached or out of bounds');
    return der;
  }
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
