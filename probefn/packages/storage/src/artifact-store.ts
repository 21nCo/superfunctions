import path from 'node:path';
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
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: ArtifactStoreOptions) {
    this.repoRoot = options.repoRoot;
    this.artifactRoot = assertRepositoryRelativePath(options.artifactRoot ?? '.artifacts');
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

  public async writeArtifact(relativePath: string, contents: string | Uint8Array): Promise<string> {
    await this.writeText(relativePath, contents);
    return assertRepositoryRelativePath(relativePath);
  }

  /** Atomically publish incrementally prepared bytes. Callers own content redaction. */
  public async writeArtifactStream(
    relativePath: string,
    produce: (write: (chunk: string) => Promise<void>) => Promise<void>,
  ): Promise<string> {
    const normalizedPath = assertRepositoryRelativePath(relativePath);
    const absolute = path.resolve(this.repoRoot, normalizedPath);
    const temporary = `${absolute}.tmp-${randomUUID()}`;
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(absolute), { recursive: true });
      const handle = await open(temporary, 'wx');
      try {
        await produce(async chunk => {
          const reservation = this.capTracker.reserve(Buffer.byteLength(chunk), normalizedPath);
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

    return new NdjsonEventSink({
      repoRoot: this.repoRoot,
      relativeDirectory,
      baseName,
      capTracker: this.capTracker,
      ...(options?.policy ? { policy: options.policy } : {}),
    });
  }

  private async writeJson(relativePath: string, value: object): Promise<void> {
    // Serialize once so the reserved byte count and persisted bytes are identical.
    await this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async writeText(relativePath: string, contents: string | Uint8Array): Promise<void> {
    const normalizedPath = assertRepositoryRelativePath(relativePath);
    const snapshot = typeof contents === 'string' ? contents : new Uint8Array(contents);
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
