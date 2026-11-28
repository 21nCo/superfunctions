import { CredentialMinterError, ScopeNotGrantable } from 'plugfn/credentials';
import type { CredentialMinter, CredentialMintRequest, MintedCredential } from 'plugfn/credentials';
import {
  GITHUB_APP_PROVIDER,
  githubAppScopeGrammar,
  githubPermissionLevelIndex,
  toAccessTokenRequest,
  type GitHubAppScope,
  type GitHubAppScopeGrammar,
} from './grammar.js';
import { githubAppJwtClaims, signGitHubAppJwt } from './jwt.js';
import { importGitHubAppPrivateKey, pemToPkcs8, type GitHubAppSigningKey } from './key.js';

/** GitHub installation access tokens live for one hour; GitHub does not let a caller shorten that. */
export const GITHUB_INSTALLATION_TOKEN_LIFETIME_SECONDS = 3600;

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'plugfn-github-app-minter';
const GITHUB_API_VERSION = '2022-11-28';
const INSTALLATION_ID = /^[1-9][0-9]{0,18}$/;
const MAX_PROVIDER_MESSAGE_LENGTH = 200;
/** The one permission GitHub may report on a token without it being requested, at `read` only. */
const IMPLICIT_PERMISSION = 'metadata';
/** Three base64url segments: anything shaped like a JWT. */
const JWT_SHAPE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
/** GitHub token prefixes (`ghs_`, `ghp_`, `gho_`, `ghu_`, `ghr_`, `github_pat_`) followed by the token body. */
const GITHUB_TOKEN_SHAPE = /\b(?:gh[a-z]_|github_pat_)[A-Za-z0-9_]+/g;

/** A GitHub App installation: its numeric ID, as a number or a decimal string. */
export type GitHubAppInstallation = number | string;

export interface GitHubAppMinterOptions {
  /** The App ID or client ID, used as the App JWT `iss`. */
  readonly appId: string | number;
  /** The App private key as PEM: PKCS#1 (`BEGIN RSA PRIVATE KEY`, as GitHub issues it) or PKCS#8 (`BEGIN PRIVATE KEY`). */
  readonly privateKey: string;
  /** REST API root, `https://api.github.com` by default; for GitHub Enterprise Server, `https://<host>/api/v3`. Must be `https:`. */
  readonly baseUrl?: string;
  /** The `fetch` to call GitHub with; the global `fetch` by default. */
  readonly fetch?: typeof fetch;
  /** Current time in milliseconds; `Date.now` by default. */
  readonly now?: () => number;
  /** The `User-Agent` header GitHub requires. */
  readonly userAgent?: string;
}

interface HandleState {
  readonly owner: object;
  readonly token: string;
  revoked: boolean;
  inflight: Promise<void> | undefined;
}

const handleStates = new WeakMap<GitHubAppRevokeHandle, HandleState>();
const HANDLE_CONSTRUCTION = Symbol('GitHubAppRevokeHandle');

/**
 * Revokes one minted installation token. Opaque: the token is held outside
 * the object, so serialising or inspecting a handle never reveals it, and only
 * the minter that minted it can revoke it, in the same process.
 */
export class GitHubAppRevokeHandle {
  readonly installationId: string;
  readonly #expiresAtMs: number;

  /** @internal Handles are created only by a GitHub App minter. */
  constructor(construction: symbol, installationId: string, expiresAtMs: number) {
    if (construction !== HANDLE_CONSTRUCTION) throw new TypeError('GitHubAppRevokeHandle is created only by a GitHub App minter');
    this.installationId = installationId;
    this.#expiresAtMs = expiresAtMs;
    Object.freeze(this);
  }

  /** When the token expires on its own. */
  get expiresAt(): Date {
    return new Date(this.#expiresAtMs);
  }

  toJSON(): { provider: string; installationId: string; expiresAt: string } {
    return { provider: GITHUB_APP_PROVIDER, installationId: this.installationId, expiresAt: this.expiresAt.toISOString() };
  }
}

export type GitHubAppMinter = CredentialMinter<GitHubAppInstallation, GitHubAppScope, GitHubAppRevokeHandle, GitHubAppScopeGrammar>;

function fail(code: ConstructorParameters<typeof CredentialMinterError>[1], message: string, options?: { status?: number; retryable?: boolean; cause?: unknown }): CredentialMinterError {
  return new CredentialMinterError(GITHUB_APP_PROVIDER, code, message, options);
}

/** Removes the given secrets, and anything shaped like a JWT or GitHub token, from untrusted text. */
function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out.replace(JWT_SHAPE, '[redacted]').replace(GITHUB_TOKEN_SHAPE, '[redacted]');
}

