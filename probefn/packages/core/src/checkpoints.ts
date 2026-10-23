import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import { createProbefnError, isProbefnError } from '@probefn/contracts/errors';
import type { CheckpointArtifact, CheckpointManifest } from '@probefn/contracts/manifests';
import { createSuccessEnvelope } from '@probefn/contracts/envelopes';
import { ArtifactStore, ArtifactCapTracker } from '@probefn/storage';

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
  /** Preferred bounded-file path; the consumer must be invoked exactly once. */
  videoCaptureStream?(consume: (video: { byteLength: number; chunks: AsyncIterable<Uint8Array> }) => Promise<void>): Promise<void>;
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
  /** Additional per-checkpoint byte allowance; cannot increase the persisted run cap. */
  artifactCapBytes?: number;
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
  if (options.includeTrace && !options.tracePath) {
    throw createProbefnError({ code: 'E_CHECKPOINT_CAPTURE_FAILED', message: 'A requested trace must be finalized before creating the checkpoint.', retryable: false });
  }
  const now = options.now ?? (() => new Date().toISOString());
  const checkpointId = `chk_${sanitizeCheckpointName(options.name)}`;
  const checkpointPaths = options.artifactStore.getCheckpointPaths(options.runId, options.name);
  const writtenPaths: string[] = [];
  if (options.artifactCapBytes !== undefined && (!Number.isSafeInteger(options.artifactCapBytes) || options.artifactCapBytes < 0)) {
    throw createProbefnError({ code: 'E_CONFIG_INVALID', message: 'Checkpoint artifactCapBytes must be a non-negative safe integer.', retryable: false });
  }
  const budget = options.artifactCapBytes === undefined ? undefined : new ArtifactCapTracker(options.artifactCapBytes);
  const writeArtifact = async (relative: string, contents: string | Uint8Array) => {
    const reservation = budget?.reserve(typeof contents === 'string' ? Buffer.byteLength(contents) : contents.byteLength, relative);
    try { const result = await options.artifactStore.writeArtifact(relative, contents); reservation?.commit(); return result; }
    catch (error) { reservation?.release(); throw error; }
  };

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

    await writeArtifact(checkpointPaths.screenshotPath, screenshot);
    writtenPaths.push(checkpointPaths.screenshotPath);
    await writeArtifact(
      checkpointPaths.domPath,
      `${JSON.stringify(domSnapshot, null, 2)}\n`,
    );
    writtenPaths.push(checkpointPaths.domPath);
    await writeArtifact(
      checkpointPaths.axPath,
      `${JSON.stringify(accessibilitySnapshot, null, 2)}\n`,
    );
    writtenPaths.push(checkpointPaths.axPath);
    await writeArtifact(
      checkpointPaths.layoutPath,
      `${JSON.stringify(layoutSnapshot, null, 2)}\n`,
    );
    writtenPaths.push(checkpointPaths.layoutPath);

    if (stylesSnapshot !== undefined) {
      await writeArtifact(
        checkpointPaths.stylesPath,
        `${JSON.stringify(stylesSnapshot, null, 2)}\n`,
      );
      writtenPaths.push(checkpointPaths.stylesPath);
    }

    if (options.includeVideo) {
      if (options.source.videoCaptureStream) {
        let accepting = true;
        let pending: Promise<void> | undefined;
        let protocolError: Error | undefined;
        const consume: Parameters<NonNullable<CheckpointCaptureSource['videoCaptureStream']>>[0] = video => {
          if (!accepting || pending || !Number.isSafeInteger(video.byteLength) || video.byteLength <= 0) {
            protocolError = new Error('Requested video stream is invalid, duplicate, or late');
            const rejected = Promise.reject<void>(protocolError);
            void rejected.catch(() => undefined);
            return rejected;
          }
          pending = (async () => {
            const reservation = budget?.reserve(video.byteLength, checkpointPaths.videoPath);
            try {
              await options.artifactStore.writeArtifactStream(checkpointPaths.videoPath, async (write, assertCanWrite) => {
                assertCanWrite(video.byteLength);
                let bytes = 0;
                for await (const chunk of video.chunks) {
                  if (!(chunk instanceof Uint8Array) || bytes + chunk.byteLength > video.byteLength) throw new Error('Video changed during capture');
                  await write(chunk); bytes += chunk.byteLength;
                }
                if (bytes !== video.byteLength) throw new Error('Video changed during capture');
              });
              writtenPaths.push(checkpointPaths.videoPath);
              reservation?.commit();
            } catch (error) { reservation?.release(); throw error; }
          })();
          // Retain ownership even if a producer ignores the returned promise.
          void pending.catch(() => undefined);
          return pending;
        };
        try { await options.source.videoCaptureStream(consume); }
        finally { accepting = false; await pending; }
        if (protocolError) throw protocolError;
        if (!pending) throw new Error('Requested video stream was not provided');
      } else {
        if (!options.source.videoCapture) throw new Error('Requested video capture is unavailable');
        const video = await options.source.videoCapture();
        if (!video.byteLength) throw new Error('Requested video capture is empty');
        await writeArtifact(checkpointPaths.videoPath, video);
        writtenPaths.push(checkpointPaths.videoPath);
      }
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
    budget?.assertCanWrite(Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`), checkpointPaths.manifestPath);
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
    if (isProbefnError(error) && error.code === 'E_STORAGE_CAP_EXCEEDED') throw error;
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
  const hash = createHash('sha256');
  if (contents) hash.update(contents);
  else for await (const chunk of createReadStream(path.resolve(repoRoot, relativePath))) hash.update(chunk as Buffer);
  return {
    kind,
    path: relativePath,
    sha256: hash.digest('hex'),
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
