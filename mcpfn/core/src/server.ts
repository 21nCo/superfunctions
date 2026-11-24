import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  WebStandardStreamableHTTPServerTransport,
  type HandleRequestOptions,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  TaskMessageQueue,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  ElicitResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListRootsResultSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type LoggingMessageNotification,
  type ResourceUpdatedNotification,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

import {
  buildMcpFnEffectiveCatalog,
  enrichMcpFnClientProfileCall,
  resolveMcpFnClientProfile,
  validateMcpFnClientProfiles,
  type McpFnClientProfileEvidence,
  type McpFnClientProfileLifecycleStage,
  type McpFnClientProfilesOptions,
  type McpFnResolvedClientProfile,
} from "./client-profiles.js";
import { errorResult, McpFnError, McpFnClientProfileError, McpFnValidationError, McpFnOutputValidationError } from "./errors.js";
import { assertMcpAppContracts } from "./apps.js";
import { createManifest, type CreateManifestOptions } from "./manifest.js";
import type { McpFnRegistry } from "./registry.js";
import type {
  McpFnClientRequestOptions,
  McpFnElicitationParams,
  McpFnElicitationResult,
  McpFnManifest,
  McpFnRequestExtra,
  McpFnRootsResult,
  McpFnSamplingParams,
  McpFnSamplingResult,
  McpFnServerInfo,
  McpFnTaskRequestExtra,
  McpFnListedTool,
} from "./types.js";

export interface McpFnToolVisibilityInput<TContext> {
  tool: McpFnListedTool;
  context: TContext;
  extra: McpFnRequestExtra;
}

export interface McpFnServerOptions<TContext> extends CreateManifestOptions {
  info: McpFnServerInfo;
  registry: McpFnRegistry<TContext>;
  context?: (extra: McpFnRequestExtra) => TContext | Promise<TContext>;
  /**
   * Per-request discovery and invocation filter. Returning false hides the
   * tool from tools/list and makes tools/call indistinguishable from an
   * unknown tool. Static manifests remain the complete server contract.
   */
  toolVisibility?: (
    input: McpFnToolVisibilityInput<TContext>,
  ) => boolean | Promise<boolean>;
  /** Authenticated client catalog projection and trusted call enrichment. */
  clientProfiles?: McpFnClientProfilesOptions<TContext>;
  /** Maximum entries returned by each list request. Defaults to 100. */
  pageSize?: number;
  additionalCapabilities?: ServerCapabilities;
  taskStore?: TaskStore;
  taskMessageQueue?: TaskMessageQueue;
  defaultTaskPollInterval?: number;
  maxTaskQueueSize?: number;
  enforceStrictCapabilities?: boolean;
}

export type McpFnWebStandardHandlerOptions<TContext> = ConstructorParameters<
  typeof WebStandardStreamableHTTPServerTransport
>[0] & {
  /**
   * Configure the live isolated server before its transport connects. This
   * runs once per stateless request, or once per session initialization
   * attempt before the SDK validates the request. Rejected attempts may
   * therefore invoke it without retaining a session. This is the correct
   * place to attach protocol instrumentation.
   */
  configureRequestServer?: (
    server: McpFnServer<TContext>,
  ) => void | Promise<void>;
  /**
   * Requests carrying an `Origin` header are refused with HTTP 403 unless the
   * origin is listed in `allowedOrigins`, or it is a loopback origin (such as
   * `http://localhost:3000`) equal to the request's own `Host`. This blocks
   * DNS-rebinding pages from reaching a local server; non-browser clients send
   * no `Origin` and are unaffected. Defaults to `"reject-unlisted"`. `"off"`
   * disables the check, and setting `enableDnsRebindingProtection` (true or
   * false) hands Host/Origin checking to the SDK transport instead.
   */
  originPolicy?: "reject-unlisted" | "off";
  /**
   * Stateful mode: the principal a session belongs to. Computed when the
   * session is created and on every later request that names it; a request
   * from a different principal gets the same 404 as an unknown session.
   * Defaults to the authenticated subject (`authInfo.extra.subject`) and
   * client ID from `handleOptions.authInfo`, or no principal when the request
   * carries no `authInfo`. Must not read the request body.
   */
  sessionPrincipal?: (input: {
    authInfo: AuthInfo | undefined;
    request: Request;
  }) => string | undefined | Promise<string | undefined>;
  /**
   * Stateful mode: most sessions kept at once. Creating one more closes the
   * least recently used idle session (no request or open stream in progress);
   * when every session is busy the new one is refused with HTTP 503.
   * Defaults to 1000.
   */
  maxSessions?: number;
  /**
   * Stateful mode: most sessions one principal may hold. Creating one more
   * closes that principal's least recently used idle session, or is refused
   * with HTTP 429 when all of them are busy. Sessions without a principal
   * share one such allowance. Defaults to 100.
   */
  maxSessionsPerPrincipal?: number;
  /**
   * Stateful mode: a session with no request or open stream for this long is
   * closed. Checked whenever the handler runs. Defaults to 30 minutes;
   * `Infinity` keeps idle sessions until they are deleted or evicted. A
   * session closed by expiry or eviction runs `onsessionclosed` like DELETE.
   */
  sessionIdleTimeoutMs?: number;
};

const DEFAULT_MAX_SESSIONS = 1_000;
const DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = 100;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

function positiveLimit(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const valid = typeof value === "number" && value > 0 &&
    (value === Infinity || (name === "sessionIdleTimeoutMs" ? Number.isFinite(value) : Number.isSafeInteger(value)));
  if (!valid) {
    throw new McpFnError("MCPFN_INVALID_OPTIONS", `${name} must be a positive ${name === "sessionIdleTimeoutMs" ? "number" : "integer"} or Infinity`);
  }
  return value;
}

