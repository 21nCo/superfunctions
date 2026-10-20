import { mkdtemp, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readEventSinkPage, iterateEventSinkFamily, MAX_EVENT_PAGE_BYTES } from '../src/index.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(value: string) { const root = await mkdtemp(path.join(tmpdir(), 'probe-page-')); roots.push(root); await writeFile(path.join(root, 'events.ndjson'), value); return root; }
it('traverses numeric rollover with physical provenance and arbitrary JSON values', async () => {
  const root = await fixture('\nnull\n42\n');
  for (let i = 2; i <= 12; i++) await writeFile(path.join(root, `events-${String(i).padStart(4, '0')}.ndjson`), `\n${JSON.stringify([i])}\n`);
  const events: unknown[] = []; const provenance: unknown[] = []; let cursor: string | undefined;
  do { const page = await readEventSinkPage(root, 'events.ndjson', { limit: 2, ...(cursor ? { cursor } : {}) }); events.push(...page.events); provenance.push(...page.provenance); cursor = page.nextCursor ?? undefined; } while (cursor);
  expect(events).toEqual([null, 42, ...Array.from({ length: 11 }, (_, i) => [i + 2])]);
  expect(provenance[0]).toEqual({ relativePath: 'events.ndjson', lineNumber: 2 });
  expect(provenance.at(-1)).toEqual({ relativePath: 'events-0012.ndjson', lineNumber: 2 });
});
it('bounds the full JSON page, preserves byte lookahead, and rejects oversized single events', async () => {
  const value = { text: '😀'.repeat(90000) };
  const root = await fixture('\n'.repeat(10000) + Array(4).fill(JSON.stringify(value)).join('\n') + '\n');
  const first = await readEventSinkPage(root, 'events.ndjson', { limit: 1000 });
  expect(first.events).toHaveLength(2); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(MAX_EVENT_PAGE_BYTES);
  const second = await readEventSinkPage(root, 'events.ndjson', { cursor: first.nextCursor! });
  expect(second.events).toEqual([value, value]); expect(second.nextCursor).toBeNull();
  expect(second.provenance[0]!.lineNumber).toBe(10003);
  await writeFile(path.join(root, 'large.ndjson'), JSON.stringify({ value: 'x'.repeat(MAX_EVENT_PAGE_BYTES) }) + '\n');
  await expect(readEventSinkPage(root, 'large.ndjson')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
});
it('rejects malformed, cross-sink, replaced and truncated cursors; follows complete appends', async () => {
  const root = await fixture('{"n":1}\n{"n":2}\n');
  const first = await readEventSinkPage(root, 'events.ndjson', { limit: 1 });
  await writeFile(path.join(root, 'other.ndjson'), '{}\n');
  for (const cursor of ['', 'invalid', first.nextCursor! + 'x']) await expect(readEventSinkPage(root, 'events.ndjson', { cursor })).rejects.toMatchObject({ code: 'E_MCP_INVALID_ARGS' });
  await expect(readEventSinkPage(root, 'other.ndjson', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'E_MCP_INVALID_ARGS' });
  await appendFile(path.join(root, 'events.ndjson'), '{"n":3}\n');
  expect((await readEventSinkPage(root, 'events.ndjson', { cursor: first.nextCursor! })).events).toEqual([{ n: 2 }, { n: 3 }]);
  await writeFile(path.join(root, 'events.ndjson'), '');
  await expect(readEventSinkPage(root, 'events.ndjson', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'E_MCP_INVALID_ARGS' });
  await writeFile(path.join(root, 'replacement'), '{"n":1}\n{"n":2}\n'); await rename(path.join(root, 'replacement'), path.join(root, 'events.ndjson'));
  await expect(readEventSinkPage(root, 'events.ndjson', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'E_MCP_INVALID_ARGS' });
});
it('handles final unterminated records without replay and rejects later extension', async () => {
  const root = await fixture('{"n":1}'); const first = await readEventSinkPage(root, 'events.ndjson', { limit: 1 });
  expect((await readEventSinkPage(root, 'events.ndjson', { cursor: first.nextCursor! })).events).toEqual([]);
  await appendFile(path.join(root, 'events.ndjson'), '\n{"n":2}\n');
  await expect(readEventSinkPage(root, 'events.ndjson', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'E_MCP_INVALID_ARGS' });
});
it('rejects missing rollover and corrupt subsequent events instead of returning incomplete evidence', async () => {
  const root = await fixture('{}\n'); await writeFile(path.join(root, 'events-0003.ndjson'), '{}\n');
  await expect(readEventSinkPage(root, 'events.ndjson')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  await writeFile(path.join(root, 'events-0002.ndjson'), 'corrupt\n');
  const first = await readEventSinkPage(root, 'events.ndjson', { limit: 1 });
  await expect(readEventSinkPage(root, 'events.ndjson', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});

it('rejects same-inode rewrite at the guarded record even when the file grows', async () => {
  const root = await fixture('{"n":1}\n{"n":2}\n');
  const first = await readEventSinkPage(root, 'events.ndjson', { limit: 1 });
  await writeFile(path.join(root, 'events.ndjson'), '{"n":9}\n{"n":2}\n{"n":3}\n');
  await expect(readEventSinkPage(root, 'events.ndjson', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'E_MCP_INVALID_ARGS' });
});

it('rejects a replaced anchor when resuming a later rollover segment', async () => {
  const root = await fixture('{}\n'); await writeFile(path.join(root, 'events-0002.ndjson'), '{"n":2}\n{"n":3}\n');
  const first = await readEventSinkPage(root, 'events.ndjson', { limit: 2 });
  await writeFile(path.join(root, 'replacement'), '{}\n'); await rename(path.join(root, 'replacement'), path.join(root, 'events.ndjson'));
  await expect(readEventSinkPage(root, 'events.ndjson', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'E_MCP_INVALID_ARGS' });
});

it('defaults to100 and validates direct iterator guard ranges before reading', async () => {
  const root = await fixture('{}\n'.repeat(101));
  const first = await readEventSinkPage(root, 'events.ndjson'); expect(first.events).toHaveLength(100);
  expect((await readEventSinkPage(root, 'events.ndjson', { cursor: first.nextCursor! })).events).toHaveLength(1);
  const iterator = iterateEventSinkFamily(root, 'events.ndjson'); const position = (await iterator.next()).value!.nextPosition!; await iterator.return(undefined);
  for (const patch of [{ guardBytes: -1 }, { guardBytes: Number.MAX_SAFE_INTEGER }, { guardOffset: -1 }, { observedSize: 0 }, { modifiedAt: NaN }, { terminated: 'yes' }, { guardHash: 'bad' }]) {
    const broken = iterateEventSinkFamily(root, 'events.ndjson', { start: { ...position, ...patch } as any });
    await expect(broken.next()).rejects.toMatchObject({ code: 'E_MCP_INVALID_ARGS' });
  }
});

it('keeps absolute repository paths out of cursor payloads while rejecting cross-repository reuse', async () => {
  const root = await fixture('{}\n{}\n'); const other = await fixture('{}\n{}\n');
  const first = await readEventSinkPage(root, 'events.ndjson', { limit: 1 });
  const payload = Buffer.from(first.nextCursor!.split('.')[0]!, 'base64url').toString();
  expect(payload).not.toContain(root); expect(payload).not.toContain(tmpdir());
  expect(JSON.parse(payload).anchor).toBe('events.ndjson');
  await expect(readEventSinkPage(other, 'events.ndjson', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'E_MCP_INVALID_ARGS' });
});
