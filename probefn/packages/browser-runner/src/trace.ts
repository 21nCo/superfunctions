import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { BrowserContext } from 'playwright';

import { createProbefnError, isProbefnError, ProbefnError } from '@probefn/contracts/errors';
import type { ArtifactStore } from '@probefn/storage';

/** Preserves admitted artifacts and exact scratch ownership when finalization fails. */
export class TraceFinalizationError extends ProbefnError {
  constructor(readonly tracePath: string | null, readonly scratchDirectory: string | null,
    readonly tracingStopped: boolean, readonly failures: unknown[]) {
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
  const scratch = await mkdtemp(path.join(tmpdir(), 'probefn-trace-'));
  let admitted: string | null = null;
  let stopped = false;
  const errors: unknown[] = [];
  try {
    const filename = path.join(scratch, 'trace.zip');
    if (options.chunk) await context.tracing.stopChunk({ path: filename });
    else await context.tracing.stop({ path: filename });
    stopped = true;
    await options.artifactStore.importArtifactFile(relativeTracePath, filename);
    admitted = relativeTracePath;
  } catch (error) { errors.push(error); }
  let pendingScratch: string | null = null;
  try { await rm(scratch, { recursive: true, force: true }); }
  catch (error) { pendingScratch = scratch; errors.push(error); }
  if (!errors.length && options.chunk) {
    try { await context.tracing.startChunk(); stopped = false; }
    catch (error) { errors.push(error); }
  }
  if (errors.length) {
    throw new TraceFinalizationError(admitted, pendingScratch, stopped, errors);
  }
  return admitted;
}