function defaultSessionPrincipal(input: { authInfo: AuthInfo | undefined }): string | undefined {
  const authInfo = input.authInfo;
  if (!authInfo) return undefined;
  const subject = authInfo.extra?.subject;
  return JSON.stringify([typeof subject === "string" ? subject : null, authInfo.clientId ?? null]);
}

function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return name === "localhost" || name === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(name);
}

function originAllowed(
  request: Request,
  allowedOrigins: readonly string[] | undefined,
): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (allowedOrigins?.includes(origin)) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin || !isLoopbackHostname(parsed.hostname)) return false;
  let host = request.headers.get("host");
  if (host === null) {
    try {
      host = new URL(request.url).host;
    } catch {
      return false;
    }
  }
  return parsed.host === host.toLowerCase();
}

function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function mergeCapabilities(
  base: ServerCapabilities,
  extra: ServerCapabilities | undefined,
): ServerCapabilities {
  const merged = { ...base, ...extra };
  for (const key of ["prompts", "resources", "tools", "tasks"] as const) {
    if (base[key] || extra?.[key]) {
      (merged as Record<string, unknown>)[key] = {
        ...(base[key] as object | undefined),
        ...(extra?.[key] as object | undefined),
      };
    }
  }
  return merged;
}

/** Resolve the exact protocol/manifest capabilities from one registry contract. */
export function resolveMcpFnServerCapabilities<TContext>(
  registry: McpFnRegistry<TContext>,
  additionalCapabilities: ServerCapabilities | undefined,
  includeTaskOperations: boolean,
): ServerCapabilities {
  const registryCapabilities = registry.capabilities();
  if (registryCapabilities.tasks && includeTaskOperations) {
    registryCapabilities.tasks = {
      ...registryCapabilities.tasks,
      list: {},
      cancel: {},
    };
  }
  return mergeCapabilities(registryCapabilities, additionalCapabilities);
}

function page<T>(
  values: T[],
  cursor: string | undefined,
  pageSize: number,
): { values: T[]; nextCursor?: string } {
  let offset = 0;
  if (cursor !== undefined) {
    const match = /^mcpfn:(\d+)$/.exec(cursor);
    if (!match)
      throw new McpError(
        ErrorCode.InvalidParams,
        "Invalid McpFn pagination cursor",
      );
    offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset > values.length) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Expired McpFn pagination cursor",
      );
    }
  }
  const selected = values.slice(offset, offset + pageSize);
  const nextOffset = offset + selected.length;
  return {
    values: selected,
    ...(nextOffset < values.length
      ? { nextCursor: `mcpfn:${nextOffset}` }
      : {}),
  };
}

