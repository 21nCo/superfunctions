/**
 * Every failure this package raises is a `KeyRingError` with a stable `code`. Messages are fixed strings plus, at
 * most, a key id (a public identifier). They never carry key material, caller-supplied key objects or the error
 * of an underlying WebCrypto call, and no `cause` is attached, so logging an error cannot leak a private key.
 */
export type KeyRingErrorCode =
  /** The key ring or signer options are malformed. */
  | 'invalid-options'
  /** A key, header or JWK declares an algorithm other than ES256. */
  | 'unsupported-algorithm'
  /** The key set does not have exactly one `active` key. */
  | 'active-key-count'
  /** Two entries share a `kid`. */
  | 'duplicate-kid'
  /** A signer or JWK declares a `kid` that differs from the entry's `kid`. */
  | 'kid-mismatch'
  /** A public JWK is malformed, or carries private key members. */
  | 'invalid-public-key'
  /** The private key could not be imported as an ES256 (P-256) signing key. */
  | 'invalid-private-key'
  /** The private key does not match the public key published for it. */
  | 'key-pair-mismatch'
  /** The protected header or payload passed to `sign` cannot be used. */
  | 'invalid-sign-input'
  /** The signer failed or returned a signature that is not a 64-byte ES256 (r || s) value. */
  | 'signing-failed'
  /** The value is not a well-formed compact JWS. */
  | 'malformed-jws'
  /** The JWS names no key id, or one this ring does not hold. */
  | 'unknown-kid'
  /** The JWS was signed with a key that has been retired. */
  | 'retired-kid'
  /** The JWS uses a header parameter this verifier does not support (for example `crit`). */
  | 'unsupported-header'
  /** The signature does not verify. */
  | 'invalid-signature';

export class KeyRingError extends Error {
  readonly code: KeyRingErrorCode;

  constructor(code: KeyRingErrorCode, message: string) {
    super(message);
    this.name = 'KeyRingError';
    this.code = code;
  }
}

/** Quotes a caller-supplied key id for an error message, bounded so a hostile header cannot bloat logs. */
export function describeKid(kid: string): string {
  return JSON.stringify(kid.length > 128 ? `${kid.slice(0, 128)}…` : kid);
}
