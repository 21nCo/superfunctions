import path from 'node:path';

import { createProbefnError } from '@probefn/contracts/errors';
import type { CheckpointManifest, RunManifest } from '@probefn/contracts/manifests';
import { ArtifactCapTracker, DEFAULT_STORAGE_CAPS, type StorageCaps } from './caps.js';
import { NdjsonEventSink, type EventSinkOptions } from './event-sink.js';
import { assertRepositoryRelativePath, writeAtomicFile, writeJsonManifestAtomic } from './manifest-writer.js';
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
}

export class ArtifactStore {
  private readonly repoRoot: string;
  private readonly artifactRoot: string;
  private readonly capTracker: ArtifactCapTracker;

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
    const normalizedPath = assertRepositoryRelativePath(relativePath);
    const bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
    this.capTracker.assertCanWrite(bytes, normalizedPath);
    const actualBytes = await writeJsonManifestAtomic(this.repoRoot, normalizedPath, value);
    this.capTracker.recordWrite(actualBytes);
  }

  private async writeText(relativePath: string, contents: string | Uint8Array): Promise<void> {
    const normalizedPath = assertRepositoryRelativePath(relativePath);
    const bytes =
      typeof contents === 'string' ? Buffer.byteLength(contents) : contents.byteLength;
    this.capTracker.assertCanWrite(bytes, normalizedPath);
    const actualBytes = await writeAtomicFile(this.repoRoot, normalizedPath, contents);
    this.capTracker.recordWrite(actualBytes);
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

  return sanitized;
}

function assertRunId(runId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: `Run id ${runId} contains unsupported characters.`,
      retryable: false,
      details: {
        runId,
      },
    });
  }
}
