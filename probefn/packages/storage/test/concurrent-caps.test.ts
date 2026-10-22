import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NdjsonEventSink } from '../src/event-sink.js';
import { ArtifactCapTracker } from '../src/caps.js';
import { ArtifactStore } from '../src/artifact-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), appendFile: vi.fn(actual.appendFile) };
});
const roots: string[] = [];
const root = async () => { const value = await fs.mkdtemp(path.join(os.tmpdir(), 'probefn-concurrent-caps-')); roots.push(value); return value; };
const fulfilled = <T>(results: PromiseSettledResult<T>[]) => results.filter((result): result is PromiseFulfilledResult<T> => result.status === 'fulfilled');
afterEach(async () => { await Promise.all(roots.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); vi.clearAllMocks(); });

describe('concurrent event storage caps', () => {
  it('reserves the shared byte budget across separate sinks before asynchronous IO', async () => {
    const repoRoot = await root(); const tracker = new ArtifactCapTracker(8); // Four '{}\n' payloads cannot fit.
    const sinks = ['console', 'network', 'errors', 'stdout'].map(baseName => new NdjsonEventSink({ repoRoot, relativeDirectory: 'events', baseName, capTracker: tracker }));
    const results = await Promise.allSettled(sinks.map(sink => sink.append({})));
    expect(fulfilled(results)).toHaveLength(2);
    expect(results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason.code)).toEqual(['E_STORAGE_CAP_EXCEEDED', 'E_STORAGE_CAP_EXCEEDED']);
    const files = await fs.readdir(path.join(repoRoot, 'events'));
    const total = (await Promise.all(files.map(file => fs.stat(path.join(repoRoot, 'events', file))))).reduce((sum, stat) => sum + stat.size, 0);
    expect(total).toBe(6); expect(tracker.getTotalBytesWritten()).toBe(6);
  });

  it('serializes concurrent event-cap errors without exceeding the configured count', async () => {
    const repoRoot = await root();
    const sink = new NdjsonEventSink({ repoRoot, relativeDirectory: 'events', baseName: 'console', capTracker: new ArtifactCapTracker(10000), policy: { maxEventsPerSink: 3, strategy: 'error' } });
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => sink.append({ index })));
    expect(fulfilled(results).map(result => result.value.eventCount)).toEqual([1, 2, 3]);
    expect((await fs.readFile(path.join(repoRoot, 'events/console.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).index)).toEqual([0, 1, 2]);
  });

  it('rotates concurrently submitted events in order with no oversized or skipped sink', async () => {
    const repoRoot = await root();
    const sink = new NdjsonEventSink({ repoRoot, relativeDirectory: 'events', baseName: 'console', capTracker: new ArtifactCapTracker(10000), policy: { maxEventsPerSink: 3, strategy: 'rollover' } });
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => sink.append({ index })));
    expect(results.map(result => result.sinkIndex)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4]);
    expect(results.map(result => result.eventCount)).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3, 1]);
    const values: number[] = [];
    for (const relativePath of new Set(results.map(result => result.relativePath))) {
      const events = (await fs.readFile(path.join(repoRoot, relativePath), 'utf8')).trim().split('\n').map(line => JSON.parse(line).index);
      expect(events.length).toBeLessThanOrEqual(3); values.push(...events);
    }
    expect(values).toEqual(Array.from({ length: 10 }, (_, index) => index));
  });

  it('releases a known pre-append failure without advancing rollover state or poisoning queued work', async () => {
    const repoRoot = await root(); const tracker = new ArtifactCapTracker(6);
    const sink = new NdjsonEventSink({ repoRoot, relativeDirectory: 'events', baseName: 'console', capTracker: tracker, policy: { maxEventsPerSink: 1, strategy: 'rollover' } });
    await sink.append({});
    vi.mocked(fs.mkdir).mockRejectedValueOnce(new Error('mkdir failed'));
    const results = await Promise.allSettled([sink.append({}), sink.append({})]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'E_STORAGE_WRITE_FAILED' } });
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { sinkIndex: 2, eventCount: 1, relativePath: 'events/console-0002.ndjson' } });
    expect(tracker.getTotalBytesWritten()).toBe(6);
  });

  it('charges uncertain partial appends and fails the sink closed instead of extending a corrupt line', async () => {
    const repoRoot = await root(); const tracker = new ArtifactCapTracker(20);
    const sink = new NdjsonEventSink({ repoRoot, relativeDirectory: 'events', baseName: 'console', capTracker: tracker });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.appendFile).mockImplementationOnce(async file => { await actual.appendFile(file, '{'); throw new Error('partial append'); });
    const results = await Promise.allSettled([sink.append({ index: 1 }), sink.append({ index: 2 })]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(fs.appendFile).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(repoRoot, 'events/console.ndjson'), 'utf8')).toBe('{');
    expect(tracker.getTotalBytesWritten()).toBe(Buffer.byteLength('{"index":1}\n'));
  });
});

describe('artifact reservations', () => {
  it('settles reservations once and counts pending bytes against admission', () => {
    const tracker = new ArtifactCapTracker(10);
    const reservation = tracker.reserve(7, 'one');
    expect(() => tracker.reserve(4, 'two')).toThrow();
    reservation.release(); reservation.commit();
    const next = tracker.reserve(10, 'two'); next.commit(); next.commit(); next.release();
    expect(tracker.getTotalBytesWritten()).toBe(10);
    expect(() => tracker.reserve(1, 'three')).toThrow();
    for (const value of [NaN, Infinity, -1, 0.5]) expect(() => new ArtifactCapTracker(10).reserve(value, 'invalid')).toThrow();
  });

  it('shares reservations between artifact replacements, JSON writes and event sinks', async () => {
    const repoRoot = await root(); const store = new ArtifactStore({ repoRoot, caps: { maxArtifactBytes: 10 } });
    const sink = store.createEventSink('run-test', 'console', 'events');
    const results = await Promise.allSettled([store.writeArtifact('.artifacts/runs/run-test/one.txt', '123456'), store.writeReport('run-test', 'json', {}), sink.append({})]);
    expect(fulfilled<unknown>(results)).toHaveLength(2); // Text6 + JSON3 reserves first; event3 cannot fit.
    expect(results[2]).toMatchObject({ status: 'rejected', reason: { code: 'E_STORAGE_CAP_EXCEEDED' } });
    expect(await fs.readFile(path.join(repoRoot, '.artifacts/runs/run-test/one.txt'), 'utf8')).toBe('123456');
  });

  it('serializes same-path replacements and charges cumulative bytes, not final disk size', async () => {
    const repoRoot = await root(); const store = new ArtifactStore({ repoRoot, caps: { maxArtifactBytes: 6 } });
    await Promise.all([store.writeArtifact('same.txt', 'aaa'), store.writeArtifact('same.txt', 'bbb')]);
    expect(await fs.readFile(path.join(repoRoot, 'same.txt'), 'utf8')).toBe('bbb');
    await expect(store.writeArtifact('same.txt', 'c')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  });

  it('retains uncertain failed-writer budget while allowing queued work to settle', async () => {
    const repoRoot = await root(); const store = new ArtifactStore({ repoRoot, caps: { maxArtifactBytes: 6 } });
    vi.mocked(fs.mkdir).mockRejectedValueOnce(new Error('writer failed before stage was observable'));
    const results = await Promise.allSettled([store.writeArtifact('failed.txt', 'aaa'), store.writeArtifact('ok.txt', 'bbb')]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'E_STORAGE_WRITE_FAILED' } });
    expect(results[1].status).toBe('fulfilled');
    await expect(store.writeArtifact('third.txt', 'c')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  });
});
