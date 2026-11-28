import { CredentialMinterError, ScopeNotGrantable } from 'plugfn/credentials';
import type { CredentialMinter, CredentialMinterErrorOptions, CredentialMintRequest, MintedCredential } from 'plugfn/credentials';
import {
  GITHUB_APP_PROVIDER,
  githubAppScopeGrammar,
  githubPermissionLevelIndex,
  toAccessTokenRequest,
  type GitHubAppNormalizedScope,
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
const INSTALLATION_ID = /^[1-9]\d{0,18}$/;
const MAX_PROVIDER_MESSAGE_LENGTH = 200;
/** The one permission GitHub may report on a token without it being requested, at `read` only. */
const IMPLICIT_PERMISSION = 'metadata';
/** A maximal run of base64url characters and dots, checked for a JWT shape by {@link hasJwtShape} (linear time). */
const BASE64URL_RUN = /[\w.-]+/g;
/** GitHub token prefixes (`ghs_`, `ghp_`, `gho_`, `ghu_`, `ghr_`, `github_pat_`) followed by the token body. */
const GITHUB_TOKEN_SHAPE = /\b(?:gh[a-z]_|github_pat_)\w+/g;
/** An error `name` kept on a redacted cause; anything else becomes `Error`. */
const ERROR_NAME = /^[A-Za-z]\w{0,63}$/;
/** A `User-Agent` that can be sent as a header: printable ASCII. */
const USER_AGENT = /^[\x20-\x7e]{1,256}$/;
/**
 * The token at the start of a 201 body (GitHub sends `token` first), read
 * from a body too large or broken to parse so the token can still be revoked.
 */
const LEADING_TOKEN = /^\s*\{\s*"token"\s*:\s*"([^"\\]{1,4096})"/;
/** A token GitHub returned that can be sent back in an `Authorization` header. */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]{1,4096}$/;
/** `expires_at` as GitHub sends it: an ISO-8601 UTC timestamp, such as `2016-07-11T22:14:10Z`. */
const ISO_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
/**
 * How far GitHub's clock may run ahead of ours: a returned `expires_at` later
 * than now + one hour + this tolerance is not a GitHub installation token's
 * and is rejected.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Attempts at the cleanup `DELETE` of a token the minter rejected. */
const CLEANUP_ATTEMPTS = 3;
const DEFAULT_CLEANUP_RETRY_DELAY_MS = 250;
/** How long the minter waits for a response body before treating it as unreadable. */
const BODY_READ_TIMEOUT_MS = 10_000;
/**
 * How long, from the response, a 201 body that missed {@link BODY_READ_TIMEOUT_MS}
 * is still read, so a token arriving late is revoked rather than left live;
 * then it is cancelled. It leaves the cleanup time within the 30 seconds
 * Workers allow `waitUntil` work after a response.
 */
const LATE_BODY_LIMIT_MS = 20_000;
/** GitHub's limit on the repositories one installation token can name. */
export const GITHUB_MAX_TOKEN_REPOSITORIES = 500;
/** Error bodies larger than this are cancelled and treated as unreadable. */
const MAX_ERROR_BODY_BYTES = 1024 * 1024;
/**
 * 201 bodies larger than this are cancelled and treated as unreadable. GitHub
 * lists a full repository object (a few KiB) per granted repository; this
 * leaves 16 KiB for each of {@link GITHUB_MAX_TOKEN_REPOSITORIES}.
 */
const MAX_GRANT_BODY_BYTES = GITHUB_MAX_TOKEN_REPOSITORIES * 16 * 1024;
/** How much of an unreadable body is kept to look for its {@link LEADING_TOKEN}. */
const BODY_HEAD_CHARS = 64 * 1024;
/**
 * How long a key stays held after its POST may have issued a token: the token
 * lifetime plus the clock-skew tolerance, since GitHub may issue it after the
 * minter last heard from it and its clock may run ahead of ours.
 */
const KEY_HOLD_MS = GITHUB_INSTALLATION_TOKEN_LIFETIME_SECONDS * 1000 + MAX_CLOCK_SKEW_MS;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

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
  /**
   * Milliseconds on a clock that wall-clock changes do not move, which
   * idempotency-key holds are measured on; `performance.now` by default.
   */
  readonly monotonicNow?: () => number;
  /** The `User-Agent` header GitHub requires. */
  readonly userAgent?: string;
  /**
   * Milliseconds before the second cleanup `DELETE` of a rejected token (the
   * third waits twice as long); 250 by default.
   */
  readonly cleanupRetryDelayMs?: number;
  /**
   * Keeps background work alive past the request that started it: the read
   * of a late 201 body and the revocation of the token in it. On Cloudflare
   * Workers pass `waitUntil` from `cloudflare:workers` (or `ctx.waitUntil`
   * bound to the request's context); without it, Workers may stop that work
   * when the request ends, and the late token stays active until it expires.
   */
  readonly waitUntil?: (task: Promise<unknown>) => void;
}

