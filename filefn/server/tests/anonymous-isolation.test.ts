import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileFn } from '../src/index.js';

describe('anonymous uploads and idempotency (FILE-30 F-02, F-11, F-18)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-anon-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeFileFn(database = memoryAdapter()) {
    const fileFn = createFileFn({
      database,
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [
        { name: 'private', contentTypes: ['text/plain'], visibility: 'private' },
        { name: 'public', contentTypes: ['text/plain'], visibility: 'public' },
      ],
      auth: {
        required: false,
        resolveSession: async (request) => {
          const user = request.headers.get('x-test-user');
          return user ? { principalId: user } : null;
        },
      },
    });
    return { fileFn, database };
  }

  async function call(
    fileFn: ReturnType<typeof makeFileFn>['fileFn'],
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const response = await fileFn.router.handle(new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }));
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text };
  }

  async function anonymousUpload(fileFn: ReturnType<typeof makeFileFn>['fileFn'], policy: string, text: string) {
    const body = Buffer.from(text);
    const init = await call(fileFn, 'POST', '/upload/init', {
      body: { policy, fileName: 'a.txt', size: body.length, mimeType: 'text/plain' },
    });
    expect(init.status).toBe(200);
    const { uploadSessionId, uploadSessionToken } = init.json.data;
    const part = await fileFn.services.uploads.uploadPartBytes(uploadSessionId, 1, body, body.length, {}, uploadSessionToken);
    await fileFn.services.uploads.completePart(uploadSessionId, 1, part.etag, part.size, {}, uploadSessionToken);
    const done = await call(fileFn, 'POST', `/upload/${uploadSessionId}/complete`, {
      body: {},
      headers: { 'x-upload-session-token': uploadSessionToken },
    });
    expect(done.status).toBe(200);
    return done.json.data as { fileId: string; versionId: string };
  }

  it('a second anonymous caller cannot list, read, grant, share or delete an anonymous upload (P2)', async () => {
    const { fileFn } = makeFileFn();
    const file = await anonymousUpload(fileFn, 'private', 'anon-1 private upload');

    const list = await call(fileFn, 'GET', '/');
    expect(list.status).toBe(200);
    expect(list.json.data.files.map((f: { fileId: string }) => f.fileId)).not.toContain(file.fileId);

    expect((await call(fileFn, 'GET', `/${file.fileId}`)).status).toBe(403);
    expect((await call(fileFn, 'GET', `/proxy/files/${file.fileId}/download`)).status).toBe(403);
    expect((await call(fileFn, 'POST', `/${file.fileId}/permissions`, { body: { userId: 'mallory', canRead: true } })).status).toBe(403);
    expect((await call(fileFn, 'POST', `/${file.fileId}/share-links`, { body: {} })).status).toBe(403);
    expect((await call(fileFn, 'DELETE', `/${file.fileId}`)).status).toBe(403);
  });

  it('a public anonymous upload is readable but still cannot be shared, granted or deleted anonymously', async () => {
    const { fileFn } = makeFileFn();
    const file = await anonymousUpload(fileFn, 'public', 'drop-off');

    const download = await call(fileFn, 'GET', `/proxy/files/${file.fileId}/download`);
    expect(download.status).toBe(200);
    expect(download.text).toBe('drop-off');
    expect((await call(fileFn, 'POST', `/${file.fileId}/share-links`, { body: {} })).status).toBe(403);
    expect((await call(fileFn, 'POST', `/${file.fileId}/permissions`, { body: { userId: 'mallory', canRead: true } })).status).toBe(403);
    expect((await call(fileFn, 'DELETE', `/${file.fileId}`)).status).toBe(403);
  });

  it('an anonymous retry gets its own session and token, and tokens are not stored in plaintext (P7)', async () => {
    const { fileFn, database } = makeFileFn();
    const body = { policy: 'private', fileName: 'a.txt', size: 3, mimeType: 'text/plain' };
    const headers = { 'x-idempotency-key': 'test-idempotency-key' };
    const first = await call(fileFn, 'POST', '/upload/init', { body, headers });
    const replay = await call(fileFn, 'POST', '/upload/init', { body, headers });
    expect(first.json.data.uploadSessionToken).toEqual(expect.any(String));
    expect(replay.json.data.uploadSessionToken).toEqual(expect.any(String));
    expect(replay.json.data.uploadSessionId).not.toBe(first.json.data.uploadSessionId);
    expect(replay.json.data.uploadSessionToken).not.toBe(first.json.data.uploadSessionToken);

    const row = await database.findOne<{ uploadSessionToken: string | null; idempotencyKey: string | null }>({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: first.json.data.uploadSessionId }],
      namespace: 'filefn',
    });
    expect(row!.uploadSessionToken).toBeNull();
    expect(row!.idempotencyKey).toBeNull();
  });

  it('replays a session created before keys were scoped only for its own owner', async () => {
    const { fileFn, database } = makeFileFn();
    const body = { policy: 'private', fileName: 'a.txt', size: 3, mimeType: 'text/plain' };
    const first = await call(fileFn, 'POST', '/upload/init', { body, headers: { 'x-idempotency-key': 'legacy-key', 'x-test-user': 'alice' } });
    // Turn the row into a pre-upgrade one, which stored the raw key.
    await database.update({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: first.json.data.uploadSessionId }],
      data: { idempotencyKey: 'legacy-key' },
      namespace: 'filefn',
    });
    const replay = await call(fileFn, 'POST', '/upload/init', { body, headers: { 'x-idempotency-key': 'legacy-key', 'x-test-user': 'alice' } });
    expect(replay.json.data.uploadSessionId).toBe(first.json.data.uploadSessionId);
  });

  it('scopes idempotency keys to the caller', async () => {
    const { fileFn } = makeFileFn();
    const body = { policy: 'private', fileName: 'a.txt', size: 3, mimeType: 'text/plain' };
    const key = { 'x-idempotency-key': 'shared-key' };
    const alice = await call(fileFn, 'POST', '/upload/init', { body, headers: { ...key, 'x-test-user': 'alice' } });
    const bob = await call(fileFn, 'POST', '/upload/init', { body: { ...body, fileName: 'b.txt' }, headers: { ...key, 'x-test-user': 'bob' } });
    expect(alice.status).toBe(200);
    // Bob's request with the same key is his own session, not a conflict with alice's.
    expect(bob.status).toBe(200);
    expect(bob.json.data.uploadSessionId).not.toBe(alice.json.data.uploadSessionId);
  });

  it('refuses a session row without an owner instead of opening it to everyone', async () => {
    const { fileFn, database } = makeFileFn();
    const init = await call(fileFn, 'POST', '/upload/init', {
      body: { policy: 'private', fileName: 'a.txt', size: 3, mimeType: 'text/plain' },
      headers: { 'x-test-user': 'alice' },
    });
    const { uploadSessionId } = init.json.data;
    await database.update({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      data: { ownerId: null },
      namespace: 'filefn',
    });
    expect((await call(fileFn, 'GET', `/upload/${uploadSessionId}/status`, { headers: { 'x-test-user': 'mallory' } })).status).toBe(403);
  });
});
