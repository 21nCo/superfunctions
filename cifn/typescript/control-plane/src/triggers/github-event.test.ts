import { expect, it } from 'vitest';
import { normalizeGitHubEvent } from './github-event.js';
const repo = { id: 42, full_name: 'owner/repo', clone_url: 'https://github.com/owner/repo.git' };
const pr = () => ({ action: 'synchronize', repository: repo, pull_request: { head: { repo, ref: 'feature', sha: 'a'.repeat(40) }, base: { repo, ref: 'main' } } });
it('separates PR base branch filtering from immutable head checkout', () => {
  expect(normalizeGitHubEvent(pr(), 'pull_request')).toMatchObject({ kind: 'run', event: { branch: 'main', sha: 'a'.repeat(40), github: { ref: 'refs/heads/feature', repository: 'owner/repo' } } });
});
it('rejects mismatched base identity and denies a fork even with identical branch names', () => {
  const fork = pr(); fork.pull_request.head.repo = { ...repo, id: 43 };
  expect(normalizeGitHubEvent(fork, 'pull_request')).toEqual({ kind: 'deny', reason: 'fork_pull_request_not_authorized' });
  const invalid = pr(); invalid.pull_request.base.repo = { ...repo, id: 43 };
  expect(() => normalizeGitHubEvent(invalid, 'pull_request')).toThrow('base identity');
});
it('skips unsupported actions and deletion/tag pushes, rejects malformed identities', () => {
  expect(normalizeGitHubEvent({ ...pr(), action: 'closed' }, 'pull_request').kind).toBe('skip');
  expect(normalizeGitHubEvent({ repository: repo, deleted: true, ref: 'refs/heads/main' }, 'push').kind).toBe('skip');
  expect(normalizeGitHubEvent({ repository: repo, ref: 'refs/tags/v1' }, 'push').kind).toBe('skip');
  for (const payload of [null, [], { repository: repo, ref: 'refs/heads/main' }, { repository: repo, ref: 'refs/heads/main', after: '0'.repeat(40) }]) expect(() => normalizeGitHubEvent(payload, 'push')).toThrow();
});
