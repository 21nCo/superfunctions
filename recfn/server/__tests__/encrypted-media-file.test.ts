import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EncryptedMediaFile } from '../src/recording/encrypted-media-file.js';

async function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(); const chunks: Uint8Array[] = [];
  try { for (;;) { const result = await reader.read(); if (result.done) break; chunks.push(result.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

describe('authenticated encrypted recording scratch', () => {
  it('stores only ciphertext, reads exact bytes, and patches across authenticated chunk boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recfn-cipher-test-'));
    const filename = join(root, 'recording.enc'); const file = await EncryptedMediaFile.create(filename);
    const bytes = Buffer.alloc(2 * 65536 + 17, 'private recording payload ');
    try {
      await file.append(bytes.subarray(0, 123)); await file.append(bytes.subarray(123)); await file.finish();
      const encrypted = await readFile(filename);
      expect(encrypted.length).toBe(bytes.length + 3 * 28);
      expect(encrypted.includes(bytes.subarray(0, 128))).toBe(false);
      expect(await collect(file.openStream())).toEqual(bytes);
      const patch = Buffer.from('replacement across boundary');
      await file.patch(65530, patch); patch.copy(bytes, 65530);
      expect(await collect(file.openStream())).toEqual(bytes);
      expect(await file.read(65530, patch.length)).toEqual(patch);
      expect((await readFile(filename)).subarray(0, 12)).not.toEqual(encrypted.subarray(0, 12));
      await file.dispose();
      expect(() => file.openStream()).toThrow('unavailable');
    } finally { await file.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it('disposes an active bounded reader and refuses future reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recfn-cipher-dispose-'));
    const file = await EncryptedMediaFile.create(join(root, 'recording.enc'));
    try {
      await file.append(Buffer.alloc(8 * 65536, 42)); await file.finish();
      const reader = file.openStream().getReader();
      expect((await reader.read()).value?.byteLength).toBe(65536);
      await file.dispose();
      await reader.cancel().catch(() => {}); reader.releaseLock();
      expect(() => file.openStream()).toThrow('unavailable');
    } finally { await file.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['tamper', 'truncate', 'reorder'] as const)('rejects %s before releasing unauthenticated plaintext', async corruption => {
    const root = await mkdtemp(join(tmpdir(), 'recfn-cipher-corrupt-'));
    const filename = join(root, 'recording.enc'); const file = await EncryptedMediaFile.create(filename);
    try {
      await file.append(Buffer.alloc(2 * 65536, 42)); await file.finish();
      const bytes = await readFile(filename);
      if (corruption === 'tamper') bytes[20] ^= 1;
      else if (corruption === 'reorder') { const first = Buffer.from(bytes.subarray(0, 65564)); bytes.copy(bytes, 0, 65564); first.copy(bytes, 65564); }
      await writeFile(filename, corruption === 'truncate' ? bytes.subarray(0, bytes.length - 1) : bytes);
      const reader = file.openStream().getReader();
      try { await expect(reader.read()).rejects.toThrow(); }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } finally { await file.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
