import { createRunManifest, type DeterministicSettings } from '@probefn/contracts';
import { buildReportJson } from '../../session-reporter/src/report-json.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ArtifactCapTracker, ArtifactStore, NdjsonEventSink, readEventSinkFamily } from '../src/index.js';
import { captureEventDeltaBaseline } from '@probefn/core';
import { ProbefnRuntime } from '../../mcp-server/src/server.js';

it('reads every rolled event through storage, deltas and MCP in numeric order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-rollover-'));
  try {
    const sink = new NdjsonEventSink({ repoRoot: root, relativeDirectory: 'events', baseName: 'console',
      capTracker: new ArtifactCapTracker(), policy: { maxEventsPerSink: 1, strategy: 'rollover' } });
    for (let i = 1; i <= 12; i++) await sink.append({ type: 'console', level: 'error', sequence: i });
    await writeFile(path.join(root, 'events', 'console-other.ndjson'), '{"sequence":999}\n');
    const records = await readEventSinkFamily(root, 'events/console.ndjson');
    expect(records.map(record => record.payload.sequence)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(records[11]).toMatchObject({ relativePath: 'events/console-0012.ndjson', lineNumber: 1 });
    expect(await captureEventDeltaBaseline(root, { consoleSinkPath: 'events/console.ndjson' })).toMatchObject({ consoleErrors: 12 });
    expect(await new ProbefnRuntime(root).readEventSink('events/console.ndjson')).toHaveLength(12);
    const deterministic: DeterministicSettings = { enabled: true, viewport: { width: 800, height: 600 },
      locale: 'en-US', timezone: 'UTC', colorScheme: 'light', reducedMotion: 'reduce', animationPolicy: 'freeze', networkIdleMs: 10 };
    const store = new ArtifactStore({ repoRoot: root });
    const paths = store.getRunPaths('rollover');
    const metadata = { sessionId: 'session', runId: 'rollover', mode: 'debug' as const, browser: 'chromium' as const,
      artifactRoot: paths.runRoot, startedAt: '2026-10-20T00:00:00Z', status: 'completed' as const, deterministic };
    await store.writeRunManifest('rollover', createRunManifest(metadata));
    const report = await buildReportJson({ repoRoot: root, session: { ...metadata, deterministic: { ...deterministic },
      artifacts: { manifestPath: paths.sessionManifestPath, consoleSinkPath: 'events/console.ndjson' } } });
    expect(report.report.eventIndex.console).toHaveLength(12);
    expect(report.report.eventIndex.console[11]).toMatchObject({ eventId: 'evt_console_12', sinkPath: 'events/console-0012.ndjson', lineNumber: 1 });
    await writeFile(path.join(root, 'events', 'console-0013.ndjson'), 'corrupt\n');
    await expect(readEventSinkFamily(root, 'events/console.ndjson')).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves physical line numbers and rejects escaping paths and missing anchors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-rollover-'));
  try {
    await writeFile(path.join(root, 'events.ndjson'), '\n{"sequence":1}\n\n{"sequence":2}\n');
    expect((await readEventSinkFamily(root, 'events.ndjson')).map(record => record.lineNumber)).toEqual([2, 4]);
    await expect(readEventSinkFamily(root, '../events.ndjson')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    await expect(readEventSinkFamily(root, 'missing.ndjson')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
