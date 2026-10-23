import { execFile } from 'node:child_process';
import { BrowseFnError } from '../../core/errors.js';

const cleanupError = () => new BrowseFnError({ code: 'PROVIDER_ERROR', message: 'Could not confirm isolated browser cleanup.' });
function command(args: string[]): Promise<{ failed: boolean; stderr: string }> {
  return new Promise(resolve => execFile('docker', args, { timeout: 1500, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
    resolve({ failed: !!error, stderr: String(stderr) });
  }));
}
/** Never infer successful cleanup from daemon failure or an ignored removal error. */
export async function removeOwnedBrowserContainer(name: string): Promise<void> {
  if (!/^browsefn-[a-f0-9-]{36}$/.test(name)) throw cleanupError();
  await command(['rm', '-f', name]);
  const deadline = Date.now() + 5000;
  while (true) {
    const status = await command(['inspect', '--format', '{{.State.Status}}', name]);
    if (status.failed) {
      if (/No such (?:object|container):/i.test(status.stderr)) return;
      throw cleanupError();
    }
    if (Date.now() >= deadline) throw cleanupError();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export function browserDeadline(timeoutMs: number, startedAt = Date.now()) {
  const remaining = () => {
    const value = timeoutMs - (Date.now() - startedAt);
    if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw timeout();
    return value;
  };
  const timeout = () => new BrowseFnError({ code: 'UPSTREAM_TIMEOUT', message: 'Isolated browser request timed out.' });
  return {
    remaining,
    async wait<T>(operation: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(timeout()), remaining()); })]);
      } finally { clearTimeout(timer); }
    },
  };
}
