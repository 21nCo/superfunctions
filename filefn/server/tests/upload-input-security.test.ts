import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileFn, type Policy } from '../src/index.js';

function nested(depth: number, leaf: unknown): unknown {
  let value: unknown = leaf;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

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

describe('upload init input (FILE-30 F-21, F-05)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-upload-input-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeFileFn(policies: Policy[] = [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'public' }]) {
    return createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'upload_input_test',
      policies,
    });
  }

  async function upload(
    fileFn: ReturnType<typeof makeFileFn>,
    ctx: { principalId: string; tenantId?: string },
    fileName: string,
    text: string,
    policy = 'docs',
  ) {
    const body = Buffer.from(text);
    const session = await fileFn.createUploadSession({ policy, fileName, size: body.length, mimeType: 'text/plain' }, ctx);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, ctx);
    await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size }, ctx);
    return fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, ctx);
  }

  it('refuses unsafe file names at init (P1 inputs)', async () => {
    const fileFn = makeFileFn();
    const alice = { principalId: 'alice', tenantId: 't1' };
    const bob = { principalId: 'bob', tenantId: 't1' };
    const aliceFile = await upload(fileFn, alice, 'report.txt', 'alice original');
    const [aliceKey] = await listObjects(rootDir);

    // Bob can read alice's public file, so he knows every part of her key.
    const detail = await fileFn.getFile({ fileId: aliceFile.fileId }, bob);
    expect(detail.fileId).toBe(aliceFile.fileId);

    const traversal = `../../../../${aliceKey}`;
    for (const fileName of [traversal, '..', '.', 'a/b.txt', 'a\\b.txt', 'bad\u0000name', 'tab\tname', '   ']) {
      await expect(
        fileFn.createUploadSession({ policy: 'docs', fileName, size: 4, mimeType: 'text/plain' }, bob),
      ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST', statusCode: 400 });
    }

    const download = await fileFn.services.files.getDownloadStream(aliceFile.fileId, undefined, alice);
    expect(await new Response(download.stream).text()).toBe('alice original');
    expect(await listObjects(rootDir)).toEqual([aliceKey]);
  });

  it.each([
    ['negative size', { size: -5 }],
    ['fractional size', { size: 1.5 }],
    ['string size', { size: 'abc' }],
    ['null size', { size: null }],
    ['unsafe integer size', { size: Number.MAX_SAFE_INTEGER + 1 }],
    ['non-string mimeType', { mimeType: 42 }],
    ['malformed mimeType', { mimeType: 'text' }],
    ['non-string fileName', { fileName: { name: 'x' } }],
    ['overlong fileName', { fileName: `${'a'.repeat(256)}.txt` }],
    ['array metadata', { metadata: ['x'] }],
    ['oversized metadata', { metadata: { blob: 'x'.repeat(17 * 1024) } }],
    ['missing policy', { policy: undefined }],
    ['unterminated quoted MIME parameter', { mimeType: 'text/plain; charset="unterminated' }],
    ['non-ASCII MIME parameter', { mimeType: 'text/plain; name=\u65E5' }],
    ['MIME parameter without a value', { mimeType: 'text/plain; garbage' }],
    ['explicit null metadata', { metadata: null }],
    ['lone surrogate in fileName', { fileName: 'a\uD800.txt' }],
    ['lone surrogate in metadata', { metadata: { note: 'x\uDFFF' } }],
    ['lone surrogate in a metadata key', { metadata: { '\uD800': 1 } }],
    ['lone surrogate in mimeType', { mimeType: 'text/plain; x=\uD800' }],
    ['metadata nested too deep', { metadata: { a: nested(70, '\uD800') } }],
    ['metadata nested past the limit', { metadata: { a: nested(40, 'ok') } }],
    ['byte order mark as fileName', { fileName: '\uFEFF' }],
  ])('rejects %s with 400 (P4)', async (_label, override) => {
    const fileFn = makeFileFn();
    const input = { policy: 'docs', fileName: 'a.txt', size: 10, mimeType: 'text/plain', ...override };
    await expect(
      fileFn.createUploadSession(input as never, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST', statusCode: 400 });
  });

  it('returns 400 over HTTP for a non-string mimeType instead of rethrowing a TypeError', async () => {
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'upload_input_http',
      policies: [{ name: 'docs', contentTypes: ['text/plain'] }],
      auth: { resolveSession: async () => ({ principalId: 'alice' }) },
    });
    const response = await fileFn.router.handle(
      new Request('http://localhost/upload/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 10, mimeType: 42 }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('FILEFN_INVALID_REQUEST');
  });

  it('accepts ordinary names, zero-byte uploads and MIME parameters', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    for (const [fileName, mimeType] of [['report.txt', 'text/plain; charset=utf-8'], ['résumé (final).pdf', 'application/pdf'], ['.hidden', 'text/plain;\tcharset=UTF-8'], ['a..b', 'application/octet-stream'], ['photo \u{1F600}.png', 'image/png'], ['trailing.txt', 'text/plain \t'], ['private.bin', 'application/x-example~v1'], ['empty-slot.png', 'image/png;'], ['quoted.txt', 'text/plain; name="a \\"b\\" c"'], ['data.jsonld', `application/ld+json; profile="https://example.com/${'p'.repeat(400)}"`]]) {
      await expect(
        fileFn.createUploadSession({ policy: 'any', fileName, size: 0, mimeType }, { principalId: 'alice' }),
      ).resolves.toMatchObject({ uploadSessionId: expect.any(String) });
    }
  });

  it('accepts a registered policy with a long name', async () => {
    const name = 'p'.repeat(300);
    const fileFn = makeFileFn([{ name }]);
    await expect(
      fileFn.createUploadSession({ policy: name, fileName: 'a.bin', size: 1, mimeType: 'application/octet-stream' }, { principalId: 'alice' }),
    ).resolves.toMatchObject({ uploadSessionId: expect.any(String) });
  });

  it('walks metadata arrays without calling their methods', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const tags = Object.assign(['a'], { some: null });
    await expect(
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata: { tags } }, { principalId: 'alice' }),
    ).resolves.toMatchObject({ uploadSessionId: expect.any(String) });
  });
});
