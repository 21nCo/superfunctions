import { finalizePageVideo } from '@probefn/browser-runner';
import { readEventSinkFamily } from '@probefn/storage';
import { createServer, type Server as NetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
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
import { ArtifactStore } from '@probefn/storage';
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

export class ProbefnRuntime {
  private readonly repoRoot: string;
  private readonly now: () => string;
  private readonly devServerManagers = new Map<string, DevServerManager>();
  private readonly sessionScopes = new Map<string, RegisteredSessionScope>();

  public constructor(repoRoot: string, now: () => string = () => new Date().toISOString()) {
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

  public async callTool(name: string, args: unknown): Promise<McpToolResponse> {
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

  public createScope(artifactRoot = FALLBACK_ARTIFACT_ROOT): SessionScope {
    const normalizedArtifactRoot = artifactRoot || FALLBACK_ARTIFACT_ROOT;
    const artifactStore = new ArtifactStore({
      repoRoot: this.repoRoot,
      artifactRoot: normalizedArtifactRoot,
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
        artifactStore,
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
    options: { video?: boolean } = {},
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
    const browserRunner = new BrowserRunner({
      repoRoot: this.repoRoot,
      artifactStore: scope.artifactStore,
      now: this.now,
    });
    const playbackSessionId = `${session.sessionId}__mcp__${Date.now()}`;
    const startedBrowser = await browserRunner.startSession({
      sessionId: playbackSessionId,
      runId: session.runId,
      browser: session.browser,
      deterministic: session.deterministic,
      ...(existingStorageStatePath ? { storageStatePath: existingStorageStatePath } : {}),
      initialUrl: session.resolvedUrl,
      ...(options.video ? { video: { enabled: true } } : {}),
      trace: {
        enabled: false,
      },
    });

    let executionError: unknown;
    try {
      const value = await execute({
        page: startedBrowser.page,
        sinkPaths: startedBrowser.sinkPaths,
        flushEvents: () => startedBrowser.eventCapture.flush(),
      });
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
      try { await browserRunner.stopSession(playbackSessionId); }
      catch (cleanupError) {
        if (executionError) throw new AggregateError([executionError, cleanupError], 'Playback and browser cleanup failed');
        throw cleanupError;
      }
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
    this.registry = new McpFnRegistry();
    for (const tool of this.tools) {
      this.registry.register({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as unknown as McpFnObjectSchema,
        annotations: { openWorldHint: false },
        metadata: { 'mcpfn/source': 'probefn' },
        handler: async (args) =>
          await this.runtime.callTool(tool.name, args) as unknown as CallToolResult,
        handleInvalidArguments: async (args) =>
          await this.runtime.callTool(tool.name, args) as unknown as CallToolResult,
      });
    }
  }

  public listTools(): ToolDefinition[] {
    return [...this.tools];
  }

  public async serveTransport(
    transport: Transport,
    signal?: AbortSignal,
  ): Promise<void> {
    const server = createMcpFnServer({
      info: MCP_SERVER_INFO,
      registry: this.registry,
      transports: ['stdio'],
    });
    await server.connect(transport);

    let abortCleanup: (() => void) | undefined;
    await new Promise<void>((resolve) => {
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
    });
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
  const config = await loadConfig(input.configPath, {
    cwd: runtime.getRepoRoot(),
  });
  const artifactRoot = config.artifactRoot;
  const scope = runtime.createScope(artifactRoot);
  const derivedSuffix = deriveSessionSuffix(config.projectName);
  const sessionId = input.sessionId ?? (derivedSuffix ? `sess_${derivedSuffix}` : `sess_${Date.now()}`);
  const runId = input.runId ?? (derivedSuffix ? `run_${derivedSuffix}` : `run_${Date.now()}`);
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

  const startedSession = await scope.devServerManager.startSession({
    sessionId,
    runId,
    mode,
    browser,
    deterministic: config.deterministicDefaults,
    devServer: selectedDevServer,
  });
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
    includeTrace?: boolean;
    includeStyles?: boolean;
    includeVideo?: boolean;
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  const { scope, session } = await runtime.resolveSessionContext(input.sessionId);
  const checkpoint = await runtime.withPlaybackSession(session, async ({ page, sinkPaths }) => {
    const before = await captureEventDeltaBaseline(runtime.getRepoRoot(), sinkPaths);
    const createdCheckpoint = await createCheckpoint({
      repoRoot: runtime.getRepoRoot(),
      artifactStore: scope.artifactStore,
      sessionId: session.sessionId,
      runId: session.runId,
      browser: session.browser,
      name: input.name,
      ...(input.includeVideo ? { includeVideo: true } : {}),
      ...(input.includeTrace !== undefined ? { includeTrace: input.includeTrace } : {}),
      ...(input.includeStyles !== undefined ? { includeStyles: input.includeStyles } : {}),
      tracePath: session.artifacts.tracePath ?? null,
      delta: diffEventDeltaSummary(
        before,
        await captureEventDeltaBaseline(runtime.getRepoRoot(), sinkPaths),
      ),
      source: {
        ...(input.includeVideo ? { videoCapture: () => finalizePageVideo(page) } : {}),
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

export async function getConsoleEvents(
  runtime: ProbefnRuntime,
  sessionId: string,
): Promise<ProbefnEnvelope<JsonValue>> {
  const { session } = await runtime.resolveSessionContext(sessionId);
  const events = await runtime.readEventSink(session.artifacts.consoleSinkPath);
  return createSuccessEnvelope({
    events: events as unknown as JsonValue,
  });
}

export async function getNetworkEvents(
  runtime: ProbefnRuntime,
  sessionId: string,
): Promise<ProbefnEnvelope<JsonValue>> {
  const { session } = await runtime.resolveSessionContext(sessionId);
  const events = await runtime.readEventSink(session.artifacts.networkSinkPath);
  return createSuccessEnvelope({
    events: events as unknown as JsonValue,
  });
}

export async function getPageErrors(
  runtime: ProbefnRuntime,
  sessionId: string,
): Promise<ProbefnEnvelope<JsonValue>> {
  const { session } = await runtime.resolveSessionContext(sessionId);
  const events = await runtime.readEventSink(session.artifacts.pageErrorSinkPath);
  return createSuccessEnvelope({
    events: events as unknown as JsonValue,
  });
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
  },
): Promise<ProbefnEnvelope<JsonValue>> {
  const { scope } = await runtime.resolveSessionContext(input.sessionId);
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
  const flow = await loadFlow(runtime.getRepoRoot(), input.file);
  const executedSteps: string[] = [];
  let lastCheckpointId: string | null = null;
  let lastReportPath: string | null = null;
  let redactedValues = 0;

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
        const reportEnvelope = await exportSessionReport(runtime, {
          sessionId: input.sessionId,
          format: step.format ?? 'json',
        });
        const reportData = expectSuccess(reportEnvelope).data as {
          reportPath: string;
        };
        lastReportPath = reportData.reportPath;
        redactedValues = countRedactedPlaceholders(
          await readFile(path.resolve(runtime.getRepoRoot(), reportData.reportPath), 'utf8'),
        );
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
