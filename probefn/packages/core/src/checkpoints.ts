import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createProbefnError } from '@probefn/contracts/errors';
import type { CheckpointArtifact, CheckpointManifest } from '@probefn/contracts/manifests';
import { createSuccessEnvelope } from '@probefn/contracts/envelopes';
import { ArtifactStore } from '@probefn/storage';

import type { EventDeltaSummary } from './deltas.js';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface CheckpointCaptureSource {
  url(): string;
  viewportSize(): ViewportSize;
  screenshot(): Promise<Uint8Array>;
  domSnapshot(): Promise<unknown>;
  accessibilitySnapshot(): Promise<unknown>;
  layoutSnapshot(): Promise<unknown>;
  stylesSnapshot?(): Promise<unknown>;
  videoCapture?(): Promise<Uint8Array>;
}

export interface CreateCheckpointOptions {
  repoRoot: string;
  artifactStore: ArtifactStore;
  sessionId: string;
  runId: string;
  browser: 'chromium' | 'firefox' | 'webkit';
  name: string;
  source: CheckpointCaptureSource;
  delta: EventDeltaSummary;
  includeStyles?: boolean;
  includeVideo?: boolean;
  includeTrace?: boolean;
  unstable?: boolean;
  tracePath?: string | null;
  now?: () => string;
}

export interface CreatedCheckpoint {
  checkpointId: string;
  manifestPath: string;
  artifacts: string[];
  analyzerWarnings: string[];
  newConsoleErrors: number;
  newPageErrors: number;
  newNetworkFailures: number;
}

export async function createCheckpoint(
  options: CreateCheckpointOptions,
): Promise<CreatedCheckpoint> {
  const now = options.now ?? (() => new Date().toISOString());
  const checkpointId = `chk_${sanitizeCheckpointName(options.name)}`;
  const checkpointPaths = options.artifactStore.getCheckpointPaths(options.runId, options.name);
  const writtenPaths: string[] = [];

  try {
    const url = options.source.url();
    const viewport = options.source.viewportSize();
    const screenshot = await options.source.screenshot();
    const domSnapshot = await options.source.domSnapshot();
    const accessibilitySnapshot = await options.source.accessibilitySnapshot();
    const layoutSnapshot = await options.source.layoutSnapshot();
    const stylesSnapshot =
      options.includeStyles && options.source.stylesSnapshot
        ? await options.source.stylesSnapshot()
        : undefined;

    await options.artifactStore.writeArtifact(checkpointPaths.screenshotPath, screenshot);
    writtenPaths.push(checkpointPaths.screenshotPath);
    await options.artifactStore.writeArtifact(
      checkpointPaths.domPath,
      `${JSON.stringify(domSnapshot, null, 2)}\n`,
    );
    writtenPaths.push(checkpointPaths.domPath);
    await options.artifactStore.writeArtifact(
      checkpointPaths.axPath,
      `${JSON.stringify(accessibilitySnapshot, null, 2)}\n`,
    );
    writtenPaths.push(checkpointPaths.axPath);
    await options.artifactStore.writeArtifact(
      checkpointPaths.layoutPath,
      `${JSON.stringify(layoutSnapshot, null, 2)}\n`,
    );
    writtenPaths.push(checkpointPaths.layoutPath);

    if (stylesSnapshot !== undefined) {
      await options.artifactStore.writeArtifact(
        checkpointPaths.stylesPath,
        `${JSON.stringify(stylesSnapshot, null, 2)}\n`,
      );
      writtenPaths.push(checkpointPaths.stylesPath);
    }

    if (options.includeVideo) {
      if (!options.source.videoCapture) throw new Error('Requested video capture is unavailable');
      const video = await options.source.videoCapture();
      if (!video.byteLength) throw new Error('Requested video capture is empty');
      await options.artifactStore.writeArtifact(checkpointPaths.videoPath, video);
      writtenPaths.push(checkpointPaths.videoPath);
    }

    const artifacts: CheckpointArtifact[] = [
      await buildArtifactRecord(options.repoRoot, checkpointPaths.screenshotPath, 'screenshot', screenshot),
      await buildArtifactRecord(options.repoRoot, checkpointPaths.domPath, 'dom'),
      await buildArtifactRecord(options.repoRoot, checkpointPaths.axPath, 'ax'),
      await buildArtifactRecord(options.repoRoot, checkpointPaths.layoutPath, 'layout'),
    ];

    if (stylesSnapshot !== undefined) {
      artifacts.push(await buildArtifactRecord(options.repoRoot, checkpointPaths.stylesPath, 'styles'));
    }

    if (options.includeVideo) artifacts.push(await buildArtifactRecord(options.repoRoot, checkpointPaths.videoPath, 'video'));

    if (options.includeTrace && options.tracePath) {
      artifacts.push(await buildArtifactRecord(options.repoRoot, options.tracePath, 'trace'));
    }

    const manifest: CheckpointManifest = {
      schemaVersion: '1.0',
      checkpointId,
      sessionId: options.sessionId,
      runId: options.runId,
      browser: options.browser,
      name: options.name,
      url,
      viewport,
      ...(options.unstable ? { unstable: true } : {}),
      artifacts,
      createdAt: now(),
    };
    const manifestPath = await options.artifactStore.writeCheckpointManifest(
      options.runId,
      options.name,
      manifest,
    );

    return {
      checkpointId,
      manifestPath,
      artifacts: artifacts.map((artifact) => artifact.path),
      analyzerWarnings: [],
      newConsoleErrors: options.delta.newConsoleErrors,
      newPageErrors: options.delta.newPageErrors,
      newNetworkFailures: options.delta.newNetworkFailures,
    };
  } catch (error) {
    await cleanupArtifacts(options.artifactStore, writtenPaths);
    throw createProbefnError({
      code: 'E_CHECKPOINT_CAPTURE_FAILED',
      message: 'Required checkpoint artifacts could not be captured.',
      retryable: true,
      cause: error,
    });
  }
}

export function checkpointSuccessEnvelope(result: CreatedCheckpoint) {
  return createSuccessEnvelope({
    checkpointId: result.checkpointId,
    artifacts: result.artifacts,
    newConsoleErrors: result.newConsoleErrors,
    newPageErrors: result.newPageErrors,
    newNetworkFailures: result.newNetworkFailures,
    analyzerWarnings: result.analyzerWarnings,
  });
}

async function buildArtifactRecord(
  repoRoot: string,
  relativePath: string,
  kind: CheckpointArtifact['kind'],
  contents?: Uint8Array,
): Promise<CheckpointArtifact> {
  const payload = contents ?? await readFile(path.resolve(repoRoot, relativePath));
  return {
    kind,
    path: relativePath,
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
}

async function cleanupArtifacts(store: ArtifactStore, relativePaths: string[]): Promise<void> {
  await Promise.all(relativePaths.map(relativePath => store.deleteArtifact(relativePath)));
}

function sanitizeCheckpointName(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
