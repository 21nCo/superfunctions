import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createObservability, type ObservationMetric } from '@superfunctions/observability';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileFn, type FileFnConfig, type FileFnObservationEvent, type QuotaProvider } from '../src/index.js';

describe('domain metrics (N-04)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-metrics-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeFileFn(extra: Partial<FileFnConfig> = {}, create = createFileFn) {
    const metrics: ObservationMetric[] = [];
    const fileFn = create({
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

  async function prepareUpload(fileFn: ReturnType<typeof createFileFn>) {
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
    return (router = fileFn.router) => router.handle(new Request(`http://localhost/upload/${created.data.uploadSessionId}/complete`, {
      method: 'POST',
      headers,
    }));
  }

  function gate() {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => { open = resolve; });
    return { wait, open };
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

  it('skips a quota denial when a concurrent complete has already published the upload', async () => {
    const checking = gate();
    const proceed = gate();
    let holdNextCheck = false;
    const quota: QuotaProvider = {
      async checkQuota() {
        if (holdNextCheck) {
          holdNextCheck = false;
          checking.open();
          await proceed.wait;
          return { allowed: false, current: 1, limit: 1 };
        }
        return { allowed: true, current: 0, limit: 1 };
      },
      async recordUsage() {},
    };
    const config = { database: memoryAdapter(), storage: createLocalStorageAdapter({ rootDir }), quota };
    const { fileFn, metrics } = makeFileFn(config);
    // Independent in-process serializers with shared storage, like two hosts.
    vi.resetModules();
    const peer = makeFileFn(config, (await import('../src/index.js')).createFileFn).fileFn;
    const complete = await prepareUpload(fileFn);
    holdNextCheck = true;
    const concurrent = complete();
    await Promise.race([checking.wait, concurrent.then(() => { throw new Error('Expected a pending quota check'); })]);
    try {
      expect((await complete(peer.router))!.status).toBe(200);
    } finally {
      proceed.open();
    }
    expect((await concurrent)!.status).toBe(200);
    expect(ofKind(metrics, 'filefn.quota', 'denied')).toEqual([]);
  });

  it('preserves an upload response when its metric sink rejects', async () => {
    const storage = createLocalStorageAdapter({ rootDir });
    delete (storage as { statObject?: unknown }).statObject;
    const observed: string[] = [];
    const { fileFn } = makeFileFn({
      storage,
      observability: {
        async metrics(metric) {
          observed.push(metric.kind);
          if (metric.kind === 'filefn.upload') throw new Error('test metric sink offline');
        },
      },
    });
    const response = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));
    expect(response!.status).toBe(500);
    expect(observed.filter((kind) => kind === 'filefn.upload')).toHaveLength(1);
  });

  it('records request metrics in the active host scope after a lazy import', async () => {
    const observed: ObservationMetric[] = [];
    const host = createObservability<FileFnObservationEvent>({ metrics: (metric) => { observed.push(metric); } });
    const storage = createLocalStorageAdapter({ rootDir });
    delete (storage as { statObject?: unknown }).statObject;
    const initial = host.startRequest({ requestId: 'test-host-initial' });
    vi.resetModules();
    const fileFn = await host.runWithRequest(initial, async () => {
      const lazy = await import('../src/index.js');
      return lazy.createFileFn({
        database: memoryAdapter(),
        storage,
        policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
        auth: { required: false },
        observability: host,
      });
    });
    initial.finish();

    const request = host.startRequest({ requestId: 'test-host-upload' });
    const response = await host.runWithRequest(request, () => fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    })));
    expect(response!.status).toBe(500);
    expect(ofKind(observed, 'filefn.upload', 'failure')).toHaveLength(1);
    expect(ofKind(request.finish().metrics, 'filefn.upload', 'failure')).toHaveLength(1);
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

    const complete = await prepareUpload(fileFn);
    expect((await complete())!.status).toBe(200);

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
