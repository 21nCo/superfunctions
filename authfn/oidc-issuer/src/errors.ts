/**
 * Every failure this package raises itself is an `OidcIssuerError` with a stable `code`. Messages are fixed text plus,
 * at most, non-secret values (a claim name, a limit or a key id); they never carry claim values or key material.
 * A failure inside the key ring while signing propagates as the ring's own `KeyRingError`.
 */
export type OidcIssuerErrorCode =
  /** The `createOidcIssuer` options are malformed (issuer URL, key ring, default lifetime or supported claims). */
  | 'invalid-options'
  /** `sub` is not a non-empty string of at most 255 printable ASCII characters. */
  | 'invalid-subject'
  /** `aud` is not a non-empty string or a non-empty array of distinct non-empty strings. */
  | 'invalid-audience'
  /** The lifetime is not a whole number of seconds from 1 to `MAX_ID_TOKEN_TTL_SECONDS`. */
  | 'invalid-ttl'
  /** `claims` is not a JSON-serializable plain object. */
  | 'invalid-claims'
  /** `claims` names a registered claim the issuer sets itself (`iss`, `sub`, `aud`, `iat`, `nbf`, `exp`, `jti`). */
  | 'reserved-claim';

export class OidcIssuerError extends Error {
  readonly code: OidcIssuerErrorCode;

  constructor(code: OidcIssuerErrorCode, message: string) {
    super(message);
    this.name = 'OidcIssuerError';
    this.code = code;
  }
}

/** Quotes a caller-supplied name for an error message, bounded so a hostile value cannot bloat logs. */
export function describeName(name: string): string {
  return JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}…` : name);
}
