/** Signed GitHub delivery normalization. Branch filters are literal names, not globs. */
export interface NormalizedGitHubEvent {
  repo: string;
  sha: string;
  branch: string;
  github: { ref: string; repository: string; sha: string; event_name: 'push' | 'pull_request' };
}
export type GitHubEventDecision =
  | { kind: 'run'; event: NormalizedGitHubEvent }
  | { kind: 'skip'; reason: string }
  | { kind: 'deny'; reason: string };

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-fA-F0-9]{40}$/.test(value) && !/^0+$/.test(value);
const branch = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'));
const name = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
function repository(value: unknown) {
  const repo = object(value);
  if (!repo || !name(repo.full_name)) throw new Error('Invalid repository identity');
  if (repo.clone_url !== undefined && (typeof repo.clone_url !== 'string' || repo.clone_url.length === 0 || repo.clone_url.length > 4096)) throw new Error('Invalid repository URL');
  return { fullName: repo.full_name, url: (repo.clone_url as string | undefined) ?? repo.full_name, id: repo.id };
}

export function normalizeGitHubEvent(payload: unknown, type: 'push' | 'pull_request'): GitHubEventDecision {
  const event = object(payload);
  if (!event) throw new Error('Invalid webhook payload');
  const repo = repository(event.repository);
  if (type === 'push') {
    if (typeof event.ref !== 'string') throw new Error('Missing push ref');
    if (event.deleted === true) return { kind: 'skip', reason: 'deleted_ref' };
    if (event.ref.startsWith('refs/tags/')) return { kind: 'skip', reason: 'tag_push' };
    if (!event.ref.startsWith('refs/heads/') || !branch(event.ref.slice(11)) || !sha(event.after)) throw new Error('Invalid push branch or commit');
    return { kind: 'run', event: { repo: repo.url, sha: event.after.toLowerCase(), branch: event.ref.slice(11), github: { ref: event.ref, repository: repo.fullName, sha: event.after.toLowerCase(), event_name: type } } };
  }
  if (typeof event.action !== 'string') throw new Error('Missing pull request action');
  if (!['opened', 'reopened', 'synchronize'].includes(event.action)) return { kind: 'skip', reason: 'pull_request_action' };
  const pr = object(event.pull_request), head = object(pr?.head), base = object(pr?.base);
  if (!pr || !head || !base || !branch(head.ref) || !branch(base.ref) || !sha(head.sha)) throw new Error('Invalid pull request head or base');
  const headRepo = repository(head.repo), baseRepo = repository(base.repo);
  if (!Number.isSafeInteger(repo.id) || Number(repo.id) <= 0 || repo.id !== baseRepo.id || repo.fullName.toLowerCase() !== baseRepo.fullName.toLowerCase()) throw new Error('Pull request base identity mismatch');
  if (repo.id !== headRepo.id || repo.fullName.toLowerCase() !== headRepo.fullName.toLowerCase()) return { kind: 'deny', reason: 'fork_pull_request_not_authorized' };
  return { kind: 'run', event: { repo: repo.url, sha: head.sha.toLowerCase(), branch: base.ref, github: { ref: `refs/heads/${head.ref}`, repository: repo.fullName, sha: head.sha.toLowerCase(), event_name: type } } };
}
