import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import type { ObservationMetric } from '@superfunctions/observability';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileFn, type FileFnConfig, type QuotaProvider } from '../src/index.js';

describe('domain metrics (N-04)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-metrics-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeFileFn(extra: Partial<FileFnConfig> = {}) {
    const metrics: ObservationMetric[] = [];
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
      auth: { required: false, resolveSession: async () => null },
      observability: {
        metrics: {
          record(metric) {
            metrics.push(metric);
          },
        },
      },
      ...extra,
    });
    return { fileFn, metrics };
  }

  function ofKind(metrics: ObservationMetric[], kind: string, operation: string) {
    return metrics.filter((metric) => metric.kind === kind && metric.operation === operation);
  }

  it('records a handled upload failure when storage cannot stat an object', async () => {
    const storage = createLocalStorageAdapter({ rootDir });
    delete (storage as { statObject?: unknown }).statObject;
    const { fileFn, metrics } = makeFileFn({ storage });

    const response = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_test_stat' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));

    expect(response!.status).toBe(500);
    const failures = ofKind(metrics, 'filefn.upload', 'failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ ok: false, labels: { reason: 'size_unverified' } });
    expect(JSON.stringify(failures[0])).not.toMatch(/uploadSession|file_/);
  });

  it('records a quota denial without usage figures', async () => {
    const quota = {
      async checkQuota() {
        return { allowed: false, current: 4, limit: 4 };
      },
      async recordUsage() {},
    } as QuotaProvider;
    const { fileFn, metrics } = makeFileFn({ quota });

    const response = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));

    expect(response!.status).toBe(402);
    const denials = ofKind(metrics, 'filefn.quota', 'denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ ok: false });
    expect(denials[0]?.labels ?? {}).toEqual({});
    expect(JSON.stringify(denials[0])).not.toMatch(/"current"|"limit"|requested/);
  });

  it('records processing duration when a run completes', async () => {
    const pending: Promise<unknown>[] = [];
    const { fileFn, metrics } = makeFileFn({
      runtime: {
        defer(work) {
          pending.push(work);
        },
      },
      processing: {
        enabled: true,
        processors: [{
          name: 'noop',
          supportedMimeTypes: ['text/plain'],
          async process() {
            return { success: true, artifacts: [] };
          },
        }],
      },
    });

    const init = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));
    expect(init!.status).toBe(200);
    const created = await init!.json() as { data: { uploadSessionId: string; uploadSessionToken: string } };
    const headers = { 'x-upload-session-token': created.data.uploadSessionToken };
    const part = await fileFn.router.handle(new Request(`http://localhost/upload/${created.data.uploadSessionId}/parts/1`, {
      method: 'PUT',
      headers,
      body: 'x',
    }));
    expect(part!.status).toBe(200);
    const complete = await fileFn.router.handle(new Request(`http://localhost/upload/${created.data.uploadSessionId}/complete`, {
      method: 'POST',
      headers,
    }));
    expect(complete!.status).toBe(200);

    let seen = 0;
    while (pending.length > seen) {
      const batch = pending.slice(seen);
      seen = pending.length;
      await Promise.all(batch);
    }

    const durations = ofKind(metrics, 'filefn.processing', 'complete');
    expect(durations).toHaveLength(1);
    expect(durations[0]).toMatchObject({ ok: true });
    expect(typeof durations[0]?.durationMs).toBe('number');
    expect(durations[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(durations[0])).not.toMatch(/file_|ver_|uploadSession/);
  });
});
