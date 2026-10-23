import { streamPageVideo } from '@probefn/browser-runner';
import { readEventSinkFamily, readEventSinkPage, type EventPageOptions, assertArtifactIdentifier } from '@probefn/storage';
import { createServer, type Server as NetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { z, type ZodType } from 'zod';
import YAML from 'yaml';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  McpFnRegistry,
  createMcpFnServer,
  type McpFnManifest,
  type McpFnObjectSchema,
} from '@mcpfn/core';

import {
  auditDesignBundle,
  extractDesignTokenMap,
  loadCheckpointAuditBundle,
} from '@probefn/analyzers';
import {
  BrowserRunner,
  captureLayoutMetadata,
  captureStylesMetadata,
  performPageAction,
  resolveSemanticTarget,
} from '@probefn/browser-runner';
import {
  createSuccessEnvelope,
  createProbefnError,
  ERROR_CODES,
  loadConfig,
  toErrorEnvelope,
  type RunManifest,
  type CheckpointManifest,
  type BrowserEngine,
  type DeterministicSettings,
  type ErrorEnvelope,
  type JsonObject,
  type JsonValue,
  type SessionMode,
  type ProbefnEnvelope,
} from '@probefn/contracts';
import {
  captureEventDeltaBaseline,
  AuthProfileStore,
  checkpointSuccessEnvelope,
  createCheckpoint,
  diffEventDeltaSummary,
  SessionManager,
  type CreatedCheckpoint,
  type SessionState,
} from '@probefn/core';
import { DevServerManager } from '@probefn/dev-server';
import { ArtifactStore, SessionOwnership, type StorageCaps } from '@probefn/storage';
import { compareBaseline, DEFAULT_BASELINE_ROOT, recordBaseline } from '@probefn/visual-baselines';

import { getBaselineTools } from './tools/baseline.js';
import { getAuthTools } from './tools/auth.js';
import { getCheckpointTools } from './tools/checkpoint.js';
import { getDesignTools } from './tools/design.js';
import { getPageTools } from './tools/page.js';
import { getReportTools } from './tools/report.js';
import { getSessionTools } from './tools/session.js';

const SERVER_VERSION = '0.0.0';
const MCP_SERVER_INFO = {
  name: 'probefn',
  version: SERVER_VERSION,
  instructions: 'Run deterministic browser probes and inspect their regression artifacts.',
};
const FALLBACK_ARTIFACT_ROOT = '.artifacts';

export interface ServeMcpServerOptions {
  repoRoot: string;
  transport: 'stdio' | 'tcp';
  tcpPort?: number;
  signal?: AbortSignal;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResponse {
  content: McpTextContent[];
  structuredContent: ProbefnEnvelope<JsonValue>;
  isError: boolean;
}

export interface ToolContext {
  runtime: ProbefnRuntime;
}

export interface ToolDefinition<TArgs extends JsonObject = JsonObject> {
  name: string;
  description: string;
  inputSchema: JsonObject;
  schema: ZodType<TArgs>;
  execute(args: TArgs, context: ToolContext): Promise<ProbefnEnvelope<JsonValue>>;
}

interface RegisteredSessionScope {
  artifactRoot: string;
}

interface SessionScope {
  artifactRoot: string;
  artifactStore: ArtifactStore;
  sessionManager: SessionManager;
  devServerManager: DevServerManager;
}

interface SessionContext {
  scope: SessionScope;
  session: SessionState;
}

interface PlaybackSessionResult<TValue> {
  value: TValue;
  sinkPaths: {
    consoleSinkPath: string;
    pageErrorSinkPath: string;
    networkSinkPath: string;
  };
  storageStatePath: string;
}

interface FlowStep {
  command: 'page.open' | 'page.act' | 'checkpoint.create' | 'report.export';
  url?: string;
  action?: 'click' | 'fill' | 'select' | 'hover' | 'press';
  query?: string;
  selector?: string;
  value?: string;
  key?: string;
  name?: string;
  includeTrace?: boolean;
  includeStyles?: boolean;
  format?: 'json' | 'markdown';
}

interface FlowDocument {
  version: number;
  steps: FlowStep[];
}

interface FlowPlayback {
  sessionId: string;
  browser: Awaited<ReturnType<BrowserRunner['startSession']>>;
}

// In-flight operations retain this flag without a runtime-global history of closed connections.
export interface RuntimeTransportContext { closed: boolean }

interface RuntimeSessionOwner {
  sessionId: string;
  runId: string;
  artifactRoot: string;
  lease: SessionOwnership;
  transport: RuntimeTransportContext | undefined;
  persistent: boolean;
  operation?: { controller: AbortController; done: Promise<void> };
  closing: boolean;
  browser?: {
    runner: BrowserRunner;
    id: string;
    started: ReturnType<BrowserRunner['startSession']>;
    closed?: Awaited<ReturnType<BrowserRunner['stopSession']>>;
    closing?: Promise<void>;
  };
}

export interface ProbefnRuntimeOptions { cleanupTimeoutMs?: number }

export class ProbefnRuntime {
  private readonly cleanupTimeoutMs: number;
  private readonly transportCleanup = new Map<RuntimeTransportContext, Promise<void>>();

