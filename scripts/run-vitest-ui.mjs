import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform === 'win32' && !process.env.npm_execpath) {
  throw new Error('On Windows, launch through npm run test:ui so npm_execpath is available');
}

// npm exec skips packages already present in its local tree. An empty prefix
// keeps Vitest, UI and the default projects' jsdom in the same isolated tree.
const prefix = await mkdtemp(join(tmpdir(), 'superfunctions-vitest-ui-'));
const args = ['exec', '--yes', '--package=npm@11.21.0', '--', 'npm', 'exec',
  '--prefix', prefix, '--yes', '--package=vitest@4.1.12',
  '--package=@vitest/ui@4.1.12', '--package=jsdom@27.4.0', '--',
  'vitest', '--ui', '--watch', ...process.argv.slice(2)];
const grouped = process.platform !== 'win32';
let child;
let escalation;
let interruptedCode;
let windowsTermination;
let rejectShutdown;
const shutdownFailed = new Promise((_, reject) => { rejectShutdown = reject; });
shutdownFailed.catch(() => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function exists() {
  if (!child?.pid) return false;
  if (!grouped) return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function signal(signal) {
  if (!child?.pid) return;
  // A naturally exited Windows parent no longer gives taskkill a usable tree.
  // Preserve its result; descendant absence cannot be proved on that path.
  if (!grouped && (child.exitCode !== null || child.signalCode !== null)) return;
  try {
    if (grouped) process.kill(-child.pid, signal);
    else windowsTermination ??= new Promise((resolve, reject) => {
      // Use the OS-owned PID tree, never a shell command or a process-name sweep.
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'inherit', windowsHide: true, timeout: 5000, killSignal: 'SIGKILL' });
      killer.once('error', reject);
      killer.once('exit', code => code === 0 ? resolve() : reject(new Error(`taskkill failed (${code}); UI tree cleanup is unconfirmed`)));
    });
    // Observe asynchronous failures immediately; finally still propagates them.
    windowsTermination?.catch(rejectShutdown);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function waitForTermination(milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (exists()) {
    if (Date.now() >= deadline) return false;
    await pause(50);
  }
  return true;
}
function interrupt(signalName, code) {
  interruptedCode = code;
  signal(signalName);
  escalation ??= setTimeout(() => signal('SIGKILL'), 5000).unref();
}
const onInterrupt = () => interrupt('SIGINT', 130);
const onTerminate = () => interrupt('SIGTERM', 143);
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
try {
  child = process.env.npm_execpath
    ? spawn(process.execPath, [process.env.npm_execpath, ...args], { stdio: 'inherit', detached: grouped })
    : spawn('npm', args, { stdio: 'inherit', detached: grouped, shell: false });
  const code = await Promise.race([shutdownFailed, new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  })]);
  process.exitCode = interruptedCode ?? code;
} finally {
  // npm may exit before its UI descendants. Verify the whole owned POSIX group,
  // not merely the direct child, before removing its temporary prefix.
  signal('SIGTERM');
  if (windowsTermination) await windowsTermination;
  if (!await waitForTermination(5000)) {
    signal('SIGKILL');
    if (!await waitForTermination(5000)) throw new Error(`UI process cleanup incomplete: ${child.pid}; prefix retained at ${prefix}`);
  }
  clearTimeout(escalation);
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  await rm(prefix, { recursive: true, force: true });
}
