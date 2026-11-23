import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ReleaseCiError, assertReleaseCi, evaluateCiRuns } from './assert-release-ci.mjs';
import { DEFAULT_RELEASE_CI } from './owners.mjs';

const PUBLIC_REPO = '21nCo/superfunctions';
const NEXT_REPO = '21nCo/super-functions.next';
const RELEASE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const TOKEN = 'test-github-token';
const script = path.join(import.meta.dirname, 'assert-release-ci.mjs');

// Trimmed recordings of GET /repos/{repo}/actions/workflows/{file}/runs?head_sha=... (workflow runs) and
// GET /repos/{repo}/commits/{sha}/check-runs (Depot check runs on next), keeping the fields the gate reads plus enough
// context to show the real shape. `ref` adds the "@<ref>" suffix GitHub may report on a workflow run's path.
const workflowRun = ({ id = 1, name = 'CI', file = 'ci.yml', ref = '', event = 'push', sha = RELEASE_SHA, status = 'completed', conclusion = 'success' } = {}) => ({
  id,
  name,
  path: `.github/workflows/${file}${ref}`,
  head_branch: 'dev',
  head_sha: sha,
  event,
  status,
  conclusion,
  run_attempt: 1,
  html_url: `https://github.com/${PUBLIC_REPO}/actions/runs/${id}`,
});
const workflowRuns = (...runs) => ({ total_count: runs.length, workflow_runs: runs });
/** A checkout whose manifests carry the given `ci` sections. */
function checkout(t, { publicCi, nextCi } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'release-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pub = { version: 1, paths: { datafn: 'public' }, rootFiles: { public: [] }, releases: { 'datafn-core': 'public' } };
  // nextCi: undefined writes no next manifest, null a next manifest without a ci section.
  if (publicCi) pub.ci = publicCi;
  writeFileSync(path.join(root, 'superfunctions.owners.json'), JSON.stringify(pub));
  if (nextCi !== undefined) {
    const next = { version: 1, releases: { 'docsfn-core': 'next' } };
    if (nextCi) next.ci = nextCi;
    writeFileSync(path.join(root, 'superfunctions.owners.next.json'), JSON.stringify(next));
  }
  return root;
}

/** A fetch that serves recorded bodies by URL path and records each request; a body may carry a `link` header. */
function recordedFetch(routes) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, headers: init.headers });
    const route = routes[parsed.pathname];
    if (route === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    const { link, ...body } = typeof route === 'function' ? route(parsed) : route;
    return Response.json(body, link ? { headers: { link } } : undefined);
  };
  return { fetchImpl, requests };
}

const refuses = async (promise, code, ...fragments) =>
  assert.rejects(promise, error => {
    assert.ok(error instanceof ReleaseCiError, `expected ReleaseCiError, got ${error}`);
    assert.equal(error.code, code, error.message);
    for (const fragment of fragments) assert.ok(error.message.includes(fragment), `${JSON.stringify(error.message)} lacks ${JSON.stringify(fragment)}`);
    return true;
  });

const RUNS_PATH = `/repos/${PUBLIC_REPO}/actions/workflows/ci.yml/runs`;

