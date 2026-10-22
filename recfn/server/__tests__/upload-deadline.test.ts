import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadObject, MemoryStorageAdapter } from '../src/integrations/storage.js';
import { uploadRecording } from '../src/recording/storage.js';
import { captureToFile } from '../src/recording/capture.js';
import { createMemoryStore } from '../src/store/memory.js';
import { MemoryLogger } from '../src/integrations/logfn.js';

it('bounds a hung sink, disposes its native file, and retains uncertain external intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recfn-upload-deadline-'));
  let completeWrite!: () => void;
  const write = new Promise<void>(resolve => { completeWrite = resolve; });
  const abort = vi.fn();
  const storage = new MemoryStorageAdapter();
  const writable = new WritableStream({ write: () => write, abort });
  storage.openUploadStream = async () => writable;
  const store = createMemoryStore();
  const bot = await store.createBot({ meetingUrl: 'https://zoom.us/j/1', platform: 'zoom', config: {}, namespace: 'test' });
  try {
    const capture = await captureToFile(new ReadableStream({ start(c) { c.enqueue({ data: new Uint8Array(32000), encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, timestamp: 0 }); c.close(); } }), { recordingFormat: 'audio_only', temporaryDirectory: directory });
    const start = Date.now();
    await expect(uploadRecording({ botId: bot.id, namespace: 'test', capture, uploadTimeoutMs: 100 }, { storage, store, logger: new MemoryLogger() })).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(await readdir(directory)).toEqual([]);
    expect(await store.getRecordings(bot.id, 'test')).toEqual([]);
    expect(await store.listBotProducers(bot.id, 'test')).toMatchObject([{ state: 'uncertain', storageRef: expect.any(String) }]);
    expect(writable.locked).toBe(false);
    expect(abort).not.toHaveBeenCalled(); // Abort is queued behind the still-running write.
    completeWrite();
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(await store.listBotProducers(bot.id, 'test')).toMatchObject([{ state: 'uncertain' }]);
  } finally { completeWrite(); await rm(directory, { recursive: true, force: true }); }
});

it('cancels a real HTTP upload after the receiver accepts bytes but never responds', async () => {
  let received = 0;
  let connectionClosed = false;
  const server = createServer(async (req, res) => {
    res.on('close', () => { connectionClosed = true; });
    for await (const chunk of req) received += chunk.length;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const storage = { name: 'hung-http', async signUploadUrl() { return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload` }; } } as any;
  try {
    await expect(uploadObject(storage, 'test', new Uint8Array(1024), { uploadTimeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(received).toBe(1024);
    await vi.waitFor(() => expect(connectionClosed).toBe(true));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('cancels an unbounded HTTP response body after successful upload headers', async () => {
  let connectionClosed = false;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Drain request. */ }
    res.on('close', () => { connectionClosed = true; });
    res.writeHead(200); res.write('unending response');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await uploadObject({ name: 'response-body', async signUploadUrl() { return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload` }; } } as any, 'test', new Uint8Array(1), { uploadTimeoutMs: 1000 });
    await vi.waitFor(() => expect(connectionClosed).toBe(true));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('aborts late acquired streams without writing and handles cancellation during a pending read', async () => {
  let acquire!: (value: WritableStream) => void;
  const abort = vi.fn(); const write = vi.fn();
  await expect(uploadObject({ name: 'late', openUploadStream: () => new Promise(resolve => { acquire = resolve; }) } as any, 'test', new Uint8Array(1), { uploadTimeoutMs: 30 })).rejects.toThrow(/timed out/);
  acquire(new WritableStream({ abort, write }));
  await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
  expect(write).not.toHaveBeenCalled();
  const controller = new AbortController(); const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({ cancel });
  const storage = new MemoryStorageAdapter();
  const pending = uploadObject(storage, 'test', { size: 1, openStream: () => source }, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(new Error('host shutdown'));
  await expect(pending).rejects.toThrow('host shutdown');
  expect(cancel).toHaveBeenCalledOnce(); expect(source.locked).toBe(false);
});

it.each([0, -1, Infinity, NaN, 0.5, 2_147_483_648])('rejects invalid upload timeout %s', async uploadTimeoutMs => {
  await expect(uploadObject(new MemoryStorageAdapter(), 'test', new Uint8Array(), { uploadTimeoutMs })).rejects.toThrow(/uploadTimeoutMs/);
});
