import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePipelineDoc } from './resolver.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cifn-resolver-test-')); roots.push(root);
  const source = join(root, 'source'), repo = join(root, 'bare'); mkdirSync(source); mkdirSync(join(source, '.ci'));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-b', 'main');
  writeFileSync(join(source, '.ci/pipeline.yml'), 'name: pinned');
  writeFileSync(join(root, 'outside'), 'must not read'); symlinkSync(join(root, 'outside'), join(source, 'escape.yml'));
  symlinkSync('.ci/pipeline.yml', join(source, 'inside.yml'));
  writeFileSync(join(source, 'oversize.yml'), 'é'.repeat(256001));
  writeFileSync(join(source, 'boundary.yml'), '#'.repeat(500 * 1024));
  git('add', '.'); git('commit', '-m', 'pinned'); const sha = git('rev-parse', 'HEAD');
  writeFileSync(join(source, '.ci/pipeline.yml'), 'name: newest'); git('commit', '-am', 'newest');
  git('clone', '--bare', '--', source, repo); return { repo, sha };
}
it('actual default Git resolver reads pinned SHA and branch using owned local policy', async () => {
  const { repo, sha } = fixture();
  expect(await resolvePipelineDoc({ repo, ref: sha }, { allowLocalRepositories: true })).toEqual({ doc: 'name: pinned', resolvedConfigPath: '.ci/pipeline.yml' });
  expect((await resolvePipelineDoc({ repo, ref: 'main' }, { allowLocalRepositories: true })).doc).toBe('name: newest');
  await expect(resolvePipelineDoc({ repo, ref: sha })).rejects.toThrow('Git checkout failed');
});
it('confines config files and enforces byte limits, including multibyte documents', async () => {
  const { repo, sha } = fixture(); const options = { allowLocalRepositories: true };
  expect((await resolvePipelineDoc({ repo, ref: sha, configPath: 'inside.yml' }, options)).doc).toBe('name: pinned');
  expect((await resolvePipelineDoc({ repo, ref: sha, configPath: 'boundary.yml' }, options)).doc.length).toBe(500 * 1024);
  await expect(resolvePipelineDoc({ repo, ref: sha, configPath: 'escape.yml' }, options)).rejects.toThrow('escapes workspace');
  await expect(resolvePipelineDoc({ repo, ref: sha, configPath: '.ci' }, options)).rejects.toThrow('regular file');
  await expect(resolvePipelineDoc({ repo, ref: sha, configPath: 'oversize.yml' }, options)).rejects.toThrow('500KB');
  await expect(resolvePipelineDoc({ repo, ref: sha, configPath: 'missing.yml' }, options)).rejects.toThrow('not found');
});
it('rejects malformed paths and cancellation before any fetcher/provider call', async () => {
  let calls = 0; const fetcher = async () => { calls++; return 'name: never'; };
  for (const configPath of ['/tmp/outside', '../outside', 'a/../../outside', 'a\\outside', '', 'a\0b']) {
    await expect(resolvePipelineDoc({ repo: 'never', ref: 'never', configPath }, { fetcher })).rejects.toThrow('config path');
  }
  const controller = new AbortController(); controller.abort();
  await expect(resolvePipelineDoc({ repo: 'never', ref: 'never' }, { fetcher, signal: controller.signal })).rejects.toThrow('cancelled');
  expect(calls).toBe(0);
  await expect(resolvePipelineDoc({ repo: 'trusted', ref: 'trusted' }, { fetcher: async () => 'é'.repeat(256001) })).rejects.toThrow('500KB');
});

it('cancels active resolver work before removing its owned workspace/helper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cifn-resolver-cancel-')); roots.push(root);
  const marker = join(root, 'started');
  writeFileSync(join(root, 'git'), `#!/bin/sh
printf '%s\\n' "$$" "$PWD" "$GIT_ASKPASS" > '${marker}'
exec /bin/sleep 30
`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = root;
  const controller = new AbortController();
  const pending = resolvePipelineDoc({ repo: 'https://fixture.invalid/repo', ref: 'HEAD' }, { signal: controller.signal });
  // Observe rejection immediately so the intentional cancellation cannot be unhandled.
  const observed = pending.then(value => ({ value }), error => ({ error }));
  try {
    const until = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(marker)).toBe(true); controller.abort();
    expect(await observed).toHaveProperty('error');
    const [pid, workspace, helper] = readFileSync(marker, 'utf8').trim().split('\n');
    expect(() => process.kill(Number(pid), 0)).toThrow();
    expect(existsSync(workspace)).toBe(false); expect(existsSync(helper)).toBe(false);
  } finally { controller.abort(); await observed; if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

it('does not accept a late custom-fetcher result after cancellation', async () => {
  const controller = new AbortController(); let finish!: (value: string) => void;
  const pending = resolvePipelineDoc({ repo: 'trusted', ref: 'trusted' }, { signal: controller.signal,
    fetcher: () => new Promise(resolve => { finish = resolve; }) });
  controller.abort(); finish('name: too late');
  await expect(pending).rejects.toThrow('cancelled');
});
