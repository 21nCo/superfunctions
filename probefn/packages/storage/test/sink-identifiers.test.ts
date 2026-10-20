import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ArtifactCapTracker, ArtifactStore, NdjsonEventSink } from '../src/index.js';

it.each(['../../../../../../outside', '../escape', '.', '..', '/absolute', 'folder/name'])('rejects event sink identifier %s before a sink can write', baseName => {
  expect(() => new NdjsonEventSink({ repoRoot: tmpdir(), relativeDirectory: '.artifacts/runs/valid/events', baseName, capTracker: new ArtifactCapTracker() }))
    .toThrow('Event sink name must be a non-reserved path segment.');
  expect(() => new ArtifactStore({ repoRoot: tmpdir() }).createEventSink('valid', baseName, 'events'))
    .toThrow('Event sink name must be a non-reserved path segment.');
});

it.each(['network.errors_v2', 'browser-console'])('preserves valid event sink name %s', name => {
  const sink = new ArtifactStore({ repoRoot: tmpdir() }).createEventSink('run-1', name, 'events');
  expect(sink.getCurrentRelativePath()).toBe(`.artifacts/runs/run-1/events/${name}.ndjson`);
});
