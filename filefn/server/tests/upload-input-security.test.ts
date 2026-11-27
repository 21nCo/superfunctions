import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { createFileFn, type Policy } from '../src/index.js';
import { listObjects, makeLocalFileFn, uploadText } from './local-storage-harness.js';
import { assertValidUploadInit } from '../src/upload-sessions/input.js';

function nested(depth: number, leaf: unknown): unknown {
  let value: unknown = leaf;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

describe('upload init input (FILE-30 F-21, F-05)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-upload-input-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const makeFileFn = (policies?: Policy[]) => makeLocalFileFn(rootDir, 'upload_input_test', policies);
  const upload = uploadText;

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

  it('refuses NUL in metadata keys and values, which PostgreSQL jsonb cannot store', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    for (const metadata of [{ a: 'x\u0000y' }, { ['k\u0000']: 1 }]) {
      await expect(
        fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata } as never, { principalId: 'alice' }),
      ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST', details: { field: 'metadata' } });
    }
  });

  it('trims HTTP whitespace around a mimeType in linear time', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    await expect(
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: ' \ttext/plain\t ' } as never, { principalId: 'alice' }),
    ).resolves.toMatchObject({ uploadSessionId: expect.any(String) });
    const started = Date.now();
    await expect(
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: `a/b${'\t'.repeat(1000)}x` } as never, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('passes the root key to toJSON when there is no (or an empty) idempotency key', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const metadata = { toJSON: (key: string) => (key === '' ? { ok: true } : null) };
    const input = { policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata, idempotencyKey: '' };
    await expect(fileFn.createUploadSession(input as never, { principalId: 'alice' })).resolves.toMatchObject({
      uploadSessionId: expect.any(String),
    });
  });

  it('passes the root key to toJSON for an anonymous caller, whose idempotency key is not used', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const metadata = { toJSON: (key: string) => (key === '' ? { ok: true } : null) };
    const input = { policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata, idempotencyKey: 'k' };
    await expect(fileFn.createUploadSession(input as never, {})).resolves.toMatchObject({ uploadSessionId: expect.any(String) });
    await expect(fileFn.createUploadSession(input as never, { principalId: 'anonymous' })).resolves.toMatchObject({
      uploadSessionId: expect.any(String),
    });
  });

  it('serializes JSON.rawJSON values as their raw text', async () => {
    const rawJSON = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;
    if (typeof rawJSON !== 'function') return;
    const checked = assertValidUploadInit({
      policy: 'any',
      fileName: 'a.txt',
      size: 1,
      mimeType: 'text/plain',
      metadata: { count: rawJSON('42') },
    } as never);
    expect(JSON.stringify(checked.metadata)).toBe('{"count":42}');
    expect(checked.metadataJson).toBe('{"count":42}');
  });

  it('keeps a JSON.rawJSON number exact in the stored and hashed JSON', async () => {
    const rawJSON = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;
    if (typeof rawJSON !== 'function') return;
    const checked = assertValidUploadInit({
      policy: 'any',
      fileName: 'a.txt',
      size: 1,
      mimeType: 'text/plain',
      metadata: { big: rawJSON('9007199254740993') },
    } as never);
    expect(JSON.stringify(checked.metadata)).toBe('{"big":9007199254740993}');
    expect(checked.metadataJson).toBe('{"big":9007199254740993}');
  });

  it('refuses a JSON.rawJSON primitive as the whole metadata, and accepts one at the deepest level', async () => {
    const rawJSON = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;
    if (typeof rawJSON !== 'function') return;
    const init = (metadata: unknown) => ({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata }) as never;
    expect(() => assertValidUploadInit(init(rawJSON('42')))).toThrow();
    const accepts = (metadata: unknown) => {
      try {
        assertValidUploadInit(init(metadata));
        return true;
      } catch {
        return false;
      }
    };
    // The deepest nesting a plain 42 is accepted at.
    let plain: unknown = { v: 42 };
    let raw: unknown = { v: rawJSON('42') };
    while (accepts({ v: plain })) {
      plain = { v: plain };
      raw = { v: raw };
    }
    expect(accepts(plain)).toBe(true);
    expect(accepts(raw)).toBe(true);
    expect(accepts({ v: raw })).toBe(false);
  });

  it('refuses a JSON.rawJSON string that decodes to NUL', async () => {
    const rawJSON = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;
    if (typeof rawJSON !== 'function') return;
    expect(() =>
      assertValidUploadInit({
        policy: 'any',
        fileName: 'a.txt',
        size: 1,
        mimeType: 'text/plain',
        metadata: { s: rawJSON('"a\\u0000b"') },
      } as never),
    ).toThrow();
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

  it('refuses a boxed Number that converts to a BigInt, as JSON.stringify does', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const boxed = Object.assign(new Number(1), { [Symbol.toPrimitive]: () => 1n });
    await expect(
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata: { n: boxed } } as never, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
  });

  it('serializes metadata exactly as JSON.stringify does for functions, boxed BigInts and shrinking arrays', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const init = (metadata: unknown, idempotencyKey?: string) =>
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata, idempotencyKey } as never, { principalId: 'alice' });

    // A function with toJSON serializes its hook result.
    const fn = Object.assign(() => 1, { toJSON: () => 'hooked' });
    const first = await init({ f: fn }, 'fn-key');
    expect((await init({ f: 'hooked' }, 'fn-key')).uploadSessionId).toBe(first.uploadSessionId);

    // A boxed BigInt is refused.
    await expect(init({ n: Object(1n) })).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });

    // An array that shrinks while being read keeps its original length (null holes).
    const arr: unknown[] = [];
    Object.defineProperty(arr, 0, { get() { arr.length = 1; return 0; }, configurable: true, enumerable: true });
    arr.length = 2;
    const shrinking = await init({ list: arr }, 'arr-key');
    expect((await init({ list: [0, null] }, 'arr-key')).uploadSessionId).toBe(shrinking.uploadSessionId);
  });

  it('fingerprints proxied metadata exactly as JSON.stringify did, and refuses cycles made by getters', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const base = { policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain' };
    const init = (metadata: unknown, idempotencyKey?: string) =>
      fileFn.createUploadSession({ ...base, metadata, idempotencyKey } as never, { principalId: 'alice' });

    // A proxied array reporting length 1.5 has one element (ToLength).
    const arrayProxy = new Proxy(['x', 'y'], { get: (t, p) => (p === 'length' ? 1.5 : Reflect.get(t, p)) });
    const a = await init({ list: arrayProxy }, 'len-key');
    expect((await init({ list: ['x'] }, 'len-key')).uploadSessionId).toBe(a.uploadSessionId);

    // A proxy listing integer keys 2, 1 is fingerprinted in that order: a
    // second identical proxied request replays the first.
    const ordered = () => new Proxy({ 1: 'one', 2: 'two' } as Record<string, string>, { ownKeys: () => ['2', '1'] });
    const o = await init(ordered(), 'order-key');
    expect((await init(ordered(), 'order-key')).uploadSessionId).toBe(o.uploadSessionId);

    // A getter that returns its parent on the first read is circular.
    let reads = 0;
    const parent: Record<string, unknown> = {};
    Object.defineProperty(parent, 'child', { enumerable: true, get() { reads += 1; return reads === 1 ? parent : 'x'; } });
    await expect(init(parent)).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
  });

  it('reports unreadable fields and BigInt array lengths as 400, and keys toJSON by fingerprint use', async () => {
    const fileFn = makeFileFn([{ name: 'any' }]);
    const throwing = { policy: 'nope', get fileName() { throw new Error('getter'); }, size: 1, mimeType: 'text/plain' };
    await expect(fileFn.createUploadSession(throwing as never, { principalId: 'alice' })).rejects.toMatchObject({
      code: 'FILEFN_INVALID_REQUEST',
      details: { field: 'fileName' },
    });
    const bigLength = new Proxy([1], { get: (t, p) => (p === 'length' ? 1n : Reflect.get(t, p)) });
    await expect(
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata: { list: bigLength } } as never, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    const keys: string[] = [];
    const metadata = { toJSON: (key: string) => { keys.push(key); return { ok: true }; } };
    await fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata } as never, { principalId: 'alice' });
    await fileFn.createUploadSession({ policy: 'any', fileName: 'a.txt', size: 1, mimeType: 'text/plain', metadata, idempotencyKey: 'k' } as never, { principalId: 'alice' });
    expect(keys).toEqual(['', 'md']);
  });
});
