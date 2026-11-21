// Release CI gate (SFNS-121 D8, SFNS-124): a tag publishes only when its commit has a completed, successful CI run on
// that exact SHA. The publish workflows run it right after the release owner gate, before anything is installed,
// built or packed; a channel-only dispatch republishes nothing and skips it.
//
//   node scripts/assert-release-ci.mjs <40-hex release commit>
//
// The running repository comes from GITHUB_REPOSITORY and selects the CI to require. On public it is the `ci` section
// of superfunctions.owners.json, defaulting to the GitHub Actions workflow .github/workflows/ci.yml; only push and
// workflow_dispatch runs count, because a pull_request run tests a merge commit, not the tagged one. On next, CI runs
// on Depot and the synced GitHub Actions CI skips every job, so superfunctions.owners.next.json must name the Depot
// check run in its `ci` section; without one, next refuses. The GitHub API is read with GITHUB_TOKEN (or GH_TOKEN) at
// GITHUB_API_URL.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RELEASE_CI, REPO_ROOT, loadOwners } from './owners.mjs';
import { PUBLISHING_REPOSITORIES, releaseRepoKind } from './assert-release-owner.mjs';

const PER_PAGE = 100;
/** Workflow run events that test the commit itself; pull_request runs test a merge of it into the base. */
export const TESTED_COMMIT_EVENTS = Object.freeze(['push', 'workflow_dispatch']);
const MAX_PAGES = 10;

export class ReleaseCiError extends Error {
  /**
   * @param {'invalid-commit' | 'missing-config' | 'missing-token' | 'api-error' | 'missing' | 'in-progress' | 'failed'} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReleaseCiError';
    this.code = code;
    this.details = details;
  }
}

/** Human description of a release CI requirement. */
export function describeCi(ci) {
  if (ci.kind === 'workflow') return `GitHub Actions workflow .github/workflows/${ci.name} (push or workflow_dispatch run)`;
  return `check run ${JSON.stringify(ci.name)}${ci.app ? ` from app ${JSON.stringify(ci.app)}` : ''}`;
}

/**
 * The CI a repository requires: on public its manifest's `ci` section or .github/workflows/ci.yml; on next the `ci`
 * section of the next manifest, which must exist (the public section and the default never apply there).
 * @param {'public' | 'next'} repo
 * @param {ReturnType<typeof loadOwners>} owners
 */
export function releaseCiFor(repo, owners) {
  if (repo === 'public') return owners.publicManifest.ci ?? DEFAULT_RELEASE_CI;
  if (owners.nextManifest?.ci) return owners.nextManifest.ci;
  throw new ReleaseCiError(
    'missing-config',
    `Refusing to publish from ${PUBLISHING_REPOSITORIES.next}: superfunctions.owners.next.json has no "ci" section naming the Depot check run ({"ci": {"checkRun": "<name>", "app": "<GitHub App slug>"}}). CI there runs on Depot, and the synced GitHub Actions CI skips every job outside ${PUBLISHING_REPOSITORIES.public}.`,
  );
}

/**
 * Decides the gate from runs already fetched. A workflow run counts only when its file is the configured workflow and
 * its event tested the commit itself (push or workflow_dispatch); a check run only when its name and app match. It
 * must also have the release commit as its head SHA, and at least one counted run must be completed with conclusion
 * "success".
 * @param {{ sha: string, ci: { kind: string, name: string, app: string | null }, runs: { name?: string, path?: string, event?: string, headSha?: string, status?: string, conclusion?: string | null, app?: string | null, url?: string }[] }} input
 */
export function evaluateCiRuns({ sha, ci, runs }) {
  const named = runs.filter(run =>
    ci.kind === 'workflow'
      ? run.path === `.github/workflows/${ci.name}` && TESTED_COMMIT_EVENTS.includes(run.event)
      : run.name === ci.name && run.app === ci.app,
  );
  const onCommit = named.filter(run => run.headSha === sha);
  const what = describeCi(ci);
  const success = onCommit.find(run => run.status === 'completed' && run.conclusion === 'success');
  if (success) return { run: success, message: `${what} succeeded on ${sha}${success.url ? ` (${success.url})` : ''}.` };
  const pending = onCommit.filter(run => run.status !== 'completed');
  if (pending.length > 0) {
    throw new ReleaseCiError(
      'in-progress',
      `Refusing to publish: ${what} on ${sha} has not completed (${pending.map(run => run.status ?? 'unknown').join(', ')}). Dispatch the publish workflow again after it succeeds.`,
      { sha },
    );
  }
  if (onCommit.length > 0) {
    throw new ReleaseCiError(
      'failed',
      `Refusing to publish: ${what} on ${sha} concluded ${onCommit.map(run => run.conclusion ?? 'without a conclusion').join(', ')}, not success.`,
      { sha },
    );
  }
  const notes = [];
  if (named.length > 0) notes.push(`${named.length} matching run(s) belong to other commits`);
  const otherEvents = ci.kind === 'workflow' ? runs.filter(run => run.path === `.github/workflows/${ci.name}` && run.headSha === sha && !TESTED_COMMIT_EVENTS.includes(run.event)) : [];
  if (otherEvents.length > 0) notes.push(`${otherEvents.length} ${[...new Set(otherEvents.map(run => run.event))].join('/')} run(s) tested a different tree`);
  const why = notes.length > 0 ? ` (${notes.join('; ')}, so they do not count)` : '';
  throw new ReleaseCiError('missing', `Refusing to publish: no ${what} ran on ${sha}${why}. A tag publishes only a commit that passed CI.`, { sha });
}

function apiUrl(base, repository, ci, sha, page) {
  const root = `${base.replace(/\/+$/, '')}/repos/${repository}`;
  const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) });
  if (ci.kind === 'workflow') {
    query.set('head_sha', sha);
    return `${root}/actions/workflows/${encodeURIComponent(ci.name)}/runs?${query}`;
  }
  query.set('check_name', ci.name);
  query.set('filter', 'latest');
  return `${root}/commits/${sha}/check-runs?${query}`;
}

