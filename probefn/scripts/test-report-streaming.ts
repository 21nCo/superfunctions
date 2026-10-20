import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ReportService } from '../packages/core/src/report-service.js';
import { ArtifactStore } from '../packages/storage/src/index.js';
import type { SessionStateLike } from '../packages/session-reporter/src/report-json.js';

const count = 160_000;
const text = '文'.repeat(512);
async function main() {
  if (process.argv[2] === '--worker') {
    const root = process.argv[3]!;
    const session = JSON.parse(await readFile(path.join(root, 'session-input.json'), 'utf8')) as SessionStateLike;
    const service = new ReportService({ repoRoot: root, artifactStore: new ArtifactStore({ repoRoot: root }) });
    const result = await service.exportReportArtifact({ session, format: 'json' });
    assert.equal('reportData' in result, false);
    let observed = 0;
    const lines = createInterface({ input: createReadStream(path.join(root, result.reportPath)), crlfDelay: Infinity });
    for await (const line of lines) {
      const start = line.indexOf('{"eventId":"evt_console_');
      if (start < 0) continue;
      const event = JSON.parse(line.slice(start));
      assert.equal(event.eventId, `evt_console_${++observed}`);
      assert.equal(event.lineNumber, observed);
      assert.equal(event.payload.text, text);
      assert.equal(event.payload.password, '[REDACTED]');
    }
    assert.equal(observed, count);
    const bytes = (await stat(path.join(root, result.reportPath))).size;
    assert.ok(bytes > 128 * 1024 * 1024);
    process.stdout.write(`${JSON.stringify({ events: observed, outputBytes: bytes, heapLimitMiB: 64 })}\n`);
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'probe-report-memory-'));
  try {
    const artifactRoot = '.artifacts/runs/run_large';
    const session: SessionStateLike = { sessionId: 'sess_large', runId: 'run_large', mode: 'debug', browser: 'chromium', artifactRoot,
      startedAt: '2026-01-01T00:00:00Z', status: 'stopped', deterministic: {}, artifacts: {
        manifestPath: `${artifactRoot}/session.json`, consoleSinkPath: `${artifactRoot}/events/console.ndjson`,
      } };
    await mkdir(path.join(root, artifactRoot, 'events'), { recursive: true });
    await writeFile(path.join(root, 'session-input.json'), JSON.stringify(session));
    await writeFile(path.join(root, session.artifacts.manifestPath), JSON.stringify({ schemaVersion: '1.0.0', ...session }));
    const handle = await open(path.join(root, session.artifacts.consoleSinkPath!), 'w');
    try {
      const batch = `${JSON.stringify({ text, password: randomUUID() })}\n`.repeat(1000);
      for (let i = 0; i < count; i += 1000) await handle.writeFile(batch);
    } finally { await handle.close(); }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=64', '--import', 'jiti/register', fileURLToPath(import.meta.url), '--worker', root], {
        cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))), stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = ''; let errors = '';
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) { process.stdout.write(output); resolve(); }
        else reject(new Error(`Report memory acceptance failed: code=${code} signal=${signal}\n${errors}`));
      });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