/** A cause that keeps the original error's name and redacted message, but none of its other fields. */
function redactedCause(error: unknown, secrets: readonly string[]): Error {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'non-Error value';
  const cause = new Error(redact(message, secrets).slice(0, MAX_PROVIDER_MESSAGE_LENGTH));
  cause.name = name;
  return cause;
}

/** GitHub's `message` from an error body, shortened and redacted, or an empty string. */
function providerMessage(body: string, secrets: readonly string[]): string {
  let message: unknown;
  try {
    message = (JSON.parse(body) as { message?: unknown } | null)?.message;
  } catch {
    return '';
  }
  if (typeof message !== 'string' || message.length === 0) return '';
  return `: ${redact(message, secrets).slice(0, MAX_PROVIDER_MESSAGE_LENGTH)}`;
}

function normalizeAppId(appId: unknown): string {
  if (typeof appId === 'number' && Number.isSafeInteger(appId) && appId > 0) return String(appId);
  if (typeof appId === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(appId)) return appId;
  throw new TypeError('GitHub App minter: appId must be a positive integer App ID or a client ID');
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('GitHub App minter: baseUrl must be an absolute URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('GitHub App minter: baseUrl must be an https: URL without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function normalizeInstallation(installation: unknown): string {
  const id = typeof installation === 'number' && Number.isSafeInteger(installation) ? String(installation) : installation;
  if (typeof id !== 'string' || !INSTALLATION_ID.test(id) || !Number.isSafeInteger(Number(id))) {
    throw fail('invalid_request', 'The installation must be a positive integer GitHub App installation ID');
  }
  return id;
}

function validateTtl(ttl: unknown): number {
  if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0) {
    throw fail('invalid_request', 'ttl must be a positive whole number of seconds');
  }
  if (ttl > GITHUB_INSTALLATION_TOKEN_LIFETIME_SECONDS) {
    throw new ScopeNotGrantable(
      GITHUB_APP_PROVIDER,
      `GitHub installation tokens live at most ${GITHUB_INSTALLATION_TOKEN_LIFETIME_SECONDS} seconds; ttl ${ttl} cannot be granted`,
    );
  }
  return ttl;
}

/** Errors for a non-2xx `access_tokens` response. */
function mintFailure(status: number, body: string, secrets: readonly string[]): CredentialMinterError {
  const detail = providerMessage(body, secrets);
  switch (status) {
    case 401:
      return fail('unauthorized', `GitHub rejected the App JWT (401)${detail}`, { status });
    case 403:
      return fail('forbidden', `GitHub refused to mint an installation token (403)${detail}`, { status });
    case 404:
      return fail('installation_not_found', `GitHub App installation not found (404)${detail}`, { status });
    case 422:
      return new ScopeNotGrantable(GITHUB_APP_PROVIDER, `GitHub cannot grant the requested repositories or permissions on this installation (422)${detail}`, { status });
    default:
      if (status === 429 || status >= 500) return fail('provider_unavailable', `GitHub is unavailable (${status})${detail}`, { status, retryable: true });
      return fail('provider_error', `Unexpected GitHub response (${status})${detail}`, { status });
  }
}

interface AccessTokenResponse {
  readonly token: string;
  readonly expiresAtMs: number;
}

/**
 * Reads a 201 `access_tokens` body and checks that GitHub granted no more
 * than requested. Returns the token even when the grant is too wide, so the
 * caller can revoke it before failing.
 */
function readAccessToken(
  body: string,
  requested: { repositories: readonly string[]; permissions: Readonly<Record<string, string>> },
): { token: AccessTokenResponse | undefined; problem: string | undefined } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { token: undefined, problem: 'GitHub returned an access token response that is not JSON' };
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const tokenValue = record.token;
  const expiresAtMs = typeof record.expires_at === 'string' ? Date.parse(record.expires_at) : Number.NaN;
  if (typeof tokenValue !== 'string' || !/^[\x21-\x7e]+$/.test(tokenValue) || !Number.isFinite(expiresAtMs)) {
    return { token: undefined, problem: 'GitHub returned an access token response without a usable token or expires_at' };
  }
  const token = { token: tokenValue, expiresAtMs };
  if (record.repository_selection !== undefined && record.repository_selection !== 'selected') {
    return { token, problem: 'GitHub granted the token every repository of the installation instead of the requested ones' };
  }
  if (Array.isArray(record.repositories)) {
    const allowed = new Set(requested.repositories);
    for (const repository of record.repositories) {
      const name = typeof repository === 'object' && repository !== null ? (repository as { name?: unknown }).name : undefined;
      if (typeof name !== 'string' || !allowed.has(name.toLowerCase())) {
        return { token, problem: 'GitHub granted the token a repository that was not requested' };
      }
    }
  }
  if (record.permissions !== undefined) {
    const granted = record.permissions;
    if (typeof granted !== 'object' || granted === null || Array.isArray(granted)) {
      return { token, problem: 'GitHub returned token permissions that cannot be checked' };
    }
    for (const [name, level] of Object.entries(granted)) {
      const requestedLevel = Object.hasOwn(requested.permissions, name) ? githubPermissionLevelIndex(requested.permissions[name]) : -1;
      const grantedLevel = githubPermissionLevelIndex(level);
      // Every GitHub App holds read-only repository metadata, and GitHub lists it on tokens it was not asked for.
      if (name === IMPLICIT_PERMISSION && level === 'read' && requestedLevel < 0) continue;
      if (requestedLevel < 0 || grantedLevel < 0 || grantedLevel > requestedLevel) {
        return { token, problem: 'GitHub granted the token a permission wider than requested' };
      }
    }
  }
  return { token, problem: undefined };
}

