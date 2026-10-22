import { it, expect } from 'vitest';
import { splitAudio } from '../src/recording/bounded-audio-split.js';
import type { AudioChunk } from '@recfn/core';
it('bounds unread branch data and resumes without losing samples', async () => {
  let produced = 0;
  const source = new ReadableStream<AudioChunk>({ pull(c) { if (produced === 100) return c.close(); c.enqueue({ data: new Uint8Array([produced++]), timestamp: 0, channels: 1, sampleRate: 16000 }); } }, { highWaterMark: 0 });
  const [a, b] = splitAudio(source, new AbortController().signal, 4);
  const left = a.getReader(); const right = b.getReader();
  const first = await left.read(); expect(first.value!.data[0]).toBe(0);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(produced).toBeLessThanOrEqual(5);
  const read = async (reader: ReadableStreamDefaultReader<AudioChunk>, values: number[] = []) => { while (true) { const value = await reader.read(); if (value.done) return values; values.push(value.value.data[0]); } };
  const [av, bv] = await Promise.all([read(left, [0]), read(right)]);
  expect(av).toEqual(Array.from({ length: 100 }, (_, i) => i)); expect(bv).toEqual(av);
  left.releaseLock(); right.releaseLock(); expect(source.locked).toBe(false);
});
it('canceling one branch allows the other to finish; abort cancels a stalled source', async () => {
  let canceled = false;
  const source = new ReadableStream<AudioChunk>({ cancel() { canceled = true; } });
  const signal = new AbortController(); const [a, b] = splitAudio(source, signal.signal, 4);
  await a.cancel(); const reader = b.getReader(); const pending = reader.read(); signal.abort();
  await expect(pending).rejects.toThrow('canceled');
  reader.releaseLock(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(canceled).toBe(true); expect(source.locked).toBe(false);
});
