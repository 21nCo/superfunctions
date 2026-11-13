import type { AuthFnSession } from '../types.js';
import {
  AuthFnConfigError,
  AuthFnInsufficientScopeError,
  AuthFnUnauthenticatedError,
  AuthFnValidationError
} from './errors.js';

/**
 * Host-declared scope registry: each key is a scope owner (an app or API such
 * as `memotron`) and each value lists that owner's actions (`read`, `write`).
 * The registered scopes are every `<owner>:<action>` pair.
 */
export type AuthFnScopeRegistry = Readonly<Record<string, readonly string[]>>;

/** Grants every registered scope. */
export const AUTHFN_ALL_SCOPES = '*';

/** A concrete `<owner>:<action>` scope declared by the registry. */
export type AuthFnRegisteredScope<TRegistry extends AuthFnScopeRegistry> = {
  [TOwner in keyof TRegistry & string]: `${TOwner}:${TRegistry[TOwner][number]}`;
}[keyof TRegistry & string];

/** Any scope a credential may be granted: a registered scope, `<owner>:*`, or `*`. */
export type AuthFnGrantableScope<TRegistry extends AuthFnScopeRegistry> =
  | AuthFnRegisteredScope<TRegistry>
  | `${keyof TRegistry & string}:*`
  | typeof AUTHFN_ALL_SCOPES;

export interface AuthFnRequireScopesOptions<TRegistry extends AuthFnScopeRegistry = AuthFnScopeRegistry> {
  /**
   * When given, every needed scope must be registered; an unregistered needed
   * scope is a host programming error and throws a `TypeError`.
   */
  registry?: TRegistry;
}

/**
 * Options for the untyped overloads. A call that passes a registry must use
 * the typed overload, so its needed scopes are checked against that registry
 * at compile time as well as at run time.
 */
type AuthFnUncheckedScopesOptions = { registry?: undefined };

const SCOPE_SEGMENT = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const OWNER_WILDCARD_ACTION = '*';

type NormalizedRegistry = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Declares a scope registry while keeping its literal owner and action names,
 * so `AuthFnRegisteredScope<typeof registry>` and `requireScopes` can type them.
 */
export function defineAuthFnScopes<const TRegistry extends AuthFnScopeRegistry>(
  registry: TRegistry
): TRegistry {
  normalizeScopeRegistry(registry);
  return registry;
}

/**
 * Validates a host scope registry. Owners and actions are 1-64 characters of
 * `a-z`, `0-9`, `_`, `.` or `-`, starting with a letter or digit, so neither
 * can contain `:` or be the `*` wildcard.
 */
export function assertValidScopeRegistry(registry: unknown): asserts registry is AuthFnScopeRegistry {
  normalizeScopeRegistry(registry);
}

/**
 * Checks requested API-key scopes against the registry and returns them
 * deduplicated in request order. `*` and `<owner>:*` for a registered owner are
 * accepted; anything else not in the registry throws `AUTHFN_VALIDATION_ERROR`
 * (HTTP 400). Without a registry only `*` is accepted.
 */
export function assertRegisteredScopes(
  registry: AuthFnScopeRegistry | undefined,
  scopes: unknown
): string[] {
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
    throw new AuthFnValidationError('API key scopes must be an array of strings', {
      field: 'scopes'
    });
  }

  const owners = normalizeScopeRegistry(registry ?? {});
  const unknown = scopes.filter((scope: string) => !isGrantableScope(owners, scope));
  if (unknown.length > 0) {
    throw new AuthFnValidationError('API key scopes must be registered scopes', {
      field: 'scopes',
      unknownScopes: [...new Set(unknown)]
    });
  }

  return [...new Set(scopes as string[])];
}

/**
 * Reads the scopes stored on an API key into the grant its session carries.
 * Keys stored before 0.6.0 were never validated, so only string entries that
 * the current registry could grant survive: a registered scope, `<owner>:*`
 * for a registered owner, or `*`. Anything else grants nothing.
 */
export function readStoredScopeGrant(
  registry: AuthFnScopeRegistry | undefined,
  stored: unknown
): string[] {
  if (!Array.isArray(stored)) {
    return [];
  }

  const owners = normalizeScopeRegistry(registry ?? {});
  return [...new Set(stored.filter(
    (scope): scope is string => typeof scope === 'string' && isGrantableScope(owners, scope)
  ))];
}

/** True when the granted scopes cover every needed scope. See `requireScopes`. */
export function hasScopes<const TRegistry extends AuthFnScopeRegistry>(
  session: Pick<AuthFnSession, 'scopes'> | null | undefined,
  needed: AuthFnRegisteredScope<TRegistry> | readonly AuthFnRegisteredScope<TRegistry>[],
  options: AuthFnRequireScopesOptions<TRegistry> & { registry: TRegistry }
): boolean;
export function hasScopes(
  session: Pick<AuthFnSession, 'scopes'> | null | undefined,
  needed: string | readonly string[],
  options?: AuthFnUncheckedScopesOptions
): boolean;
export function hasScopes(
  session: Pick<AuthFnSession, 'scopes'> | null | undefined,
  needed: string | readonly string[],
  options?: AuthFnRequireScopesOptions
): boolean {
  return missingScopes(session, readNeededScopes(needed, options?.registry)).length === 0;
}