interface HandleState {
  readonly owner: object;
  readonly token: string;
  readonly expiresAtMs: number;
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

/**
 * What `mint` accepts as `scope`: the frozen snapshot `githubAppScopeGrammar.isSubset`
 * (or `normalize`) returned, which is what a policy-checked caller should pass,
 * or a provider-shaped {@link GitHubAppScope}, normalised once.
 */
export type GitHubAppMintScope = GitHubAppNormalizedScope | GitHubAppScope;

export type GitHubAppMinter = CredentialMinter<GitHubAppInstallation, GitHubAppMintScope, GitHubAppRevokeHandle, GitHubAppScopeGrammar>;

function fail(code: ConstructorParameters<typeof CredentialMinterError>[1], message: string, options?: CredentialMinterErrorOptions): CredentialMinterError {
  return new CredentialMinterError(GITHUB_APP_PROVIDER, code, message, options);
}

/** Whether a base64url-and-dots run holds three consecutive dot-separated segments of 8 or more characters (a JWT). */
function hasJwtShape(run: string): boolean {
  let segments = 0;
  for (const segment of run.split('.')) {
    segments = segment.length >= 8 ? segments + 1 : 0;
    if (segments === 3) return true;
  }
  return false;
}

/** Removes the given secrets, and anything shaped like a JWT or GitHub token, from untrusted text. */
function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out.replace(BASE64URL_RUN, (run) => (hasJwtShape(run) ? '[redacted]' : run)).replace(GITHUB_TOKEN_SHAPE, '[redacted]');
}

/**
 * A cause that keeps the original error's redacted message and, when it is a
 * plain identifier, its name, but none of its other fields.
 */
function redactedCause(error: unknown, secrets: readonly string[]): Error {
  let name = 'Error';
  let message = 'non-Error value';
  // Every read is guarded: a throwing accessor (or Proxy trap) could carry a
  // secret in what it throws, so its throw is dropped, never propagated.
  try {
    if (typeof error === 'string') message = error;
    else if (error instanceof Error) {
      // Read each field once: a getter could answer differently on a second read.
      const rawName: unknown = error.name;
      const rawMessage: unknown = error.message;
      const redactedName = typeof rawName === 'string' ? redact(rawName, secrets) : '';
      if (ERROR_NAME.test(redactedName)) name = redactedName;
      message = typeof rawMessage === 'string' ? rawMessage : '';
    }
  } catch {
    name = 'Error';
    message = 'unreadable error';
  }
  const cause = new Error(redact(message, secrets).slice(0, MAX_PROVIDER_MESSAGE_LENGTH));
  cause.name = name;
  return cause;
}

/** Milliseconds for a strict ISO-8601 UTC timestamp, or `NaN` for anything else (`"2050"` included). */
function parseExpiresAt(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const match = ISO_UTC_TIMESTAMP.exec(value);
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, Number((match[7] ?? '').padEnd(3, '0').slice(0, 3)));
  const date = new Date(ms);
  // Reject a field Date.UTC would carry over (month 13, February 30, hour 24) and two-digit years.
  const exact =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  // Fractional seconds are kept to the millisecond; finer digits are dropped, which only makes the expiry earlier.
  return exact ? ms : Number.NaN;
}