  public async awaitCleanup<T>(task: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([task, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(createProbefnError({ code: 'E_INTERNAL',
          message: 'Cleanup has not settled; ownership remains held until its work finishes.', retryable: true,
          details: { cleanupPending: true, cleanupTimeoutMs: this.cleanupTimeoutMs } })), this.cleanupTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private readonly transportScope = new AsyncLocalStorage<RuntimeTransportContext>();
  private readonly operationScope = new AsyncLocalStorage<RuntimeSessionOwner>();
  private readonly sessionOwners = new Map<string, RuntimeSessionOwner>();

  public operationSignal(): AbortSignal | undefined { return this.requestSignal.getStore(); }

  public withTransport<T>(transport: RuntimeTransportContext, execute: () => Promise<T>): Promise<T> {
    return this.transportScope.run(transport, execute);
  }

  public isSessionOperation(sessionId: string): boolean {
    const owner = this.operationScope.getStore();
    if (owner?.sessionId !== sessionId) return false;
    owner.lease.assertOwned();
    return true;
  }

  public async withSessionOperation<T>(sessionId: string, execute: () => Promise<T>, initial?: { artifactRoot: string; runId: string; maxOwnershipSlots?: number }, resident = false): Promise<T> {
    if (this.isSessionOperation(sessionId)) return execute();
    const transport = this.transportScope.getStore();
    if (transport?.closed) throw new Error('MCP transport is closing.');
    let owner = this.sessionOwners.get(sessionId);
    if (owner && initial && (owner.runId !== initial.runId || owner.artifactRoot !== initial.artifactRoot)) {
      throw createProbefnError({ code: 'E_SESSION_ALREADY_RUNNING', message: 'Owned session identity differs from requested run or artifact root.', retryable: false });
    }
    if (owner && (owner.transport !== transport || owner.operation || owner.closing)) {
      throw createProbefnError({ code: 'E_SESSION_ALREADY_RUNNING', message: 'Another caller owns this session operation.', retryable: true });
    }
    if (!owner) {
      const context = initial ? undefined : await this.resolveSessionContext(sessionId);
      const artifactRoot = initial?.artifactRoot ?? context!.scope.artifactRoot;
      const runId = initial?.runId ?? context!.session.runId;
      const lease = await SessionOwnership.acquire({ repoRoot: this.repoRoot, artifactRoot, sessionId, runId,
        ...(initial?.maxOwnershipSlots !== undefined ? { maxOwnershipSlots: initial.maxOwnershipSlots } : {}) });
      if (transport?.closed) { lease.release(); throw new Error('MCP transport closed during ownership acquisition.'); }
      owner = { sessionId, runId, artifactRoot, lease, transport, persistent: Boolean(transport && (initial || resident)), closing: false };
      this.sessionOwners.set(sessionId, owner);
      if (!initial) {
        try {
          const current = await this.resolveSessionContext(sessionId);
          if (current.session.runId !== runId || current.scope.artifactRoot !== artifactRoot) throw new Error('Session identity changed during ownership acquisition.');
        } catch (error) { lease.release(); this.sessionOwners.delete(sessionId); throw error; }
      }
    }
    owner.lease.assertOwned();
    const controller = new AbortController();
    const parent = this.requestSignal.getStore();
    const abort = () => controller.abort(parent?.reason);
    parent?.addEventListener('abort', abort, { once: true });
    if (parent?.aborted) abort();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    owner.operation = { controller, done };
    try {
      controller.signal.throwIfAborted();
      return await owner.lease.run(() => this.operationScope.run(owner, () => this.requestSignal.run(controller.signal, execute)));
    } finally {
      parent?.removeEventListener('abort', abort);
      delete owner.operation;
      if (!owner.persistent && !owner.browser) { owner.lease.release(); this.sessionOwners.delete(sessionId); }
      finish();
    }
  }

  public async cancelSessionOperation(sessionId: string): Promise<void> {
    const owner = this.sessionOwners.get(sessionId);
    if (!owner || this.isSessionOperation(sessionId)) return;
    if (owner.transport !== this.transportScope.getStore()) throw createProbefnError({ code: 'E_SESSION_ALREADY_RUNNING', message: 'Session belongs to another transport.', retryable: true });
    if (owner.operation) {
      owner.operation.controller.abort(new Error('Session stop requested.'));
      await this.awaitCleanup(owner.operation.done);
    }
  }

  public releaseSessionOwner(sessionId: string): void {
    const owner = this.operationScope.getStore();
    if (owner?.sessionId !== sessionId) throw new Error('Only the active owner can release a session.');
    owner.lease.release();
    this.sessionOwners.delete(sessionId);
  }

  public async closeTransport(transport: RuntimeTransportContext): Promise<void> {
    transport.closed = true;
    let task = this.transportCleanup.get(transport);
    if (!task) {
      const owners = [...this.sessionOwners.values()].filter(owner => owner.transport === transport);
      // Signal every owner first; one stalled cleanup cannot delay another client's session cancellation.
      for (const owner of owners) { owner.closing = true; owner.operation?.controller.abort(new Error('MCP transport closed.')); }
      task = (async () => {
        const results = await Promise.allSettled(owners.map(async owner => {
          await owner.operation?.done;
          if (this.sessionOwners.get(owner.sessionId) !== owner) return;
          try { await owner.lease.run(() => this.operationScope.run(owner, () => stopSession(this, owner.sessionId))); }
          catch (error) {
            if (toErrorEnvelope(error).error.code !== 'E_SESSION_NOT_FOUND') throw error;
            await owner.lease.run(() => this.createScope(owner.artifactRoot).devServerManager.stopSession(owner.sessionId)).catch(error => {
              if (toErrorEnvelope(error).error.code !== 'E_SESSION_NOT_FOUND') throw error;
            });
            owner.lease.release(); this.sessionOwners.delete(owner.sessionId);
          }
        }));
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown);
        if (errors.length) throw new AggregateError(errors, 'MCP session cleanup failed.');
      })();
      this.transportCleanup.set(transport, task);
      void task.then(() => this.transportCleanup.delete(transport), () => this.transportCleanup.delete(transport));
    }
    await this.awaitCleanup(task);
  }

  private traceDestination(scope: SessionScope, runId: string): string {
    return path.posix.join(path.posix.dirname(scope.artifactStore.getRunPaths(runId).tracePath), `browser-${randomUUID()}.trace.zip`);
  }

  private async recordTrace(sessionId: string, tracePath: string): Promise<void> {
    const owner = this.operationScope.getStore();
    owner?.lease.assertOwned();
    const { scope, session } = await this.resolveSessionContext(sessionId);
    const patch = { artifacts: {
      tracePath, tracePaths: [...new Set([...(session.artifacts.tracePaths ?? []), ...(session.artifacts.tracePath ? [session.artifacts.tracePath] : []), tracePath])],
    } };
    if (session.status === 'failed') await scope.sessionManager.markFailed(sessionId, patch);
    else if (session.status === 'completed') await scope.sessionManager.markCompleted(sessionId, patch);
    else await scope.sessionManager.markRunning(sessionId, patch);
  }

  public async flushSessionTrace(sessionId: string): Promise<string | null> {
    const owner = this.operationScope.getStore();
    const transient = this.playbackScope.getStore();
    owner?.lease.assertOwned();
    let trace: string;
    if (owner?.sessionId === sessionId && owner.browser) {
      const scope = this.createScope(owner.artifactRoot);
      await owner.browser.started;
      trace = await owner.browser.runner.flushTrace(owner.browser.id, this.traceDestination(scope, owner.runId));
    } else if (transient?.sessionId === sessionId) {
      trace = await transient.runner.flushTrace(transient.id, this.traceDestination(transient.scope, transient.runId));
    } else return null;
    await this.recordTrace(sessionId, trace);
    return trace;
  }

  public hasActiveFlow(sessionId: string): boolean { return this.activeFlows.has(sessionId); }

  public async closeSessionBrowser(sessionId: string, saveTrace = true): Promise<void> {
    const owner = this.operationScope.getStore();
    if (owner?.sessionId !== sessionId || !owner.browser) return;
    const browser = owner.browser;
    browser.closing ??= (async () => {
      try {
        browser.closed ??= await browser.runner.stopSession(browser.id, { saveTrace });
        if (browser.closed.tracePath) await this.recordTrace(sessionId, browser.closed.tracePath);
        delete owner.browser;
      } catch (error) {
        if (!browser.runner.hasSession(browser.id) && !browser.closed) delete owner.browser;
        if (!browser.runner.hasSession(browser.id) && !browser.closed && error && typeof error === 'object' && 'code' in error && error.code === 'E_SESSION_NOT_FOUND') {
          delete owner.browser;
          return;
        }
        throw error;
      }
    })();
    try { await browser.closing; }
    finally { delete browser.closing; }
  }

  private async withResidentPlayback<T>(session: SessionState, execute: (input: {
    page: Awaited<ReturnType<BrowserRunner['startSession']>>['page'];
    sinkPaths: Awaited<ReturnType<BrowserRunner['startSession']>>['sinkPaths'];
    flushEvents: () => Promise<void>;
  }) => Promise<T>, options: { flow?: boolean; signal?: AbortSignal; video?: boolean }, storageStatePath?: string): Promise<PlaybackSessionResult<T>> {
    const owner = this.operationScope.getStore()!;
    if (options.video) throw createProbefnError({ code: 'E_CONFIG_INVALID', message: 'Video finalization closes its page; use an explicit ephemeral CLI capture instead of a resident session.', retryable: false });
    const scope = this.createScope(owner.artifactRoot);
    if (session.status === 'completed' || session.status === 'failed') throw createProbefnError({ code: 'E_SESSION_NOT_FOUND', message: 'Browser session has already ended.', retryable: false });
    const signal = options.signal ?? this.requestSignal.getStore();
    signal?.throwIfAborted();
    if (!owner.browser) {
      const runner = new BrowserRunner({ repoRoot: this.repoRoot, artifactStore: scope.artifactStore, now: this.now });
      const id = `${session.sessionId}__resident__${randomUUID()}`;
      const started = runner.startSession({ sessionId: id, runId: session.runId, browser: session.browser,
        deterministic: session.deterministic, initialUrl: session.resolvedUrl!, ...(storageStatePath ? { storageStatePath } : {}),
        trace: { enabled: true, relativeTracePath: this.traceDestination(scope, session.runId) } });
      owner.browser = { runner, id, started };
    }
    const browser = owner.browser;
    const abort = () => { void owner.lease.run(() => this.operationScope.run(owner, () => this.closeSessionBrowser(session.sessionId))).catch(() => undefined); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let executionError: unknown;
    try {
      const started = await browser.started;
      signal?.throwIfAborted();
      const invoke = () => execute({ page: started.page, sinkPaths: started.sinkPaths, flushEvents: () => started.eventCapture.flush() });
      const value = await (options.flow ? this.flowPlayback.run({ sessionId: session.sessionId, browser: started }, invoke) : invoke());
      signal?.throwIfAborted();
      const auth = new AuthProfileStore({ repoRoot: this.repoRoot, artifactStore: scope.artifactStore });
      return { value, sinkPaths: started.sinkPaths, storageStatePath: await auth.writeSessionStorageState({ runId: session.runId, storageState: await started.page.context().storageState() }) };
    } catch (error) { executionError = error; throw error; }
    finally {
      signal?.removeEventListener('abort', abort);
      try {
        if (signal?.aborted) {
          await this.closeSessionBrowser(session.sessionId);
          await scope.sessionManager.markFailed(session.sessionId);
        } else if (owner.browser) await this.flushSessionTrace(session.sessionId);
      } catch (cleanupError) {
        try { await this.closeSessionBrowser(session.sessionId, false); }
        catch (closeError) { throw new AggregateError([executionError, cleanupError, closeError].filter(Boolean), 'Resident playback cleanup failed.'); }
        await scope.sessionManager.markFailed(session.sessionId);
        if (executionError) throw new AggregateError([executionError, cleanupError], 'Resident playback and trace finalization failed.');
        throw cleanupError;
      }
    }
  }

  private readonly playbackScope = new AsyncLocalStorage<{ sessionId: string; runId: string; runner: BrowserRunner; id: string; scope: SessionScope }>();
  private readonly playbackOwners = new Set<string>();
  private readonly flowPlayback = new AsyncLocalStorage<FlowPlayback>();
  private readonly requestSignal = new AsyncLocalStorage<AbortSignal>();
  private readonly activeFlows = new Map<string, { controller: AbortController; done: Promise<void>; cleanupError?: unknown }>();

  public async cancelFlow(sessionId: string): Promise<void> {
    const active = this.activeFlows.get(sessionId);
    if (active) {
      active.controller.abort(new Error('Flow cancelled by session stop.'));
      await active.done;
      if (active.cleanupError) throw active.cleanupError;
    }
  }

  public isInFlow(sessionId: string): boolean {
    return this.flowPlayback.getStore()?.sessionId === sessionId;
  }

  public async withFlow<T>(session: SessionState, execute: () => Promise<T>, finalize: () => Promise<void>): Promise<T> {
    if (this.activeFlows.has(session.sessionId)) {
      throw createProbefnError({ code: 'E_SESSION_ALREADY_RUNNING', message: 'A flow already owns this session.', retryable: true });
    }
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const parent = this.requestSignal.getStore();
    const abort = () => controller.abort(parent?.reason);
    parent?.addEventListener('abort', abort, { once: true });
    if (parent?.aborted) abort();
    this.activeFlows.set(session.sessionId, { controller, done });
    try {
      controller.signal.throwIfAborted();
      const result = await this.withPlaybackSession(session, execute, { flow: true, signal: controller.signal });
      controller.signal.throwIfAborted();
      await finalize();
      controller.signal.throwIfAborted();
      return result.value;
    } finally {
      parent?.removeEventListener('abort', abort);
      this.activeFlows.delete(session.sessionId);
      finish();
    }
  }
  private readonly repoRoot: string;
  private readonly now: () => string;
  private readonly devServerManagers = new Map<string, DevServerManager>();
  private readonly sessionScopes = new Map<string, RegisteredSessionScope>();

  public constructor(repoRoot: string, now: () => string = () => new Date().toISOString(), options: ProbefnRuntimeOptions = {}) {
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 300000) throw new TypeError('cleanupTimeoutMs must be an integer from 1 through 300000.');
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.repoRoot = repoRoot;
    this.now = now;
  }

  public listTools(): ToolDefinition[] {
    return [
      ...getSessionTools(),
      ...getAuthTools(),
      ...getPageTools(),
      ...getCheckpointTools(),
      ...getDesignTools(),
      ...getBaselineTools(),
      ...getReportTools(),
    ];
  }

  public async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResponse> {
    if (signal) return this.requestSignal.run(signal, () => this.callTool(name, args));
    const tool = this.listTools().find((candidate) => candidate.name === name);
    if (!tool) {
      return this.toToolResult(
        toErrorEnvelope(
          createProbefnError({
            code: 'E_INTERNAL',
            message: `Unknown tool ${name}.`,
            retryable: false,
          }),
        ),
      );
    }

    try {
      const parsedArgs = parseToolArgs(tool.schema, args);
      const envelope = await tool.execute(parsedArgs, {
        runtime: this,
      });
      return this.toToolResult(envelope);
    } catch (error) {
      return this.toToolResult(toErrorEnvelope(error));
    }
  }

  public getRepoRoot(): string {
    return this.repoRoot;
  }

  public nowIso(): string {
    return this.now();
  }

  public rememberSession(sessionId: string, artifactRoot: string): void {
    this.sessionScopes.set(sessionId, {
      artifactRoot,
    });
  }

  public createScope(artifactRoot = FALLBACK_ARTIFACT_ROOT, caps?: Partial<StorageCaps>): SessionScope {
    const normalizedArtifactRoot = artifactRoot || FALLBACK_ARTIFACT_ROOT;
    const artifactStore = new ArtifactStore({
      repoRoot: this.repoRoot,
      artifactRoot: normalizedArtifactRoot,
      ...(caps ? { caps } : {}),
    });
    const sessionManager = new SessionManager({
      repoRoot: this.repoRoot,
      artifactStore,
      now: this.now,
    });
    let devServerManager = this.devServerManagers.get(normalizedArtifactRoot);
    if (!devServerManager) {
      devServerManager = new DevServerManager({
        repoRoot: this.repoRoot,
        artifactStore: new ArtifactStore({ repoRoot: this.repoRoot, artifactRoot: normalizedArtifactRoot }),
        now: this.now,
      });
      this.devServerManagers.set(normalizedArtifactRoot, devServerManager);
    }

    return {
      artifactRoot: normalizedArtifactRoot,
      artifactStore,
      sessionManager,
      devServerManager,
    };
  }

  public async resolveSessionContext(sessionId: string): Promise<SessionContext> {
    const rememberedScope = this.sessionScopes.get(sessionId);
    const candidateArtifactRoots = rememberedScope
      ? [rememberedScope.artifactRoot, FALLBACK_ARTIFACT_ROOT]
      : [FALLBACK_ARTIFACT_ROOT];

    for (const artifactRoot of candidateArtifactRoots) {
      const scope = this.createScope(artifactRoot);
      try {
        const session = await scope.sessionManager.read(sessionId);
        this.rememberSession(sessionId, artifactRoot);
        return {
          scope,
          session,
        };
      } catch (error) {
        const envelope = toErrorEnvelope(error);
        if (!envelope.ok && envelope.error.code === 'E_SESSION_NOT_FOUND') {
          continue;
        }

        throw error;
      }
    }

    throw createProbefnError({
      code: 'E_SESSION_NOT_FOUND',
      message: `Session ${sessionId} was not found.`,
      retryable: false,
      details: {
        sessionId,
      },
    });
  }

  public async readEventPage(relativePath: string | undefined, options: EventPageOptions = {}) {
    if (!relativePath) {
      if (options.cursor) throw createProbefnError({ code: 'E_MCP_INVALID_ARGS', message: 'No sink exists for this cursor.', retryable: false });
      return { events: [], provenance: [], nextCursor: null };
    }
    try { return await readEventSinkPage(this.repoRoot, relativePath, options); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message: 'Requested event sink does not exist.', retryable: false });
      throw error;
    }
  }

