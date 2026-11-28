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
  /** The scope to narrow the credential to, in the minter's grammar input shape. */
  readonly scope: TScope;
  /**
   * Requested lifetime in whole seconds (a positive safe integer). A minter
   * never returns a credential that outlives what its provider enforces and
   * reports the real expiry in `expiresAt`; each minter documents how it
   * treats a `ttl` its provider cannot honour exactly.
   */
  readonly ttl: number;
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
 * - `mint` keeps no state between calls, so retrying a failed or successful
 *   mint with the same request asks the provider for the same grant again.
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
