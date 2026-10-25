import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
export interface OwnedProcessResult { exitCode: number; stdout: string; stderr: string; lines: string[]; truncated?: boolean; streamed?: boolean }

export class ProcessGroupUncertainError extends Error {
  constructor() { super('Owned process group termination requires reconciliation'); }
}
/** POSIX only. Never uses process identities recovered from persistent state. */
export async function executeOwnedShell(command: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, onLines?: (lines: string[]) => void): Promise<OwnedProcessResult> {
  return executeOwnedProcess('/bin/sh', ['-c', command], cwd, env, signal, onLines);
}

/** Same owned-process lifecycle for argv-based tools; no shell interpolation. */
export async function executeOwnedProcess(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, onLines?: (lines: string[]) => void, timeoutMs = 300_000): Promise<OwnedProcessResult> {
  const empty = { exitCode: 1, stdout: '', stderr: '', lines: [] };
  if (signal?.aborted) return empty;
  if (process.platform === 'win32') throw new ProcessGroupUncertainError();
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false;
  child.once('close', () => { closed = true; });
  let stdout = ''; let stderr = ''; let bytes = 0; let stopping = false;
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  const partial = { stdout: '', stderr: '' };
  const publish = (text: string, output: 'stdout' | 'stderr') => {
    if (!onLines) return;
    partial[output] += text;
    const lines = partial[output].split('\n');
    partial[output] = lines.pop()!;
    if (lines.length) onLines(lines.filter(Boolean));
  };
  const alive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false;
      // A transient EPERM probe is not proof of disappearance. Keep waiting
      // within the existing deadline; signal-delivery errors still fail closed.
      if ((cause as NodeJS.ErrnoException).code === 'EPERM') return true;
      throw new ProcessGroupUncertainError(); }
  };
  const send = (value: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, value); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw new ProcessGroupUncertainError(); }
  };
  let termination: Promise<void> | undefined;
  let rejectTermination!: (cause: unknown) => void;
  const terminationFailure = new Promise<number>((_, reject) => { rejectTermination = reject; });
  void terminationFailure.catch(() => {});
  const stop = () => {
    stopping = true;
    if (!termination) {
      termination = (async () => {
        send('SIGTERM');
        const gracefulUntil = Date.now() + 1_000;
        while (alive() && Date.now() < gracefulUntil) await delay(20);
        if (alive()) send('SIGKILL');
        const killUntil = Date.now() + 5_000;
        while (alive() && Date.now() < killUntil) await delay(20);
        if (alive()) throw new ProcessGroupUncertainError();
      })();
      // Observed again below; suppress unhandled rejection while awaiting child exit.
      void termination.catch(rejectTermination);
    }
  };
  const capture = (chunk: Buffer, output: 'stdout' | 'stderr') => {
    bytes += chunk.length;
    if (bytes > 1_048_576) { stop(); return; }
    const decoded = output === 'stdout' ? stdoutDecoder.write(chunk) : stderrDecoder.write(chunk);
    if (output === 'stdout') stdout += decoded; else stderr += decoded;
    publish(decoded, output);
  };
  child.stdout.on('data', chunk => capture(chunk, 'stdout'));
  child.stderr.on('data', chunk => capture(chunk, 'stderr'));
  signal?.addEventListener('abort', stop, { once: true });
  const timeout = setTimeout(stop, timeoutMs);
  try {
    const exited = new Promise<number>(resolve => {
      child.once('error', () => resolve(1));
      child.once('exit', (code) => resolve(code ?? 1));
      if (signal?.aborted) stop();
    });
    const code = await Promise.race([exited, terminationFailure]);
    // A shell exit or closed stdio does not prove its descendants have exited.
    if (alive()) stop();
    if (termination) await termination;
    if (alive()) throw new ProcessGroupUncertainError();
    const streamsUntil = Date.now() + 1_000;
    while (!closed && Date.now() < streamsUntil) await delay(10);
    if (!closed) throw new ProcessGroupUncertainError();
    const outTail = stdoutDecoder.end(), errTail = stderrDecoder.end();
    stdout += outTail; stderr += errTail;
    // A forcibly interrupted capture may end in a secret prefix. Withhold the
    // partial lines instead of persisting an unredactable fragment. Completed
    // lines were already passed through the caller's literal-secret redaction.
    if (stopping) return { exitCode: 1, stdout: '', stderr: '', lines: [], truncated: true, streamed: !!onLines };
    publish(outTail, 'stdout'); publish(errTail, 'stderr');
    if (onLines) onLines([partial.stdout, partial.stderr].filter(Boolean));
    const lines = [...stdout.split('\n'), ...stderr.split('\n')].filter(Boolean);
    return { exitCode: stopping ? 1 : code, stdout, stderr, lines, streamed: !!onLines };
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', stop);
    child.stdout.destroy(); child.stderr.destroy();
  }
}