test('public: a successful push run of ci.yml on the release commit passes, read with the token for that SHA', async t => {
  const root = checkout(t);
  const { fetchImpl, requests } = recordedFetch({
    [RUNS_PATH]: workflowRuns(workflowRun({ id: 7, event: 'pull_request', conclusion: 'failure' }), workflowRun({ id: 8 }), workflowRun({ id: 9, sha: OTHER_SHA, conclusion: 'failure' })),
  });
  const result = await assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl });
  assert.deepEqual(result.ci, DEFAULT_RELEASE_CI);
  assert.match(result.message, /workflow \.github\/workflows\/ci\.yml \(push run\) succeeded on a{40} \(https:\/\/github.com\/21nCo\/superfunctions\/actions\/runs\/8\)/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.searchParams.get('head_sha'), RELEASE_SHA);
  assert.equal(requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('public: a failed, in-progress, missing or other-commit CI run is refused', async t => {
  const root = checkout(t);
  const cases = [
    ['failed', workflowRuns(workflowRun({ conclusion: 'failure' })), 'concluded failure (https://github.com/21nCo/superfunctions/actions/runs/1), not success'],
    ['failed', workflowRuns(workflowRun({ conclusion: 'cancelled' }), workflowRun({ id: 2, conclusion: 'skipped' })), 'concluded cancelled (https://github.com/21nCo/superfunctions/actions/runs/1), skipped'],
    ['in-progress', workflowRuns(workflowRun({ status: 'in_progress', conclusion: null })), 'has not completed (in_progress)'],
    ['in-progress', workflowRuns(workflowRun({ conclusion: 'failure' }), workflowRun({ id: 2, status: 'queued', conclusion: null })), 'queued'],
    ['missing', workflowRuns(), 'no GitHub Actions workflow .github/workflows/ci.yml'],
    // A pull_request run tests the merge of the tagged commit into its base, not the tagged commit itself.
    ['missing', workflowRuns(workflowRun({ event: 'pull_request' })), '1 pull_request run(s) on it are not push runs'],
    // A dispatch run of a commit already on dev plans an empty diff, so it proves nothing about the packages.
    ['missing', workflowRuns(workflowRun({ event: 'workflow_dispatch' })), '1 workflow_dispatch run(s) on it are not push runs'],
    ['failed', workflowRuns(workflowRun({ conclusion: 'failure' }), workflowRun({ id: 2, event: 'pull_request' }), workflowRun({ id: 3, event: 'workflow_dispatch' })), 'concluded failure'],
    // A failed push run on the commit is not outvoted by a successful one.
    ['failed', workflowRuns(workflowRun({ id: 1 }), workflowRun({ id: 2, conclusion: 'failure' })), 'concluded failure (https://github.com/21nCo/superfunctions/actions/runs/2)'],
    ['in-progress', workflowRuns(workflowRun({ id: 1 }), workflowRun({ id: 2, status: 'in_progress', conclusion: null })), 'has not completed'],
    // Any workflow can set its run name to "CI" (pullfrog.yml takes it as an input); only ci.yml's runs count.
    ['missing', workflowRuns(workflowRun({ name: 'CI', file: 'pullfrog.yml' })), 'no GitHub Actions workflow'],
    ['missing', workflowRuns(workflowRun({ name: 'CI', file: 'pullfrog.yml', ref: '@main' })), 'no GitHub Actions workflow'],
    ['missing', workflowRuns(workflowRun({ file: 'ci.yml.bak', ref: '@main' })), 'no GitHub Actions workflow'],
    // An "@<ref>" suffix on the path changes neither which runs count nor what the diagnostics say.
    ['failed', workflowRuns(workflowRun({ ref: '@main' }), workflowRun({ id: 2, ref: '@refs/heads/dev', conclusion: 'failure' })), 'concluded failure (https://github.com/21nCo/superfunctions/actions/runs/2)'],
    ['missing', workflowRuns(workflowRun({ ref: '@main', event: 'workflow_dispatch' })), '1 workflow_dispatch run(s) on it are not push runs'],
    ['missing', workflowRuns(workflowRun({ ref: '@main', sha: OTHER_SHA })), '1 matching run(s) belong to other commits'],
    ['missing', workflowRuns(workflowRun({ sha: OTHER_SHA })), '1 matching run(s) belong to other commits'],
  ];
  for (const [code, body, fragment] of cases) {
    const { fetchImpl } = recordedFetch({ [RUNS_PATH]: body });
    await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl }), code, fragment);
  }
});

test('public: a successful push run whose path GitHub reports with an @<ref> suffix passes', async t => {
  const root = checkout(t);
  for (const ref of ['@main', '@refs/heads/dev']) {
    const { fetchImpl } = recordedFetch({ [RUNS_PATH]: workflowRuns(workflowRun({ ref })) });
    const result = await assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl });
    assert.match(result.message, /workflow \.github\/workflows\/ci\.yml \(push run\) succeeded on a{40}/);
  }
});

test('next refuses every CI-gated tag as unproven, even with a green Depot check run its manifest names (owner decision 2026-11-21)', async t => {
  // A green Depot check run of the configured name and app on the exact commit, plus green synced GitHub Actions runs:
  // neither shows that a full push run tested the tagged commit, so neither is read.
  const greenDepot = { total_count: 1, check_runs: [{ id: 1, name: 'Depot CI', head_sha: RELEASE_SHA, status: 'completed', conclusion: 'success', app: { slug: 'depot' } }] };
  const { fetchImpl, requests } = recordedFetch({
    [`/repos/${NEXT_REPO}/commits/${RELEASE_SHA}/check-runs`]: greenDepot,
    [`/repos/${NEXT_REPO}/actions/workflows/ci.yml/runs`]: workflowRuns(workflowRun()),
  });
  const roots = [
    checkout(t, { nextCi: { checkRun: 'Depot CI', app: 'depot' } }),
    checkout(t, { nextCi: { checkRun: 'Depot CI', app: 'depot-checks' } }),
    checkout(t, { nextCi: { workflow: 'ci.yml' } }),
    checkout(t, { publicCi: { workflow: 'ci.yml' }, nextCi: null }),
    checkout(t),
  ];
  for (const root of roots) {
    for (const token of [TOKEN, '']) {
      await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: NEXT_REPO, token, root, fetchImpl }), 'unproven', '21nCo/super-functions.next: its CI is unproven', 'SFNS-160');
    }
  }
  assert.equal(requests.length, 0);
  // The public gate is unchanged by the same manifests.
  const pub = recordedFetch({ [RUNS_PATH]: workflowRuns(workflowRun()) });
  await assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root: roots[0], fetchImpl: pub.fetchImpl });
});

