import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createObservability, type ObservationMetric, type RequestObservation } from '@superfunctions/observability';
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

  it('preserves getter-backed request context and logging when guarding a configured sink', async () => {
    const context = new AsyncLocalStorage<RequestObservation<FileFnObservationEvent>>();
    const observations: Array<{ kind: string; requestId?: string }> = [];
    const warnings: string[] = [];
    class HostConfiguration {
      get metrics() {
        return (metric: ObservationMetric) => {
          observations.push({ kind: metric.kind, requestId: context.getStore()?.requestId });
        };
      }
      get logger() {
        return { warn: (message: string) => { warnings.push(message); } };
      }
      get requestContext() {
        return {
          get: () => context.getStore(),
          run: async <T>(observation: RequestObservation<FileFnObservationEvent>, work: () => T | Promise<T>) =>
            context.run(observation, work),
        };
      }
    }
    const storage = createLocalStorageAdapter({ rootDir });
    delete (storage as { statObject?: unknown }).statObject;
    const { fileFn } = makeFileFn({ storage, observability: new HostConfiguration() });
    const response = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'test-host-upload' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));
    expect(response!.status).toBe(500);
    expect(observations).toContainEqual({ kind: 'filefn.upload', requestId: 'test-host-upload' });
    expect(warnings).toContain('Upload storage adapter does not implement statObject');
  });

  it('preserves a bare logger with its own metrics property', async () => {
    const warnings: string[] = [];
    const storage = createLocalStorageAdapter({ rootDir });
    delete (storage as { statObject?: unknown }).statObject;
    const logger = {
      warn: (message: string) => { warnings.push(message); },
      metrics: () => { throw new Error('test logger internal metric function'); },
    };
    const { fileFn } = makeFileFn({ storage, observability: logger });
    const response = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));
    expect(response!.status).toBe(500);
    expect(warnings).toContain('Upload storage adapter does not implement statObject');
  });

  it('requires a guarded sink for new domain metrics when the host supplies a prebuilt scope', async () => {
    const observed: string[] = [];
    const observability = createObservability<FileFnObservationEvent>({
      async metrics(metric) {
        observed.push(metric.kind);
        if (metric.kind === 'filefn.upload') throw new Error('test metric sink offline');
      },
    });
    const storage = createLocalStorageAdapter({ rootDir });
    delete (storage as { statObject?: unknown }).statObject;
    const { fileFn } = makeFileFn({ storage, observability });
    const response = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));
    expect(response!.status).toBe(500);
    expect(observed).not.toContain('filefn.upload');
  });

  it.each([true, false])('records duration and outcome when a run completes (success=%s)', async (success) => {
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
            return { success, artifacts: [] };
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
    expect(durations[0]).toMatchObject({ ok: success });
    expect(typeof durations[0]?.durationMs).toBe('number');
    expect(durations[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(durations[0])).not.toMatch(/file_|ver_|uploadSession/);
  });
});
