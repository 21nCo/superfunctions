import { defineScopeGrammar } from 'plugfn/scopes';
import type { NormalizedScope, ScopeCallbackGrammar, ScopeItem, ScopeRisk } from 'plugfn/scopes';

/** GitHub App permission levels, from least to most access. */
export const GITHUB_PERMISSION_LEVELS = Object.freeze(['read', 'write', 'admin'] as const);

export type GitHubPermissionLevel = (typeof GITHUB_PERMISSION_LEVELS)[number];

/**
 * A GitHub App installation-token scope, in the shape of the
 * `POST /app/installations/{id}/access_tokens` body: repository names (without
 * the owner; the installation fixes the account) and a level per permission.
 */
export interface GitHubAppScope {
  readonly repositories?: readonly string[];
  readonly permissions?: Readonly<Record<string, GitHubPermissionLevel>>;
}

export const GITHUB_APP_PROVIDER = 'github-app';

const GITHUB_APP_DIMENSIONS = {
  /** Lower-cased repository names: GitHub resolves repository names case-insensitively. */
  repositories: { kind: 'exactSet' },
  /**
   * `<permission>:<level>` items. A level implies every lower level, so
   * `contents: 'write'` normalises to `contents:read` and `contents:write`, and
   * an envelope granting `write` covers a request for `read`.
   */
  permissions: { kind: 'exactSet' },
} as const;

export type GitHubAppScopeDimensions = typeof GITHUB_APP_DIMENSIONS;

export type GitHubAppNormalizedScope = NormalizedScope<GitHubAppScopeDimensions>;

export type GitHubAppScopeGrammar = ScopeCallbackGrammar<GitHubAppScopeDimensions, GitHubAppScope>;

/** GitHub repository names: ASCII letters, digits, `.`, `-` and `_`, at most 100 characters. */
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** GitHub App permission names, such as `contents` or `organization_administration`. */
const PERMISSION_NAME = /^[a-z][a-z0-9_]{0,99}$/;
const PERMISSION_ITEM = /^([a-z][a-z0-9_]{0,99}):(read|write|admin)$/;
const SCOPE_KEYS: ReadonlySet<string> = new Set(['repositories', 'permissions']);

function levelIndex(level: unknown): number {
  for (let i = 0; i < GITHUB_PERMISSION_LEVELS.length; i++) {
    if (GITHUB_PERMISSION_LEVELS[i] === level) return i;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRepositories(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('repositories must be an array of repository names');
  const names: string[] = [];
  // Own-index reads on purpose: no inherited iterator runs over caller input.
  for (let i = 0; i < value.length; i++) { // NOSONAR: deliberate own-index loop
    const name: unknown = value[i];
    if (typeof name !== 'string' || !REPOSITORY_NAME.test(name) || name === '.' || name === '..') {
      throw new TypeError('repositories must hold repository names without the owner, such as "app"');
    }
    names[names.length] = name.toLowerCase();
  }
  return names;
}

function normalizePermissions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) throw new TypeError('permissions must map permission names to "read", "write" or "admin"');
  const items: string[] = [];
  const names = Object.keys(value);
  for (let i = 0; i < names.length; i++) { // NOSONAR: deliberate own-index loop
    const name = names[i]!;
    const level = levelIndex(value[name]);
    if (!PERMISSION_NAME.test(name) || level < 0) {
      throw new TypeError('permissions must map permission names to "read", "write" or "admin"');
    }
    for (let implied = 0; implied <= level; implied++) items[items.length] = `${name}:${GITHUB_PERMISSION_LEVELS[implied]}`;
  }
  return items;
}

function normalizeGitHubAppScope(input: GitHubAppScope): { repositories: string[]; permissions: string[] } {
  if (!isRecord(input)) throw new TypeError('A GitHub App scope must be an object');
  const keys = Object.keys(input);
  for (let i = 0; i < keys.length; i++) { // NOSONAR: deliberate own-index loop
    // An unknown key such as `repository_ids` would otherwise be dropped, and
    // the token would not be narrowed the way the caller meant.
    if (!SCOPE_KEYS.has(keys[i]!)) throw new TypeError('A GitHub App scope holds only repositories and permissions');
  }
  return {
    repositories: normalizeRepositories(input.repositories),
    permissions: normalizePermissions(input.permissions),
  };
}

function riskOfGitHubAppItem(item: ScopeItem<GitHubAppScopeDimensions>): ScopeRisk {
  // A repository alone grants nothing; its permissions carry the risk.
  if (item.dimension !== 'permissions') return 'read';
  const match = PERMISSION_ITEM.exec(String(item.value));
  if (!match) throw new TypeError('Unrecognised GitHub App permission item');
  if (match[1] === 'administration' || match[2] === 'admin') return 'destructive';
  return match[2] === 'write' ? 'write' : 'read';
}

/**
 * The GitHub App installation-token scope grammar. Repository names are
 * compared case-insensitively; a permission level covers every lower level;
 * any `admin` level and every `administration` permission are destructive.
 */
export const githubAppScopeGrammar: GitHubAppScopeGrammar = defineScopeGrammar<GitHubAppScopeDimensions, GitHubAppScope>({
  provider: GITHUB_APP_PROVIDER,
  dimensions: GITHUB_APP_DIMENSIONS,
  normalize: normalizeGitHubAppScope,
  riskOf: riskOfGitHubAppItem,
});

/** UTF-16 code-unit order, independent of locale, so the canonical grant is the same everywhere. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The `access_tokens` request body for a normalised scope: the repository
 * names, sorted, and the highest level of each permission.
 */
export function toAccessTokenRequest(scope: GitHubAppNormalizedScope): {
  repositories: string[];
  permissions: Record<string, GitHubPermissionLevel>;
} {
  const repositories: string[] = [];
  // Own-index reads of the frozen snapshot on purpose: no inherited iterator runs.
  for (let i = 0; i < scope.repositories.length; i++) repositories[repositories.length] = scope.repositories[i]!; // NOSONAR: deliberate own-index loop
  repositories.sort(compareCodeUnits);
  const highest = new Map<string, number>();
  for (let i = 0; i < scope.permissions.length; i++) { // NOSONAR: deliberate own-index loop
    const match = PERMISSION_ITEM.exec(scope.permissions[i]!);
    if (!match) throw new TypeError('Unrecognised GitHub App permission item');
    const level = levelIndex(match[2]);
    if (level > (highest.get(match[1]!) ?? -1)) highest.set(match[1]!, level);
  }
  const permissions: Record<string, GitHubPermissionLevel> = {};
  for (const name of [...highest.keys()].sort(compareCodeUnits)) permissions[name] = GITHUB_PERMISSION_LEVELS[highest.get(name)!]!;
  return { repositories, permissions };
}

/** Index of a level in {@link GITHUB_PERMISSION_LEVELS}, or -1 for anything else. */
export function githubPermissionLevelIndex(level: unknown): number {
  return levelIndex(level);
}
