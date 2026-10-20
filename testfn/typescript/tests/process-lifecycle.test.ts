import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { executeNode } from '../src/integrations/process.js';

async function fixture(mode: 'exit' | 'wait', stdio: 'ignored' | 'closed') {
  const root = await mkdtemp(join(tmpdir(), 'testfn-process-'));
  const ready = join(root, 'ready');
  const childCode = `process.on('SIGTERM',()=>{});${stdio === 'closed' ? "require('fs').closeSync(1);require('fs').closeSync(2);" : ''}process.send('ready');setInterval(()=>{},1000);`;
  const code = `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore',${stdio === 'ignored' ? "'ignore','ignore'" : "'inherit','inherit'"},'ipc']});child.once('message',()=>{require('fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({group:process.pid,child:child.pid}));child.disconnect();child.unref();${mode === 'wait' ? 'setInterval(()=>{},1000);' : ''}});`;
  const ids = async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { return JSON.parse(await readFile(ready, 'utf8')) as { group: number; child: number }; }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    throw new Error('Fixture failed to become ready');
  };
  return { code, ids, cleanup: async () => {
    vi.restoreAllMocks();
    try { const value = JSON.parse(await readFile(ready, 'utf8')); process.kill(-value.group, 'SIGKILL'); } catch {}
    await rm(root, { recursive: true, force: true });
  } };
}

it.skipIf(process.platform === 'win32').each(['ignored', 'closed'] as const)('cleans normal-exit resistant descendants with %s stdio and fails the execution', async stdio => {
  const test = await fixture('exit', stdio);
  try {
    const execution = executeNode(['-e', test.code], { timeout: 5000 });
    const ids = await test.ids();
    const result = await execution;
    expect(result.code).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(() => process.kill(-ids.group, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  } finally { await test.cleanup(); }
}, 10000);

it.skipIf(process.platform === 'win32').each(['cancel', 'timeout'] as const)('waits for the whole owned group after %s and preserves an unrelated process', async mode => {
  const test = await fixture('wait', 'closed');
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const sentinelExit = once(sentinel, 'exit');
  const controller = new AbortController();
  try {
    const execution = executeNode(['-e', test.code], { signal: controller.signal, timeout: mode === 'timeout' ? 700 : 5000 });
    const ids = await test.ids();
    if (mode === 'cancel') controller.abort();
    const result = await execution;
    expect(result.aborted).toBe(mode === 'cancel');
    expect(result.timedOut).toBe(mode === 'timeout');
    expect(() => process.kill(-ids.group, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
  } finally { await test.cleanup(); sentinel.kill('SIGKILL'); await sentinelExit; }
}, 10000);

it.skipIf(process.platform === 'win32')('rejects unconfirmed group termination rather than reporting cancellation success', async () => {
  const test = await fixture('wait', 'ignored');
  const controller = new AbortController();
  try {
    const execution = executeNode(['-e', test.code], { signal: controller.signal, timeout: 5000 });
    const result = expect(execution).rejects.toThrow('termination could not be confirmed');
    const ids = await test.ids();
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -ids.group && signal === 'SIGTERM') throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    controller.abort();
    await result;
    expect(() => kill(ids.child, 0)).not.toThrow();
  } finally { await test.cleanup(); }
}, 10000);