  public async readEventSink(relativePath: string | undefined): Promise<Array<Record<string, JsonValue>>> {
    if (!relativePath) {
      return [];
    }

    try {
      return (await readEventSinkFamily(this.repoRoot, relativePath)).map(record => record.payload as Record<string, JsonValue>);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        throw createProbefnError({
          code: 'E_STORAGE_WRITE_FAILED',
          message: 'Requested event sink does not exist.',
          retryable: false,
          details: {
            path: relativePath,
          },
        });
      }

      throw error;
    }
  }

  public async withPlaybackSession<TValue>(
    session: SessionState,
    execute: (input: {
      page: Awaited<ReturnType<BrowserRunner['startSession']>>['page'];
      sinkPaths: Awaited<ReturnType<BrowserRunner['startSession']>>['sinkPaths'];
      flushEvents: () => Promise<void>;
    }) => Promise<TValue>,
    options: { video?: boolean; flow?: boolean; signal?: AbortSignal } = {},
  ): Promise<PlaybackSessionResult<TValue>> {
    if (this.isInFlow(session.sessionId)) return this.executePlaybackSession(session, execute, options);
    if (this.playbackOwners.has(session.sessionId)) {
      throw createProbefnError({ code: 'E_SESSION_ALREADY_RUNNING', message: 'A playback operation already owns this session.', retryable: true });
    }
    this.playbackOwners.add(session.sessionId);
    try { return await this.executePlaybackSession(session, execute, options); }
    finally { this.playbackOwners.delete(session.sessionId); }
  }

