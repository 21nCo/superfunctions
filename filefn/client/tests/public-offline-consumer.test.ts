import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// Only the package entry point: what an app imports from @filefn/client.
import { OfflineQueue, OfflineQueueError, type OfflineQueueEntry } from '../src/index.js';
import { SharedLockManager, createStorage } from '../src/__tests__/helpers/offline-fixtures.js';

beforeEach(() => vi.stubGlobal('navigator', {}));
afterEach(() => vi.unstubAllGlobals());

it('runs a guest consumer end to end through the public API with deterministic upload and verification adapters', async () => {
  const { root } = createStorage();
  const linked = new Map<string, string>();
  const queue = new OfflineQueue({
    partition: { serviceId: 'svc-notes', principal: { kind: 'guest', namespace: 'guest-test-1' } },
    getRoot: async () => root,
    coordinator: new SharedLockManager().forTab('page'),
    uploader: { upload: async ({ fileId }) => ({ fileId, versionId: 'ver_test_1' }) },
    hooks: {
      verify: async ({ versionId }) => (versionId === 'ver_test_1' ? { verified: true } : { verified: false, reason: 'unknown version' }),
      publish: {
        idempotent: true,
        run: async ({ operationId, fileId }) => {
          linked.set(operationId, fileId);
          return { result: { link: operationId } };
        },
      },
    },
  });

  const staged = await queue.stage({ entryId: 'note-1', policy: 'attachments', file: new Blob(['draft']), hold: true });
  if (staged.status !== 'staged') throw new Error('refused');
  expect(await queue.process('note-1')).toMatchObject({ status: 'provisional', reason: 'held' });
  const settled = queue.whenSettled('note-1', staged.entry.generation);
  await queue.release('note-1', staged.entry.generation, staged.holdId!);
  await queue.processAll();

  const entry: OfflineQueueEntry = await settled;
  expect(entry).toMatchObject({ state: 'published', upload: { versionId: 'ver_test_1' }, publication: { result: { link: entry.operationId } } });
  expect([...linked]).toEqual([[entry.operationId, entry.fileId]]);
  queue.dispose();
  await expect(queue.list()).rejects.toBeInstanceOf(OfflineQueueError);
});
