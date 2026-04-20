import type { AudioChunk } from 'recfn';

export interface NormalizedAudioChunk {
  data: Uint8Array;
  timestamp: number;
}

function cloneArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  const cloned = new Uint8Array(buffer.byteLength);
  cloned.set(buffer);
  return cloned.buffer;
}

export async function fetchJsonOrThrow<T>(
  fetchFn: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  errorPrefix: string,
): Promise<T> {
  const response = await fetchFn(input, init);
  if (!response.ok) {
    const responseText =
      typeof response.text === 'function' ? await response.text() : '';
    throw new Error(`${errorPrefix}: ${response.status} ${responseText}`.trim());
  }
  return (await response.json()) as T;
}

export async function fetchArrayBufferOrThrow(
  fetchFn: typeof globalThis.fetch,
  input: string,
  errorPrefix: string,
): Promise<ArrayBuffer> {
  const response = await fetchFn(input);
  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${response.status}`);
  }
  return response.arrayBuffer();
}

export async function readAudioChunkStream(
  stream: ReadableStream<Uint8Array | AudioChunk>,
): Promise<NormalizedAudioChunk[]> {
  const reader = stream.getReader();
  const chunks: NormalizedAudioChunk[] = [];
  let fallbackTimestamp = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      if (value instanceof Uint8Array) {
        chunks.push({
          data: new Uint8Array(cloneArrayBuffer(value)),
          timestamp: fallbackTimestamp,
        });
        fallbackTimestamp += 1000;
        continue;
      }

      const audioChunk = value as AudioChunk;
      chunks.push({
        data: new Uint8Array(cloneArrayBuffer(audioChunk.data)),
        timestamp: audioChunk.timestamp,
      });
      fallbackTimestamp = Math.max(fallbackTimestamp + 1000, audioChunk.timestamp);
    }
  } finally {
    reader.releaseLock();
  }

  return chunks;
}
