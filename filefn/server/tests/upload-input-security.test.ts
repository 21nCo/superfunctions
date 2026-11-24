import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { runInNewContext } from 'node:vm';
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
    for (const [fileName, mimeType] of [['report.txt', 'text/plain; charset=utf-8'], ['résumé (final).pdf', 'application/pdf'], ['.hidden', 'text/plain;\tcharset=UTF-8'], ['a..b', 'application/octet-stream'], ['photo \u{1F600}.png', 'image/png'], ['trailing.txt', 'text/plain \t'], ['private.bin', 'application/x-example~v1'], ['empty-slot.png', 'image/png;'], ['quoted.txt', 'text/plain; name="a \\"b\\" c"'], ['latin1.txt', 'text/plain; name="caf\u00e9"'], ['c1.txt', 'text/plain; name="a\u0093b"'], ['data.jsonld', `application/ld+json; profile="https://example.com/${'p'.repeat(400)}"`]]) {
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

  it('refuses metadata that reuses one child many times without expanding it', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    let node: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 30; i++) node = { a: node, b: node };
    const started = Date.now();
    await expect(
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata: node }, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('hashes and stores the metadata snapshot it checked', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    let calls = 0;
    const metadata = {
      toJSON() {
        calls += 1;
        if (calls > 1) throw new Error('second serialization');
        return { tag: 'once' };
      },
    };
    const input = { policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata, idempotencyKey: 'test-key' };
    const first = await fileFn.createUploadSession(input as never, { principalId: 'alice' });
    expect(first.uploadSessionId).toEqual(expect.any(String));
    expect(calls).toBe(1);
  });

  it('applies the budgets to what toJSON returns, too', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    let node: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 30; i++) node = { a: node, b: node };
    const metadata = { toJSON: () => ({ graph: node }) };
    const started = Date.now();
    await expect(
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata } as never, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reads fields from the caller object, including accessors, when metadata is present', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const proto = { get policy() { return 'any'; } };
    const input = Object.assign(Object.create(proto), { fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata: { a: 1 } });
    await expect(fileFn.createUploadSession(input, { principalId: 'alice' })).resolves.toMatchObject({ uploadSessionId: expect.any(String) });
  });

  it('uses the fields it validated even if a metadata hook changes the caller object', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const input: Record<string, unknown> = { policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain' };
    input.metadata = { toJSON: () => { input.size = -5; return { ok: true }; } };
    const session = await fileFn.createUploadSession(input as never, { principalId: 'alice' });
    expect(session.totalParts).toBe(1);
  });

  it('counts repeated references to one long string against the byte limit', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const big = 'x'.repeat(10_000);
    await expect(
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata: { list: Array(1000).fill(big) } }, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
  });

  it('serializes boxed primitives as JSON.stringify does', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const session = await fileFn.createUploadSession(
      { policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata: { count: new Number(1), name: new String('n'), flag: new Boolean(false) } } as never,
      { principalId: 'alice' },
    );
    expect(session.uploadSessionId).toEqual(expect.any(String));
  });

  it('unboxes primitives from another realm, matching the JSON.stringify fingerprint', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const foreign = runInNewContext('({ count: new Number(1), flag: new Boolean(true) })');
    const input = { policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', idempotencyKey: 'realm-key' };
    const first = await fileFn.createUploadSession({ ...input, metadata: foreign } as never, { principalId: 'alice' });
    // A plain retry with the primitive values replays the same session.
    const retry = await fileFn.createUploadSession({ ...input, metadata: { count: 1, flag: true } }, { principalId: 'alice' });
    expect(retry.uploadSessionId).toBe(first.uploadSessionId);
  });

  it('reports invalid metadata as 400 even when a hook throws a hostile value', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } });
    const metadata = { toJSON() { throw hostile; } };
    await expect(
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata } as never, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
  });

  it('checks scalar fields before reading metadata', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const input = { policy: 'any', fileName: 'a.txt', size: -1, mimeType: 'text/plain', get metadata() { throw new Error('getter'); } };
    await expect(fileFn.createUploadSession(input as never, { principalId: 'alice' })).rejects.toMatchObject({
      code: 'FILEFN_INVALID_REQUEST',
      details: { field: 'size' },
    });
    const valid = { policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', get metadata() { throw new Error('getter'); } };
    await expect(fileFn.createUploadSession(valid as never, { principalId: 'alice' })).rejects.toMatchObject({
      code: 'FILEFN_INVALID_REQUEST',
      details: { field: 'metadata' },
    });
  });
});
