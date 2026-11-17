import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJobServer, type ContainerJobHandler, type JobServerOptions } from '../src/server.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(handler: ContainerJobHandler, options: Partial<JobServerOptions> = {}) {
  const server = createJobServer({ handler, maxConcurrentJobs: 2, maxBodyBytes: 4096, ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init),
    postJob: (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
  };
}

function completingHandler() {
  return { handle: vi.fn(async () => ({ status: 'completed', artifactsCreated: 1, skippedProcessors: [] })) };
}

const job = { fileId: 'file_1', versionId: 'ver_1', storageKey: 'files/a.png', mimeType: 'image/png', size: 3, fileName: 'a.png' };

describe('container job server', () => {
  it('answers GET /health without running a job', async () => {
    const handler = completingHandler();
    const client = await start(handler, { token: 'secret' });

    const response = await client.get('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('runs one job per POST /jobs with its delivery attempt and returns the outcome', async () => {
    const handler = completingHandler();
    const client = await start(handler);

    const first = await client.postJob({ job, attempts: 3 });
    const defaulted = await client.postJob({ job });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ outcome: { status: 'completed', artifactsCreated: 1, skippedProcessors: [] } });
    expect(defaulted.status).toBe(200);
    expect(handler.handle.mock.calls).toEqual([[job, { attempts: 3 }], [job, { attempts: 1 }]]);
  });

  it('returns a retry outcome as 200 so the caller decides to redeliver', async () => {
    const client = await start({ handle: async () => ({ status: 'retry', errors: ['thumbnail: boom'] }) });

    const response = await client.postJob({ job });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: { status: 'retry', errors: ['thumbnail: boom'] } });
  });

  it('serves no other routes or methods', async () => {
    const handler = completingHandler();
    const client = await start(handler);

    const responses = await Promise.all([
      client.get('/'),
      client.get('/jobs/1', { method: 'POST' }),
      client.get('/jobs'),
      client.get('/health', { method: 'POST' }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 405, 405]);
    expect(responses[2].headers.get('allow')).toBe('POST');
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-JSON body', 'not json', 400],
    ['a body without a job', { attempts: 1 }, 400],
    ['an array body', [job], 400],
    ['attempts below 1', { job, attempts: 0 }, 400],
    ['a fractional attempt', { job, attempts: 1.5 }, 400],
    ['a string attempt', { job, attempts: '2' }, 400],
  ])('rejects %s without running a job', async (_label, body, status) => {
    const handler = completingHandler();
    const client = await start(handler);

    const response = await client.postJob(body);

    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe('FILEFN_CONTAINER_REQUEST_INVALID');
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('requires a JSON content type', async () => {
    const handler = completingHandler();
    const client = await start(handler);

    const response = await client.postJob({ job }, { 'content-type': 'text/plain' });

    expect(response.status).toBe(415);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('rejects a body over the limit', async () => {
    const handler = completingHandler();
    const client = await start(handler, { maxBodyBytes: 1024 });

    const response = await client.postJob({ job: { ...job, fileName: 'x'.repeat(2048) } });

    expect(response.status).toBe(413);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('requires the bearer token for jobs when one is configured', async () => {
    const handler = completingHandler();
    const client = await start(handler, { token: 'secret' });

    const missing = await client.postJob({ job });
    const wrong = await client.postJob({ job }, { authorization: 'Bearer secret2' });
    const right = await client.postJob({ job }, { authorization: 'Bearer secret' });

    expect([missing.status, wrong.status, right.status]).toEqual([401, 401, 200]);
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('answers 503 past the concurrent job limit and accepts jobs again once one finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handle = vi.fn(async () => {
      await gate;
      return { status: 'completed' };
    });
    const client = await start({ handle }, { maxConcurrentJobs: 1 });

    const running = client.postJob({ job });
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    const busy = await client.postJob({ job });
    release();

    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('1');
    expect((await running).status).toBe(200);
    expect((await client.postJob({ job })).status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('answers 500 and reports the error when the handler throws', async () => {
    const onError = vi.fn();
    const failure = new Error('database unavailable');
    const client = await start({ handle: async () => { throw failure; } }, { onError });

    const response = await client.postJob({ job });

    expect(response.status).toBe(500);
    expect((await response.json()).error).toEqual({ code: 'FILEFN_CONTAINER_JOB_ERROR', message: 'the job could not be run' });
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