test('public refuses a check-run ci section: its releases need a GitHub Actions workflow', async t => {
  const root = checkout(t, { publicCi: { checkRun: 'CI', app: 'some-other-app' } });
  const { fetchImpl, requests } = recordedFetch({});
  await refuses(
    assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl }),
    'missing-config',
    'public releases require a GitHub Actions workflow',
  );
  assert.equal(requests.length, 0);
});

test('public uses its own manifest ci section when present', async t => {
  const root = checkout(t, { publicCi: { workflow: 'release-ci.yml' }, nextCi: { checkRun: 'Depot CI', app: 'depot' } });
  const { fetchImpl, requests } = recordedFetch({ [`/repos/${PUBLIC_REPO}/actions/workflows/release-ci.yml/runs`]: workflowRuns(workflowRun({ file: 'release-ci.yml' })) });
  const result = await assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl });
  assert.deepEqual(result.ci, { kind: 'workflow', name: 'release-ci.yml', app: null });
  assert.equal(requests.length, 1);
});

test('every page of runs is read before deciding', async t => {
  const root = checkout(t);
  const filler = Array.from({ length: 100 }, (_, index) => workflowRun({ id: index + 10, event: 'pull_request' }));
  const { fetchImpl, requests } = recordedFetch({
    [RUNS_PATH]: url => (url.searchParams.get('page') === '1' ? { total_count: 101, workflow_runs: filler } : { total_count: 101, workflow_runs: [workflowRun({ id: 9 })] }),
  });
  await assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl });
  assert.deepEqual(requests.map(request => request.url.searchParams.get('page')), ['1', '2']);
});

test('a short page is not the last page while total_count or the Link header says more remain', async t => {
  const root = checkout(t);
  const nextLink = page => `<https://api.github.com${RUNS_PATH}?page=${page}>; rel="next"`;
  const byTotal = recordedFetch({
    [RUNS_PATH]: url => (url.searchParams.get('page') === '1' ? { total_count: 2, workflow_runs: [workflowRun({ id: 1 })] } : { total_count: 2, workflow_runs: [workflowRun({ id: 2, conclusion: 'failure' })] }),
  });
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl: byTotal.fetchImpl }), 'failed');
  assert.equal(byTotal.requests.length, 2);
  const byLink = recordedFetch({
    [RUNS_PATH]: url => (url.searchParams.get('page') === '1' ? { link: nextLink(2), workflow_runs: [workflowRun()] } : { workflow_runs: [workflowRun({ id: 2, conclusion: 'failure' })] }),
  });
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl: byLink.fetchImpl }), 'failed');
  assert.equal(byLink.requests.length, 2);
  // A response that promises more but delivers an empty page refuses.
  const truncated = recordedFetch({ [RUNS_PATH]: url => (url.searchParams.get('page') === '1' ? { total_count: 3, workflow_runs: [workflowRun()] } : { total_count: 3, workflow_runs: [] }) });
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl: truncated.fetchImpl }), 'api-error', 'end early (1 of 3)');
  // A later page that drops total_count and the Link header does not cancel the results page 1 advertised.
  const dropped = recordedFetch({ [RUNS_PATH]: url => (url.searchParams.get('page') === '1' ? { total_count: 2, workflow_runs: [workflowRun()] } : { workflow_runs: [] }) });
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl: dropped.fetchImpl }), 'api-error', 'end early (1 of 2)');
  // An empty answer to a page the Link header promised is truncation, even without counts.
  const linkOnly = recordedFetch({
    [RUNS_PATH]: url => (url.searchParams.get('page') === '1' ? { link: nextLink(2), workflow_runs: [workflowRun()] } : { workflow_runs: [] }),
  });
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl: linkOnly.fetchImpl }), 'api-error', 'end early (1 of more)');
  // A run added mid-read shifts offset paging: page 2 repeats a page-1 result, and an unseen run may be skipped.
  const shifted = recordedFetch({
    [RUNS_PATH]: url =>
      url.searchParams.get('page') === '1'
        ? { total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, index) => workflowRun({ id: index + 1 })) }
        : { total_count: 102, workflow_runs: [workflowRun({ id: 100 }), workflowRun({ id: 101 })] },
  });
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl: shifted.fetchImpl }), 'api-error', 'repeat result 100');
});