  private async executePlaybackSession<TValue>(
    session: SessionState,
    execute: (input: {
      page: Awaited<ReturnType<BrowserRunner['startSession']>>['page'];
      sinkPaths: Awaited<ReturnType<BrowserRunner['startSession']>>['sinkPaths'];
      flushEvents: () => Promise<void>;
    }) => Promise<TValue>,
    options: { video?: boolean; flow?: boolean; signal?: AbortSignal } = {},
  ): Promise<PlaybackSessionResult<TValue>> {
    if (!session.resolvedUrl) {
      throw createProbefnError({
        code: 'E_INTERNAL',
        message: `Session ${session.sessionId} does not have a resolvedUrl.`,
        retryable: false,
        details: {
          sessionId: session.sessionId,
        },
      });
    }

    const scope = this.createScope(this.sessionScopes.get(session.sessionId)?.artifactRoot ?? FALLBACK_ARTIFACT_ROOT);
    const authProfileStore = new AuthProfileStore({
      repoRoot: this.repoRoot,
      artifactStore: scope.artifactStore,
    });
    const existingStorageStatePath =
      await authProfileStore.hasStorageStatePath(session.artifacts.storageStatePath)
        ? session.artifacts.storageStatePath
        : undefined;
    const currentFlow = this.flowPlayback.getStore();
    if (currentFlow?.sessionId === session.sessionId) {
      const browser = currentFlow.browser;
      const value = await execute({ page: browser.page, sinkPaths: browser.sinkPaths, flushEvents: () => browser.eventCapture.flush() });
      return { value, sinkPaths: browser.sinkPaths, storageStatePath: await authProfileStore.writeSessionStorageState({
        runId: session.runId, storageState: await browser.page.context().storageState(),
      }) };
    }
    if (this.operationScope.getStore()?.persistent) {
      return this.withResidentPlayback(session, execute, options, existingStorageStatePath);
    }
    if (this.activeFlows.has(session.sessionId) && !options.flow) {
      throw createProbefnError({ code: 'E_SESSION_ALREADY_RUNNING', message: 'A flow owns this session.', retryable: true });
    }
    const browserRunner = new BrowserRunner({
      repoRoot: this.repoRoot,
      artifactStore: scope.artifactStore,
      now: this.now,
    });
    const playbackSessionId = `${session.sessionId}__mcp__${randomUUID()}`;
    options = { ...options, ...(options.signal ?? this.requestSignal.getStore() ? { signal: options.signal ?? this.requestSignal.getStore()! } : {}) };
    options.signal?.throwIfAborted();
    const playbackOwner = this.operationScope.getStore();
    if (playbackOwner?.browser) throw createProbefnError({ code: 'E_SESSION_ALREADY_RUNNING', message: 'Browser cleanup is pending; retry session.stop before another playback.', retryable: true });
    const startingBrowser = browserRunner.startSession({
      sessionId: playbackSessionId,
      runId: session.runId,
      browser: session.browser,
      deterministic: session.deterministic,
      ...(existingStorageStatePath ? { storageStatePath: existingStorageStatePath } : {}),
      initialUrl: session.resolvedUrl,
      ...(options.video ? { video: { enabled: true } } : {}),
      trace: {
        enabled: true,
        relativeTracePath: this.traceDestination(scope, session.runId),
      },
    });

    if (playbackOwner) playbackOwner.browser = { runner: browserRunner, id: playbackSessionId, started: startingBrowser };
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      if (playbackOwner) await playbackOwner.lease.run(() => this.operationScope.run(playbackOwner, () => this.closeSessionBrowser(session.sessionId)));
      else {
        const closed = await browserRunner.stopSession(playbackSessionId);
        if (closed.tracePath) await this.recordTrace(session.sessionId, closed.tracePath);
      }
    })();
    const abort = () => { void close().catch(() => undefined); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let executionError: unknown;
    try {
      const startedBrowser = await startingBrowser;
      options.signal?.throwIfAborted();
      const invoke = () => execute({
        page: startedBrowser.page,
        sinkPaths: startedBrowser.sinkPaths,
        flushEvents: () => startedBrowser.eventCapture.flush(),
      });
      const value = await this.playbackScope.run({ sessionId: session.sessionId, runId: session.runId, runner: browserRunner, id: playbackSessionId, scope }, () => options.flow
        ? this.flowPlayback.run({ sessionId: session.sessionId, browser: startedBrowser }, invoke)
        : invoke());
      return {
        value,
        sinkPaths: startedBrowser.sinkPaths,
        storageStatePath: await authProfileStore.writeSessionStorageState({
          runId: session.runId,
          storageState: await startedBrowser.page.context().storageState(),
        }),
      };
    } catch (error) {
      executionError = error;
      throw error;
    } finally {
      try {
        // Join startup, including failures that retained scratch ownership, before releasing the native owner.
        await (closing ?? startingBrowser.then(close, async () => {
          if (browserRunner.hasSession(playbackSessionId)) await close();
          else if (playbackOwner) delete playbackOwner.browser;
        }));
      }
      catch (cleanupError) {
        const active = this.activeFlows.get(session.sessionId);
        if (active && options.flow) active.cleanupError = cleanupError;
        if (executionError) throw new AggregateError([executionError, cleanupError], 'Playback and browser cleanup failed');
        throw cleanupError;
      } finally { options.signal?.removeEventListener('abort', abort); }
    }
  }

  public toToolResult(envelope: ProbefnEnvelope<JsonValue>): McpToolResponse {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(envelope, null, 2),
        },
      ],
      structuredContent: envelope,
      isError: !envelope.ok,
    };
  }
}

export async function serveMcpServer(options: ServeMcpServerOptions): Promise<void> {
  const runtime = new ProbefnRuntime(options.repoRoot);
  const server = new ProbefnMcpServer(runtime);
  const toolNames = server.listTools().map((tool) => tool.name);

  if (options.transport === 'stdio') {
    process.stderr.write(`probefn mcp stdio ready: ${toolNames.join(', ')}\n`);
    await server.serveTransport(new StdioServerTransport(), options.signal);
    return;
  }

  const port = options.tcpPort ?? 7007;
  const netServer = await new Promise<NetServer>((resolve, reject) => {
    const listeningServer = createServer((socket) => {
      const transport = createStreamTransport(socket, socket);
      void server.serveTransport(transport, options.signal);
    });
    listeningServer.once('error', reject);
    listeningServer.listen(port, '127.0.0.1', () => resolve(listeningServer));
  });
  const address = netServer.address() as AddressInfo;
  process.stderr.write(
    `probefn mcp tcp ready on 127.0.0.1:${address.port}: ${toolNames.join(', ')}\n`,
  );

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      netServer.close(() => resolve());
    };
    if (options.signal) {
      if (options.signal.aborted) {
        cleanup();
      } else {
        options.signal.addEventListener('abort', cleanup, { once: true });
        netServer.once('close', () => options.signal?.removeEventListener('abort', cleanup));
      }
    }
  });
}

export class ProbefnMcpServer {
  private readonly runtime: ProbefnRuntime;
  private readonly tools: ToolDefinition[];
  readonly registry: McpFnRegistry;

  public constructor(runtime: ProbefnRuntime) {
    this.runtime = runtime;
    this.tools = runtime.listTools();
    this.registry = this.createRegistry();
  }

  private createRegistry(transport?: RuntimeTransportContext): McpFnRegistry {
    const registry = new McpFnRegistry();
    for (const tool of this.tools) {
      registry.register({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as unknown as McpFnObjectSchema,
        annotations: { openWorldHint: false },
        metadata: { 'mcpfn/source': 'probefn' },
        handler: async (args, _context, extra) => {
          const execute = () => this.runtime.callTool(tool.name, args, extra.signal);
          return await (transport ? this.runtime.withTransport(transport, execute) : execute()) as unknown as CallToolResult;
        },
        handleInvalidArguments: async (args) =>
          await this.runtime.callTool(tool.name, args) as unknown as CallToolResult,
      });
    }
    return registry;
  }

  public listTools(): ToolDefinition[] {
    return [...this.tools];
  }

