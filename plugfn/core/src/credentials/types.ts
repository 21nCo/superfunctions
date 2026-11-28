/**
 * Short-lived credential minting.
 *
 * A credential minter turns a provider installation and a scope, expressed in
 * the minter's own scope grammar, into a short-lived secret narrowed to that
 * scope. Policy (whether a caller may ask for that scope at all) is decided
 * before minting, with `grammar.isSubset(request, envelope)`; the minter only
 * mints exactly what it is asked for, or fails.
 */

import type { AnyScopeCallbackGrammar } from '../scopes/types.js';

/** What to mint. */
export interface CredentialMintRequest<TInstallation = unknown, TScope = unknown> {
  /** The provider installation (account, app installation, tenant) to mint for. */
  readonly installation: TInstallation;
  /**
   * The scope to narrow the credential to. After a policy check, pass the
   * frozen snapshot `grammar.isSubset(request, envelope)` returned as `scope`:
   * a minter accepts its own grammar's snapshot and builds the grant from it
   * alone, so the check and the mint read the same scope. A minter may also
   * accept the grammar's input shape, which it normalises once.
   */
  readonly scope: TScope;
  /**
   * Requested lifetime in whole seconds (a positive safe integer). A minter
   * never returns a credential that outlives what its provider enforces and
   * reports the real expiry in `expiresAt`; each minter documents how it
   * treats a `ttl` its provider cannot honour exactly.
   */
  readonly ttl: number;
  /**
   * An optional caller-chosen key (1 to 256 characters) that makes a retried
   * mint idempotent within one minter instance. Mints with the same key and
   * the same installation, scope and `ttl` share one provider call while it
   * is in flight, and then return the same credential while it is neither
   * revoked nor expired; after that the key mints a new credential. The same
   * key with a different request rejects with `invalid_request` while the
   * earlier credential is live. A key never sends a second provider request
   * while a credential from an earlier one under that key may be live: only
   * a definite non-issuance (a failure before the request, or a provider
   * refusal such as HTTP 4xx) frees it at once. A failure after which a
   * credential may exist (the connection failed after the request was sent,
   * a 5xx, or a success response that was lost or unusable) rejects with
   * `mint_outcome_unknown`, and every mint with that key repeats the failure
   * until any such credential has expired. A `rejected_credential_not_revoked`
   * failure is repeated, with the same `revokeHandle`, until that handle is
   * revoked or the credential expires.
   */
  readonly idempotencyKey?: string;
}

/** A minted credential. */
export interface MintedCredential<THandle = unknown> {
  /** The secret to present to the provider. Never log it. */
  readonly secret: string;
  /** When the provider stops accepting `secret`. */
  readonly expiresAt: Date;
  /** Pass to `revoke` to end the credential before `expiresAt`. */
  readonly revokeHandle: THandle;
}

/**
 * A provider credential minter.
 *
 * Contract:
 * - `mint` narrows the credential to exactly the requested scope, never wider.
 *   A scope the provider cannot grant rejects with `ScopeNotGrantable`; every
 *   other failure rejects with `CredentialMinterError`. Errors never carry
 *   the minted secret or the minter's own signing material.
 * - Without `idempotencyKey`, each `mint` asks the provider for a new
 *   credential. With one, a retried or concurrent mint of the same request
 *   returns the same credential (see {@link CredentialMintRequest.idempotencyKey}).
 *   When the provider reports success but its response is lost or unusable,
 *   `mint` rejects with the non-retryable `mint_outcome_unknown`: a
 *   credential may have been issued, and it expires on its own. Without a
 *   key, a transport failure or a provider 5xx is a retryable
 *   `provider_unavailable`; for a provider without its own idempotency key, a
 *   request it received before failing may still have issued a credential
 *   nobody can see. With a key, those failures are `mint_outcome_unknown`.
 * - When the provider issues a credential the minter rejects, the minter
 *   revokes it before failing; if that revoke fails, it rejects with
 *   `rejected_credential_not_revoked`, with a `revokeHandle` to retry the
 *   cleanup when the minter still holds the credential.
 * - `revoke` is idempotent: revoking a credential that is already revoked or
 *   expired resolves without error.
 */
export interface CredentialMinter<
  TInstallation = unknown,
  TScope = unknown,
  THandle = unknown,
  TGrammar extends AnyScopeCallbackGrammar = AnyScopeCallbackGrammar,
> {
  /** Provider identifier, the same as `grammar.provider`. */
  readonly provider: string;
  /** The scope grammar requests and envelopes for this minter are written in. */
  readonly grammar: TGrammar;
  mint(request: CredentialMintRequest<TInstallation, TScope>): Promise<MintedCredential<THandle>>;
  revoke(handle: THandle): Promise<void>;
}
