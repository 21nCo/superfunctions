import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { createProbefnError } from '@probefn/contracts/errors';

export const EMPTY_EVENT_CHAIN = '0'.repeat(64);
const conflict = () => createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Pending event append conflicts with its persisted file identity or bytes.', retryable: false });
export const eventDigest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const extendEventChain = (chain: string, recordDigest: string): string => eventDigest(`${chain}:${recordDigest}`);
const safeInteger = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const intentSchema = z.object({
  path: z.string(), dev: safeInteger, ino: safeInteger, offset: safeInteger,
  mtime: z.number().finite(), payload: z.string().min(1), digest, prefixChain: digest,
  count: safeInteger, sinkIndex: safeInteger.min(1), rollover: z.boolean(),
  priorFailed: z.union([z.literal(0), z.literal(1)]),
}).strict();
export type EventAppendIntent = z.infer<typeof intentSchema>;
export function parseEventIntent(serialized: string): EventAppendIntent {
  try { return intentSchema.parse(JSON.parse(serialized)); } catch { throw conflict(); }
}

/** Streaming record hash chain; never buffer an existing event line. */
export async function inspectEventPrefix(file: FileHandle, length: number): Promise<{ count: number; chain: string }> {
  if (!Number.isSafeInteger(length) || length < 0) throw conflict();
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0, count = 0, chain = EMPTY_EVENT_CHAIN, record = createHash('sha256'), openRecord = false;
  while (position < length) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, length - position), position);
    if (!bytesRead) throw conflict();
    position += bytesRead;
    let start = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 10) {
        record.update(buffer.subarray(start, i + 1));
        chain = extendEventChain(chain, record.digest('hex')); count++;
        record = createHash('sha256'); start = i + 1; openRecord = false;
      }
    }
    if (start < bytesRead) { record.update(buffer.subarray(start, bytesRead)); openRecord = true; }
  }
  if (openRecord) throw conflict();
  return { count, chain };
}

/** Append only missing bytes after proving the exact recorded prefix and suffix. */
export async function reconcileEventAppend(file: FileHandle, intent: EventAppendIntent, verifyPrefix = true): Promise<void> {
  const before = await file.stat();
  const payload = Buffer.from(intent.payload);
  if (!before.isFile() || before.nlink !== 1 || before.dev !== intent.dev || before.ino !== intent.ino ||
      !Number.isSafeInteger(intent.offset) || intent.offset < 0 || !payload.length ||
      payload.at(-1) !== 10 || payload.subarray(0, -1).includes(10) || eventDigest(payload) !== intent.digest ||
      !/^[0-9a-f]{64}$/.test(intent.prefixChain) || before.size < intent.offset || before.size > intent.offset + payload.length) throw conflict();
  if (verifyPrefix) {
    const prefix = await inspectEventPrefix(file, intent.offset);
    if (prefix.count !== intent.count || prefix.chain !== intent.prefixChain) throw conflict();
  } else if (before.size !== intent.offset || before.mtimeMs !== intent.mtime) throw conflict();
  const present = before.size - intent.offset;
  const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, present)));
  let position = 0;
  while (position < present) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, present - position), intent.offset + position);
    if (!bytesRead || !buffer.subarray(0, bytesRead).equals(payload.subarray(position, position + bytesRead))) throw conflict();
    position += bytesRead;
  }
  const checked = await file.stat();
  if (checked.dev !== before.dev || checked.ino !== before.ino || checked.size !== before.size || checked.mtimeMs !== before.mtimeMs) throw conflict();
  if (present < payload.length) await file.writeFile(payload.subarray(present));
  await file.sync();
  const after = await file.stat();
  if (after.dev !== intent.dev || after.ino !== intent.ino || after.size !== intent.offset + payload.length) throw conflict();
}
