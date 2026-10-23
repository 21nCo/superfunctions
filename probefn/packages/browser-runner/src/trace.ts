import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { BrowserContext } from 'playwright';

import { createProbefnError } from '@probefn/contracts/errors';
import type { ArtifactStore } from '@probefn/storage';

export interface TraceLifecycleOptions {
  repoRoot: string;
  artifactStore: ArtifactStore;
  runId: string;
  enabled: boolean;
  relativeTracePath?: string;
}

export async function startTracing(
  context: BrowserContext,
  options: TraceLifecycleOptions,
): Promise<boolean> {
  if (!options.enabled) {
    return false;
  }

  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  return true;
}

export async function stopTracing(
  context: BrowserContext,
  options: TraceLifecycleOptions,
): Promise<string | null> {
  if (!options.enabled) {
    return null;
  }

  const relativeTracePath = options.relativeTracePath ?? options.artifactStore.getRunPaths(options.runId).tracePath;
  const runDirectory = path.posix.dirname(options.artifactStore.getRunPaths(options.runId).tracePath);
  if (path.posix.normalize(relativeTracePath) !== relativeTracePath || !relativeTracePath.startsWith(`${runDirectory}/`)) {
    throw createProbefnError({ code: 'E_CONFIG_INVALID', message: 'Trace path must remain inside its owning run.', retryable: false });
  }
  const scratch = await mkdtemp(path.join(tmpdir(), 'probefn-trace-'));
  try {
    const filename = path.join(scratch, 'trace.zip');
    await context.tracing.stop({ path: filename });
    await options.artifactStore.importArtifactFile(relativeTracePath, filename);
    return relativeTracePath;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