const normalize = {
  workflow: run => ({ name: run?.name, path: run?.path, event: run?.event, headSha: run?.head_sha, status: run?.status, conclusion: run?.conclusion, app: null, url: run?.html_url }),
  'check-run': run => ({ name: run?.name, headSha: run?.head_sha, status: run?.status, conclusion: run?.conclusion, app: run?.app?.slug ?? null, url: run?.html_url }),
};

/**
 * Reads every page of workflow runs (for a workflow requirement) or check runs (for a check-run requirement) for the
 * release commit.
 */
export async function fetchCiRuns({ sha, ci, repository, token, apiBase = 'https://api.github.com', fetchImpl = fetch }) {
  const runs = [];
  const field = ci.kind === 'workflow' ? 'workflow_runs' : 'check_runs';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = apiUrl(apiBase, repository, ci, sha, page);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      });
    } catch (error) {
      throw new ReleaseCiError('api-error', `Refusing to publish: could not read ${describeCi(ci)} results for ${sha}: ${error.message}`, { url });
    }
    if (!response.ok) {
      throw new ReleaseCiError('api-error', `Refusing to publish: GitHub returned ${response.status} for ${url}`, { url, status: response.status });
    }
    const body = await response.json();
    const items = body?.[field];
    if (!Array.isArray(items)) throw new ReleaseCiError('api-error', `Refusing to publish: GitHub's response for ${url} has no ${field} list`, { url });
    runs.push(...items.map(normalize[ci.kind]));
    const total = Number.isInteger(body.total_count) ? body.total_count : null;
    if (items.length < PER_PAGE || (total !== null && runs.length >= total)) return runs;
  }
  return runs;
}

/**
 * Refuses a release commit without a completed, successful CI run on that SHA.
 * @param {{ sha: string, repository: string | undefined, token: string | undefined, apiBase?: string, root?: string, fetchImpl?: typeof fetch }} input
 */
export async function assertReleaseCi({ sha, repository, token, apiBase, root = REPO_ROOT, fetchImpl }) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new ReleaseCiError('invalid-commit', `Expected the release commit as a full 40-character SHA, not ${JSON.stringify(sha ?? '')}`, { sha });
  }
  const repo = releaseRepoKind(repository);
  const ci = releaseCiFor(repo, loadOwners({ root }));
  if (!token) throw new ReleaseCiError('missing-token', 'Refusing to publish: GITHUB_TOKEN is required to read CI results for the release commit.');
  const runs = await fetchCiRuns({ sha, ci, repository: PUBLISHING_REPOSITORIES[repo], token, apiBase, fetchImpl });
  return { ci, ...evaluateCiRuns({ sha, ci, runs }) };
}

// realpath: a symlinked path to this file (such as macOS's /var -> /private/var) must still run the gate, never skip it.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await assertReleaseCi({
      sha: process.argv[2],
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      apiBase: process.env.GITHUB_API_URL || undefined,
    });
    console.log(result.message);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
