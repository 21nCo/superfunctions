import path from 'node:path';

import type { BrowserContext } from 'playwright';

import { createProbefnError, isProbefnError, ProbefnError } from '@probefn/contracts/errors';
import type { ArtifactStore } from '@probefn/storage';

/** Preserves admitted artifacts and exact scratch ownership when finalization fails. */
export class TraceFinalizationError extends ProbefnError {
  constructor(readonly tracePath: string | null, readonly scratchDirectory: string | null,
    readonly tracingStopped: boolean, readonly failures: unknown[], readonly scratchId: string | null = null) {
    const primary = failures[0];
    super({ code: isProbefnError(primary) ? primary.code : 'E_STORAGE_WRITE_FAILED',
      message: 'Trace finalization did not complete.', retryable: Boolean(tracePath || scratchDirectory),
      details: { ...(isProbefnError(primary) ? primary.details : {}), cleanupPending: Boolean(scratchDirectory), ...(tracePath ? { tracePath } : {}) },
      cause: new AggregateError(failures) });
  }
}

export interface TraceLifecycleOptions {
  repoRoot: string;
  artifactStore: ArtifactStore;
  runId: string;
  enabled: boolean;
  relativeTracePath?: string;
  chunk?: boolean;
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
  return options.artifactStore.withTraceScratch(options.runId, relativeTracePath, async scratch => {
    let admitted: string | null = null;
    let stopped = false;
    let sealed = false;
    const errors: unknown[] = [];
    try {
      await scratch.producing();
      if (options.chunk) await context.tracing.stopChunk({ path: scratch.filename });
      else await context.tracing.stop({ path: scratch.filename });
      stopped = true;
      // Playwright's awaited export has finished writing this exact file.
      await scratch.seal(); sealed = true;
      await options.artifactStore.importArtifactFile(relativeTracePath, scratch.filename);
      admitted = relativeTracePath;
      await scratch.admitted();
    } catch (error) { errors.push(error); }
    let pendingScratch: string | null = path.dirname(scratch.filename);
    // Failed/unknown producer completion cannot authorize deletion.
    if (sealed) {
      try { await scratch.cleanup(admitted === null); pendingScratch = null; }
      catch (error) { errors.push(error); }
    }
    if (!errors.length && options.chunk) {
      try { await context.tracing.startChunk(); stopped = false; }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new TraceFinalizationError(admitted, pendingScratch, stopped, errors, pendingScratch ? scratch.id : null);
    return admitted;
  });
}
