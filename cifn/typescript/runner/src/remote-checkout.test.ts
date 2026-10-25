import { Runner } from './runner.js';
import { ProcessGroupUncertainError } from './executor/owned-shell.js';
import { MemoryStore, MemoryQueueClient, DEFAULT_QUEUE_NAME } from '@cifn/control-plane';
import { MemoryLogFnClient } from './reporting/logfn-client.js';
import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeRemoteShellJob } from './remote-runner.js';
import { executeOwnedCheckout, executeCheckout } from './steps/checkout.js';
const roots: string[] = [];
function directory() { const root = mkdtempSync(join(tmpdir(), 'cifn-checkout-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = directory(), source = join(root, 'source'), bare = join(root, 'bare'); mkdirSync(source);
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-b', 'main'); writeFileSync(join(source, 'receipt'), 'first'); git('add', '.'); git('commit', '-m', 'first');
  const first = git('rev-parse', 'HEAD'); git('tag', '-a', 'v1', '-m', 'v1');
  writeFileSync(join(source, 'receipt'), 'second'); git('commit', '-am', 'second'); git('clone', '--bare', '--', source, bare);
  return { bare, first };
}
it('admits checkout and reports running before invalid repository failure', async () => {
  const observed: string[] = [];
  const result = await executeRemoteShellJob({ runId: 'checkout', jobKey: 'build', jobSpec: {
    'runs-on': 'default', steps: [{ uses: 'checkout', with: { repository: '/missing-owned-fixture', ref: 'main' } }, { run: 'true' }],
  } }, undefined, undefined, undefined, undefined, async (_key, status) => { observed.push(status); });
  expect(observed).toContain('running'); expect(result.status).toBe('failure');
});
it('checks out exact commit, branch, annotated tag and HEAD without persistent remote', async () => {
  const { bare, first } = fixture();
  for (const [ref, content] of [[first, 'first'], ['main', 'second'], ['refs/tags/v1', 'first'], ['HEAD', 'second']]) {
    const workspace = directory();
    expect(await executeOwnedCheckout({ repo: bare, ref, workspace, allowLocalRepositories: true })).toEqual({ success: true, lines: ['Checkout complete'] });
    expect(readFileSync(join(workspace, 'receipt'), 'utf8')).toBe(content);
    expect(readFileSync(join(workspace, '.git/config'), 'utf8')).not.toContain(bare);
    expect(existsSync(join(workspace, '.git/objects/info/alternates'))).toBe(false);
  }
});
it('uses trigger SHA and awaited status journal before subsequent workspace shell', async () => {
  const { bare, first } = fixture(); const observed: string[] = [];
  const result = await executeRemoteShellJob({ runId: 'checkout', jobKey: 'build', pipelineRef: { repo: bare, ref: 'main', configPath: '.cifn.yml' }, trigger: { type: 'push', payload: { after: first, ref: 'refs/heads/main', repository: { full_name: 'fixture/repository' } } }, jobSpec: {
    'runs-on': 'default', steps: [{ uses: 'checkout' }, { run: 'test "$(cat receipt)" = first && test -z "$(git remote)"' }],
  } }, undefined, undefined, undefined, undefined, async (key, status) => { observed.push(`${key}:${status}`); }, { allowLocalRepositories: true });
  expect(result.status).toBe('success');
  expect(observed).toEqual(['step-0:running', 'step-0:success', 'step-1:running', 'step-1:success']);
});
it('rejects unsafe transport/ref and local access without host policy before writing workspace', async () => {
  const { bare } = fixture();
  for (const [repo, ref, allowLocalRepositories] of [[bare, 'main', false], ['ext::sh -c bad', 'main', true], ['--upload-pack=bad', 'main', true], ['ssh://example.invalid/repo', 'main', true], ['https://user:secret@example.invalid/repo', 'main', true], [bare, '--upload-pack=bad', true], [bare, 'main:refs/heads/other', true], [bare, 'main; touch /tmp/no', true]] as const) {
    const workspace = directory();
    expect((await executeOwnedCheckout({ repo, ref, workspace, allowLocalRepositories })).success).toBe(false);
    expect(existsSync(join(workspace, '.git'))).toBe(false);
  }
});
it('preserves synchronous argv compatibility and rejects pre-existing repository config', () => {
  const { bare } = fixture(), workspace = directory();
  expect(executeCheckout({ repo: bare, ref: 'main', workspace, allowLocalRepositories: true }).success).toBe(true);
  expect(executeCheckout({ repo: bare, ref: 'main', workspace, allowLocalRepositories: true }).success).toBe(false);
});
it('already cancelled checkout performs no repository writes', async () => {
  const { bare } = fixture(), workspace = directory(); const controller = new AbortController(); controller.abort();
  expect((await executeOwnedCheckout({ repo: bare, ref: 'main', workspace, allowLocalRepositories: true, signal: controller.signal })).success).toBe(false);
  expect(existsSync(join(workspace, '.git'))).toBe(false);
});

it('cancels an active owned Git process and clears credential helper files without logging secrets', async () => {
  const root = directory(), workspace = directory(), marker = join(root, 'started');
  // Owned fake executable isolates the supervision/credential boundary without a network provider.
  writeFileSync(join(root, 'git'), `#!/bin/sh
printf '%s\\n' "$$" > '${marker}'
printf '%s\\n' "$GIT_ASKPASS" >> '${marker}'
printf '%s\\n' "$CIFN_CHECKOUT_TOKEN" >&2
exec /bin/sleep 30
`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = root;
  const controller = new AbortController();
  const operation = executeOwnedCheckout({ repo: 'https://fixture.invalid/repo', ref: 'HEAD', workspace, token: 'owned-fixture-secret', signal: controller.signal });
  try {
    const until = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(marker)).toBe(true);
    controller.abort();
    const result = await operation;
    expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain('owned-fixture-secret');
    const [pid, helper] = readFileSync(marker, 'utf8').trim().split('\n');
    expect(() => process.kill(Number(pid), 0)).toThrow();
    expect(existsSync(helper)).toBe(false);
  } finally { controller.abort(); await operation; if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

it('normalizes exact GitHub shorthand without a network request or credential-bearing argv', async () => {
  const root = directory(), workspace = directory(), marker = join(root, 'args');
  writeFileSync(join(root, 'git'), `#!/bin/sh
printf '%s\\n' "$@" >> '${marker}'
exit 0
`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = root;
  try {
    expect((await executeOwnedCheckout({ repo: 'owner/repo.git', ref: 'refs/tags/v1', workspace, token: 'private-fixture-token' })).success).toBe(true);
    const args = readFileSync(marker, 'utf8');
    expect(args).toContain('https://github.com/owner/repo.git'); expect(args).not.toContain('private-fixture-token');
    expect(args).toContain('credential.helper='); expect(args).toContain('http.followRedirects=false');
    const sha = 'a'.repeat(40);
    const remote = await executeRemoteShellJob({ runId: 'raw', jobKey: 'build', trigger: { type: 'push', payload: { repository: { full_name: 'owner/trigger-repo' }, ref: 'refs/heads/main', after: sha } }, jobSpec: { 'runs-on': 'default', steps: [{ uses: 'checkout' }, { run: 'true' }] } });
    expect(remote.status).toBe('success');
    const rawArgs = readFileSync(marker, 'utf8'); expect(rawArgs).toContain('https://github.com/owner/trigger-repo'); expect(rawArgs).toContain(sha);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

it('retains a private workspace when owned process termination is uncertain', async () => {
  const store = new MemoryStore(), queue = new MemoryQueueClient(); let workspace = '';
  const pipelineSpec = { on: { workflow_dispatch: {} }, jobs: { build: { 'runs-on': 'default', steps: [{ run: 'owned-command' }] } } };
  const run = store.createRun({ pipelineSpec, trigger: { type: 'workflow_dispatch' } });
  const runner = new Runner({ store, queue, logClient: new MemoryLogFnClient(), pipelineSpecs: new Map([[run.id, pipelineSpec]]),
    runCommand: async (_command, path) => { workspace = path; throw new ProcessGroupUncertainError(); } });
  await queue.enqueue(DEFAULT_QUEUE_NAME, { runId: run.id, jobKey: 'build', jobSpec: pipelineSpec.jobs.build });
  try { await expect(runner.processNextJob()).rejects.toBeInstanceOf(ProcessGroupUncertainError); expect(existsSync(workspace)).toBe(true); }
  finally { if (workspace) rmSync(workspace, { recursive: true, force: true }); }
});
