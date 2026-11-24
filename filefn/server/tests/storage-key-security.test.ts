import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeStoragePath, createFileFn, sanitizeStorageKeySegment, unsafeStorageKeyReason, type Policy } from '../src/index.js';

async function listObjects(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(relative(rootDir, path).split('\\').join('/'));
    }
  }
  await walk(rootDir);
  return out.sort();
}

describe('storage keys (FILE-30 F-01)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-storage-keys-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeFileFn(policies: Policy[] = [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'public' }]) {
    return createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'storage_keys_test',
      policies,
    });
  }

  async function upload(
    fileFn: ReturnType<typeof makeFileFn>,
    ctx: { principalId: string; tenantId?: string },
    fileName: string,
    text: string,
  ) {
    const body = Buffer.from(text);
    const session = await fileFn.createUploadSession({ policy: 'docs', fileName, size: body.length, mimeType: 'text/plain' }, ctx);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, ctx);
    await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size }, ctx);
    return fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, ctx);
  }

  it('a traversal file name stays inside its own key, so it cannot overwrite or delete the owner object (P1)', async () => {
    const fileFn = makeFileFn();
    const alice = { principalId: 'alice', tenantId: 't1' };
    const bob = { principalId: 'bob', tenantId: 't1' };
    const aliceFile = await upload(fileFn, alice, 'report.txt', 'alice original');
    const [aliceKey] = await listObjects(rootDir);

    const bobFile = await upload(fileFn, bob, `../../../../${aliceKey}`, 'BOB-WAS-HERE');
    const objects = await listObjects(rootDir);
    expect(objects).toHaveLength(2);
    const bobKey = objects.find((key) => key !== aliceKey)!;
    expect(bobKey.startsWith(`t1/bob/${bobFile.fileId}/`)).toBe(true);
    expect(unsafeStorageKeyReason(bobKey)).toBeNull();
    expect(await readFile(join(rootDir, aliceKey), 'utf8')).toBe('alice original');

    await fileFn.deleteFile({ fileId: bobFile.fileId }, bob);
    expect(await listObjects(rootDir)).toEqual([aliceKey]);
    const download = await fileFn.services.files.getDownloadStream(aliceFile.fileId, undefined, alice);
    expect(await new Response(download.stream).text()).toBe('alice original');
  });

  it('builds default keys from sanitized tenant and principal segments, keeping names and safe IDs as they are', async () => {
    const fileFn = makeFileFn();
    const result = await upload(fileFn, { principalId: '../alice', tenantId: 't1/..' }, 'report..pdf', 'hello');
    const [key] = await listObjects(rootDir);
    expect(unsafeStorageKeyReason(key)).toBeNull();
    expect(key).toBe(`t1%2F../%2E%2E%2Falice/${result.fileId}/${result.versionId}-report..pdf`);
  });

  it('refuses a policy storagePath that yields an unsafe key', async () => {
    const fileFn = makeFileFn([
      { name: 'dots', storagePath: (ctx) => `${ctx.principalId}/../${ctx.versionId}.bin` },
      { name: 'empty', storagePath: () => '' },
    ]);
    await expect(
      fileFn.createUploadSession({ policy: 'dots', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST', details: { reason: 'dot segment' } });
    await expect(
      fileFn.createUploadSession({ policy: 'empty', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST', details: { reason: 'empty key' } });
  });

  it('keeps distinct version IDs distinct in keys', () => {
    const a = computeStoragePath({ name: 'p' }, { fileName: 'x', fileId: 'file_1', versionId: 'ver_a__b' });
    const b = computeStoragePath({ name: 'p' }, { fileName: 'x', fileId: 'file_1', versionId: 'ver_a_b' });
    expect(a).toBe('file_1/ver_a__b-x');
    expect(a).not.toBe(b);
  });

  it('sanitizes only what could leave the segment, without collisions', () => {
    expect(sanitizeStorageKeySegment('../a/b')).toBe('%2E%2E%2Fa%2Fb');
    expect(sanitizeStorageKeySegment('..')).toBe('%2E%2E');
    expect(sanitizeStorageKeySegment('.')).toBe('%2E');
    expect(sanitizeStorageKeySegment('')).toBe('%20');
    expect(sanitizeStorageKeySegment('_')).toBe('_');
    expect(sanitizeStorageKeySegment('\u0000')).toBe('%00');
    expect(sanitizeStorageKeySegment('team/east')).toBe('team%2Feast');
    expect(sanitizeStorageKeySegment('team_east')).toBe('team_east');
    expect(sanitizeStorageKeySegment('100%2Feast')).toBe('100%252Feast');
    expect(sanitizeStorageKeySegment('org__a')).toBe('org__a');
    expect(sanitizeStorageKeySegment('acme ')).toBe('acme ');
    expect(sanitizeStorageKeySegment('acme.com')).toBe('acme.com');
    expect(sanitizeStorageKeySegment('.env')).toBe('.env');
    expect(sanitizeStorageKeySegment('report..pdf')).toBe('report..pdf');
    expect(unsafeStorageKeyReason('a/./b')).toBe('dot segment');
    expect(unsafeStorageKeyReason('/a')).toBe('absolute key');
    expect(unsafeStorageKeyReason('C:/Windows/x')).toBe('absolute key');
    expect(unsafeStorageKeyReason('c:')).toBe('absolute key');
    expect(unsafeStorageKeyReason('C:x/y')).toBe('absolute key');
    expect(unsafeStorageKeyReason('ab:c/x')).toBeNull();
    expect(sanitizeStorageKeySegment('a:b')).toBe('a%3Ab');
    expect(sanitizeStorageKeySegment('ab:c')).toBe('ab:c');
    expect(unsafeStorageKeyReason('a\\b')).toBe('backslash');
    expect(unsafeStorageKeyReason('acme.com/a..b')).toBeNull();
  });

  it('shortens a long file name in the key so the segment fits a 255-byte filesystem name', async () => {
    const fileFn = makeFileFn();
    const longName = `${'f'.repeat(140)}/${'n'.repeat(120)}.txt`;
    await upload(fileFn, { principalId: 'alice', tenantId: 't1' }, longName, 'hello');
    const [key] = await listObjects(rootDir);
    const last = key.split('/').pop()!;
    expect(new TextEncoder().encode(last).length).toBeLessThan(200);
    expect(last.endsWith('.txt')).toBe(true);
    const other = computeStoragePath({ name: 'p' }, { fileName: `${'f'.repeat(140)}/${'m'.repeat(120)}.txt`, fileId: 'file_1', versionId: 'ver_1' });
    const same = computeStoragePath({ name: 'p' }, { fileName: longName, fileId: 'file_1', versionId: 'ver_1' });
    expect(other).not.toBe(same);
  });

  it('bounds long tenant and principal segments too', () => {
    const key = computeStoragePath({ name: 'p' }, { tenantId: '%'.repeat(86), principalId: 'p'.repeat(300), fileName: 'x', fileId: 'file_1', versionId: 'ver_1' });
    for (const segment of key.split('/')) {
      expect(new TextEncoder().encode(segment).length).toBeLessThanOrEqual(130);
    }
    expect(unsafeStorageKeyReason(key)).toBeNull();
    // A shortened segment carries `%~`, which no literal ID can produce.
    const tenantSegment = key.split('/')[0];
    expect(tenantSegment).toMatch(/%~[0-9a-f]{32}$/);
    expect(sanitizeStorageKeySegment(tenantSegment)).not.toBe(tenantSegment);
  });
});