  public async serveTransport(
    transport: Transport,
    signal?: AbortSignal,
  ): Promise<void> {
    const owner: RuntimeTransportContext = { closed: false };
    const server = createMcpFnServer({
      info: MCP_SERVER_INFO,
      registry: this.createRegistry(owner),
      transports: ['stdio'],
    });
    await server.connect(transport);

    let abortCleanup: (() => void) | undefined;
    try { await new Promise<void>((resolve) => {
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        if (signal && abortCleanup) {
          signal.removeEventListener('abort', abortCleanup);
        }
        resolve();
      };

      const protocolClose = transport.onclose;
      transport.onclose = () => {
        protocolClose?.();
        finish();
      };

      abortCleanup = () => {
        void server.close().finally(finish);
      };
      if (signal) {
        if (signal.aborted) {
          abortCleanup();
          return;
        }
        signal.addEventListener('abort', abortCleanup, { once: true });
      }
    }); } finally { await this.runtime.closeTransport(owner); }
  }

  public manifest(): McpFnManifest {
    return createMcpFnServer({
      info: MCP_SERVER_INFO,
      registry: this.registry,
      transports: ['stdio'],
    }).manifest();
  }
}

export function defineTool<TArgs extends JsonObject>(
  tool: ToolDefinition<TArgs>,
): ToolDefinition<TArgs> {
  return tool;
}

export function jsonToolSchema(input: {
  required?: string[];
  properties: JsonObject;
}): JsonObject {
  return {
    type: 'object',
    properties: input.properties,
    additionalProperties: false,
    ...(input.required && input.required.length > 0 ? { required: input.required } : {}),
  };
}

export { strictObjectSchema } from './schema.js';

export function parseToolArgs<TArgs extends JsonObject>(
  schema: ZodType<TArgs>,
  input: unknown,
): TArgs {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) {
    return parsed.data;
  }

  const firstIssue = parsed.error.issues[0];
  const issuePath = firstIssue?.path.join('.') ?? '';
  const message =
    firstIssue?.code === 'invalid_type' &&
    firstIssue.received === 'undefined' &&
    issuePath.length > 0
      ? `Missing required field ${issuePath}.`
      : firstIssue?.message ?? 'Invalid MCP tool arguments.';

  throw createProbefnError({
    code: 'E_MCP_INVALID_ARGS',
    message,
    retryable: false,
    details: {
      issues: firstIssue
        ? [
            {
              path: firstIssue.path.join('.'),
              message: firstIssue.message,
            },
          ]
        : [],
    },
  });
}

export async function startSessionFromConfig(
  runtime: ProbefnRuntime,
  input: {
    configPath: string;
    mode?: SessionMode;
    browser?: BrowserEngine;
    devServerName?: string;
    url?: string;
    authProfileId?: string;
    sessionId?: string;
    runId?: string;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  if (input.sessionId !== undefined) assertArtifactIdentifier(input.sessionId, 'Session id');
  if (input.runId !== undefined) assertArtifactIdentifier(input.runId, 'Run id');
  const config = await loadConfig(input.configPath, {
    cwd: runtime.getRepoRoot(),
  });
  const artifactRoot = config.artifactRoot;
  const derivedSuffix = deriveSessionSuffix(config.projectName);
  const sessionId = input.sessionId ?? (derivedSuffix ? `sess_${derivedSuffix}` : `sess_${Date.now()}`);
  const runId = input.runId ?? (derivedSuffix ? `run_${derivedSuffix}` : `run_${Date.now()}`);
  assertArtifactIdentifier(sessionId, 'Session id');
  assertArtifactIdentifier(runId, 'Run id');
  if (!runtime.isSessionOperation(sessionId)) {
    return runtime.withSessionOperation(sessionId, () => startSessionFromConfig(runtime, { ...input, sessionId, runId }), {
      artifactRoot, runId, ...(config.storageCaps?.maxOwnershipSlots !== undefined ? { maxOwnershipSlots: config.storageCaps.maxOwnershipSlots } : {}),
    });
  }
  const storageCaps: Partial<StorageCaps> = {
    ...(config.storageCaps?.maxOwnershipSlots !== undefined ? { maxOwnershipSlots: config.storageCaps.maxOwnershipSlots } : {}),
    ...(config.storageCaps?.maxArtifactBytes !== undefined ? { maxArtifactBytes: config.storageCaps.maxArtifactBytes } : {}),
    ...(config.storageCaps?.maxEventsPerSink !== undefined ? { maxEventsPerSink: config.storageCaps.maxEventsPerSink } : {}),
    ...(config.storageCaps?.maxAccountingDatabaseBytes !== undefined ? { maxAccountingDatabaseBytes: config.storageCaps.maxAccountingDatabaseBytes } : {}),
  };
  const scope = runtime.createScope(artifactRoot, storageCaps);
  const priorBytes = await readFile(path.resolve(runtime.getRepoRoot(), scope.sessionManager.getStatePath(sessionId)), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (priorBytes) {
    const prior = JSON.parse(priorBytes) as SessionState;
    if (prior.status === 'running' || prior.status === 'starting') throw createProbefnError({ code: 'E_SESSION_ALREADY_RUNNING', message: 'Session already has an active persisted run.', retryable: false });
  }
  const mode = input.mode ?? config.defaultMode;
  const browser = input.browser ?? config.defaultBrowser;
  const authProfileStore = new AuthProfileStore({
    repoRoot: runtime.getRepoRoot(),
    artifactStore: scope.artifactStore,
  });
  const storageStatePath = input.authProfileId
    ? (
        await authProfileStore.initializeSessionStorageFromProfile({
          profileId: input.authProfileId,
          runId,
        })
      ).storageStatePath
    : undefined;

  const selectedDevServer =
    input.url
      ? {
          mode: 'attach' as const,
          name: input.devServerName ?? 'adhoc',
          url: input.url,
          timeoutMs: 120000,
          envAllowlist: [],
        }
      : input.devServerName
        ? config.devServers[input.devServerName]
        : Object.values(config.devServers)[0];

  if (!selectedDevServer) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'No dev server found in probefn config.',
      retryable: false,
    });
  }

  const signal = runtime.operationSignal();
  signal?.throwIfAborted();
  const startingSession = scope.devServerManager.startSession({
    sessionId,
    runId,
    mode,
    browser,
    deterministic: config.deterministicDefaults,
    devServer: selectedDevServer,
    storageCaps,
  });
  let stopping: Promise<unknown> | undefined;
  const cancelStart = () => { stopping ??= scope.devServerManager.stopSession(sessionId); void stopping.catch(() => undefined); };
  signal?.addEventListener('abort', cancelStart, { once: true });
  if (signal?.aborted) cancelStart();
  let startedSession: Awaited<typeof startingSession>;
  try { startedSession = await startingSession; signal?.throwIfAborted(); }
  finally {
    signal?.removeEventListener('abort', cancelStart);
    if (stopping) await stopping.catch(error => { if (toErrorEnvelope(error).error.code !== 'E_SESSION_NOT_FOUND') throw error; });
  }
  await scope.sessionManager.initialize({
    sessionId,
    runId,
    mode,
    browser,
    deterministic: config.deterministicDefaults,
    artifactRoot: startedSession.artifactRoot,
    startedAt: startedSession.startedAt,
    manifestPath: startedSession.manifestPath,
    resolvedUrl: startedSession.resolvedUrl,
    artifacts: {
      ...(storageStatePath ? { storageStatePath } : {}),
      ...(startedSession.stdoutSinkPath
        ? { devServerStdoutSinkPath: startedSession.stdoutSinkPath }
        : {}),
      ...(startedSession.stderrSinkPath
        ? { devServerStderrSinkPath: startedSession.stderrSinkPath }
        : {}),
    },
  });
  await scope.sessionManager.markRunning(sessionId, {
    resolvedUrl: startedSession.resolvedUrl,
    artifacts: {
      ...(storageStatePath ? { storageStatePath } : {}),
      ...(startedSession.stdoutSinkPath
        ? { devServerStdoutSinkPath: startedSession.stdoutSinkPath }
        : {}),
      ...(startedSession.stderrSinkPath
        ? { devServerStderrSinkPath: startedSession.stderrSinkPath }
        : {}),
    },
  });
  runtime.rememberSession(sessionId, artifactRoot);

  return createSuccessEnvelope({
    sessionId,
    runId,
    artifactRoot: startedSession.artifactRoot,
    startedAt: startedSession.startedAt,
    resolvedUrl: startedSession.resolvedUrl,
    deterministic: config.deterministicDefaults,
  });
}

