import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '@probefn/storage';
import type { SessionStateLike } from '../src/report-json.js';
import { ReportService } from '../../core/src/report-service.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-report-stream-'));
  const artifactRoot = '.artifacts/runs/run_test';
  const events = `${artifactRoot}/events`;
  await mkdir(path.join(root, events), { recursive: true });
  const session: SessionStateLike = { sessionId: 'sess_test', runId: 'run_test', mode: 'debug', browser: 'chromium', artifactRoot,
    startedAt: '2026-01-01T00:00:00Z', status: 'stopped', deterministic: {}, artifacts: {
      manifestPath: `${artifactRoot}/session.json`, consoleSinkPath: `${events}/console.ndjson`,
      networkSinkPath: `${events}/network.ndjson`, pageErrorSinkPath: `${events}/page.ndjson`,
      devServerStdoutSinkPath: `${events}/stdout.ndjson`, devServerStderrSinkPath: `${events}/stderr.ndjson`,
    } };
  await writeFile(path.join(root, session.artifacts.manifestPath), JSON.stringify({ ...session, schemaVersion: '1.0.0', password: randomUUID() }));
  const write = async (name: string, rows: unknown[]) => writeFile(path.join(root, events, name), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await write('actions.ndjson', [{ action: 'click', query: 'Submit order' }]);
  await write('console.ndjson', [{ text: 'First 文', password: randomUUID(), path: '.artifacts/auth-profiles/demo/storage-state.json' }, { text: 'Cannot read properties of undefined (reading "user")' }]);
  await write('console-0002.ndjson', [{ text: 'Cannot read properties of undefined (reading "plan")' }, { text: 'Bearer sample-token', nested: ['.artifacts/auth-profiles/demo/storage-state.json', 'safe'] }]);
  await write('network.ndjson', [{ method: 'POST', url: 'https://example.invalid/order/submit', headers: { Authorization: `Bearer ${randomUUID()}` } }]);
  await write('page.ndjson', [{ message: 'Cannot read properties of undefined (reading "another")' }]);
  await write('stdout.ndjson', [{ line: 'ready', token: '[REDACTED]' }]);
  await write('stderr.ndjson', [{ line: 'error' }]);
  return { root, session };
}

describe('artifact-only reports', () => {
  it('matches full JSON contents, Markdown bytes, warnings and counts across rollover/redaction/correlation', async () => {
    const { root, session } = await fixture();
    try {
      const store = new ArtifactStore({ repoRoot: root });
      const service = new ReportService({ repoRoot: root, artifactStore: store });
      for (const format of ['json', 'markdown'] as const) {
        const full = await service.exportReport({ session, format });
        const expected = await readFile(path.join(root, full.reportPath), 'utf8');
        const streamed = await service.exportReportArtifact({ session, format });
        const actual = await readFile(path.join(root, streamed.reportPath), 'utf8');
        if (format === 'json') {
          expect(JSON.parse(actual)).toEqual(JSON.parse(expected));
          expect(JSON.parse(actual).eventIndex.console).toHaveLength(4);
          expect(JSON.parse(actual).hypotheses[0].hypothesisId).toBe('rh_submit_plan');
        } else expect(actual).toBe(expected);
        const { reportData: _data, ...metadata } = full;
        expect(streamed).toEqual(metadata);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves previous report and removes temporary output after malformed input', async () => {
    const { root, session } = await fixture();
    try {
      const store = new ArtifactStore({ repoRoot: root });
      const service = new ReportService({ repoRoot: root, artifactStore: store });
      const target = path.join(root, session.artifactRoot, 'report.json');
      await writeFile(target, 'previous');
      await writeFile(path.join(root, session.artifacts.networkSinkPath!), '{invalid\n');
      await expect(service.exportReportArtifact({ session, format: 'json' })).rejects.toThrow();
      expect(await readFile(target, 'utf8')).toBe('previous');
      expect((await readdir(path.dirname(target))).filter(name => name.includes('.tmp-'))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('applies byte caps incrementally and removes temporary output on failure', async () => {
    const { root, session } = await fixture();
    try {
      const store = new ArtifactStore({ repoRoot: root, caps: { maxArtifactBytes: 100 } });
      const service = new ReportService({ repoRoot: root, artifactStore: store });
      await expect(service.exportReportArtifact({ session, format: 'json' })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
      expect((await readdir(path.join(root, session.artifactRoot))).filter(name => name.includes('report.json'))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('returns structured filesystem failures and removes abandoned temporary files', async () => {
    const { root, session } = await fixture();
    try {
      const store = new ArtifactStore({ repoRoot: root });
      const service = new ReportService({ repoRoot: root, artifactStore: store });
      const target = path.join(root, session.artifactRoot, 'report.json');
      await mkdir(target);
      await expect(service.exportReportArtifact({ session, format: 'json' })).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
      expect((await readdir(path.dirname(target))).filter(name => name.includes('.tmp-'))).toEqual([]);
      expect(await readdir(target)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
