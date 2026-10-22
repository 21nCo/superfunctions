import { it, expect } from 'vitest';
import { captureToFile } from '../src/recording/capture.js';
import { uploadRecording } from '../src/recording/storage.js';
import { uploadObject, MemoryStorageAdapter } from '../src/integrations/storage.js';
import { MemoryLogger } from '../src/integrations/logfn.js';
import { createMemoryStore } from '../src/store/memory.js';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
it('streams signed HTTP uploads with the exact declared length', async () => {
  let received = 0; let declared = 0;
  const server = createServer(async (req, res) => { for await (const chunk of req) received += chunk.length; res.end('ok'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    let chunks = 0;
    await uploadObject({ name: 'signed-test', capabilities: { signedUploadUrls: true }, async signUploadUrl(input: any) { declared = input.constraints.contentLength; return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload` }; } } as any, 'media', {
      size: 1024 * 100,
      openStream: () => new ReadableStream({ pull(c) { if (chunks === 100) return c.close(); chunks++; c.enqueue(new Uint8Array(1024)); } }),
    });
    expect(declared).toBe(102400); expect(received).toBe(declared); expect(chunks).toBe(100);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it.each(['preflight', 'upload'])('disposes file artifacts when %s fails', async stage => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'recfn-artifact-failure-'));
  try {
    const capture = await captureToFile(new ReadableStream({ start(c) { c.enqueue({ data: new Uint8Array(32000), encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, timestamp: 0 }); c.close(); } }), { recordingFormat: 'audio_only', temporaryDirectory });
    const store = createMemoryStore();
    const bot = await store.createBot({ meetingUrl: 'https://zoom.us/j/1', platform: 'zoom', config: {}, namespace: 'test' });
    const storage = new MemoryStorageAdapter();
    if (stage === 'upload') storage.openUploadStream = async () => new WritableStream({ write() { throw new Error('storage failed'); } });
    await expect(uploadRecording({ botId: stage === 'preflight' ? 'missing' : bot.id, namespace: 'test', capture }, { store, storage, logger: new MemoryLogger() })).rejects.toThrow();
    expect(await readdir(temporaryDirectory)).toEqual([]);
    expect(await store.getRecordings(bot.id, 'test')).toEqual([]);
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
});