export async function stopSession(
  runtime: ProbefnRuntime,
  sessionId: string,
): Promise<ProbefnEnvelope<JsonValue>> {
  if (!runtime.isSessionOperation(sessionId)) {
    return runtime.awaitCleanup((async () => {
      await runtime.cancelSessionOperation(sessionId);
      return runtime.withSessionOperation(sessionId, () => stopSession(runtime, sessionId));
    })());
  }
  await runtime.cancelFlow(sessionId);
  await runtime.closeSessionBrowser(sessionId);
  const { scope, session } = await runtime.resolveSessionContext(sessionId);
  try {
    await scope.devServerManager.stopSession(sessionId);
  } catch (error) {
    const envelope = toErrorEnvelope(error);
    if (!envelope.ok && envelope.error.code === 'E_SESSION_NOT_FOUND') {
      await stopPersistedSpawnedDevServer(runtime, scope, session);
    } else if (!envelope.ok) {
      throw error;
    }
  }

  const nextState =
    session.status === 'completed' || session.status === 'failed'
      ? session
      : await scope.sessionManager.markCompleted(sessionId);

  const manifest = JSON.parse(await readFile(path.resolve(runtime.getRepoRoot(), nextState.artifacts.manifestPath), 'utf8')) as RunManifest;
  await scope.artifactStore.writeRunManifest(nextState.runId, { ...manifest,
    status: nextState.status === 'failed' ? 'failed' : 'completed', ...(nextState.endedAt ? { endedAt: nextState.endedAt } : {}) });
  runtime.releaseSessionOwner(sessionId);
  return createSuccessEnvelope({
    sessionId: nextState.sessionId,
    status: nextState.status,
    endedAt: nextState.endedAt ?? null,
  });
}

export async function openPage(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    url: string;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  if (!runtime.isSessionOperation(input.sessionId)) return runtime.withSessionOperation(input.sessionId, () => openPage(runtime, input), undefined, true);
  const { scope, session } = await runtime.resolveSessionContext(input.sessionId);
  const targetUrl = session.resolvedUrl
    ? new URL(input.url, session.resolvedUrl).toString()
    : new URL(input.url).toString();

  const playback = await runtime.withPlaybackSession(session, async ({ page }) => {
    await page.goto(targetUrl, {
      waitUntil: 'load',
    });
    if (session.deterministic.enabled) {
      await page.waitForTimeout(session.deterministic.networkIdleMs);
    }

    return page.url();
  });

  await scope.sessionManager.markRunning(session.sessionId, {
    resolvedUrl: playback.value,
    artifacts: {
      ...playback.sinkPaths,
      storageStatePath: playback.storageStatePath,
    },
  });

  return createSuccessEnvelope({
    sessionId: session.sessionId,
    resolvedUrl: playback.value,
  });
}

export async function findPageElement(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    query: string;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  if (!runtime.isSessionOperation(input.sessionId)) return runtime.withSessionOperation(input.sessionId, () => findPageElement(runtime, input), undefined, true);
  const { session } = await runtime.resolveSessionContext(input.sessionId);
  const playback = await runtime.withPlaybackSession(session, async ({ page }) =>
    resolveSemanticTarget(page, input.query),
  );

  return createSuccessEnvelope({
    elements: [
      {
        elementId: playback.value.element.elementId,
        role: playback.value.element.role,
        name: playback.value.element.name,
        text: playback.value.element.text,
        bounds: playback.value.element.bounds as unknown as JsonValue,
        selectorHints: playback.value.element.selectorHints as unknown as JsonValue,
      },
    ],
  });
}

export async function actOnPage(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    action: 'click' | 'fill' | 'select' | 'hover' | 'press';
    query?: string;
    selector?: string;
    value?: string;
    key?: string;
    requireDomConfirmation?: boolean;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  if (!runtime.isSessionOperation(input.sessionId)) return runtime.withSessionOperation(input.sessionId, () => actOnPage(runtime, input), undefined, true);
  const { scope, session } = await runtime.resolveSessionContext(input.sessionId);
  const playback = await runtime.withPlaybackSession(session, async ({ page, sinkPaths, flushEvents }) =>
    performPageAction({
      flushEvents,
      networkIdleMs: session.deterministic.networkIdleMs,
      settleTimeoutMs: Math.max(5000, session.deterministic.networkIdleMs + 1000),
      repoRoot: runtime.getRepoRoot(),
      page,
      action: {
        kind: input.action,
        target: {
          ...(input.query
            ? {
                query: input.query,
                requireDomConfirmation: input.requireDomConfirmation ?? true,
              }
            : {}),
          ...(input.selector ? { selector: input.selector } : {}),
        },
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.key !== undefined ? { key: input.key } : {}),
      },
      eventPaths: sinkPaths,
    }),
  );

  await scope.sessionManager.markRunning(session.sessionId, {
    artifacts: {
      ...playback.sinkPaths,
      storageStatePath: playback.storageStatePath,
    },
  });

  return createSuccessEnvelope(playback.value as unknown as JsonValue);
}

export async function createCheckpointFromSession(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    name: string;
    artifactCapBytes?: number;
    includeTrace?: boolean;
    includeStyles?: boolean;
    includeVideo?: boolean;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  if (!runtime.isSessionOperation(input.sessionId)) return runtime.withSessionOperation(input.sessionId, () => createCheckpointFromSession(runtime, input), undefined, true);
  const { scope, session } = await runtime.resolveSessionContext(input.sessionId);
  const checkpoint = await runtime.withPlaybackSession(session, async ({ page, sinkPaths }) => {
    const tracePath = input.includeTrace && !runtime.isInFlow(session.sessionId)
      ? await runtime.flushSessionTrace(session.sessionId) ?? session.artifacts.tracePath ?? null
      : session.artifacts.tracePath ?? null;
    const before = await captureEventDeltaBaseline(runtime.getRepoRoot(), sinkPaths);
    const createdCheckpoint = await createCheckpoint({
      repoRoot: runtime.getRepoRoot(),
      artifactStore: scope.artifactStore,
      sessionId: session.sessionId,
      runId: session.runId,
      browser: session.browser,
      name: input.name,
      ...(input.artifactCapBytes !== undefined ? { artifactCapBytes: input.artifactCapBytes } : {}),
      ...(input.includeVideo ? { includeVideo: true } : {}),
      ...(input.includeTrace !== undefined ? { includeTrace: input.includeTrace && !runtime.isInFlow(session.sessionId) } : {}),
      ...(input.includeStyles !== undefined ? { includeStyles: input.includeStyles } : {}),
      tracePath,
      delta: diffEventDeltaSummary(
        before,
        await captureEventDeltaBaseline(runtime.getRepoRoot(), sinkPaths),
      ),
      source: {
        ...(input.includeVideo ? { videoCaptureStream: (consume) => streamPageVideo(page, consume) } : {}),
        url: () => page.url(),
        viewportSize: () => page.viewportSize() ?? { width: 0, height: 0 },
        screenshot: async () => page.screenshot({ fullPage: true }),
        domSnapshot: async () => ({ html: await page.content() }),
        accessibilitySnapshot: async () => ({
          snapshot: await page.locator('body').ariaSnapshot({ mode: 'ai' } as never),
        }),
        layoutSnapshot: async () => captureLayoutMetadata(page),
        ...(input.includeStyles
          ? { stylesSnapshot: async () => captureStylesMetadata(page) }
          : {}),
      },
    });
    return createdCheckpoint;
  }, { video: input.includeVideo ?? false });

  await scope.sessionManager.markRunning(session.sessionId, {
    artifacts: {
      ...checkpoint.sinkPaths,
      storageStatePath: checkpoint.storageStatePath,
    },
  });

  return checkpointSuccessEnvelope(checkpoint.value as CreatedCheckpoint) as ProbefnEnvelope<JsonValue>;
}

export async function getConsoleEvents(runtime: ProbefnRuntime, sessionId: string, options: EventPageOptions = {}): Promise<ProbefnEnvelope<JsonValue>> {
  const { session } = await runtime.resolveSessionContext(sessionId);
  return createSuccessEnvelope(await runtime.readEventPage(session.artifacts.consoleSinkPath, options) as unknown as JsonValue);
}

export async function getNetworkEvents(runtime: ProbefnRuntime, sessionId: string, options: EventPageOptions = {}): Promise<ProbefnEnvelope<JsonValue>> {
  const { session } = await runtime.resolveSessionContext(sessionId);
  return createSuccessEnvelope(await runtime.readEventPage(session.artifacts.networkSinkPath, options) as unknown as JsonValue);
}

