import path from 'node:path';
import { createReadStream } from 'node:fs';
import { RunQuota } from './run-quota.js';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { createProbefnError } from '@probefn/contracts/errors';
import type { CheckpointManifest, RunManifest } from '@probefn/contracts/manifests';
import { ArtifactCapTracker, DEFAULT_STORAGE_CAPS, type StorageCaps } from './caps.js';
import { NdjsonEventSink, type EventSinkOptions } from './event-sink.js';
import { assertArtifactIdentifier, assertRepositoryRelativePath, writeAtomicFile } from './manifest-writer.js';
import { redactSensitiveData } from './redaction.js';

export interface ArtifactStoreOptions {
  repoRoot: string;
  artifactRoot?: string;
  caps?: Partial<StorageCaps>;
}

export interface RunPaths {
  runRoot: string;
  checkpointRoot: string;
  diffRoot: string;
  devServerRoot: string;
  eventRoot: string;
  sessionManifestPath: string;
  tracePath: string;
  reportJsonPath: string;
  reportMarkdownPath: string;
}

export interface CheckpointPaths {
  root: string;
  manifestPath: string;
  screenshotPath: string;
  domPath: string;
  axPath: string;
  layoutPath: string;
  stylesPath: string;
  videoPath: string;
}

export class ArtifactStore {
  private readonly repoRoot: string;
  private readonly artifactRoot: string;
  private readonly capTracker: ArtifactCapTracker;
  private readonly runQuota: RunQuota;
  private readonly maxEventsPerSink: number;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: ArtifactStoreOptions) {
    this.repoRoot = options.repoRoot;
    this.artifactRoot = assertRepositoryRelativePath(options.artifactRoot ?? '.artifacts');
    this.maxEventsPerSink = options.caps?.maxEventsPerSink ?? DEFAULT_STORAGE_CAPS.maxEventsPerSink;
    if (!Number.isSafeInteger(this.maxEventsPerSink) || this.maxEventsPerSink < 1) throw new TypeError('Event cap must be a positive safe integer.');
    this.runQuota = new RunQuota(this.repoRoot, this.artifactRoot, options.caps?.maxArtifactBytes ?? DEFAULT_STORAGE_CAPS.maxArtifactBytes, options.caps?.maxAccountingDatabaseBytes);
    this.capTracker = new ArtifactCapTracker(
      options.caps?.maxArtifactBytes ?? DEFAULT_STORAGE_CAPS.maxArtifactBytes,
    );
  }

  public getArtifactRoot(): string {
    return this.artifactRoot;
  }

  public getRunPaths(runId: string): RunPaths {
    assertRunId(runId);

    const runRoot = path.posix.join(this.artifactRoot, 'runs', runId);
    return {
      runRoot,
      checkpointRoot: path.posix.join(runRoot, 'checkpoints'),
      diffRoot: path.posix.join(runRoot, 'diffs'),
      devServerRoot: path.posix.join(runRoot, 'devserver'),
      eventRoot: path.posix.join(runRoot, 'events'),
      sessionManifestPath: path.posix.join(runRoot, 'session.json'),
      tracePath: path.posix.join(runRoot, 'browser.trace.zip'),
      reportJsonPath: path.posix.join(runRoot, 'report.json'),
      reportMarkdownPath: path.posix.join(runRoot, 'report.md'),
    };
  }

  public getCheckpointPaths(runId: string, checkpointName: string): CheckpointPaths {
    const runPaths = this.getRunPaths(runId);
    const safeCheckpointName = sanitizeSegment(checkpointName);
    const root = path.posix.join(runPaths.checkpointRoot, safeCheckpointName);

    return {
      root,
      manifestPath: path.posix.join(root, 'checkpoint.json'),
      screenshotPath: path.posix.join(root, 'screenshot.png'),
      domPath: path.posix.join(root, 'dom.json'),
      axPath: path.posix.join(root, 'ax.json'),
      layoutPath: path.posix.join(root, 'layout.json'),
      stylesPath: path.posix.join(root, 'styles.json'),
      videoPath: path.posix.join(root, 'video.webm'),
    };
  }

  public async writeRunManifest(runId: string, manifest: RunManifest): Promise<string> {
    const relativePath = this.getRunPaths(runId).sessionManifestPath;
    await this.writeJson(relativePath, manifest);
    return relativePath;
  }

  public async writeCheckpointManifest(
    runId: string,
    checkpointName: string,
    manifest: CheckpointManifest,
  ): Promise<string> {
    const relativePath = this.getCheckpointPaths(runId, checkpointName).manifestPath;
    await this.writeJson(relativePath, manifest);
    return relativePath;
  }

  public async writeReport(
    runId: string,
    format: 'json' | 'markdown',
    contents: string | Record<string, unknown>,
  ): Promise<string> {
    const runPaths = this.getRunPaths(runId);
    const relativePath = format === 'json' ? runPaths.reportJsonPath : runPaths.reportMarkdownPath;
    if (format === 'json') {
      await this.writeJson(
        relativePath,
        redactSensitiveData(contents as Record<string, unknown>).value,
      );
    } else {
      await this.writeText(relativePath, redactSensitiveData(contents as string).value);
    }
    return relativePath;
  }

  public async writeArtifact(relativePath: string, contents: string | Uint8Array, scope?: { runId: string }): Promise<string> {
    await this.writeText(relativePath, contents, scope);
    return assertRepositoryRelativePath(relativePath);
  }

  /** Atomically publish incrementally prepared bytes. Callers own content redaction. */
  public async writeArtifactStream(
    relativePath: string,
    produce: (write: (chunk: string | Uint8Array) => Promise<void>) => Promise<void>,
    scope?: { runId: string },
  ): Promise<string> {
    const normalizedPath = this.validateDestination(relativePath);
    const runId = this.resolveScope(normalizedPath, scope);
    if (runId) return this.writeManaged(normalizedPath, runId, produce, !this.runIdForPath(normalizedPath));
    const absolute = path.resolve(this.repoRoot, normalizedPath);
    const temporary = `${absolute}.tmp-${randomUUID()}`;
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(absolute), { recursive: true });
      const handle = await open(temporary, 'wx');
      try {
        await produce(async chunk => {
          const reservation = this.capTracker.reserve(typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength, normalizedPath);
          try { await handle.writeFile(chunk); }
          finally { reservation.commit(); }
        });
        await handle.sync();
        await handle.close();
        await rename(temporary, absolute);
      } finally {
        try { await handle.close(); }
        finally { await rm(temporary, { force: true }); }
      }
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    try { await operation; }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('E_')) throw error;
      throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: `Could not stream artifact ${normalizedPath}.`, retryable: false, details: { path: normalizedPath }, cause: error });
    }
    return normalizedPath;
  }

  public createEventSink(
    runId: string,
    baseName: string,
    directory: 'devserver' | 'events' | `checkpoints/${string}`,
    options?: Partial<
      Omit<EventSinkOptions, 'repoRoot' | 'relativeDirectory' | 'baseName' | 'capTracker'>
    >,
  ): NdjsonEventSink {
    const runPaths = this.getRunPaths(runId);
    const relativeDirectory =
      directory === 'devserver'
        ? runPaths.devServerRoot
        : directory === 'events'
          ? runPaths.eventRoot
        : path.posix.join(runPaths.runRoot, directory);

    if (!relativeDirectory.startsWith(`${runPaths.runRoot}/`) || relativeDirectory.split('/').includes('.probefn-staging')) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Event directory must remain within its run.', retryable: false });
    return new NdjsonEventSink({
      repoRoot: this.repoRoot,
      relativeDirectory,
      baseName,
      capTracker: this.capTracker,
      appendPersisted: (payload, policy) => this.runQuota.transaction(runId, relativeDirectory,
        quota => quota.append(relativeDirectory, baseName, payload, policy)),
      policy: { maxEventsPerSink: this.maxEventsPerSink, ...options?.policy },
    });
  }

  /** Admit a completed external producer file incrementally; caller owns its scratch cleanup. */
  public async importArtifactFile(relativePath: string, sourcePath: string): Promise<string> {
    return this.writeArtifactStream(relativePath, async write => {
      for await (const chunk of createReadStream(sourcePath)) await write(chunk as Buffer);
    });
  }

  public async deleteArtifact(relativePath: string): Promise<void> {
    const normalized = assertRepositoryRelativePath(relativePath);
    const runId = this.runIdForPath(normalized);
    if (!runId) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Deletion requires a run-scoped artifact path.', retryable: false });
    await this.runQuota.transaction(runId, normalized, async quota => {
      await rm(await quota.prepare(normalized), { force: true });
    });
  }

  private resolveScope(relative: string, scope?: { runId: string }): string | undefined {
    const pathRunId = this.runIdForPath(relative);
    const sessionState = relative.startsWith(`${path.posix.join(this.artifactRoot, 'session-state')}/`);
    if (sessionState && !scope) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Session-state writes require an explicit run scope.', retryable: false });
    if (scope && pathRunId && scope.runId !== pathRunId) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Artifact run scope does not match its path.', retryable: false });
    if (scope && !pathRunId && !sessionState) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'External run accounting is restricted to session-state artifacts.', retryable: false });
    return scope?.runId ?? pathRunId;
  }

  private validateDestination(relative: string): string {
    const normalized = assertRepositoryRelativePath(relative);
    if (normalized.startsWith(path.posix.join(this.artifactRoot, '.quota.sqlite')) || normalized.split('/').includes('.probefn-staging')) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Artifact path uses reserved accounting storage.', retryable: false });
    return normalized;
  }

  private runIdForPath(relative: string): string | undefined {
    const prefix = `${path.posix.join(this.artifactRoot, 'runs')}/`;
    if (!relative.startsWith(prefix)) return undefined;
    const [runId, ...rest] = relative.slice(prefix.length).split('/');
    assertArtifactIdentifier(runId!, 'Run id');
    if (rest.includes('.probefn-staging')) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Artifact path uses the reserved staging directory.', retryable: false });
    if (!rest.length) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Artifact path requires a file within its run.', retryable: false });
    return runId;
  }

  private async writeManaged(relative: string, runId: string,
    produce: (write: (chunk: string | Uint8Array) => Promise<void>) => Promise<void>, external = false): Promise<string> {
    await this.runQuota.transaction(runId, relative, async quota => {
      const absolute = await quota.prepare(relative);
      const temporary = await quota.prepare(path.posix.join(this.getRunPaths(runId).runRoot, '.probefn-staging', `${randomUUID()}.probefn-tmp-${randomUUID()}`));
      const handle = await open(temporary, 'wx', 0o600);
      let writes: Promise<void> = Promise.resolve();
      let closed = false;
      let writeError: unknown;
      const write = (chunk: string | Uint8Array): Promise<void> => {
        if (closed) return Promise.reject(new Error('Artifact producer is already closed.'));
        const snapshot = typeof chunk === 'string' ? chunk : new Uint8Array(chunk);
        const operation = writes.then(async () => {
          if (writeError) throw writeError;
          quota.reserve(typeof snapshot === 'string' ? Buffer.byteLength(snapshot) : snapshot.byteLength, relative);
          await handle.writeFile(snapshot);
        });
        writes = operation.catch(error => { writeError = error; });
        return operation;
      };
      try {
        try { await produce(write); } finally { closed = true; await writes; }
        if (writeError) throw writeError;
        await handle.sync(); await handle.close();
        await rename(temporary, absolute);
      } finally {
        await handle.close();
        await rm(temporary, { force: true });
      }
    }, external);
    return relative;
  }

  private async writeJson(relativePath: string, value: object): Promise<void> {
    // Serialize once so the reserved byte count and persisted bytes are identical.
    await this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async writeText(relativePath: string, contents: string | Uint8Array, scope?: { runId: string }): Promise<void> {
    const normalizedPath = this.validateDestination(relativePath);
    const snapshot = typeof contents === 'string' ? contents : new Uint8Array(contents);
    const runId = this.resolveScope(normalizedPath, scope);
    if (runId) { await this.writeManaged(normalizedPath, runId, write => write(snapshot), !!scope && !this.runIdForPath(normalizedPath)); return; }
    const bytes = typeof snapshot === 'string' ? Buffer.byteLength(snapshot) : snapshot.byteLength;
    const reservation = this.capTracker.reserve(bytes, normalizedPath);
    // Also serialize replacements: atomic writer temp names are time based, and two
    // simultaneous writes to one destination must not share a temporary file.
    const operation = this.writeQueue.then(async () => {
      try { await writeAtomicFile(this.repoRoot, normalizedPath, snapshot); }
      finally {
        // A failed atomic writer may have created a partial temporary file or renamed
        // before failing its stat. Conservatively charge the attempt, including overwrites.
        reservation.commit();
      }
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (sanitized.length === 0) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: 'Checkpoint names must contain at least one safe character.',
      retryable: false,
      details: {
        value,
      },
    });
  }

  assertArtifactIdentifier(sanitized, 'Checkpoint name');
  return sanitized;
}

function assertRunId(runId: string): void {
  assertArtifactIdentifier(runId, 'Run id');
}