/**
 * Creates a GitHub App installation-token minter.
 *
 * `mint({ installation, scope, ttl })` signs a 10-minute RS256 App JWT with
 * WebCrypto and calls `POST /app/installations/{installation}/access_tokens`
 * with exactly the requested `repositories` and `permissions`. The scope must
 * name at least one repository and one permission, because GitHub widens an
 * omitted list to everything the installation holds. A 422 (a repository or
 * permission outside the installation), a scope that does not normalise, and
 * a `ttl` above one hour reject with `ScopeNotGrantable`. GitHub fixes the
 * token lifetime at one hour: `expiresAt` is GitHub's real expiry, which is
 * later than `now + ttl` for a shorter `ttl`; revoke the token at the end of
 * the caller's own deadline if it must not outlive it.
 *
 * `revoke(handle)` calls `DELETE /installation/token` with the token. It is
 * idempotent: a handle already revoked, an expired token and a 401 (GitHub's
 * answer for a token that no longer works) all resolve.
 *
 * Neither the App JWT nor the installation token is ever logged, and no error
 * message, field or cause contains them.
 */
export function createGitHubAppMinter(options: GitHubAppMinterOptions): GitHubAppMinter {
  const appId = normalizeAppId(options.appId);
  // Parse the PEM now so a bad key fails at construction; WebCrypto import is async and cached.
  pemToPkcs8(options.privateKey);
  const privateKeyPem = options.privateKey;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  let signingKey: Promise<GitHubAppSigningKey> | undefined;

  function loadSigningKey(): Promise<GitHubAppSigningKey> {
    if (!signingKey) {
      signingKey = importGitHubAppPrivateKey(privateKeyPem);
      // A failed import is not cached, so a retried mint imports again.
      signingKey.catch(() => {
        signingKey = undefined;
      });
    }
    return signingKey;
  }

  async function appJwt(): Promise<string> {
    let key: GitHubAppSigningKey;
    try {
      key = await loadSigningKey();
    } catch (error) {
      throw fail('invalid_configuration', 'The GitHub App private key cannot be used to sign the App JWT', { cause: redactedCause(error, []) });
    }
    return signGitHubAppJwt(key, githubAppJwtClaims(appId, Math.floor(now() / 1000)));
  }

  function headers(bearer: string): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${bearer}`,
      'user-agent': userAgent,
      'x-github-api-version': GITHUB_API_VERSION,
    };
  }

  async function call(method: string, url: string, bearer: string, body: string | undefined, secrets: readonly string[]): Promise<{ status: number; text: string }> {
    try {
      const init: RequestInit = { method, headers: headers(bearer), redirect: 'manual' };
      if (body !== undefined) {
        init.body = body;
        (init.headers as Record<string, string>)['content-type'] = 'application/json';
      }
      const response = await doFetch(url, init);
      return { status: response.status, text: await response.text() };
    } catch (error) {
      throw fail('provider_unavailable', `GitHub could not be reached (${method} ${new URL(url).pathname})`, {
        retryable: true,
        cause: redactedCause(error, secrets),
      });
    }
  }

  const owner = {};

  async function deleteToken(token: string): Promise<void> {
    const { status, text } = await call('DELETE', `${baseUrl}/installation/token`, token, undefined, [token]);
    // 401: GitHub no longer accepts the token (already revoked or expired), which is the goal.
    if (status === 204 || status === 401) return;
    const detail = providerMessage(text, [token]);
    if (status === 429 || status >= 500) throw fail('provider_unavailable', `GitHub is unavailable (${status})${detail}`, { status, retryable: true });
    throw fail('provider_error', `GitHub did not revoke the installation token (${status})${detail}`, { status });
  }

  const minter: GitHubAppMinter = {
    provider: GITHUB_APP_PROVIDER,
    grammar: githubAppScopeGrammar,

    async mint(request: CredentialMintRequest<GitHubAppInstallation, GitHubAppScope>): Promise<MintedCredential<GitHubAppRevokeHandle>> {
      if (typeof request !== 'object' || request === null) throw fail('invalid_request', 'mint needs { installation, scope, ttl }');
      const installationId = normalizeInstallation(request.installation);
      validateTtl(request.ttl);
      const normalized = githubAppScopeGrammar.normalize(request.scope);
      if (!normalized.ok) {
        throw new ScopeNotGrantable(GITHUB_APP_PROVIDER, 'The scope is not a valid GitHub App scope', { violations: normalized.violations });
      }
      const grant = toAccessTokenRequest(normalized.scope);
      if (grant.repositories.length === 0 || Object.keys(grant.permissions).length === 0) {
        throw new ScopeNotGrantable(
          GITHUB_APP_PROVIDER,
          'A GitHub App scope must name at least one repository and one permission: GitHub widens an empty list to the whole installation',
        );
      }

      const jwt = await appJwt();
      const { status, text } = await call(
        'POST',
        `${baseUrl}/app/installations/${installationId}/access_tokens`,
        jwt,
        JSON.stringify(grant),
        [jwt],
      );
      if (status !== 201) throw mintFailure(status, text, [jwt]);

      const { token, problem } = readAccessToken(text, grant);
      if (problem !== undefined || token === undefined) {
        // Fail closed: a token GitHub widened is revoked before reporting the failure.
        if (token) await deleteToken(token.token).catch(() => undefined);
        throw fail('provider_error', problem ?? 'GitHub returned an unusable access token response', { status });
      }
      if (token.expiresAtMs <= now()) {
        throw fail('provider_error', 'GitHub returned an installation token that has already expired', { status });
      }

      const revokeHandle = new GitHubAppRevokeHandle(HANDLE_CONSTRUCTION, installationId, token.expiresAtMs);
      handleStates.set(revokeHandle, { owner, token: token.token, revoked: false, inflight: undefined });
      return Object.freeze({ secret: token.token, expiresAt: new Date(token.expiresAtMs), revokeHandle });
    },

    async revoke(handle: GitHubAppRevokeHandle): Promise<void> {
      const state = typeof handle === 'object' && handle !== null ? handleStates.get(handle) : undefined;
      if (!state || state.owner !== owner) throw new TypeError('revoke needs a revokeHandle this GitHub App minter returned');
      if (state.revoked) return;
      if (handle.expiresAt.getTime() <= now()) {
        state.revoked = true;
        return;
      }
      if (!state.inflight) {
        state.inflight = deleteToken(state.token).then(
          () => {
            state.revoked = true;
            state.inflight = undefined;
          },
          (error: unknown) => {
            state.inflight = undefined;
            throw error;
          },
        );
      }
      return state.inflight;
    },
  };
  return Object.freeze(minter);
}
