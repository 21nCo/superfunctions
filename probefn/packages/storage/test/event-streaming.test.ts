import { appendFile, mkdtemp, open, rm, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactCapTracker, NdjsonEventSink, iterateEventSinkFamily, readEventSinkFamily } from '../src/index.js';
import { captureEventDeltaBaseline } from '@probefn/core';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.mocked(open).mockClear();
});
async function fixture(contents: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-event-stream-')); roots.push(root);
  await writeFile(path.join(root, 'events.ndjson'), contents); return root;
}

it('yields incrementally and closes the actual file on early iterator return', async () => {
  const root = await fixture('{"sequence":1}\ncorrupt-secret-value\n');
  await writeFile(path.join(root, 'events-0002.ndjson'), '{"sequence":2}\n');
  const events = iterateEventSinkFamily(root, 'events.ndjson');
  expect((await events.next()).value?.payload).toEqual({ sequence: 1 });
  expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
  const handle = await vi.mocked(open).mock.results[0]!.value;
  await events.return(undefined);
  await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
});

it('preserves UTF-8 across read chunks, CRLF, blank physical lines and final unterminated records', async () => {
  const text = 'a'.repeat(65520) + '😀é'.repeat(1000);
  const root = await fixture(`\r\n${JSON.stringify({ text })}\r\n\n{"sequence":2}`);
  const records = await readEventSinkFamily(root, 'events.ndjson');
  expect(records.map(record => record.lineNumber)).toEqual([2, 4]);
  expect(records[0]!.payload.text).toBe(text);
  expect(records[1]!.payload.sequence).toBe(2);
});

it('bounds encoded record bytes and closes the file on a structured limit failure', async () => {
  const line = JSON.stringify({ text: 'é😀' });
  const root = await fixture(`${line}\n`);
  expect(await readEventSinkFamily(root, 'events.ndjson', { maxRecordBytes: Buffer.byteLength(line) })).toHaveLength(1);
  await expect(readEventSinkFamily(root, 'events.ndjson', { maxRecordBytes: Buffer.byteLength(line) - 1 }))
    .rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED', details: { relativePath: 'events.ndjson', lineNumber: 1 } });
  for (const result of vi.mocked(open).mock.results) await expect((await result.value).stat()).rejects.toMatchObject({ code: 'EBADF' });
});

it('fails closed with physical provenance for malformed JSON', async () => {
  const contents = '{bad-secret';
  const root = await fixture(`\n${contents}\n`);
  try { await readEventSinkFamily(root, 'events.ndjson'); throw new Error('unexpected success'); }
  catch (error) {
    expect(error).toMatchObject({ code: 'E_STORAGE_WRITE_FAILED', details: { relativePath: 'events.ndjson', lineNumber: 2 } });
    expect(JSON.stringify(error)).not.toContain('bad-secret');
  }
});

it('does not silently return partial evidence when a snapshotted rollover disappears', async () => {
  const root = await fixture('{"sequence":1}\n');
  await writeFile(path.join(root, 'events-0002.ndjson'), '{"sequence":2}\n');
  const events = iterateEventSinkFamily(root, 'events.ndjson');
  await events.next();
  await unlink(path.join(root, 'events-0002.ndjson'));
  await expect(events.next()).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});

it('detects truncation of a segment during iteration', async () => {
  const root = await fixture('{"sequence":1}\n' + '{"sequence":2}\n'.repeat(10000));
  const events = iterateEventSinkFamily(root, 'events.ndjson');
  await events.next();
  await truncate(path.join(root, 'events.ndjson'), 0);
  await expect((async () => { for await (const _ of events) { /* drain */ } })())
    .rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});

it('counts all rolled events without retaining their payloads and keeps missing anchors empty', async () => {
  const root = await fixture('{"type":"console","level":"info"}\n');
  await writeFile(path.join(root, 'events-0002.ndjson'), '{"type":"console","level":"error"}\n'.repeat(10000));
  expect(await captureEventDeltaBaseline(root, { consoleSinkPath: 'events.ndjson', pageErrorSinkPath: 'missing.ndjson' }))
    .toEqual({ consoleErrors: 10000, pageErrors: 0, networkFailures: 0 });
});

it('does not chase appends beyond the segment size observed at the start of iteration', async () => {
  const root = await fixture('{"sequence":1}\n{"sequence":2}\n');
  const events = iterateEventSinkFamily(root, 'events.ndjson');
  expect((await events.next()).value?.payload.sequence).toBe(1);
  await appendFile(path.join(root, 'events.ndjson'), '{"sequence":3}\n');
  const remaining = [];
  for await (const event of events) remaining.push(event.payload.sequence);
  expect(remaining).toEqual([2]);
  expect(await readEventSinkFamily(root, 'events.ndjson')).toHaveLength(3);
});

it('preserves every JSON value accepted by the public sink writer', async () => {
  const root = await fixture('');
  const sink = new NdjsonEventSink({ repoRoot: root, relativeDirectory: '.', baseName: 'events', capTracker: new ArtifactCapTracker() });
  const values = [null, [], 42, 'text', true, { type: 'console', level: 'error' }];
  for (const value of values) await sink.append(value);
  expect((await readEventSinkFamily(root, 'events.ndjson')).map(record => record.payload)).toEqual(values);
  expect((await captureEventDeltaBaseline(root, { consoleSinkPath: 'events.ndjson' })).consoleErrors).toBe(1);
});

it.each(['events-0003.ndjson', 'events-00002.ndjson'])('rejects missing or ambiguous rollover segment %s before yielding partial evidence', async name => {
  const root = await fixture('{"sequence":1}\n');
  await writeFile(path.join(root, name), '{"sequence":2}\n');
  if (name === 'events-00002.ndjson') await writeFile(path.join(root, 'events-0002.ndjson'), '{"sequence":2}\n');
  await expect(iterateEventSinkFamily(root, 'events.ndjson').next()).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  await expect(captureEventDeltaBaseline(root, { consoleSinkPath: 'events.ndjson' })).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});
