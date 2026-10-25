import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeOwnedProcess, ProcessGroupUncertainError } from '../execution/owned-process.js';

export interface CheckoutOptions {
  repo: string;
  ref: string;
  workspace: string;
  token?: string;
  /** Trusted host policy, never a pipeline-controlled field. */
  allowLocalRepositories?: boolean;
  signal?: AbortSignal;
}
export interface CheckoutResult { success: boolean; lines: string[]; error?: string }
const failure = (): CheckoutResult => ({ success: false, lines: ['Checkout failed'], error: 'Checkout failed' });

function prepare(options: CheckoutOptions) {
  const { ref, token } = options;
  let { repo } = options;
  if (options.allowLocalRepositories !== undefined && typeof options.allowLocalRepositories !== 'boolean') throw Error('Invalid local repository policy');
  if (typeof repo === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo)) repo = `https://github.com/${repo}`;
  try { lstatSync(join(options.workspace, '.git')); throw Error('Checkout requires a fresh workspace'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (typeof repo !== 'string' || repo.length > 4096 || /[\x00-\x20\x7f]/.test(repo) || repo.startsWith('-')) throw Error('Invalid repository');
  if (typeof ref !== 'string' || !ref || ref.length > 1024 || ref.startsWith('-') || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw Error('Invalid ref');
  let repository: string;
  if (isAbsolute(repo)) {
    if (!options.allowLocalRepositories || token) throw Error('Local repository policy');
    repository = realpathSync(repo);
    if (!lstatSync(repository).isDirectory()) throw Error('Invalid local repository');
  } else {
    const url = new URL(repo);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) throw Error('Invalid repository transport');
    repository = url.href;
  }
  if (token !== undefined && (typeof token !== 'string' || !token || token.length > 65536 || /[\r\n\x00]/.test(token))) throw Error('Invalid credential');
  const directory = mkdtempSync(join(tmpdir(), 'cifn-git-'));
  try {
    const home = join(directory, 'home'); mkdirSync(home, { mode: 0o700 });
    const askpass = join(directory, 'askpass');
    writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token";; *Password*) printf "%s\\n" "$CIFN_CHECKOUT_TOKEN";; *) exit 1;; esac\n', { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C', HOME: home, XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: askpass, GIT_LFS_SKIP_SMUDGE: '1', ...(token ? { CIFN_CHECKOUT_TOKEN: token } : {}) };
    const prefix = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always', '-c', `protocol.file.allow=${options.allowLocalRepositories ? 'always' : 'never'}`,
      '-c', 'http.followRedirects=false', '-c', 'submodule.recurse=false'];
    // No remote URL/credential is persisted. Fetch a ref or full commit ID into FETCH_HEAD.
    const commands = [['init', '--template=', '.'], ['fetch', '--no-tags', '--depth=1', '--', repository, ref], ['checkout', '--detach', '--force', 'FETCH_HEAD']];
    return { directory, env, commands: commands.map(args => [...prefix, ...args]) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

/** Compatibility synchronous API; remote execution always uses executeOwnedCheckout. */
export function executeCheckout(options: CheckoutOptions): CheckoutResult {
  let prepared: ReturnType<typeof prepare> | undefined;
  const deadline = performance.now() + 120_000;
  try {
    prepared = prepare(options);
    for (const args of prepared.commands) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) return failure();
      execFileSync('git', args, { cwd: options.workspace, env: prepared.env, timeout: remaining, maxBuffer: 1_048_576, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return { success: true, lines: ['Checkout complete'] };
  } catch { return failure(); }
  finally { if (prepared) rmSync(prepared.directory, { recursive: true, force: true }); }
}

/** Cancellation and timeout retain the same owned POSIX process-group guarantees as shell steps. */
export async function executeOwnedCheckout(options: CheckoutOptions): Promise<CheckoutResult> {
  let prepared: ReturnType<typeof prepare> | undefined;
  let uncertain = false;
  const deadline = performance.now() + 120_000;
  try {
    if (options.signal?.aborted) return failure();
    prepared = prepare(options);
    for (const args of prepared.commands) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0 || options.signal?.aborted) return failure();
      const result = await executeOwnedProcess('git', args, options.workspace, prepared.env, options.signal, undefined, remaining);
      if (result.exitCode !== 0 || result.truncated) return failure();
    }
    return { success: true, lines: ['Checkout complete'] };
  } catch (error) { if (error instanceof ProcessGroupUncertainError) { uncertain = true; throw error; } return failure(); }
  finally { if (prepared && !uncertain) rmSync(prepared.directory, { recursive: true, force: true }); }
}
