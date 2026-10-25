import path from 'node:path';
import { CaptureScratchRegistry, type CaptureScratchPage } from './capture-scratch.js';
import { createReadStream } from 'node:fs';
import { RunQuota, safeDirectory, safeFile } from './run-quota.js';
import { open, rename, rm } from 'node:fs/promises';
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
    this.runQuota = new RunQuota(this.repoRoot, this.artifactRoot, options.caps?.maxArtifactBytes, options.caps?.maxAccountingDatabaseBytes, options.caps?.maxEventsPerSink, options.caps?.maxOwnershipSlots);
    this.capTracker = new ArtifactCapTracker(
      options.caps?.maxArtifactBytes ?? DEFAULT_STORAGE_CAPS.maxArtifactBytes,
    );
  }

  /** Persist run limits before producers start; later default-configured writers cannot raise them. */
  public async initializeRunPolicy(runId: string, caps?: Partial<StorageCaps>): Promise<void> {
    if (caps) {
      const configured = new ArtifactStore({ repoRoot: this.repoRoot, artifactRoot: this.artifactRoot, caps });
      await configured.initializeRunPolicy(runId);
      return;
    }
    await this.runQuota.transaction(runId, this.getRunPaths(runId).runRoot, async () => undefined);
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
    await this.writeText(relativePath, `${JSON.stringify(manifest, null, 2)}\n`, { runId, requireEventIntegrity: manifest.status === 'completed' });
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

  public async writeArtifact(relativePath: string, contents: string | Uint8Array, scope?: { runId: string; requireEventIntegrity?: boolean }): Promise<string> {
    await this.writeText(relativePath, contents, scope);
    return assertRepositoryRelativePath(relativePath);
  }

  /** Atomically publish incrementally prepared bytes. Preflight known sizes before reading; each write still enforces the cap. Callers own content redaction. */
  public async writeArtifactStream(
    relativePath: string,
    produce: (write: (chunk: string | Uint8Array) => Promise<void>, assertCanWrite: (bytes: number) => void) => Promise<void>,
    scope?: { runId: string },
  ): Promise<string> {
    const normalizedPath = this.validateDestination(relativePath);
    const runId = this.resolveScope(normalizedPath, scope);
    if (runId) return this.writeManaged(normalizedPath, runId, produce, !this.runIdForPath(normalizedPath));
    const absolute = path.resolve(this.repoRoot, normalizedPath);
    const temporary = `${absolute}.tmp-${randomUUID()}`;
    const operation = this.writeQueue.then(async () => {
      await safeDirectory(this.repoRoot, path.posix.dirname(normalizedPath));
      await safeFile(absolute);
      const handle = await open(temporary, 'wx');
      try {
        await produce(async chunk => {
          const reservation = this.capTracker.reserve(typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength, normalizedPath);
          try { await handle.writeFile(chunk); }
          finally { reservation.commit(); }
        }, bytes => this.capTracker.assertCanWrite(bytes, normalizedPath));
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

    if (!relativeDirectory.startsWith(`${runPaths.runRoot}/`) || relativeDirectory.split('/').some(part => ['.probefn-staging', '.probefn-scratch'].includes(part))) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Event directory must remain within its run.', retryable: false });
    return new NdjsonEventSink({
      repoRoot: this.repoRoot,
      relativeDirectory,
      baseName,
      capTracker: this.capTracker,
      appendPersisted: (payload, policy) => this.runQuota.transaction(runId, relativeDirectory,
        quota => quota.append(relativeDirectory, baseName, payload, policy, options?.policy?.maxEventsPerSink !== undefined), false, true),
      policy: { maxEventsPerSink: this.maxEventsPerSink, ...options?.policy },
    });
  }

  /** Recover durably admitted appends; report any event rejected before durable admission. */
  public async recoverEventWrites(runId: string): Promise<{ failed: boolean }> {
    return this.runQuota.transaction(runId, this.getRunPaths(runId).runRoot, async quota => ({ failed: quota.hasEventFailure() }));
  }

  /** Keep native ownership across short registry transactions and the actual producer. */
  public async withTraceScratch<T>(runId: string, destination: string, operation: (scratch: {
    id: string; filename: string; producing(): Promise<void>; seal(): Promise<void>; admitted(): Promise<void>; cleanup(discardSealed?: boolean): Promise<void>;
  }) => Promise<T>): Promise<T> {
    const registry = new CaptureScratchRegistry(this.repoRoot, this.artifactRoot, this.runQuota);
    return registry.owned(runId, async () => {
      const record = await registry.prepare(runId, destination);
      let active = true;
      const pending = new Set<Promise<void>>(), failures: unknown[] = [];
      const invoke = (method: () => Promise<void>): Promise<void> => {
        if (!active) return Promise.reject(createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Capture scratch callback has ended.', retryable: false }));
        const promise = method(); pending.add(promise);
        void promise.then(() => pending.delete(promise), error => { failures.push(error); pending.delete(promise); });
        return promise;
      };
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        const value = await operation({ id: record.id, filename: registry.filename(record),
          producing: () => invoke(async () => { await registry.producing(runId, record.id); }),
          seal: () => invoke(() => registry.seal(runId, record.id)), admitted: () => invoke(() => registry.admitted(runId, record.id)),
          cleanup: (discardSealed = false) => invoke(() => registry.cleanup(runId, record.id, discardSealed)) });
        outcome = { ok: true, value };
      } catch (error) { outcome = { ok: false, error }; }
      finally { active = false; await Promise.allSettled([...pending]); }
      if (!outcome.ok) throw outcome.error;
      if (failures.length) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Capture scratch operation did not complete.', retryable: false, cause: new AggregateError(failures) });
      return outcome.value;
    });
  }
  public async cleanupTraceScratch(runId: string, id: string): Promise<void> {
    const registry = new CaptureScratchRegistry(this.repoRoot, this.artifactRoot, this.runQuota);
    await registry.owned(runId, () => registry.cleanup(runId, id));
  }
  /** Explicitly reconcile sealed output; never overwrite an unrelated destination. */
  public async reconcileTraceScratch(runId: string, id: string): Promise<string> {
    return new CaptureScratchRegistry(this.repoRoot, this.artifactRoot, this.runQuota).reconcile(runId, id);
  }
  /** Acknowledge only after durably persisting the trace receipt in host session state. */
  public async acknowledgeTraceScratch(runId: string, destination: string): Promise<void> {
    await new CaptureScratchRegistry(this.repoRoot, this.artifactRoot, this.runQuota).acknowledge(runId, destination);
  }
  /** Producing generations are quarantined, never reclaimed on PID/age assumptions. */
  public async recoverTraceScratch(runId: string, cursor?: string, limit?: number): Promise<CaptureScratchPage> {
    return new CaptureScratchRegistry(this.repoRoot, this.artifactRoot, this.runQuota).recover(runId, cursor, limit);
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
    const folded = normalized.toLowerCase();
    for (const directory of ['runs', 'session-state']) {
      const prefix = path.posix.join(this.artifactRoot, directory) + '/';
      if (folded.startsWith(prefix.toLowerCase()) && !normalized.startsWith(prefix)) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Managed artifact paths must use configured directory casing.', retryable: false });
    }
    if (folded.split('/').some(segment => segment === '.ownership' || segment === '.probefn-staging' || segment === '.probefn-scratch' || segment.startsWith('.quota.sqlite'))) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Artifact path uses reserved storage metadata.', retryable: false });
    return normalized;
  }

  private runIdForPath(relative: string): string | undefined {
    const prefix = `${path.posix.join(this.artifactRoot, 'runs')}/`;
    if (!relative.startsWith(prefix)) return undefined;
    const [runId, ...rest] = relative.slice(prefix.length).split('/');
    assertArtifactIdentifier(runId!, 'Run id');
    if (rest.some(part => ['.probefn-staging', '.probefn-scratch'].includes(part))) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Artifact path uses the reserved staging directory.', retryable: false });
    if (!rest.length) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Artifact path requires a file within its run.', retryable: false });
    return runId;
  }

  private async writeManaged(relative: string, runId: string,
    produce: (write: (chunk: string | Uint8Array) => Promise<void>, assertCanWrite: (bytes: number) => void) => Promise<void>, external = false, requireEventIntegrity = false): Promise<string> {
    await this.runQuota.transaction(runId, relative, async quota => {
      if (requireEventIntegrity && quota.hasEventFailure()) throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Run has an event write that was not durably admitted; completion is denied.', retryable: false });
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
        try { await produce(write, bytes => quota.assertCanWrite(bytes, relative)); } finally { closed = true; await writes; }
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

  private async writeText(relativePath: string, contents: string | Uint8Array, scope?: { runId: string; requireEventIntegrity?: boolean }): Promise<void> {
    const normalizedPath = this.validateDestination(relativePath);
    const snapshot = typeof contents === 'string' ? contents : new Uint8Array(contents);
    const runId = this.resolveScope(normalizedPath, scope);
    if (runId) { await this.writeManaged(normalizedPath, runId, write => write(snapshot), !!scope && !this.runIdForPath(normalizedPath), scope?.requireEventIntegrity); return; }
    const bytes = typeof snapshot === 'string' ? Buffer.byteLength(snapshot) : snapshot.byteLength;
    const reservation = this.capTracker.reserve(bytes, normalizedPath);
    // Also serialize replacements: atomic writer temp names are time based, and two
    // simultaneous writes to one destination must not share a temporary file.
    const operation = this.writeQueue.then(async () => {
      try {
        await safeDirectory(this.repoRoot, path.posix.dirname(normalizedPath));
        await safeFile(path.resolve(this.repoRoot, normalizedPath));
        await writeAtomicFile(this.repoRoot, normalizedPath, snapshot);
      }
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
