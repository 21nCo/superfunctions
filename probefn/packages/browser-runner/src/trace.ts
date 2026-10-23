import path from 'node:path';

import type { BrowserContext } from 'playwright';

import type { ArtifactStore } from '@probefn/storage';

export interface TraceLifecycleOptions {
  repoRoot: string;
  artifactStore: ArtifactStore;
  runId: string;
  enabled: boolean;
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

  const relativeTracePath = options.artifactStore.getRunPaths(options.runId).tracePath;
  await context.tracing.stop({
    path: path.resolve(options.repoRoot, relativeTracePath),
  });
  return relativeTracePath;
}