/**
 * The shared scope check hosts call before protected work. Every needed scope
 * must be a concrete `<owner>:<action>` and must be granted by the session:
 * exactly, by `<owner>:*` for the same owner, or by `*`. Cookie and bearer
 * user sessions carry `['*']`; API-key sessions carry the key's
 * stored scopes that the host registry can grant.
 *
 * Throws `AUTHFN_UNAUTHENTICATED` (401) without a session and
 * `AUTHFN_INSUFFICIENT_SCOPE` (403) when a needed scope is not granted.
 */
export function requireScopes<
  TSession extends Pick<AuthFnSession, 'scopes'>,
  const TRegistry extends AuthFnScopeRegistry
>(
  session: TSession | null | undefined,
  needed: AuthFnRegisteredScope<TRegistry> | readonly AuthFnRegisteredScope<TRegistry>[],
  options: AuthFnRequireScopesOptions<TRegistry> & { registry: TRegistry }
): asserts session is TSession;
export function requireScopes<TSession extends Pick<AuthFnSession, 'scopes'>>(
  session: TSession | null | undefined,
  needed: string | readonly string[],
  options?: AuthFnUncheckedScopesOptions
): asserts session is TSession;
export function requireScopes(
  session: Pick<AuthFnSession, 'scopes'> | null | undefined,
  needed: string | readonly string[],
  options?: AuthFnRequireScopesOptions
): void {
  const required = readNeededScopes(needed, options?.registry);
  if (!session) {
    throw new AuthFnUnauthenticatedError();
  }

  const missing = missingScopes(session, required);
  if (missing.length > 0) {
    throw new AuthFnInsufficientScopeError('Insufficient scope', {
      requiredScopes: required,
      missingScopes: missing
    });
  }
}

function missingScopes(
  session: Pick<AuthFnSession, 'scopes'> | null | undefined,
  required: readonly string[]
): string[] {
  // Read only `session.scopes`: metadata and subject attributes can carry
  // caller-supplied values and are never a grant.
  const granted = Array.isArray(session?.scopes)
    ? session.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  return required.filter((scope) => !granted.some((grant) => grantCovers(grant, scope)));
}

function grantCovers(grant: string, needed: string): boolean {
  if (grant === AUTHFN_ALL_SCOPES || grant === needed) {
    return true;
  }

  const grantParts = splitScope(grant);
  return grantParts !== null &&
    grantParts.action === OWNER_WILDCARD_ACTION &&
    grantParts.owner === splitScope(needed)?.owner;
}

function readNeededScopes(
  needed: string | readonly string[],
  registry: AuthFnScopeRegistry | undefined
): string[] {
  const list = typeof needed === 'string' ? [needed] : needed;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError('requireScopes needs at least one scope');
  }

  const owners = registry === undefined ? undefined : normalizeScopeRegistry(registry);
  for (const scope of list) {
    const parts = typeof scope === 'string' ? splitScope(scope) : null;
    if (!parts || !SCOPE_SEGMENT.test(parts.owner) || !SCOPE_SEGMENT.test(parts.action)) {
      throw new TypeError(`requireScopes needs concrete <owner>:<action> scopes; received ${JSON.stringify(scope)}`);
    }
    if (owners && !owners.get(parts.owner)?.has(parts.action)) {
      throw new TypeError(`requireScopes received unregistered scope ${JSON.stringify(scope)}`);
    }
  }

  return [...new Set(list as readonly string[])];
}

function isGrantableScope(owners: NormalizedRegistry, scope: string): boolean {
  if (scope === AUTHFN_ALL_SCOPES) {
    return true;
  }

  const parts = splitScope(scope);
  if (!parts) {
    return false;
  }

  const actions = owners.get(parts.owner);
  return actions !== undefined &&
    (parts.action === OWNER_WILDCARD_ACTION || actions.has(parts.action));
}

function splitScope(scope: string): { owner: string; action: string } | null {
  const separator = scope.indexOf(':');
  if (separator <= 0 || separator !== scope.lastIndexOf(':') || separator === scope.length - 1) {
    return null;
  }

  return { owner: scope.slice(0, separator), action: scope.slice(separator + 1) };
}

function normalizeScopeRegistry(registry: unknown): NormalizedRegistry {
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
    throw new AuthFnConfigError('authfn scopes must map each owner to an array of actions');
  }

  const owners = new Map<string, ReadonlySet<string>>();
  for (const [owner, actions] of Object.entries(registry)) {
    if (!SCOPE_SEGMENT.test(owner)) {
      throw new AuthFnConfigError(`authfn scope owner ${JSON.stringify(owner)} is invalid`, { owner });
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new AuthFnConfigError(`authfn scope owner ${JSON.stringify(owner)} must list at least one action`, { owner });
    }
    for (const action of actions) {
      if (typeof action !== 'string' || !SCOPE_SEGMENT.test(action)) {
        throw new AuthFnConfigError(`authfn scope action ${JSON.stringify(action)} for ${JSON.stringify(owner)} is invalid`, {
          owner,
          action
        });
      }
    }
    owners.set(owner, new Set(actions as string[]));
  }

  return owners;
}
