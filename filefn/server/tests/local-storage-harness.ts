import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { createFileFn, type Policy } from '../src/index.js';

/** Every object key under a local storage root, sorted, with `/` separators. */
export async function listObjects(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(relative(rootDir, path).split('\\').join('/'));
    }
  }
  await walk(rootDir);
  return out.sort((a, b) => a.localeCompare(b));
}

export const DOCS_POLICY: Policy = { name: 'docs', contentTypes: ['text/plain'], visibility: 'public' };

/** A FileFn on an in-memory database and local storage under `rootDir`. */
export function makeLocalFileFn(rootDir: string, namespace: string, policies: Policy[] = [DOCS_POLICY]) {
  return createFileFn({
    database: memoryAdapter(),
    storage: createLocalStorageAdapter({ rootDir }),
    namespace,
    policies,
  });
}

/** Uploads `text` as one proxied part and completes the session. */
export async function uploadText(
  fileFn: ReturnType<typeof makeLocalFileFn>,
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
