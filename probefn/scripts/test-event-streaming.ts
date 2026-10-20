import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { captureEventDeltaBaseline } from '../packages/core/src/deltas.js';

const count = 160_000;
async function main(): Promise<void> {
  if (process.argv[2] === '--worker') {
    const result = await captureEventDeltaBaseline(process.argv[3]!, { consoleSinkPath: 'events.ndjson' });
    assert.equal(result.consoleErrors, count);
    process.stdout.write(`${JSON.stringify({ count: result.consoleErrors, heapLimitMiB: 64 })}\n`);
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'probefn-stream-memory-'));
  try {
    const line = `${JSON.stringify({ type: 'console', level: 'error', message: 'x'.repeat(768) })}\n`;
    const handle = await open(path.join(root, 'events.ndjson'), 'w');
    try {
      const batch = line.repeat(1000);
      for (let offset = 0; offset < count; offset += 1000) await handle.writeFile(batch);
    } finally { await handle.close(); }
    // Fixture volume exceeds the child's V8 heap. Array-based delta counting cannot retain it.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=64', '--import', 'jiti/register', fileURLToPath(import.meta.url), '--worker', root], {
        cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))), stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = ''; let errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) { process.stdout.write(output); resolve(); }
        else reject(new Error(`Streaming memory acceptance failed: code=${code} signal=${signal}\n${errors}`));
      });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
