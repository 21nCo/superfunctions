// Release CI gate (SFNS-121 D8, SFNS-124): a tag publishes only when its commit has a completed, successful CI run on
// that exact SHA. The publish workflows run it right after the release owner gate, before anything is installed,
// built or packed; a channel-only dispatch republishes nothing and skips it.
//
//   node scripts/assert-release-ci.mjs <40-hex release commit> [--root <checkout whose manifests apply>]
//
// The manifests come from --root (in the publish workflows, the tag checkout), defaulting to this script's checkout.
// The running repository comes from GITHUB_REPOSITORY and selects the CI to require. On public it is the `ci` section
// of superfunctions.owners.json, defaulting to the GitHub Actions workflow .github/workflows/ci.yml; only push runs
// count, because a pull_request run tests a merge commit and a workflow_dispatch run may plan no package jobs. On next,
// CI runs on Depot and the synced GitHub Actions CI skips every job, so superfunctions.owners.next.json must name the
// check run Depot's GitHub App (slug "depot") reports in its `ci` section; without one, or with a workflow or another
// app there, next refuses. Every counted run on the
// commit must have succeeded, and there must be at least one. The GitHub API is read with GITHUB_TOKEN (or GH_TOKEN) at
// GITHUB_API_URL.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RELEASE_CI, REPO_ROOT, loadOwners } from './owners.mjs';
import { PUBLISHING_REPOSITORIES, parseGateArgs, releaseRepoKind } from './assert-release-owner.mjs';

const PER_PAGE = 100;
/**
 * Workflow run events that test the commit itself with the planned package jobs: a pull_request run tests a merge of
 * it into the base, and a workflow_dispatch run of a commit already on dev plans an empty diff.
 */
export const TESTED_COMMIT_EVENTS = Object.freeze(['push']);
/** The GitHub App whose check runs carry next's CI result (Depot CI); the live slug is confirmed by SFNS-160. */
export const DEPOT_APP_SLUG = 'depot';
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
  if (ci.kind === 'workflow') return `GitHub Actions workflow .github/workflows/${ci.name} (push run)`;
  return `check run ${JSON.stringify(ci.name)}${ci.app ? ` from app ${JSON.stringify(ci.app)}` : ''}`;
}

/**
 * The CI a repository requires: on public its manifest's `ci` section or .github/workflows/ci.yml; on next the `ci`
 * section of the next manifest, which must name a check run (the public section and the default never apply there,
 * and GitHub Actions workflows skip every job on next).
 * @param {'public' | 'next'} repo
 * @param {ReturnType<typeof loadOwners>} owners
 */
export function releaseCiFor(repo, owners) {
  if (repo === 'public') return owners.publicManifest.ci ?? DEFAULT_RELEASE_CI;
  const ci = owners.nextManifest?.ci;
  if (ci?.kind === 'check-run' && ci.app === DEPOT_APP_SLUG) return ci;
  const problem = !ci
    ? 'has no "ci" section naming'
    : ci.kind === 'workflow'
      ? 'names a GitHub Actions workflow in its "ci" section instead of'
      : `names a check run from app ${JSON.stringify(ci.app)} in its "ci" section instead of`;
  throw new ReleaseCiError(
    'missing-config',
    `Refusing to publish from ${PUBLISHING_REPOSITORIES.next}: superfunctions.owners.next.json ${problem} the Depot check run ({"ci": {"checkRun": "<name>", "app": "${DEPOT_APP_SLUG}"}}). CI there runs on Depot, and the synced GitHub Actions CI skips every job outside ${PUBLISHING_REPOSITORIES.public}.`,
  );
}

/**
 * Decides the gate from runs already fetched. A workflow run counts only when its file is the configured workflow and
 * its event tested the commit itself (push); a check run only when its name and app match. It must also have the
 * release commit as its head SHA. At least one run must count, and every counted run must be completed with
 * conclusion "success": a failure on the commit is not outvoted by another run.
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
  const pending = onCommit.filter(run => run.status !== 'completed');
  if (pending.length > 0) {
    throw new ReleaseCiError(
      'in-progress',
      `Refusing to publish: ${what} on ${sha} has not completed (${pending.map(run => run.status ?? 'unknown').join(', ')}). Dispatch the publish workflow again after it succeeds.`,
      { sha },
    );
  }
  const unsuccessful = onCommit.filter(run => run.conclusion !== 'success');
  if (unsuccessful.length > 0) {
    throw new ReleaseCiError(
      'failed',
      `Refusing to publish: ${what} on ${sha} concluded ${unsuccessful.map(run => `${run.conclusion ?? 'without a conclusion'}${run.url ? ` (${run.url})` : ''}`).join(', ')}, not success.`,
      { sha },
    );
  }
  if (onCommit.length > 0) {
    const urls = onCommit.map(run => run.url).filter(Boolean);
    return { run: onCommit[0], message: `${what} succeeded on ${sha}${urls.length > 0 ? ` (${urls.join(', ')})` : ''}.` };
  }
  const notes = [];
  if (named.length > 0) notes.push(`${named.length} matching run(s) belong to other commits`);
  const otherEvents = ci.kind === 'workflow' ? runs.filter(run => run.path === `.github/workflows/${ci.name}` && run.headSha === sha && !TESTED_COMMIT_EVENTS.includes(run.event)) : [];
  if (otherEvents.length > 0) notes.push(`${otherEvents.length} ${[...new Set(otherEvents.map(run => run.event))].join('/')} run(s) on it are not push runs`);
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
    // More results remain while the Link header offers a next page or total_count exceeds what was read; without
    // either signal, a full page may still have a successor.
    const total = Number.isInteger(body.total_count) ? body.total_count : null;
    const linked = /\brel="next"/.test(response.headers?.get?.('link') ?? '');
    const more = linked || (total !== null ? runs.length < total : items.length === PER_PAGE);
    if (!more) return runs;
    if (items.length === 0) {
      throw new ReleaseCiError('api-error', `Refusing to publish: GitHub's results for ${url} end early (${runs.length} of ${total ?? 'more'}), so the gate cannot read them all.`, { url });
    }
  }
  // A failure on a page that was never read must not be missed: refuse rather than decide on part of the results.
  throw new ReleaseCiError(
    'api-error',
    `Refusing to publish: ${describeCi(ci)} has more than ${PER_PAGE * MAX_PAGES} results for ${sha}, so the gate cannot read them all.`,
    { sha },
  );
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
    const { positionals, root } = parseGateArgs(process.argv.slice(2));
    if (positionals.length !== 1) throw new Error('Usage: assert-release-ci.mjs <release commit> [--root <dir>]');
    const result = await assertReleaseCi({
      sha: positionals[0],
      root,
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
