import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDatabase, startContainer } from '../src/main.js';
import { received, sharedDatabase } from './fixtures/shared-database.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const env = {
  FILEFN_R2_ENDPOINT: 'http://127.0.0.1:9',
  FILEFN_R2_BUCKET: 'bucket',
  FILEFN_R2_ACCESS_KEY_ID: 'key',
  FILEFN_R2_SECRET_ACCESS_KEY: 'secret',
  FILEFN_DATABASE: fixture('shared-database.ts'),
  FILEFN_CONTAINER_TOKEN: 'test-container-token',
  PORT: '0',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadDatabase', () => {
  it('creates an in-memory database for memory', async () => {
    const database = await loadDatabase('memory', {});
    expect(typeof database.findOne).toBe('function');
  });

  it('calls a module default export with the environment', async () => {
    const before = received.length;
    const database = await loadDatabase(fixture('shared-database.ts'), { FILEFN_NAMESPACE: 'ns' });

    expect(database).toBe(sharedDatabase);
    expect(received.slice(before)).toEqual([{ FILEFN_NAMESPACE: 'ns' }]);
  });

  it.each([
    ['not-a-factory.ts', /must default-export a function/],
    ['not-an-adapter.ts', /did not return a database adapter/],
  ])('rejects a module that %s', async (name, message) => {
    await expect(loadDatabase(fixture(name), {})).rejects.toThrow(message);
  });
});

describe('startContainer', () => {
  it('serves health on the configured port and closes the database on close', async () => {
    const close = vi.spyOn(sharedDatabase, 'close');
    const running = await startContainer(env);

    const response = await fetch(`http://127.0.0.1:${running.port}/health`);
    await running.close();

    expect(response.status).toBe(200);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('waits for a job whose client disconnected before closing the database', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = {
      handle: vi.fn(async () => {
        await gate;
        events.push('job finished');
        return { status: 'completed' };
      }),
    };
    vi.spyOn(sharedDatabase, 'close').mockImplementation(async () => { events.push('database closed'); });
    const running = await startContainer(env, { handler });
    const disconnected = new AbortController();

    const request = fetch(`http://127.0.0.1:${running.port}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-container-token' },
      body: JSON.stringify({ job: { fileId: 'file_1' } }),
      signal: disconnected.signal,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledTimes(1));
    disconnected.abort();
    await request;
    const closing = running.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual([]);
    release();
    await closing;

    expect(events).toEqual(['job finished', 'database closed']);
  });

  it('rejects an invalid configuration before loading the database', async () => {
    const before = received.length;
    await expect(startContainer({ ...env, FILEFN_PROCESSORS: 'video' })).rejects.toThrow(/FILEFN_CONTAINER_CONFIG_INVALID/);
    expect(received).toHaveLength(before);
  });

  it('closes the database when the port cannot be bound', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const close = vi.spyOn(sharedDatabase, 'close');
    try {
      await expect(startContainer({ ...env, PORT: String((blocker.address() as AddressInfo).port) }))
        .rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