export async function getPageErrors(runtime: ProbefnRuntime, sessionId: string, options: EventPageOptions = {}): Promise<ProbefnEnvelope<JsonValue>> {
  const { session } = await runtime.resolveSessionContext(sessionId);
  return createSuccessEnvelope(await runtime.readEventPage(session.artifacts.pageErrorSinkPath, options) as unknown as JsonValue);
}

export async function getLayoutReport(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    checkpointId: string;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  const { session } = await runtime.resolveSessionContext(input.sessionId);
  const bundle = await loadCheckpointAuditBundle({
    repoRoot: runtime.getRepoRoot(),
    artifactRoot: session.artifactRoot,
    checkpointId: input.checkpointId,
  });

  return createSuccessEnvelope({
    checkpointId: bundle.checkpointId,
    checkpointPath: bundle.checkpointPath,
    layoutPath: bundle.layoutPath,
    viewport: bundle.viewport as unknown as JsonValue,
    layout: bundle.layout as unknown as JsonValue,
  });
}

export async function auditDesign(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    checkpointId: string;
    configPath?: string;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  const { session } = await runtime.resolveSessionContext(input.sessionId);
  const bundle = await loadCheckpointAuditBundle({
    repoRoot: runtime.getRepoRoot(),
    artifactRoot: session.artifactRoot,
    checkpointId: input.checkpointId,
  });

  let tokenMap;
  if (input.configPath) {
    const config = await loadConfig(input.configPath, {
      cwd: runtime.getRepoRoot(),
    });
    tokenMap = extractDesignTokenMap(config.analyzers);
  }

  const result = auditDesignBundle(bundle, {
    ...(tokenMap ? { tokenMap } : {}),
    warnOnMissingTokenMap: false,
  });
  return createSuccessEnvelope({
    findings: result.findings as unknown as JsonValue,
  }, result.warnings);
}

export async function recordVisualBaseline(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    checkpointId: string;
    key: string;
    configPath?: string;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  if (!runtime.isSessionOperation(input.sessionId)) return runtime.withSessionOperation(input.sessionId, () => recordVisualBaseline(runtime, input));
  const { session } = await runtime.resolveSessionContext(input.sessionId);
  const baselineRoot = input.configPath
    ? (await loadConfig(input.configPath, { cwd: runtime.getRepoRoot() })).baselineRoot
    : DEFAULT_BASELINE_ROOT;
  const result = await recordBaseline({
    repoRoot: runtime.getRepoRoot(),
    artifactRoot: session.artifactRoot,
    baselineRoot,
    checkpointId: input.checkpointId,
    baselineKey: input.key,
    sessionId: session.sessionId,
    runId: session.runId,
    deterministic: session.deterministic,
  });

  return createSuccessEnvelope({
    baselineKey: result.baselineKey,
    registryPath: result.registryPath,
    sourceCheckpointId: result.sourceCheckpointId,
  }, result.warnings);
}

export async function compareVisualBaseline(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    checkpointId: string;
    key: string;
    configPath?: string;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  if (!runtime.isSessionOperation(input.sessionId)) return runtime.withSessionOperation(input.sessionId, () => compareVisualBaseline(runtime, input));
  const { session } = await runtime.resolveSessionContext(input.sessionId);
  const baselineRoot = input.configPath
    ? (await loadConfig(input.configPath, { cwd: runtime.getRepoRoot() })).baselineRoot
    : DEFAULT_BASELINE_ROOT;
  const result = await compareBaseline({
    repoRoot: runtime.getRepoRoot(),
    artifactRoot: session.artifactRoot,
    baselineRoot,
    checkpointId: input.checkpointId,
    baselineKey: input.key,
    runId: session.runId,
  });

  return createSuccessEnvelope({
    baselineKey: result.baselineKey,
    status: result.status,
    pixelDiffPercent: result.pixelDiffPercent,
    findings: result.findings as unknown as JsonValue,
  });
}

export async function saveAuthProfile(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    profileId: string;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  if (!runtime.isSessionOperation(input.sessionId)) return runtime.withSessionOperation(input.sessionId, () => saveAuthProfile(runtime, input));
  const { scope, session } = await runtime.resolveSessionContext(input.sessionId);
  const authProfileStore = new AuthProfileStore({
    repoRoot: runtime.getRepoRoot(),
    artifactStore: scope.artifactStore,
  });

  let sourceStorageStatePath = session.artifacts.storageStatePath;
  if (!(await authProfileStore.hasStorageStatePath(sourceStorageStatePath))) {
    const playback = await runtime.withPlaybackSession(session, async () => null);
    sourceStorageStatePath = playback.storageStatePath;
    await scope.sessionManager.markRunning(session.sessionId, {
      artifacts: {
        ...playback.sinkPaths,
        storageStatePath: playback.storageStatePath,
      },
    });
  }

  const savedProfile = await authProfileStore.saveProfileFromPath({
    profileId: input.profileId,
    sourceStorageStatePath: sourceStorageStatePath!,
  });
  return createSuccessEnvelope({
    profileId: savedProfile.profileId,
    storageStatePath: savedProfile.storageStatePath,
  });
}

export async function exportSessionReport(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    format: 'json' | 'markdown';
    artifactOnly?: boolean;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  if (!runtime.isSessionOperation(input.sessionId)) return runtime.withSessionOperation(input.sessionId, () => exportSessionReport(runtime, input));
  if (!runtime.hasActiveFlow(input.sessionId)) await runtime.flushSessionTrace(input.sessionId);
  const { scope } = await runtime.resolveSessionContext(input.sessionId);
  if (input.artifactOnly) {
    const exported = await scope.sessionManager.exportReportArtifact({ sessionId: input.sessionId, format: input.format });
    return createSuccessEnvelope({ reportPath: exported.reportPath, tracePath: exported.tracePath, includes: exported.includes as unknown as JsonValue }, exported.warnings);
  }
  const exportedReport = await scope.sessionManager.exportReport({
    sessionId: input.sessionId,
    format: input.format,
  });

  return createSuccessEnvelope({
    reportPath: exportedReport.reportPath,
    tracePath: exportedReport.tracePath,
    includes: exportedReport.includes as unknown as JsonValue,
    ...(input.format === 'json'
      ? {
          runMetadata: exportedReport.reportData.runMetadata as unknown as JsonValue,
          checkpointIndex: exportedReport.reportData.checkpointIndex as unknown as JsonValue,
          eventIndex: exportedReport.reportData.eventIndex as unknown as JsonValue,
          findings: exportedReport.reportData.findings as unknown as JsonValue,
          regressions: exportedReport.reportData.regressions as unknown as JsonValue,
          hypotheses: exportedReport.reportData.hypotheses as unknown as JsonValue,
          ...(exportedReport.reportData.unresolvedReason
            ? {
                unresolvedReason: exportedReport.reportData.unresolvedReason,
              }
            : {}),
          artifactReferences: exportedReport.reportData.artifactReferences as unknown as JsonValue,
        }
      : {}),
  }, exportedReport.warnings);
}