test('more results than the gate can page through refuse instead of deciding on part of them', async t => {
  const root = checkout(t);
  const { fetchImpl, requests } = recordedFetch({
    [RUNS_PATH]: url => {
      const offset = (Number(url.searchParams.get('page')) - 1) * 100;
      return { total_count: 1001, workflow_runs: Array.from({ length: 100 }, (_, index) => workflowRun({ id: offset + index + 10 })) };
    },
  });
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl }), 'api-error', 'more than 1000 results');
  assert.equal(requests.length, 10);
});

test('bad input, a missing token, an API error or an unknown repository refuses', async t => {
  const root = checkout(t);
  const { fetchImpl } = recordedFetch({});
  await refuses(assertReleaseCi({ sha: 'HEAD', repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl }), 'invalid-commit');
  await refuses(assertReleaseCi({ sha: RELEASE_SHA.toUpperCase(), repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl }), 'invalid-commit');
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: '', root, fetchImpl }), 'missing-token');
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl }), 'api-error', 'GitHub returned 404');
  const broken = recordedFetch({ [RUNS_PATH]: { message: 'unexpected' } }).fetchImpl;
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl: broken }), 'api-error', 'no workflow_runs list');
  const offline = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  };
  await refuses(assertReleaseCi({ sha: RELEASE_SHA, repository: PUBLIC_REPO, token: TOKEN, root, fetchImpl: offline }), 'api-error', 'ENOTFOUND');
  await assert.rejects(assertReleaseCi({ sha: RELEASE_SHA, repository: 'someone/fork', token: TOKEN, root, fetchImpl }), /only public/);
});

test('a failure on the release commit is not outvoted; runs on other commits never count', () => {
  const runs = [
    { path: '.github/workflows/ci.yml', event: 'push', headSha: OTHER_SHA, status: 'completed', conclusion: 'success' },
    { path: '.github/workflows/ci.yml', event: 'push', headSha: RELEASE_SHA, status: 'completed', conclusion: 'failure' },
    { path: '.github/workflows/ci.yml', event: 'push', headSha: RELEASE_SHA, status: 'completed', conclusion: 'success' },
  ];
  assert.throws(() => evaluateCiRuns({ sha: RELEASE_SHA, ci: DEFAULT_RELEASE_CI, runs }), error => error.code === 'failed');
  assert.match(evaluateCiRuns({ sha: RELEASE_SHA, ci: DEFAULT_RELEASE_CI, runs: [runs[0], runs[2]] }).message, /succeeded/);
  assert.throws(() => evaluateCiRuns({ sha: RELEASE_SHA, ci: DEFAULT_RELEASE_CI, runs: [runs[0]] }), error => error.code === 'missing');
});

test('the command reads GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_API_URL and --root and exits non-zero on refusal', async t => {
  // --root selects the manifests: this one names a workflow file, which the request path shows was used.
  const root = checkout(t, { publicCi: { workflow: 'ci.yml' } });
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization });
    const sha = new URL(request.url, 'http://localhost').searchParams.get('head_sha');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(workflowRuns(workflowRun({ conclusion: sha === RELEASE_SHA ? 'success' : 'failure', sha }))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const run = sha =>
    new Promise(resolve => {
      const child = spawn(process.execPath, [script, sha, '--root', root], {
        env: { ...process.env, GITHUB_REPOSITORY: PUBLIC_REPO, GITHUB_TOKEN: TOKEN, GH_TOKEN: '', GITHUB_API_URL: apiBase },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
  const passed = await run(RELEASE_SHA);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /succeeded on a{40}/);
  const refused = await run(OTHER_SHA);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /concluded failure \(https:\/\/github.com\/21nCo\/superfunctions\/actions\/runs\/1\), not success/);
  assert.equal(seen[0].authorization, `Bearer ${TOKEN}`);
  assert.ok(seen[0].url.startsWith(`/repos/${PUBLIC_REPO}/actions/workflows/ci.yml/runs?`));
});

test('the command still runs the gate when reached through a symlink', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-ci-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'assert-release-ci.mjs');
  symlinkSync(script, link);
  const result = spawnSync(process.execPath, [link, 'HEAD'], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: PUBLIC_REPO } });
  assert.equal(result.status, 1, 'a skipped gate would exit 0');
  assert.match(result.stderr, /full 40-character SHA/);
});