async function releaseAfterResponse(
  response: Response,
  release: () => Promise<void>,
): Promise<Response> {
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    await release();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await release();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await release();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class McpFnServer<TContext = undefined> {
  readonly registry: McpFnRegistry<TContext>;
  readonly info: McpFnServerInfo;
  readonly protocol: Server;
  readonly capabilities: ServerCapabilities;
  private readonly contextFactory: (
    extra: McpFnRequestExtra,
  ) => TContext | Promise<TContext>;
  private readonly toolVisibility?: McpFnServerOptions<TContext>["toolVisibility"];
  private readonly clientProfiles?: McpFnClientProfilesOptions<TContext>;
  private readonly manifestOptions: CreateManifestOptions;
  private readonly pageSize: number;
  private readonly serverOptions: McpFnServerOptions<TContext>;
  private readonly requestServers = new Set<McpFnServer<TContext>>();
  // Resource URIs this server's client subscribed to through a successful
  // resources/subscribe request. Each HTTP session has its own server, so this
  // is the session's subscription set; it is dropped when the session closes.
  private readonly resourceSubscriptions = new Set<string>();
  // resources/subscribe requests still running, by URI. The SDK handles
  // requests concurrently, so an unsubscribe can finish while an earlier
  // subscribe for the same URI is still awaiting its handler. Unsubscribe and
  // close() drop these tokens, and a subscribe whose token is gone does not
  // record its subscription: the later unsubscribe wins.
  private readonly pendingResourceSubscriptions = new Map<string, Set<symbol>>();
  private connected = false;
  // Request handlers of this server still running, and a callback for when
  // the last one settles (used by createWebStandardHandler's idle tracking).
  private inFlightRequests = 0;
  private onRequestsSettled?: () => void;

  constructor(options: McpFnServerOptions<TContext>) {
    this.serverOptions = { ...options };
    this.info = options.info;
    this.registry = options.registry;
    assertMcpAppContracts(this.registry);
    this.contextFactory = options.context ?? (() => undefined as TContext);
    this.toolVisibility = options.toolVisibility;
    this.clientProfiles = options.clientProfiles;
    if (this.clientProfiles) validateMcpFnClientProfiles(this.clientProfiles);
    this.pageSize = options.pageSize ?? 100;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1) {
      throw new Error("McpFn pageSize must be a positive integer");
    }
    const hasTaskTools = Boolean(this.registry.capabilities().tasks);
    if (hasTaskTools && !options.taskStore) {
      throw new Error("Task-capable McpFn tools require a taskStore");
    }
    const declaredCapabilities = mergeCapabilities(
      options.capabilities ?? {},
      options.additionalCapabilities,
    );
    this.capabilities = resolveMcpFnServerCapabilities(
      this.registry,
      declaredCapabilities,
      Boolean(options.taskStore),
    );
    this.manifestOptions = {
      protocolVersions: options.protocolVersions,
      transports: options.transports,
      extensions: options.extensions,
      capabilities: this.capabilities,
      clientRequirements: options.clientRequirements,
    };
    const { instructions, ...implementation } = options.info;
    this.protocol = new Server(implementation, {
      capabilities: this.capabilities,
      instructions,
      taskStore: options.taskStore,
      taskMessageQueue: options.taskMessageQueue,
      defaultTaskPollInterval: options.defaultTaskPollInterval,
      maxTaskQueueSize: options.maxTaskQueueSize,
      enforceStrictCapabilities: options.enforceStrictCapabilities,
      debouncedNotificationMethods: [
        "notifications/tools/list_changed",
        "notifications/resources/list_changed",
        "notifications/prompts/list_changed",
      ],
    });
    this.installHandlers();
  }

  private installHandlers(): void {
    // Count running request handlers, so a session whose tool outlives its
    // HTTP stream (or is still honouring a cancellation) counts as busy.
    const register = this.protocol.setRequestHandler.bind(this.protocol);
    const handlers = {
      setRequestHandler: ((schema: unknown, handler: (request: unknown, extra: unknown) => Promise<unknown>) =>
        register(schema as never, (async (request: unknown, extra: unknown) => {
          this.inFlightRequests += 1;
          try {
            return await handler(request, extra);
          } finally {
            this.inFlightRequests -= 1;
            if (this.inFlightRequests === 0) this.onRequestsSettled?.();
          }
        }) as never)) as typeof this.protocol.setRequestHandler,
    };
    if (this.capabilities.tools) {
      handlers.setRequestHandler(
        ListToolsRequestSchema,
        async (request, extra) => {
          const tools = this.registry.listTools();
          if (!this.toolVisibility && !this.clientProfiles) {
            const result = page(tools, request.params?.cursor, this.pageSize);
            return {
              tools: result.values,
              ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            };
          }
          const context = await this.contextFactory(extra);
          const resolved = await this.resolveProfile(context, extra);
          const visibleTools = await this.filterVisibleTools(
            tools,
            context,
            extra,
          );
          const effective = await this.buildEffectiveCatalog(
            visibleTools,
            resolved,
            tools,
          );
          const result = page(effective, request.params?.cursor, this.pageSize);
          return {
            tools: result.values,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          };
        },
      );
      handlers.setRequestHandler(
        CallToolRequestSchema,
        async (request, extra) => {
          const context = await this.contextFactory(extra);
          const isTaskRequest = Boolean(request.params.task);
          let resolved: McpFnResolvedClientProfile<TContext> | undefined;
          let routingError: McpError | undefined;
          const completedStages = new Set<McpFnClientProfileLifecycleStage>();
          let currentStage: McpFnClientProfileLifecycleStage =
            "profile-resolution";
          let taskOutputFailureReported = false;
          let taskRequestSettled = false;
          let taskStorageFailureReported = false;
          const pendingTaskOutput: Array<Omit<McpFnClientProfileEvidence, "formatVersion">> = [];
          const flushTaskOutput = async () => {
            taskRequestSettled = true;
            for (const event of pendingTaskOutput.splice(0)) await this.emitProfileEvidence(event);
          };
          try {
            resolved = await this.resolveProfile(context, extra);
            currentStage = "catalog-projection";
            let canonicalTools: McpFnListedTool[];
            if (this.clientProfiles) {
              canonicalTools = this.registry.listTools();
            } else {
              const requestedTool = this.registry.getListedTool(request.params.name);
              canonicalTools = requestedTool ? [requestedTool] : [];
            }
            const visibleTools = await this.filterVisibleTools(
              canonicalTools,
              context,
              extra,
            );
            const effectiveTools = await this.buildEffectiveCatalog(
              visibleTools,
              resolved,
              canonicalTools,
            );
            const listedTool = effectiveTools.find(
              (tool) => tool.name === request.params.name,
            );
            if (!listedTool) {
              throw (routingError = new McpError(
                ErrorCode.MethodNotFound,
                `Tool ${request.params.name} not found`,
              ));
            }
            const taskSupport = this.registry.taskSupport(request.params.name);
            if (taskSupport === "required" && !isTaskRequest) {
              throw (routingError = new McpError(
                ErrorCode.MethodNotFound,
                `Tool ${request.params.name} requires task augmentation`,
              ));
            }
            if (taskSupport === "forbidden" && isTaskRequest) {
              throw (routingError = new McpError(
                ErrorCode.MethodNotFound,
                `Tool ${request.params.name} does not support task augmentation`,
              ));
            }
            currentStage = "argument-enrichment";
            await this.emitProfileEvidence({
              stage: currentStage,
              outcome: "started",
              profile: this.profileReference(resolved),
              tool: request.params.name,
            });
            const enrichedArguments = await enrichMcpFnClientProfileCall({
              resolved,
              tool: listedTool,
              arguments: request.params.arguments,
            });
            await this.emitProfileEvidence({
              stage: currentStage,
              outcome: "succeeded",
              profile: this.profileReference(resolved),
              tool: request.params.name,
            });

            const observer = {
              onTaskStorageFailure: async (error: unknown) => {
                if (taskStorageFailureReported) return;
                taskStorageFailureReported = true;
                const event: Omit<McpFnClientProfileEvidence, "formatVersion"> = {
                  stage: "task-result-storage", outcome: "failed",
                  profile: this.profileReference(resolved), tool: request.params.name,
                  code: error instanceof McpFnError ? error.code : "MCPFN_TOOL_ERROR",
                };
                if (taskRequestSettled) await this.emitProfileEvidence(event);
                else pendingTaskOutput.push(event);
              },
              onTaskOutput: async (outcome: "succeeded" | "failed", error?: unknown) => {
                taskOutputFailureReported = outcome === "failed";
                completedStages.delete("output-validation");
                const event: Omit<McpFnClientProfileEvidence, "formatVersion"> = {
                  stage: "output-validation", outcome,
                  profile: this.profileReference(resolved),
                  tool: request.params.name,
                  ...(outcome === "failed" ? { code: "MCPFN_INVALID_OUTPUT",
                    ...(error instanceof McpFnOutputValidationError ? { issues: (error.details as { issues?: McpFnClientProfileEvidence["issues"] } | undefined)?.issues } : {}),
                  } : {}),
                };
                if (taskRequestSettled) await this.emitProfileEvidence(event);
                else pendingTaskOutput.push(event);
              },
              onStage: (
                stage: "input-validation" | "invalid-arguments-handler" | "handler" | "output-validation",
              ) => {
                currentStage = stage;
                completedStages.add(stage);
              },
            };
            if (isTaskRequest) {
              if (!extra.taskStore)
                throw new Error("No task store is available");
              const result = await this.registry.createToolTask(
                request.params.name,
                enrichedArguments,
                context,
                extra as McpFnTaskRequestExtra,
                observer,
              );
              // Result writes during the creation callback validate output
              // before the callback returns, so their evidence precedes handler.
              await this.emitCompletedToolStages(
                completedStages,
                resolved,
                request.params.name,
                flushTaskOutput,
              );
              await flushTaskOutput();
              return result;
            }
            const result = await this.registry.callTool(
              request.params.name,
              enrichedArguments,
              context,
              extra,
              observer,
            );
            await this.emitCompletedToolStages(
              completedStages,
              resolved,
              request.params.name,
            );
            return result;
          } catch (error) {
            completedStages.delete(currentStage);
            if ((currentStage as McpFnClientProfileLifecycleStage) === "invalid-arguments-handler") completedStages.delete("input-validation");
            if (resolved) await this.emitCompletedToolStages(completedStages, resolved, request.params.name, flushTaskOutput);
            await flushTaskOutput();
            const profile = this.profileReference(resolved);
            const details =
              error instanceof McpFnError &&
              error.details &&
              typeof error.details === "object" &&
              !Array.isArray(error.details)
                ? (error.details as Record<string, unknown>)
                : {};
            if ((currentStage as McpFnClientProfileLifecycleStage) === "invalid-arguments-handler") await this.emitProfileEvidence({
              stage: "input-validation", outcome: "failed", profile, tool: request.params.name, code: "MCPFN_INVALID_ARGUMENTS",
            });
            const issues = (error instanceof McpFnValidationError || error instanceof McpFnOutputValidationError) && ["input-validation", "output-validation"].includes(currentStage) && Array.isArray(details.issues)
              ? (details.issues as McpFnClientProfileEvidence["issues"])
              : undefined;
            if (!((currentStage as McpFnClientProfileLifecycleStage) === "output-validation" && taskOutputFailureReported) && !["profile-resolution", "catalog-projection"].includes(currentStage)) await this.emitProfileEvidence({
              stage: currentStage,
              outcome: "failed",
              profile,
              tool: request.params.name,
              code:
                error instanceof McpFnError ? error.code : "MCPFN_TOOL_ERROR",
              ...(issues ? { issues } : {}),
            });
            if (error instanceof McpError && (error === routingError ||
                ["profile-resolution", "catalog-projection", "argument-enrichment"].includes(currentStage))) throw error;
            const lifecycleError =
              error instanceof McpFnError && (error.details === undefined || (error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)))
                ? new McpFnError(error.code, error.message, {
                    ...details,
                    lifecycleStage: currentStage,
                    ...(profile ? { profile } : {}),
                  })
                : error;
            if (isTaskRequest) throw lifecycleError;
            return errorResult(lifecycleError, {
              includeStructuredContent: !this.registry.hasOutputSchema(
                request.params.name,
              ),
            });
          }
        },
      );
    }

    if (this.capabilities.resources) {
      handlers.setRequestHandler(
        ListResourcesRequestSchema,
        async (request, extra) => {
          const context = await this.contextFactory(extra);
          const result = page(
            await this.registry.listResources(context, extra),
            request.params?.cursor,
            this.pageSize,
          );
          return {
            resources: result.values,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          };
        },
      );
      handlers.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        async (request) => {
          const result = page(
            this.registry.listResourceTemplates(),
            request.params?.cursor,
            this.pageSize,
          );
          return {
            resourceTemplates: result.values,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          };
        },
      );
      handlers.setRequestHandler(
        ReadResourceRequestSchema,
        async (request, extra) => {
          const context = await this.contextFactory(extra);
          return this.registry.readResource(request.params.uri, context, extra);
        },
      );
      if (this.capabilities.resources.subscribe) {
        handlers.setRequestHandler(
          SubscribeRequestSchema,
          async (request, extra) => {
            const uri = request.params.uri;
            const token = Symbol(uri);
            let pending = this.pendingResourceSubscriptions.get(uri);
            if (!pending) {
              pending = new Set();
              this.pendingResourceSubscriptions.set(uri, pending);
            }
            pending.add(token);
            try {
              const context = await this.contextFactory(extra);
              await this.registry.changeSubscription(uri, true, context, extra);
              // Record it only if no unsubscribe or close() ran since it began.
              if (this.pendingResourceSubscriptions.get(uri)?.has(token)) {
                this.resourceSubscriptions.add(uri);
              }
              return {};
            } finally {
              const current = this.pendingResourceSubscriptions.get(uri);
              current?.delete(token);
              if (current?.size === 0) this.pendingResourceSubscriptions.delete(uri);
            }
          },
        );
        handlers.setRequestHandler(
          UnsubscribeRequestSchema,
          async (request, extra) => {
            // Stop delivery first: a client that asked to unsubscribe gets no
            // further updates even when the registry handler then fails, and a
            // subscribe for this URI that is still running does not restore it.
            this.pendingResourceSubscriptions.delete(request.params.uri);
            this.resourceSubscriptions.delete(request.params.uri);
            const context = await this.contextFactory(extra);
            await this.registry.changeSubscription(
              request.params.uri,
              false,
              context,
              extra,
            );
            return {};
          },
        );
      }
    }

    if (this.capabilities.prompts) {
      handlers.setRequestHandler(
        ListPromptsRequestSchema,
        async (request) => {
          const result = page(
            this.registry.listPrompts(),
            request.params?.cursor,
            this.pageSize,
          );
          return {
            prompts: result.values,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          };
        },
      );
      handlers.setRequestHandler(
        GetPromptRequestSchema,
        async (request, extra) => {
          const context = await this.contextFactory(extra);
          return this.registry.getPrompt(
            request.params.name,
            request.params.arguments,
            context,
            extra,
          );
        },
      );
    }

    if (this.capabilities.completions) {
      handlers.setRequestHandler(
        CompleteRequestSchema,
        async (request, extra) => {
          const context = await this.contextFactory(extra);
          return this.registry.complete(
            request.params.ref,
            request.params.argument,
            request.params.context?.arguments,
            context,
            extra,
          );
        },
      );
    }
  }

  private async filterVisibleTools(
    tools: McpFnListedTool[],
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<McpFnListedTool[]> {
    if (!this.toolVisibility) return tools;
    const decisions = await Promise.all(
      tools.map((tool) => this.toolVisibility!({ tool, context, extra })),
    );
    return tools.filter((_, index) => decisions[index]);
  }

  private profileReference(
    resolved: McpFnResolvedClientProfile<TContext> | undefined,
  ) {
    return resolved?.profile
      ? { id: resolved.profile.id, version: resolved.profile.version }
      : undefined;
  }

  private async resolveProfile(
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<McpFnResolvedClientProfile<TContext>> {
    const reportedClient = {
      info: this.protocol.getClientVersion(),
      capabilities: this.protocol.getClientCapabilities(),
    };
    if (!this.clientProfiles) return { context, extra, reportedClient };
    await this.emitProfileEvidence({
      stage: "profile-resolution",
      outcome: "started",
    });
    try {
      const resolved = await resolveMcpFnClientProfile(this.clientProfiles, {
        context,
        extra,
        reportedClient,
      });
      await this.emitProfileEvidence({
        stage: "profile-resolution",
        outcome: "succeeded",
        profile: this.profileReference(resolved),
      });
      return resolved;
    } catch (error) {
      await this.emitProfileEvidence({
        stage: "profile-resolution",
        outcome: "failed",
        code:
          error instanceof McpFnError
            ? error.code
            : "MCPFN_PROFILE_RESOLUTION_FAILED",
      });
      throw error;
    }
  }

  private async buildEffectiveCatalog(
    tools: McpFnListedTool[],
    resolved: McpFnResolvedClientProfile<TContext>,
    knownTools: McpFnListedTool[] = tools,
  ): Promise<McpFnListedTool[]> {
    await this.emitProfileEvidence({
      stage: "catalog-projection",
      outcome: "started",
      profile: this.profileReference(resolved),
    });
    try {
      const result = await buildMcpFnEffectiveCatalog({
        canonicalTools: tools,
        knownTools,
        schemaResources: this.registry.schemaDefinitions(),
        resolved,
      });
      await this.emitProfileEvidence({
        stage: "catalog-projection",
        outcome: "succeeded",
        profile: this.profileReference(resolved),
      });
      return result.tools;
    } catch (error) {
      await this.emitProfileEvidence({
        stage: "catalog-projection",
        outcome: "failed",
        profile: this.profileReference(resolved),
        code:
          error instanceof McpFnError
            ? error.code
            : "MCPFN_CATALOG_PROJECTION_FAILED",
      });
      throw error;
    }
  }

  private async emitCompletedToolStages(
    stages: Set<McpFnClientProfileLifecycleStage>,
    resolved: McpFnResolvedClientProfile<TContext>,
    tool: string,
    beforeHandler?: () => Promise<void>,
  ): Promise<void> {
    for (const stage of [
      "input-validation",
      "invalid-arguments-handler",
      "handler",
      "output-validation",
    ] as const) {
      if (stage === "handler") await beforeHandler?.();
      if (!stages.has(stage)) continue;
      await this.emitProfileEvidence({
        stage,
        outcome: stage === "input-validation" && stages.has("invalid-arguments-handler") ? "failed" : "succeeded",
        profile: this.profileReference(resolved),
        tool,
      });
    }
  }

  private async emitProfileEvidence(
    event: Omit<McpFnClientProfileEvidence, "formatVersion">,
  ): Promise<void> {
    try {
      await this.clientProfiles?.evidence?.(structuredClone({ formatVersion: 1, ...event, ...(event.code === undefined ? {} : { code: profileEvidenceCode(event.code) }) }));
    } catch {
      // Evidence sinks are observational and must never alter request behavior.
    }
  }

  manifest(): McpFnManifest {
    return createManifest(this.info, this.registry, this.manifestOptions);
  }

  async connect(transport: Transport): Promise<void> {
    if (this.connected)
      throw new Error("McpFnServer is already connected to a transport");
    await this.protocol.connect(transport);
    this.connected = true;
  }

  async serveStdio(): Promise<void> {
    await this.connect(new StdioServerTransport());
  }

  async createWebStandardHandler(
    options: McpFnWebStandardHandlerOptions<TContext> = {},
  ): Promise<
    (request: Request, options?: HandleRequestOptions) => Promise<Response>
  > {
    const {
      configureRequestServer,
      originPolicy = "reject-unlisted",
      sessionPrincipal = defaultSessionPrincipal,
      maxSessions: maxSessionsOption,
      maxSessionsPerPrincipal: maxPerPrincipalOption,
      sessionIdleTimeoutMs: idleTimeoutOption,
      ...transportOptions
    } = options;
    if (originPolicy !== "reject-unlisted" && originPolicy !== "off") {
      throw new McpFnError("MCPFN_INVALID_OPTIONS", 'originPolicy must be "reject-unlisted" or "off"');
    }
    const maxSessions = positiveLimit("maxSessions", maxSessionsOption, DEFAULT_MAX_SESSIONS);
    const maxPerPrincipal = positiveLimit("maxSessionsPerPrincipal", maxPerPrincipalOption, DEFAULT_MAX_SESSIONS_PER_PRINCIPAL);
    const idleTimeoutMs = positiveLimit("sessionIdleTimeoutMs", idleTimeoutOption, DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    const checkOrigin = originPolicy === "reject-unlisted" &&
      transportOptions.enableDnsRebindingProtection === undefined;
    const rejectOrigin = (request: Request): Response | undefined =>
      checkOrigin && !originAllowed(request, transportOptions.allowedOrigins)
        ? jsonRpcErrorResponse(403, -32000, "Origin not allowed")
        : undefined;

    if (!transportOptions.sessionIdGenerator) {
      if (this.clientProfiles?.profiles.some((profile) => profile.requiresReportedClient !== false)) {
        throw new McpFnClientProfileError("MCPFN_PROFILE_REQUIRES_SESSION", "Client profiles require sessionIdGenerator to retain initialize metadata; stateless-independent profiles must declare requiresReportedClient: false");
      }
      return async (request: Request, handleOptions?: HandleRequestOptions) => {
        const refused = rejectOrigin(request);
        if (refused) return refused;
        const requestServer = new McpFnServer(this.serverOptions);
        const transport = new WebStandardStreamableHTTPServerTransport(
          transportOptions,
        );
        this.requestServers.add(requestServer);
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          this.requestServers.delete(requestServer);
          await requestServer.close();
        };

        try {
          await configureRequestServer?.(requestServer);
          await requestServer.connect(transport);
          const response = await transport.handleRequest(
            request,
            handleOptions,
          );
          return releaseAfterResponse(response, release);
        } catch (error) {
          await release();
          throw error;
        }
      };
    }

    interface Session {
      server: McpFnServer<TContext>;
      transport: WebStandardStreamableHTTPServerTransport;
      bucket: string | symbol;
      principal: string | undefined;
      lastActive: number;
      /** Increases on every use; orders sessions when timestamps tie. */
      lastUse: number;
      /** HTTP requests and open streams in progress, including initialization. */
      active: number;
      /** Close once: run the host's onsessionclosed, then release the server. */
      close: (fromDelete: boolean) => Promise<void>;
    }
    // Sessions without a principal share one bucket for maxSessionsPerPrincipal.
    // A symbol cannot collide with any principal key a host returns.
    const ANONYMOUS = Symbol("anonymous");
    const sessions = new Map<string, Session>();
    // Evicted or expired sessions still closing keep their capacity until
    // closed, and so do admitted sessions whose initialization is finishing.
    const closingSessions = new Set<Session>();
    const reservedSessions = new Set<Session>();
    let useCounter = 0;
    const sessionNotFound = () =>
      jsonRpcErrorResponse(404, -32001, "Session not found");
    const busy = (session: Session) => session.active !== 0 || session.server.inFlightRequests !== 0;
    const closeQuietly = (victims: Session[]) =>
      Promise.all(victims.map((session) => session.close(false).catch(() => undefined)));
    // Take a session out of the table; it counts against capacity until closed.
    const takeSession = (id: string, session: Session) => {
      sessions.delete(id);
      closingSessions.add(session);
      return session;
    };
    // The idle session used least recently, if any. Busy sessions are never
    // evicted: closing one would leave its requests unanswered.
    const leastRecentlyUsedIdle = (bucket?: string | symbol) => {
      let chosen: [string, Session] | undefined;
      for (const entry of sessions) {
        const session = entry[1];
        if (busy(session) || (bucket !== undefined && session.bucket !== bucket)) continue;
        if (!chosen || session.lastUse < chosen[1].lastUse) chosen = entry;
      }
      return chosen;
    };
    const sweepIdle = () => {
      if (!Number.isFinite(idleTimeoutMs)) return [];
      const now = Date.now();
      return [...sessions]
        .filter(([, session]) => !busy(session) && now - session.lastActive >= idleTimeoutMs)
        .map(([id, session]) => takeSession(id, session));
    };
    // Reserve room for one new session in a single synchronous step, so
    // concurrent initializations cannot exceed the limits. Evicted sessions
    // stay charged (as closing) until their transports are closed, and the
    // reservation is charged until the session is published or abandoned.
    // Returns the sessions evicted to make room, or the refusal when every
    // candidate is busy.
    const reserve = (session: Session): Session[] | Response => {
      const victims: Session[] = [];
      const count = (match: (candidate: Session) => boolean) => {
        let total = 0;
        for (const candidate of sessions.values()) if (match(candidate)) total += 1;
        for (const candidate of closingSessions) if (match(candidate) && !victims.includes(candidate)) total += 1;
        for (const candidate of reservedSessions) if (match(candidate)) total += 1;
        return total;
      };
      const restore = () => {
        for (const victim of victims) {
          closingSessions.delete(victim);
          sessions.set(victim.transport.sessionId!, victim);
        }
      };
      while (count((candidate) => candidate.bucket === session.bucket) >= maxPerPrincipal) {
        const entry = leastRecentlyUsedIdle(session.bucket);
        if (!entry) {
          restore();
          return jsonRpcErrorResponse(429, -32000, "Too many sessions for this principal");
        }
        victims.push(takeSession(...entry));
      }
      while (count(() => true) >= maxSessions) {
        const entry = leastRecentlyUsedIdle();
        if (!entry) {
          restore();
          return jsonRpcErrorResponse(503, -32000, "Too many sessions");
        }
        victims.push(takeSession(...entry));
      }
      reservedSessions.add(session);
      return victims;
    };

    return async (request: Request, handleOptions?: HandleRequestOptions) => {
      const refused = rejectOrigin(request);
      if (refused) return refused;
      await closeQuietly(sweepIdle());
      const principal = await sessionPrincipal({
        authInfo: handleOptions?.authInfo,
        request,
      });
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session || session.principal !== principal) return sessionNotFound();
        session.active += 1;
        session.lastActive = Date.now();
        session.lastUse = ++useCounter;
        let settled = false;
        const settle = async () => {
          if (settled) return;
          settled = true;
          session.active -= 1;
          session.lastActive = Date.now();
        };
        try {
          const response = await session.transport.handleRequest(request, handleOptions);
          return await releaseAfterResponse(response, settle);
        } catch (error) {
          await settle();
          throw error;
        }
      }

      const requestServer = new McpFnServer(this.serverOptions);
      let initialized: Session | undefined;
      let refusal: Response | undefined;
      let released = false;
      let transport: WebStandardStreamableHTTPServerTransport;
      const release = async () => {
        if (released) return;
        released = true;
        const id = transport.sessionId;
        if (id !== undefined && sessions.get(id)?.server === requestServer) sessions.delete(id);
        this.requestServers.delete(requestServer);
        try {
          await requestServer.close();
        } finally {
          if (initialized) closingSessions.delete(initialized);
        }
      };
      let closing: Promise<void> | undefined;
      const close = (fromDelete: boolean) => {
        closing ??= (async () => {
          const id = transport.sessionId;
          if (id !== undefined && sessions.get(id)?.server === requestServer) {
            sessions.delete(id);
            if (initialized) closingSessions.add(initialized);
          }
          try {
            if (id !== undefined) await transportOptions.onsessionclosed?.(id);
          } catch (error) {
            if (fromDelete) throw error;
          } finally {
            await release();
          }
        })();
        return closing;
      };
      transport = new WebStandardStreamableHTTPServerTransport({
        ...transportOptions,
        // Runs only for a valid initialize request, so other requests without
        // a session ID can never evict a session.
        onsessioninitialized: async (id) => {
          const session: Session = {
            server: requestServer,
            transport,
            bucket: principal ?? ANONYMOUS,
            principal,
            lastActive: Date.now(),
            lastUse: ++useCounter,
            // The initialize response itself is in progress.
            active: 1,
            close,
          };
          const victims = reserve(session);
          if (victims instanceof Response) {
            refusal = victims;
            throw new Error("Session capacity reached");
          }
          try {
            // Victims finish closing before the new session goes live.
            await closeQuietly(victims);
            await transportOptions.onsessioninitialized?.(id);
          } finally {
            reservedSessions.delete(session);
          }
          // Published only once the host accepted it.
          initialized = session;
          sessions.set(id, session);
          requestServer.onRequestsSettled = () => {
            if (session.active === 0) session.lastActive = Date.now();
          };
        },
        // DELETE from the session's own principal.
        onsessionclosed: () => close(true),
      });
      this.requestServers.add(requestServer);

      try {
        await configureRequestServer?.(requestServer);
        await requestServer.connect(transport);
        const response = await transport.handleRequest(request, handleOptions);
        if (refusal) {
          await response.body?.cancel().catch(() => undefined);
          await release();
          return refusal;
        }
        const session = initialized;
        if (session) {
          let settled = false;
          return releaseAfterResponse(response, async () => {
            if (settled) return;
            settled = true;
            session.active -= 1;
            session.lastActive = Date.now();
          });
        }
        return releaseAfterResponse(response, release);
      } catch (error) {
        await release();
        throw error;
      }
    };
  }

  sample(
    params: McpFnSamplingParams,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnSamplingResult> {
    const unavailable = this.directClientRequestError("sample", "sampleForRequest");
    if (unavailable) return Promise.reject(unavailable);
    return this.protocol.createMessage(params, options);
  }

  sampleForRequest(
    extra: McpFnRequestExtra,
    params: McpFnSamplingParams,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnSamplingResult> {
    const schema = params.tools?.length
      ? CreateMessageResultWithToolsSchema
      : CreateMessageResultSchema;
    return extra.sendRequest(
      { method: "sampling/createMessage", params },
      schema,
      options,
    ) as Promise<McpFnSamplingResult>;
  }

  elicit(
    params: McpFnElicitationParams,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnElicitationResult> {
    const unavailable = this.directClientRequestError("elicit", "elicitForRequest");
    if (unavailable) return Promise.reject(unavailable);
    return this.protocol.elicitInput(params, options);
  }

  elicitForRequest(
    extra: McpFnRequestExtra,
    params: McpFnElicitationParams,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnElicitationResult> {
    return extra.sendRequest(
      { method: "elicitation/create", params },
      ElicitResultSchema,
      options,
    );
  }

  listRoots(options?: RequestOptions): Promise<McpFnRootsResult> {
    const unavailable = this.directClientRequestError("listRoots", "listRootsForRequest");
    if (unavailable) return Promise.reject(unavailable);
    return this.protocol.listRoots(undefined, options);
  }

  // sample(), elicit() and listRoots() send a request to the client on this
  // server's own transport. With createWebStandardHandler, each request or
  // session is served by its own server, so there is no single client to ask:
  // tool handlers use the *ForRequest variants with their `extra` instead.
  private directClientRequestError(method: string, alternative: string): McpFnError | undefined {
    if (this.connected) return undefined;
    return new McpFnError(
      "MCPFN_CLIENT_REQUEST_NEEDS_REQUEST",
      `${method}() needs a directly connected transport. Over createWebStandardHandler, call ${alternative}(extra, ...) from the tool handler instead.`,
    );
  }

  listRootsForRequest(
    extra: McpFnRequestExtra,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnRootsResult> {
    return extra.sendRequest(
      { method: "roots/list" },
      ListRootsResultSchema,
      options,
    );
  }

  // The per-request or per-session servers created by createWebStandardHandler
  // that currently have a client. Each one owns a single HTTP client's transport.
  private connectedRequestServers(): McpFnServer<TContext>[] {
    return [...this.requestServers].filter((server) => server.connected);
  }

  // This server and every per-request or per-session server with a client.
  private connectedServers(): McpFnServer<TContext>[] {
    return [...(this.connected ? [this] : []), ...this.connectedRequestServers()];
  }

  // Deliver to every recipient. A failure on this server's own transport is
  // still reported; a per-request or per-session server whose client went
  // away does not stop the others from receiving the notification.
  private async broadcast(
    servers: McpFnServer<TContext>[],
    send: (server: McpFnServer<TContext>) => Promise<void>,
  ): Promise<void> {
    const results = await Promise.allSettled(servers.map((server) => send(server)));
    const own = servers.indexOf(this);
    const ownResult = own === -1 ? undefined : results[own];
    if (ownResult?.status === "rejected") throw ownResult.reason;
  }

  /**
   * Sends `notifications/message` to one client, never to every session.
   *
   * Without `sessionId`, only the transport connected with `connect()` or
   * `serveStdio()` receives it. With `sessionId`, only the client whose
   * transport has that session id receives it: the directly connected
   * transport or one `createWebStandardHandler()` session. Tool handlers
   * behind `createWebStandardHandler()` pass `extra.sessionId`; a stateless
   * handler has no session to name and logs through `extra.sendNotification`.
   * The recipient's `logging/setLevel` choice is honoured.
   */
  async sendLoggingMessage(
    params: LoggingMessageNotification["params"],
    sessionId?: string,
  ): Promise<void> {
    const recipients = sessionId === undefined
      ? this.connected ? [this] : []
      : this.connectedServers().filter((server) => server.protocol.transport?.sessionId === sessionId);
    await this.broadcast(
      recipients,
      // The SDK keeps each HTTP client's logging level under its transport's
      // session id, so pass the recipient's own id unless one was given.
      (server) => server.protocol.sendLoggingMessage(params, sessionId ?? server.protocol.transport?.sessionId),
    );
  }

  /**
   * Sends `notifications/resources/updated` for `params.uri`. The transport
   * connected with `connect()` or `serveStdio()` receives it as before; a
   * `createWebStandardHandler()` session receives it only while it holds a
   * subscription to that exact URI from a successful `resources/subscribe`
   * (until it unsubscribes or the session closes).
   */
  async sendResourceUpdated(params: ResourceUpdatedNotification["params"]): Promise<void> {
    await this.broadcast(
      [
        ...(this.connected ? [this] : []),
        ...this.connectedRequestServers().filter((server) => server.resourceSubscriptions.has(params.uri)),
      ],
      (server) => server.protocol.sendResourceUpdated(params),
    );
  }

  /**
   * Sends `notifications/resources/list_changed` to every connected client:
   * the direct transport and every `createWebStandardHandler()` session. The
   * notification carries no data and every client shares the registry.
   */
  async sendResourceListChanged(): Promise<void> {
    await this.broadcast(this.connectedServers(), (server) => server.protocol.sendResourceListChanged());
  }

  /** Sends `notifications/tools/list_changed` to every connected client, like `sendResourceListChanged()`. */
  async sendToolListChanged(): Promise<void> {
    await this.broadcast(this.connectedServers(), (server) => server.protocol.sendToolListChanged());
  }

  /** Sends `notifications/prompts/list_changed` to every connected client, like `sendResourceListChanged()`. */
  async sendPromptListChanged(): Promise<void> {
    await this.broadcast(this.connectedServers(), (server) => server.protocol.sendPromptListChanged());
  }

  async close(): Promise<void> {
    const requestServers = [...this.requestServers];
    this.requestServers.clear();
    await Promise.all(requestServers.map((server) => server.close()));
    this.pendingResourceSubscriptions.clear();
    this.resourceSubscriptions.clear();
    await this.protocol.close();
    this.connected = false;
  }
}

export function createMcpFnServer<TContext = undefined>(
  options: McpFnServerOptions<TContext>,
): McpFnServer<TContext> {
  return new McpFnServer(options);
}

const PROFILE_EVIDENCE_CODES = new Set(["MCPFN_PROFILE_RESOLUTION_FAILED", "MCPFN_CATALOG_PROJECTION_FAILED", "MCPFN_AMBIGUOUS_CLIENT_PROFILE", "MCPFN_DUPLICATE_CLIENT_PROFILE", "MCPFN_FORGED_SERVER_ARGUMENT", "MCPFN_INVALID_ARGUMENTS", "MCPFN_INVALID_CLIENT_PROFILE", "MCPFN_INVALID_OUTPUT", "MCPFN_INVALID_PROFILE_ARGUMENTS", "MCPFN_INVALID_PROJECTED_CATALOG", "MCPFN_INVALID_VERIFIED_IDENTITY", "MCPFN_MISSING_TRUSTED_CONTEXT", "MCPFN_PROFILE_ARGUMENT_MUTATION", "MCPFN_PROFILE_ASYMMETRIC", "MCPFN_PROFILE_ENRICHER_REQUIRED", "MCPFN_PROJECTED_TOOL_DUPLICATE", "MCPFN_PROJECTED_TOOL_UNKNOWN", "MCPFN_SERVER_ARGUMENT_NOT_REQUIRED", "MCPFN_SERVER_ARGUMENT_TOOL_UNKNOWN", "MCPFN_TOOL_ERROR"]);
function profileEvidenceCode(code: string): string {
  return PROFILE_EVIDENCE_CODES.has(code) ? code : "MCPFN_TOOL_ERROR";
}