function deriveSessionSuffix(projectName: string | undefined): string | null {
  if (!projectName) {
    return null;
  }

  const normalized = projectName
    .trim()
    .replace(/^vite[-_]/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  return normalized.length > 0 ? normalized : null;
}

async function stopPersistedSpawnedDevServer(
  repoRoot: string | ProbefnRuntime,
  scope: SessionScope,
  session: SessionState,
): Promise<boolean> {
  const root = typeof repoRoot === 'string' ? repoRoot : repoRoot.getRepoRoot();
  const manifest = await readRunManifest(root, session.artifacts.manifestPath);
  const pid = manifest.devServer?.pid;

  if (manifest.devServer?.mode !== 'spawn' || typeof pid !== 'number') {
    return false;
  }

  const target = process.platform === 'win32' ? pid : -pid;
  try {
    process.kill(target, 'SIGTERM');
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error
        ? (error as { code?: string }).code
        : undefined;
    if (code !== 'ESRCH') {
      throw error;
    }
  }

  await finalizeRunManifest(root, scope, session, manifest.status === 'failed' ? 'failed' : 'completed');
  return true;
}

async function finalizeRunManifest(
  repoRoot: string,
  scope: SessionScope,
  session: SessionState,
  status: 'completed' | 'failed',
): Promise<void> {
  const manifest = await readRunManifest(repoRoot, session.artifacts.manifestPath);
  manifest.status = status;
  manifest.endedAt = new Date().toISOString();
  await scope.artifactStore.writeRunManifest(session.runId, manifest);
}

async function readRunManifest(repoRoot: string, manifestPath: string): Promise<RunManifest> {
  return JSON.parse(
    await readFile(path.resolve(repoRoot, manifestPath), 'utf8'),
  ) as RunManifest;
}

export async function runFlow(
  runtime: ProbefnRuntime,
  input: {
    sessionId: string;
    file: string;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  if (!runtime.isSessionOperation(input.sessionId)) return runtime.withSessionOperation(input.sessionId, () => runFlow(runtime, input), undefined, true);
  const flow = await loadFlow(runtime.getRepoRoot(), input.file);
  const executedSteps: string[] = [];
  let lastCheckpointId: string | null = null;
  let lastReportPath: string | null = null;
  let redactedValues = 0;

  const initial = await runtime.resolveSessionContext(input.sessionId);
  await runtime.withFlow(initial.session, async () => {
    for (const step of flow.steps) {
      switch (step.command) {
        case 'page.open':
          if (!step.url) {
            throw createProbefnError({
              code: 'E_CONFIG_INVALID',
              message: 'Flow step page.open requires a url.',
              retryable: false,
            });
          }
          await openPage(runtime, {
            sessionId: input.sessionId,
            url: step.url,
          });
          executedSteps.push(step.command);
          break;
        case 'page.act': {
          if (!step.action || (!step.query && !step.selector)) {
            throw createProbefnError({
              code: 'E_CONFIG_INVALID',
              message: 'Flow step page.act requires action and query or selector.',
              retryable: false,
            });
          }
          await actOnPage(runtime, {
            sessionId: input.sessionId,
            action: step.action,
            ...(step.query ? { query: step.query } : {}),
            ...(step.selector ? { selector: step.selector } : {}),
            ...(step.value !== undefined ? { value: step.value } : {}),
            ...(step.key !== undefined ? { key: step.key } : {}),
          });
          executedSteps.push(step.command);
          break;
        }
        case 'checkpoint.create': {
          if (!step.name) {
            throw createProbefnError({
              code: 'E_CONFIG_INVALID',
              message: 'Flow step checkpoint.create requires a name.',
              retryable: false,
            });
          }
          const checkpointEnvelope = await createCheckpointFromSession(runtime, {
            sessionId: input.sessionId,
            name: step.name,
            ...(step.includeTrace ? { includeTrace: true } : {}),
            ...(step.includeStyles ? { includeStyles: true } : {}),
          });
          const checkpointData = expectSuccess(checkpointEnvelope).data as {
            checkpointId: string;
          };
          lastCheckpointId = checkpointData.checkpointId;
          executedSteps.push(step.command);
          break;
        }
        case 'report.export': {
          // Export after browser close so the report references its finalized trace.
          executedSteps.push(step.command);
          break;
        }
        default:
          throw createProbefnError({
            code: 'E_CONFIG_INVALID',
            message: `Unsupported flow step ${(step as { command?: string }).command ?? '<none>'}.`,
            retryable: false,
          });
      }
    }

  }, async () => {
    const { scope, session } = await runtime.resolveSessionContext(input.sessionId);
    const tracePath = session.artifacts.tracePath;
    if (!tracePath) throw createProbefnError({ code: 'E_CHECKPOINT_CAPTURE_FAILED', message: 'Flow trace was not finalized.', retryable: true });
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.resolve(runtime.getRepoRoot(), tracePath))) hash.update(chunk);
    const traceHash = hash.digest('hex');
    for (const step of flow.steps) {
      if (step.command === 'checkpoint.create' && step.includeTrace && step.name) {
        const manifestPath = scope.artifactStore.getCheckpointPaths(session.runId, step.name).manifestPath;
        const manifest = JSON.parse(await readFile(path.resolve(runtime.getRepoRoot(), manifestPath), 'utf8')) as CheckpointManifest;
        manifest.artifacts = [...manifest.artifacts.filter(artifact => artifact.kind !== 'trace'), { kind: 'trace', path: tracePath, sha256: traceHash }];
        await scope.artifactStore.writeCheckpointManifest(session.runId, step.name, manifest);
      }
    }
    // Reports are run summaries: finalize them only after the replay artifact exists.
    for (const step of flow.steps.filter(step => step.command === 'report.export')) {
      const format = step.format ?? 'json';
      const report = expectSuccess(await exportSessionReport(runtime, { sessionId: input.sessionId, format })).data as { reportPath: string };
      lastReportPath = report.reportPath;
      redactedValues = countRedactedPlaceholders(await readFile(path.resolve(runtime.getRepoRoot(), report.reportPath), 'utf8'));
    }
  });
  const { session } = await runtime.resolveSessionContext(input.sessionId);
  return createSuccessEnvelope({
    file: input.file,
    steps: executedSteps,
    checkpointId: lastCheckpointId,
    reportPath: lastReportPath,
    redactedValues,
    consoleSink: session.artifacts.consoleSinkPath ?? null,
    pageErrorSink: session.artifacts.pageErrorSinkPath ?? null,
    networkSink: session.artifacts.networkSinkPath ?? null,
    devServerStdoutSink: session.artifacts.devServerStdoutSinkPath ?? null,
    devServerStderrSink: session.artifacts.devServerStderrSinkPath ?? null,
  });
}

async function loadFlow(repoRoot: string, file: string): Promise<FlowDocument> {
  if (path.isAbsolute(file) || file.startsWith('..')) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'Flow files must use repository-relative paths.',
      retryable: false,
    });
  }

  const normalizedFile = path.normalize(file);
  const absolutePath = path.resolve(repoRoot, normalizedFile);
  const relativeToRoot = path.relative(repoRoot, absolutePath);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'Flow files must stay within the repository root.',
      retryable: false,
    });
  }
  const parsed = YAML.parse(await readFile(absolutePath, 'utf8')) as FlowDocument;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.steps)) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'Flow file must contain version: 1 and a steps array.',
      retryable: false,
    });
  }

  return parsed;
}

function expectSuccess(envelope: ProbefnEnvelope<JsonValue>) {
  if (!envelope.ok) {
    throw createProbefnError({
      code: envelope.error.code as never,
      message: envelope.error.message,
      retryable: envelope.error.retryable,
      ...(envelope.error.details ? { details: envelope.error.details } : {}),
    });
  }

  return envelope;
}

function countRedactedPlaceholders(value: string): number {
  return value.match(/\[REDACTED\]/g)?.length ?? 0;
}

export const errorCodeEnum = z.enum(ERROR_CODES);

function createStreamTransport(
  input: Readable,
  output: Writable,
): Transport {
  let buffer = Buffer.alloc(0);
  let started = false;
  let closed = false;

  const onData = (chunk: Buffer | string) => {
    buffer = Buffer.concat([
      buffer,
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
    ]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = Buffer.alloc(0);
        transport.onerror?.(new Error('MCP TCP frame is missing Content-Length.'));
        return;
      }

      const contentLength = Number.parseInt(lengthMatch[1] ?? '0', 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) {
        return;
      }

      const body = buffer.subarray(bodyStart, bodyStart + contentLength);
      buffer = buffer.subarray(bodyStart + contentLength);
      try {
        const message = JSON.parse(body.toString('utf8')) as JSONRPCMessage;
        transport.onmessage?.(message);
      } catch (error) {
        transport.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  const onError = (error: Error) => transport.onerror?.(error);
  const onClose = () => {
    if (closed) return;
    closed = true;
    transport.onclose?.();
  };

  const transport: Transport = {
    async start(): Promise<void> {
      if (started) throw new Error('MCP TCP transport is already started.');
      started = true;
      input.on('data', onData);
      input.on('error', onError);
      input.on('end', onClose);
      input.on('close', onClose);
    },
    async close(): Promise<void> {
      input.off('data', onData);
      input.off('error', onError);
      input.off('end', onClose);
      input.off('close', onClose);
      if (!input.destroyed) input.destroy();
      if (!output.destroyed) output.end();
      onClose();
    },
    async send(message: JSONRPCMessage): Promise<void> {
      const payload = Buffer.from(JSON.stringify(message), 'utf8');
      const header = Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, 'utf8');
      await new Promise<void>((resolve, reject) => {
        output.write(Buffer.concat([header, payload]), (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
  return transport;
}
