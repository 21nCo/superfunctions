import type { ScopeViolation } from '../scopes/types.js';

export type CredentialMinterErrorCode =
  /** The mint request itself is invalid (installation or ttl). */
  | 'invalid_request'
  /** The minter's own configuration (a signing key, say) cannot be used. */
  | 'invalid_configuration'
  /** The provider rejected the minter's own credentials (HTTP 401). */
  | 'unauthorized'
  /** The provider refused the request (HTTP 403). */
  | 'forbidden'
  /** The installation does not exist or is not visible to the minter (HTTP 404). */
  | 'installation_not_found'
  /** The requested scope cannot be granted; always a {@link ScopeNotGrantable}. */
  | 'scope_not_grantable'
  /** The provider could not be reached or failed (network error, HTTP 5xx, 429). */
  | 'provider_unavailable'
  /** Any other provider failure, including a response the minter cannot trust. */
  | 'provider_error'
  /**
   * The provider issued a credential the minter rejected (wider than asked,
   * or a response it cannot trust), and revoking that credential failed too:
   * it may stay active until it expires. The error never carries it; when
   * the minter can still revoke it, `revokeHandle` lets the caller retry the
   * cleanup with `revoke`.
   */
  | 'rejected_credential_not_revoked'
  /**
   * The provider may have issued a credential whose response was lost: it
   * reported success but the body could not be read or carried no usable
   * credential, or, for a mint with an `idempotencyKey`, the connection
   * failed after the request was sent or the provider answered 5xx. The
   * minter cannot know or revoke it and it stays active until it expires, so
   * this is not retryable: a retry could issue a second credential.
   */
  | 'mint_outcome_unknown';

export interface CredentialMinterErrorOptions {
  readonly status?: number;
  readonly retryable?: boolean;
  readonly cause?: unknown;
  /** A handle `revoke` accepts, for a rejected credential whose cleanup failed. */
  readonly revokeHandle?: unknown;
}

/**
 * A minting or revocation failure. The message and fields never contain the
 * minted secret or the minter's signing material.
 */
export class CredentialMinterError extends Error {
  readonly code: CredentialMinterErrorCode;
  readonly provider: string;
  /** The provider's HTTP status, when the failure came from a response. */
  readonly status: number | undefined;
  /** Whether repeating the same call may succeed. */
  readonly retryable: boolean;
  /**
   * For `rejected_credential_not_revoked`, when the minter can still revoke
   * the rejected credential: pass it to the minter's `revoke` to finish the
   * cleanup. A handle never contains the secret. Otherwise `undefined`.
   */
  readonly revokeHandle: unknown;

  constructor(provider: string, code: CredentialMinterErrorCode, message: string, options: CredentialMinterErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CredentialMinterError';
    this.code = code;
    this.provider = provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.revokeHandle = options.revokeHandle;
  }
}

/**
 * The provider cannot grant the requested scope: it is malformed for the
 * minter's grammar, would widen to the whole installation, or reaches outside
 * what the installation holds (a repository or permission it was not given).
 */
export class ScopeNotGrantable extends CredentialMinterError {
  /** Grammar violations, when the scope was rejected before any provider call. */
  readonly violations: readonly ScopeViolation[];

  constructor(
    provider: string,
    message: string,
    options: CredentialMinterErrorOptions & { readonly violations?: readonly ScopeViolation[] } = {},
  ) {
    super(provider, 'scope_not_grantable', message, { ...options, retryable: false });
    this.name = 'ScopeNotGrantable';
    this.violations = Object.freeze([...(options.violations ?? [])]);
  }
}
