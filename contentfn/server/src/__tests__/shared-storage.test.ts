import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { createAssetStorageBackend } from '../storage/storageBackend.js';

it('writes actual bytes through shared local storage and cleans failed URL mapping', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contentfn-assets-'));
  try {
    const adapter = createLocalStorageAdapter({ rootDir: directory });
    let key = '';
    const backend = createAssetStorageBackend(adapter, { prefix: 'assets', urlForKey: value => { key = value; return `https://assets.example/${value}`; } });
    const url = await backend.writeAsset(Buffer.from('real asset bytes'), '../../outside.txt', 'text/plain');
    expect(url).toBe(`https://assets.example/${key}`);
    expect(key).toMatch(/^assets\/[a-f0-9-]+$/);
    expect(await readFile(join(directory, key), 'utf8')).toBe('real asset bytes');
    const failing = createAssetStorageBackend(adapter, { prefix: 'failed', urlForKey: () => { throw new Error('mapping failed'); } });
    await expect(failing.writeAsset(Buffer.from('remove me'), 'a.txt', 'text/plain')).rejects.toThrow('mapping failed');
    expect(await readdir(join(directory, 'failed'))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
