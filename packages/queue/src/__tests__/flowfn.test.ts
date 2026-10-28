import { describe, expect, it } from 'vitest';
import { FlowFnQueueAdapter } from '../index.js';

describe('FlowFnQueueAdapter', () => {
  it('flowfn adapter sends authenticated enqueue/dequeue requests', async () => {
    const calls: Array<{ url: string; method: string; auth?: string }> = [];

    const adapter = new FlowFnQueueAdapter<{ id: string }>({
      baseUrl: 'https://flowfn.example.com',
      apiKey: 'flowfn-key',
      fetch: (async (url, init) => {
        calls.push({
          url: String(url),
          method: String(init?.method ?? 'GET'),
          auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
        });

        if (String(url).includes('/dequeue')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ payload: { id: 'job_1' } }),
          } as Response;
        }

        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response;
      }) as typeof globalThis.fetch,
    });

    await adapter.enqueue('jobs', { id: 'job_1' });
    const payload = await adapter.dequeue('jobs');

    expect(payload).toEqual({ id: 'job_1' });
    expect(calls[0].url).toContain('/queues/jobs/enqueue');
    expect(calls[1].url).toContain('/queues/jobs/dequeue');
    expect(calls[0].auth).toBe('Bearer flowfn-key');
    expect(calls[1].auth).toBe('Bearer flowfn-key');
  });

  it('flowfn adapter preserves an explicit undefined payload', async () => {
    const adapter = new FlowFnQueueAdapter<string | undefined>({
      baseUrl: 'https://flowfn.example.com',
      apiKey: 'flowfn-key',
      fetch: (async (_url) => {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ payload: undefined }),
        } as Response;
      }) as typeof globalThis.fetch,
    });

    expect(await adapter.dequeue('jobs')).toBeUndefined();
  });

  it('flowfn adapter aborts stalled requests using timeoutMs', async () => {
    const adapter = new FlowFnQueueAdapter<{ id: string }>({
      baseUrl: 'https://flowfn.example.com',
      apiKey: 'flowfn-key',
      timeoutMs: 5,
      fetch: (async (_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }) as typeof globalThis.fetch,
    });

    await expect(adapter.enqueue('jobs', { id: 'job_1' })).rejects.toThrow('The operation was aborted.');
  });

  it('rejects a non-finite timeoutMs value', async () => {
    expect(
      () =>
        new FlowFnQueueAdapter({
          baseUrl: 'https://flowfn.example.com',
          apiKey: 'flowfn-key',
          timeoutMs: Number.NaN,
        })
    ).toThrow('FLOWFN_QUEUE_TIMEOUT_INVALID');
  });

  it('flowfn adapter normalizes a trailing slash in baseUrl', async () => {
    const calls: string[] = [];
    const adapter = new FlowFnQueueAdapter<{ id: string }>({
      baseUrl: 'https://flowfn.example.com/',
      apiKey: 'flowfn-key',
      fetch: (async (url) => {
        calls.push(String(url));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response;
      }) as typeof globalThis.fetch,
    });

    await adapter.enqueue('jobs', { id: 'job_1' });

    expect(calls).toEqual(['https://flowfn.example.com/queues/jobs/enqueue']);
  });
});