function validateIdempotencyKey(key: unknown): string | undefined {
  if (key === undefined) return undefined;
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw fail('invalid_request', `idempotencyKey must be a string of 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  return key;
}

function validateRetryDelay(delay: unknown): number {
  if (delay === undefined) return DEFAULT_CLEANUP_RETRY_DELAY_MS;
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
    throw new TypeError('GitHub App minter: cleanupRetryDelayMs must be a non-negative number');
  }
  return delay;
}

function validateUserAgent(userAgent: unknown): string {
  if (userAgent === undefined) return DEFAULT_USER_AGENT;
  if (typeof userAgent !== 'string' || !USER_AGENT.test(userAgent)) {
    throw new TypeError('GitHub App minter: userAgent must be 1 to 256 printable ASCII characters');
  }
  return userAgent;
}

function validateClock(clock: unknown): (() => number) | undefined {
  if (clock !== undefined && typeof clock !== 'function') throw new TypeError('GitHub App minter: monotonicNow must be a function');
  return clock as (() => number) | undefined;
}

function validateWaitUntil(waitUntil: unknown): ((task: Promise<unknown>) => void) | undefined {
  if (waitUntil !== undefined && typeof waitUntil !== 'function') throw new TypeError('GitHub App minter: waitUntil must be a function');
  return waitUntil as ((task: Promise<unknown>) => void) | undefined;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

interface BodyReading {
  readonly result: Promise<BodyRead>;
  /** The start of what has been read so far. */
  peek(): string;
  /** Stops reading and cancels the stream. */
  cancel(): void;
}

interface BodyRead {
  /** The whole body, or `undefined` when it failed, was too large or did not finish in time. */
  readonly text: string | undefined;
  /** The start of what was read, kept when `text` is `undefined`. */
  readonly head: string;
}

/**
 * Reads a response body as text, within `limitMs` and `maxBytes`. Every
 * outcome but a complete read cancels the stream, so no stalled read stays
 * open after the minter is done with it (Cloudflare Workers limit open
 * subrequests).
 */
function startBodyRead(response: Response, limitMs: number, maxBytes: number): BodyReading {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const stream = response.body;
    if (stream === null) return { result: Promise.resolve({ text: '', head: '' }), peek: () => '', cancel: () => undefined };
    reader = stream.getReader();
  } catch {
    return { result: Promise.resolve({ text: undefined, head: '' }), peek: () => '', cancel: () => undefined };
  }
  let finished = false;
  const finish = (cancel: boolean): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (cancel) reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  };
  const timer = setTimeout(() => finish(true), limitMs);
  const decoder = new TextDecoder();
  let out = '';
  const unread = (): BodyRead => {
    finish(true);
    return { text: undefined, head: out.slice(0, BODY_HEAD_CHARS) };
  };
  const result = (async (): Promise<BodyRead> => {
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (finished) return unread();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          // Keep the start of the body even when its first chunk is the one too large.
          if (out.length < BODY_HEAD_CHARS) out += decoder.decode(chunk.value.subarray(0, BODY_HEAD_CHARS));
          return unread();
        }
        out += decoder.decode(chunk.value, { stream: true });
      }
      out += decoder.decode();
    } catch {
      return unread();
    }
    finish(false);
    return { text: out, head: '' };
  })();
  return { result, peek: () => out.slice(0, BODY_HEAD_CHARS), cancel: () => finish(true) };
}

/** An error response body, or `undefined` when it cannot be read within {@link BODY_READ_TIMEOUT_MS} (the stream is then cancelled). */
async function readBody(response: Response): Promise<string | undefined> {
  return (await startBodyRead(response, BODY_READ_TIMEOUT_MS, MAX_ERROR_BODY_BYTES).result).text;
}

const TIMED_OUT = Symbol('timed out');

/** `promise`, or {@link TIMED_OUT} if it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** `value` when it is a token string that can be sent back to GitHub. */
function usableToken(value: unknown): string | undefined {
  return typeof value === 'string' && HEADER_SAFE_TOKEN.test(value) ? value : undefined;
}

/** The usable token a 201 body carries, if any: from the parsed body, or from the start of one that cannot be read or parsed whole. */
function bodyToken(body: BodyRead): string | undefined {
  const text = body.text ?? body.head;
  try {
    const token = usableToken((JSON.parse(text) as { token?: unknown } | null)?.token);
    if (token !== undefined) return token;
  } catch {
    // Not whole JSON: look for the leading token below.
  }
  return usableToken(LEADING_TOKEN.exec(text.slice(0, BODY_HEAD_CHARS))?.[1]);
}

/** Releases a body the minter will not read. */
function discardBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => undefined);
  } catch {
    // Nothing to release.
  }
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
  let href = url.href;
  while (href.endsWith('/')) href = href.slice(0, -1);
  return href;
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
function mintFailure(status: number, body: string | undefined, secrets: readonly string[]): CredentialMinterError {
  const detail = providerMessage(body ?? '', secrets);
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

interface ReadAccessToken {
  /** The token string GitHub returned, when it is one; revoked by the caller if `problem` is set. */
  readonly token: string | undefined;
  readonly expiresAtMs: number;
  readonly problem: string | undefined;
}

/**
 * Reads a 201 `access_tokens` body and checks that GitHub granted exactly
 * what was requested. It fails closed: the grant must say
 * `repository_selection: "selected"`, list every requested repository and no
 * other, and list every requested permission at the requested level and no
 * other (except read-only `metadata`), and `expires_at` must be an ISO-8601
 * UTC timestamp. Returns any usable token string even when the response is
 * rejected, so the caller can revoke it before failing.
 */
function readAccessToken(body: string, requested: GrantRequest): ReadAccessToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { token: undefined, expiresAtMs: Number.NaN, problem: 'GitHub returned an access token response that is not JSON' };
  }
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const token = usableToken(record.token);
  const expiresAtMs = parseExpiresAt(record.expires_at);
  let problem: string | undefined;
  if (token === undefined) problem = 'GitHub returned an access token response without a usable token';
  else if (!Number.isFinite(expiresAtMs)) problem = 'GitHub returned an access token response without a usable expires_at';
  else problem = repositoriesProblem(record, requested.repositories) ?? permissionsProblem(record.permissions, requested.permissions);
  return { token, expiresAtMs, problem };
}

type GrantRequest = ReturnType<typeof toAccessTokenRequest>;

/** Why a 201's repositories are not exactly the requested ones, if they are not. */
function repositoriesProblem(record: Record<string, unknown>, requested: readonly string[]): string | undefined {
  if (record.repository_selection !== 'selected') return 'GitHub did not confirm that the token is limited to the requested repositories';
  const repositories = record.repositories;
  if (!Array.isArray(repositories)) return 'GitHub did not list the repositories granted to the token';
  const allowed = new Set(requested);
  const granted = new Set<string>();
  for (const repository of repositories) {
    const name = typeof repository === 'object' && repository !== null ? (repository as { name?: unknown }).name : undefined;
    if (typeof name !== 'string' || !allowed.has(name.toLowerCase())) return 'GitHub granted the token a repository that was not requested';
    granted.add(name.toLowerCase());
  }
  return requested.every((repository) => granted.has(repository)) ? undefined : 'GitHub did not grant the token every requested repository';
}

/** Why a 201's permissions are not exactly the requested levels (plus read-only `metadata`), if they are not. */
function permissionsProblem(granted: unknown, requested: Readonly<Record<string, string>>): string | undefined {
  if (typeof granted !== 'object' || granted === null || Array.isArray(granted)) return 'GitHub did not list the permissions granted to the token';
  for (const [name, level] of Object.entries(granted)) {
    const requestedLevel = Object.hasOwn(requested, name) ? githubPermissionLevelIndex(requested[name]) : -1;
    const grantedLevel = githubPermissionLevelIndex(level);
    // Every GitHub App holds read-only repository metadata, and GitHub lists it on tokens it was not asked for.
    if (name === IMPLICIT_PERMISSION && level === 'read' && requestedLevel < 0) continue;
    if (requestedLevel < 0 || grantedLevel < 0 || grantedLevel > requestedLevel) return 'GitHub granted the token a permission wider than requested';
  }
  for (const [name, level] of Object.entries(requested)) {
    const grantedLevel = Object.hasOwn(granted, name) ? githubPermissionLevelIndex((granted as Record<string, unknown>)[name]) : -1;
    if (grantedLevel !== githubPermissionLevelIndex(level)) return 'GitHub did not grant the token every requested permission at the requested level';
  }
  return undefined;
}

/**
 * Creates a GitHub App installation-token minter.
 *
 * `mint({ installation, scope, ttl, idempotencyKey? })` signs a 10-minute
 * RS256 App JWT with WebCrypto and calls
 * `POST /app/installations/{installation}/access_tokens` with exactly the
 * requested `repositories` and `permissions`. Pass as `scope` the frozen
 * snapshot `grammar.isSubset(request, envelope)` returned: the minter builds
 * the grant from that snapshot alone, so the policy check and the mint read
 * the same scope. A provider-shaped scope is also accepted and normalised
 * once, for a caller that checks no envelope. The scope must name at least
 * one repository and one permission, because GitHub widens an omitted list to
 * everything the installation holds. A 422 (a repository or permission
 * outside the installation), a scope that does not normalise, and a `ttl`
 * above one hour reject with `ScopeNotGrantable`. GitHub fixes the token
 * lifetime at one hour: `expiresAt` is GitHub's real expiry, which is later
 * than `now + ttl` for a shorter `ttl`; revoke the token at the end of the
 * caller's own deadline if it must not outlive it. GitHub names at most
 * {@link GITHUB_MAX_TOKEN_REPOSITORIES} repositories per token; a larger scope
 * is `ScopeNotGrantable`.
 *
 * GitHub's 201 must grant exactly the request (see `readAccessToken`), with
 * an `expires_at` in the future and no later than one hour plus a five-minute
 * clock-skew tolerance from now. Otherwise the minter revokes the returned
 * token, retrying a transient failure of that `DELETE` up to three attempts,
 * and rejects with `provider_error`. When the cleanup still fails it rejects
 * with `rejected_credential_not_revoked`, carrying a `revokeHandle` that
 * `revoke` accepts to finish the cleanup; the token stays active until then,
 * or until it expires. A 201 whose body cannot be read within 10 seconds, or
 * carries no usable token, rejects with the non-retryable
 * `mint_outcome_unknown`; a body that arrives later (within 20 seconds of the response) is
 * still read, and any token in it is revoked, never returned. On Workers that
 * late work outlives the request only through the `waitUntil` option. A 201
 * body too large or broken to read whole is searched for its leading token,
 * which is revoked as for a rejected grant.
 *
 * Retries: GitHub has no idempotency key, so the minter keeps one per
 * instance, in memory. Mints with the same `idempotencyKey` and request share
 * one POST and return the same credential until it is revoked or expires; the
 * key with a different request rejects with `invalid_request`. A keyed mint
 * never sends a second POST while a token from an earlier POST under its key
 * may be live: a transport failure after the request was sent, a 5xx or any
 * other answer that is neither 201 nor 4xx, and a lost or unusable 201
 * reject with `mint_outcome_unknown`, and the key repeats that failure for one
 * hour plus the five-minute skew tolerance, by when any such token has
 * expired. A `rejected_credential_not_revoked` failure is repeated, with the
 * same `revokeHandle`, until that handle is revoked or its token expires (plus
 * the tolerance). A credential is returned again until it is revoked or
 * expires; from its `expires_at` until the tolerance has passed, the key
 * rejects with a retryable `provider_unavailable`. A mint that never settles
 * (on Workers, its request was cancelled) holds its key for that hour plus
 * tolerance from its POST (GitHub ends any request it takes longer than 10
 * seconds to process), then frees it; if it settles later, its token is
 * revoked, never returned. Holds run on `monotonicNow` (`performance.now()`
 * by default), which wall-clock changes cannot move. Only a definite
 * non-issuance (a failure before the POST, or a 4xx) frees the key at once. Without a key, a transport
 * failure or 5xx is a retryable `provider_unavailable`: if GitHub had already
 * created a token, it is unknown to the minter and expires within the hour.
 *
 * `revoke(handle)` calls `DELETE /installation/token` with the token. It is
 * idempotent: a handle already revoked resolves without a call, and a 401
 * (GitHub's answer for a revoked or expired token) counts as revoked.
 *
 * Neither the App JWT nor the installation token is ever logged, and no error
 * message, field or cause contains them.
 *
 * Trust boundary: code running in the caller's realm (a scope getter, a
 * patched built-in or `fetch`) has the caller's own authority and is not
 * defended against; a compromised app private key is out of scope (SFNS-115).
 */
export function createGitHubAppMinter(options: GitHubAppMinterOptions): GitHubAppMinter {
  const appId = normalizeAppId(options.appId);
  // Parse the PEM now so a bad key fails at construction; WebCrypto import is async and cached.
  pemToPkcs8(options.privateKey);
  const privateKeyPem = options.privateKey;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  /** The clock key holds are measured on: the injected `now`, or else one that wall-clock changes cannot move. */
  const elapsed = validateClock(options.monotonicNow) ?? (() => performance.now());
  const userAgent = validateUserAgent(options.userAgent);
  const cleanupRetryDelayMs = validateRetryDelay(options.cleanupRetryDelayMs);
  const waitUntil = validateWaitUntil(options.waitUntil);
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

  /** Sends one request; a transport failure becomes a redacted, retryable `provider_unavailable`. */
  async function send(method: string, url: string, bearer: string, body: string | undefined, secrets: readonly string[]): Promise<Response> {
    try {
      const init: RequestInit = { method, headers: headers(bearer), redirect: 'manual' };
      if (body !== undefined) {
        init.body = body;
        (init.headers as Record<string, string>)['content-type'] = 'application/json';
      }
      return await doFetch(url, init);
    } catch (error) {
      throw fail('provider_unavailable', `GitHub could not be reached (${method} ${new URL(url).pathname})`, {
        retryable: true,
        cause: redactedCause(error, secrets),
      });
    }
  }

  const owner = {};

  function registerHandle(installationId: string, token: string, expiresAtMs: number): GitHubAppRevokeHandle {
    const handle = new GitHubAppRevokeHandle(HANDLE_CONSTRUCTION, installationId, expiresAtMs);
    handleStates.set(handle, { owner, token, expiresAtMs, revoked: false, inflight: undefined });
    return handle;
  }

  /**
   * The normalised scope to mint: the snapshot itself when `scope` is one
   * this grammar returned (checked by identity through `classifyScope`), or
   * else one normalisation of the provider-shaped input.
   */
  function approvedScope(scope: unknown): GitHubAppNormalizedScope {
    if (typeof scope === 'object' && scope !== null) {
      try {
        githubAppScopeGrammar.classifyScope(scope as GitHubAppNormalizedScope);
        return scope as GitHubAppNormalizedScope;
      } catch {
        // Not a snapshot of this grammar: normalise it as provider-shaped input below.
      }
    }
    const normalized = githubAppScopeGrammar.normalize(scope as GitHubAppScope);
    if (!normalized.ok) {
      throw new ScopeNotGrantable(GITHUB_APP_PROVIDER, 'The scope is not a valid GitHub App scope', { violations: normalized.violations });
    }
    return normalized.scope;
  }

  /**
   * One `DELETE /installation/token`. The status decides: 204 and 401 (the
   * token no longer works) both mean revoked, and their body is released unread.
   */
  async function deleteToken(token: string): Promise<void> {
    const response = await send('DELETE', `${baseUrl}/installation/token`, token, undefined, [token]);
    const status = response.status;
    if (status === 204 || status === 401) {
      discardBody(response);
      return;
    }
    const detail = providerMessage((await readBody(response)) ?? '', [token]);
    if (status === 429 || status >= 500) throw fail('provider_unavailable', `GitHub is unavailable (${status})${detail}`, { status, retryable: true });
    throw fail('provider_error', `GitHub did not revoke the installation token (${status})${detail}`, { status });
  }

  /** {@link deleteToken}, retried after a retryable failure (429, 5xx, network) up to {@link CLEANUP_ATTEMPTS} attempts. */
  async function deleteTokenWithRetry(token: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await deleteToken(token); // NOSONAR: cleanup attempts are sequential by design; each waits for the previous answer.
        return;
      } catch (error) {
        if (attempt >= CLEANUP_ATTEMPTS || !(error instanceof CredentialMinterError) || !error.retryable) throw error;
      }
      await sleep(cleanupRetryDelayMs * attempt);
    }
  }

  /**
   * How long an idempotency key stays held after a mint that may have left
   * a token live: until `handle` is revoked (when the minter holds the
   * token) or `untilMs`, by which any such token has expired.
   */
  interface KeyHold {
    readonly handle: GitHubAppRevokeHandle | undefined;
    readonly untilMs: number;
    /** For a credential: when it expires (wall clock); past it, the key returns no credential. */
    readonly expiresAtMs?: number;
  }
  /** Each credential's key hold end, on the hold clock, from the same observation that validated its expiry. */
  const credentialHolds = new WeakMap<GitHubAppRevokeHandle, number>();
  /** Failures after which a token may be live, and the hold they put on their idempotency key. */
  const keyHolds = new WeakMap<CredentialMinterError, KeyHold>();

  /** A failure that leaves the key held; every other mint failure is a definite non-issuance and frees it. */
  function holding(error: CredentialMinterError, hold: KeyHold): CredentialMinterError {
    keyHolds.set(error, hold);
    return error;
  }

  /**
   * `mint_outcome_unknown`: GitHub may have issued a token the minter cannot
   * see. Measured on this clock after the response, `now + 1 h + skew` is
   * past the expiry of any token issued before it.
   */
  function outcomeUnknown(reason: string, status: number | undefined, cause?: unknown): CredentialMinterError {
    return holding(
      fail('mint_outcome_unknown', `${reason}: a token may have been issued, and it stays active until it expires within the hour`, {
        status,
        retryable: false,
        cause,
      }),
      { handle: undefined, untilMs: elapsed() + KEY_HOLD_MS },
    );
  }

  /**
   * Revokes, with bounded retries, a usable token in a 201 body that arrived
   * after the minter gave up on it, registered with `waitUntil` when given.
   */
  function revokeLateToken(token: Promise<string | undefined>): void {
    const task = token.then((value) => (value === undefined ? undefined : deleteTokenWithRetry(value))).catch(() => undefined);
    try {
      waitUntil?.(task);
    } catch {
      // The task still runs for as long as the runtime allows.
    }
  }

  /**
   * Fails a mint whose 201 carried a token the minter cannot accept. The
   * token is revoked first; if that cleanup fails, the error says the
   * rejected token may still be active and carries a handle to retry it.
   */
  async function rejectGrant(token: string, expiresAtMs: number, problem: string, status: number, installationId: string): Promise<CredentialMinterError> {
    try {
      await deleteTokenWithRetry(token);
    } catch (error) {
      const at = now();
      // Trust GitHub's expiry only within the token lifetime; otherwise the token ends within the hour of its 201.
      const lifetimeEnd = at + GITHUB_INSTALLATION_TOKEN_LIFETIME_SECONDS * 1000;
      const handleExpiresAtMs = Number.isFinite(expiresAtMs) && expiresAtMs > at && expiresAtMs <= lifetimeEnd ? expiresAtMs : lifetimeEnd;
      const revokeHandle = registerHandle(installationId, token, handleExpiresAtMs);
      return holding(
        fail(
          'rejected_credential_not_revoked',
          `${problem}; revoking the rejected installation token also failed, so it may stay active until it expires: pass error.revokeHandle to revoke() to retry`,
          {
            status,
            retryable: false,
            cause: error instanceof CredentialMinterError ? error : redactedCause(error, [token]),
            revokeHandle,
          },
        ),
        { handle: revokeHandle, untilMs: elapsed() + KEY_HOLD_MS },
      );
    }
    return fail('provider_error', `${problem}; the installation token was revoked`, { status });
  }

  /**
   * One POST to GitHub for an already validated grant. A failure that may
   * have left a token live is registered in {@link keyHolds}. For a keyed
   * mint (`keyed`), a transport failure or a response other than 201 or 4xx
   * is `mint_outcome_unknown`, because GitHub may have issued a token before
   * it failed; without a key they stay retryable. `onDispatch` runs just
   * before the POST is handed to `fetch`; when it returns `false` (the key
   * was freed and may be in use by another mint), nothing is sent.
   */
  async function mintGrant(
    installationId: string,
    grant: GrantRequest,
    keyed: boolean,
    onDispatch?: () => boolean,
  ): Promise<MintedCredential<GitHubAppRevokeHandle>> {
    const jwt = await appJwt();
    if (onDispatch?.() === false) {
      throw fail('provider_unavailable', 'The mint was not sent: its idempotency key expired while it waited', { retryable: true });
    }
    let response: Response;
    try {
      response = await send('POST', `${baseUrl}/app/installations/${installationId}/access_tokens`, jwt, JSON.stringify(grant), [jwt]);
    } catch (error) {
      if (keyed) throw outcomeUnknown('The connection to GitHub failed after the mint request was sent', undefined, error);
      throw error;
    }
    const status = response.status;
    if (status !== 201) {
      const failure = mintFailure(status, await readBody(response), [jwt]);
      // Only a 4xx says GitHub refused before issuing anything.
      if (keyed && (status < 400 || status >= 500)) throw outcomeUnknown(`GitHub answered the mint with ${status}`, status, failure);
      throw failure;
    }

    const body = startBodyRead(response, LATE_BODY_LIMIT_MS, MAX_GRANT_BODY_BYTES);
    const result = await within(body.result, BODY_READ_TIMEOUT_MS);
    if (result === TIMED_OUT) {
      // A token already read is revoked at once; otherwise the rest of the body is awaited.
      const early = usableToken(LEADING_TOKEN.exec(body.peek())?.[1]);
      if (early !== undefined) body.cancel();
      revokeLateToken(early === undefined ? body.result.then(bodyToken) : Promise.resolve(early));
      throw outcomeUnknown('GitHub reported a minted installation token but its response did not arrive in time', status);
    }
    const read = result.text === undefined ? undefined : readAccessToken(result.text, grant);
    if (read?.token === undefined) {
      const problem = `GitHub reported a minted installation token but its response ${read ? 'carried no usable token' : 'could not be read'}`;
      // A token at the start of a body that cannot be read or parsed whole is still revoked.
      const token = bodyToken(result);
      if (token === undefined) throw outcomeUnknown(problem, status);
      throw await rejectGrant(token, Number.NaN, problem, status, installationId);
    }
    const at = now();
    const observedAt = elapsed();
    let problem = read.problem;
    if (problem === undefined && read.expiresAtMs <= at) problem = 'GitHub returned an installation token that has already expired';
    if (problem === undefined && read.expiresAtMs > at + GITHUB_INSTALLATION_TOKEN_LIFETIME_SECONDS * 1000 + MAX_CLOCK_SKEW_MS) {
      problem = 'GitHub returned an expires_at later than the one-hour installation token lifetime allows';
    }
    if (problem !== undefined) throw await rejectGrant(read.token, read.expiresAtMs, problem, status, installationId);

    const revokeHandle = registerHandle(installationId, read.token, read.expiresAtMs);
    credentialHolds.set(revokeHandle, observedAt + (read.expiresAtMs - at) + MAX_CLOCK_SKEW_MS);
    return Object.freeze({ secret: read.token, expiresAt: new Date(read.expiresAtMs), revokeHandle });
  }

  interface KeyedMint {
    readonly request: string;
    readonly promise: Promise<MintedCredential<GitHubAppRevokeHandle>>;
    /** Set once the mint settles with a credential, or with a failure that may have left a token live. */
    hold: KeyHold | undefined;
    /**
     * Until the mint settles: when any token its POST may issue has expired
     * (set again at dispatch). A mint that never settles frees its key then.
     */
    pendingUntilMs: number;
  }
  const keyedMints = new Map<string, KeyedMint>();

  /** Frees keys whose hold has ended: its token confirmed revoked, or past its private expiry, or a pending mint past its deadline. */
  function pruneKeyedMints(): void {
    const at = elapsed();
    for (const [key, entry] of keyedMints) {
      const hold = entry.hold;
      if (hold === undefined) {
        if (entry.pendingUntilMs <= at) keyedMints.delete(key);
        continue;
      }
      const revoked = hold.handle !== undefined && handleStates.get(hold.handle)?.revoked === true;
      if (revoked || hold.untilMs <= at) keyedMints.delete(key);
    }
  }

  const minter: GitHubAppMinter = {
    provider: GITHUB_APP_PROVIDER,
    grammar: githubAppScopeGrammar,

    async mint(request: CredentialMintRequest<GitHubAppInstallation, GitHubAppMintScope>): Promise<MintedCredential<GitHubAppRevokeHandle>> {
      if (typeof request !== 'object' || request === null) throw fail('invalid_request', 'mint needs { installation, scope, ttl }');
      // Read each request field once: a getter could answer differently on a second read.
      const { installation, scope, ttl, idempotencyKey } = request;
      const installationId = normalizeInstallation(installation);
      validateTtl(ttl);
      const key = validateIdempotencyKey(idempotencyKey);
      const grant = toAccessTokenRequest(approvedScope(scope));
      if (grant.repositories.length === 0 || Object.keys(grant.permissions).length === 0) {
        throw new ScopeNotGrantable(
          GITHUB_APP_PROVIDER,
          'A GitHub App scope must name at least one repository and one permission: GitHub widens an empty list to the whole installation',
        );
      }
      if (grant.repositories.length > GITHUB_MAX_TOKEN_REPOSITORIES) {
        throw new ScopeNotGrantable(GITHUB_APP_PROVIDER, `A GitHub installation token can name at most ${GITHUB_MAX_TOKEN_REPOSITORIES} repositories`);
      }
      if (key === undefined) return mintGrant(installationId, grant, false);

      pruneKeyedMints();
      const fingerprint = JSON.stringify([installationId, grant, ttl]);
      const existing = keyedMints.get(key);
      if (existing) {
        if (existing.request !== fingerprint) {
          throw fail('invalid_request', 'This idempotencyKey is already in use for a different mint request');
        }
        const expiresAtMs = existing.hold?.expiresAtMs;
        if (expiresAtMs !== undefined && now() >= expiresAtMs) {
          // Never hand back an expired credential; GitHub's clock may still accept it, so no new POST yet either.
          throw fail('provider_unavailable', "The credential minted for this idempotencyKey has expired; the key mints again after GitHub's clock-skew tolerance", {
            retryable: true,
          });
        }
        return existing.promise;
      }
      // The key is held from the POST until its token is confirmed revoked or
      // past its expiry (kept privately, never read from the returned Date), or
      // until a definite non-issuance (a failure before the POST, or a 4xx) frees it.
      const entry: KeyedMint = {
        request: fingerprint,
        promise: mintGrant(installationId, grant, true, () => {
          // A mint whose key was freed while it waited must not send a POST another mint may duplicate.
          if (keyedMints.get(key) !== entry) return false;
          entry.pendingUntilMs = elapsed() + KEY_HOLD_MS;
          return true;
        }).then(
          async (credential) => {
            if (keyedMints.get(key) !== entry) {
              // Settled after its key was freed: another mint may hold the key now, so this token is revoked, never returned.
              throw await rejectGrant(credential.secret, Number.NaN, 'The mint settled after its idempotency key expired', 201, installationId);
            }
            const handle = credential.revokeHandle;
            // GitHub's expiry as time left on the hold clock, plus the skew tolerance.
            entry.hold = { handle, untilMs: credentialHolds.get(handle)!, expiresAtMs: handleStates.get(handle)!.expiresAtMs };
            return credential;
          },
          (error: unknown) => {
            const hold = error instanceof CredentialMinterError ? keyHolds.get(error) : undefined;
            if (hold !== undefined) entry.hold = hold;
            else if (keyedMints.get(key) === entry) keyedMints.delete(key);
            throw error;
          },
        ),
        hold: undefined,
        pendingUntilMs: elapsed() + KEY_HOLD_MS,
      };
      keyedMints.set(key, entry);
      return entry.promise;
    },

    async revoke(handle: GitHubAppRevokeHandle): Promise<void> {
      const state = typeof handle === 'object' && handle !== null ? handleStates.get(handle) : undefined;
      if (state?.owner !== owner) throw new TypeError('revoke needs a revokeHandle this GitHub App minter returned');
      if (state.revoked) return;
      // Always ask GitHub, even past the local expiry: the local clock may be
      // wrong, and a 401 for an expired token already counts as revoked.
      state.inflight ??= deleteToken(state.token).then(
        () => {
          state.revoked = true;
          state.inflight = undefined;
        },
        (error: unknown) => {
          state.inflight = undefined;
          throw error;
        },
      );
      return state.inflight;
    },
  };
  return Object.freeze(minter);
}
