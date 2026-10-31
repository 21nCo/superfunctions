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
  /** Maximum retained sessions plus pending initialization attempts (default 1024). */
  maxSessions?: number;
  /** Idle milliseconds after all HTTP responses finish (default 30 minutes). */
  idleTimeoutMs?: number;
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
};

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

// Unlike Promise.race against a long-lived close promise, settled requests remove
// their listener immediately instead of accumulating callbacks for the session lifetime.
function responseUntilClosed(
  response: Promise<Response>,
  listeners: Set<() => void>,
  isClosed: () => boolean,
  fallback: () => Response,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const onClose = () => { listeners.delete(onClose); resolve(fallback()); };
    if (isClosed()) onClose();
    else listeners.add(onClose);
    response.then(
      value => { listeners.delete(onClose); resolve(value); },
      error => { listeners.delete(onClose); reject(error); },
    );
  });
}

function protocolError(error: unknown): Error {
  if (error instanceof Error && error.name === "McpError" && "code" in error && Number.isSafeInteger(error.code)) return error;
  // Intentional McpFn errors retain their existing public message, but no backend data.
  const message = error instanceof McpFnError ? error.message : "Internal error";
  const normalized = new McpError(ErrorCode.InternalError, message);
  // McpError prefixes its local Error.message; the wire message stays public text.
  normalized.message = message;
  return normalized;
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
  private readonly handlerClosers = new Set<() => Promise<void>>();
  private readonly requestServers = new Set<McpFnServer<TContext>>();
  private connected = false;

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

  private readonly setRequestHandler: Server["setRequestHandler"] = (schema, handler) => {
    this.protocol.setRequestHandler(schema, async (request, extra) => {
      try { return await handler(request, extra); }
      catch (error) { throw protocolError(error); }
    });
  };

  private installHandlers(): void {
    if (this.capabilities.tools) {
      this.setRequestHandler(
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
      this.setRequestHandler(
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
              await this.emitCompletedToolStages(
                completedStages,
                resolved,
                request.params.name,
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
            if (resolved) await this.emitCompletedToolStages(completedStages, resolved, request.params.name);
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
            // SDK classes may come from a different copy than the bundled runtime.
            if (error instanceof Error && error.name === "McpError" && "code" in error && Number.isSafeInteger(error.code) && (error === routingError ||
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
      this.setRequestHandler(
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
      this.setRequestHandler(
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
      this.setRequestHandler(
        ReadResourceRequestSchema,
        async (request, extra) => {
          const context = await this.contextFactory(extra);
          return this.registry.readResource(request.params.uri, context, extra);
        },
      );
      if (this.capabilities.resources.subscribe) {
        this.setRequestHandler(
          SubscribeRequestSchema,
          async (request, extra) => {
            const context = await this.contextFactory(extra);
            await this.registry.changeSubscription(
              request.params.uri,
              true,
              context,
              extra,
            );
            return {};
          },
        );
        this.setRequestHandler(
          UnsubscribeRequestSchema,
          async (request, extra) => {
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
      this.setRequestHandler(
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
      this.setRequestHandler(
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
      this.setRequestHandler(
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
  ): Promise<void> {
    for (const stage of [
      "input-validation",
      "invalid-arguments-handler",
      "handler",
      "output-validation",
    ] as const) {
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
    const { configureRequestServer, maxSessions = 1024, idleTimeoutMs = 30 * 60 * 1000, ...transportOptions } = options;
    if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
      throw new RangeError("maxSessions must be a positive safe integer");
    }
    if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 2_147_483_647) {
      throw new RangeError("idleTimeoutMs must be a positive integer no greater than 2147483647");
    }
    const failure = (status: number, message: string) => new Response(JSON.stringify({
      jsonrpc: "2.0", error: { code: status === 404 ? -32001 : -32000, message }, id: null,
    }), { status, headers: { "content-type": "application/json" } });
    if (!transportOptions.sessionIdGenerator) {
      if (this.serverOptions.taskStore) {
        throw new Error("HTTP task storage requires sessionIdGenerator; stateless requests cannot isolate tasks between callers");
      }
      if (this.clientProfiles?.profiles.some((profile) => profile.requiresReportedClient !== false)) {
        throw new McpFnClientProfileError("MCPFN_PROFILE_REQUIRES_SESSION", "Client profiles require sessionIdGenerator to retain initialize metadata; stateless-independent profiles must declare requiresReportedClient: false");
      }
      let closed = false;
      const releases = new Set<() => Promise<void>>();
      this.handlerClosers.add(async () => {
        closed = true;
        await Promise.all([...releases].map(release => release()));
      });
      return async (request: Request, handleOptions?: HandleRequestOptions) => {
        if (closed) return failure(503, "Server closed");
        const pendingResponses = new Set<() => void>();
        const requestServer = new McpFnServer(this.serverOptions);
        const transport = new WebStandardStreamableHTTPServerTransport(
          transportOptions,
        );
        this.requestServers.add(requestServer);
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          for (const settle of pendingResponses) settle();
          releases.delete(release);
          this.requestServers.delete(requestServer);
          await requestServer.close();
        };

        releases.add(release);
        try {
          await configureRequestServer?.(requestServer);
          if (released) return failure(503, "Server closed");
          await requestServer.connect(transport);
          if (released) return failure(503, "Server closed");
          const response = await responseUntilClosed(
            transport.handleRequest(request, handleOptions), pendingResponses,
            () => released, () => failure(503, "Server closed"),
          );
          return releaseAfterResponse(response, release);
        } catch (error) {
          await release();
          throw error;
        }
      };
    }

    type Session = {
      transport: WebStandardStreamableHTTPServerTransport;
      authenticatedOwner?: string;
      pendingResponses: Set<() => void>;
      active: number;
      timer?: ReturnType<typeof setTimeout>;
      released: boolean;
      release: () => Promise<void>;
    };
    const sessions = new Map<string, Session>();
    // Reservations are taken synchronously, before configuration or SDK initialization.
    const reservations = new Set<Session>();
    let closed = false;
    const closeHandler = async () => {
      closed = true;
      await Promise.all([...reservations].map((session) => session.release()));
    };
    this.handlerClosers.add(closeHandler);
    const cancelIdle = (session: Session) => {
      if (session.timer !== undefined) clearTimeout(session.timer);
      session.timer = undefined;
    };
    const finishRequest = (session: Session) => {
      let finished = false;
      return async () => {
        if (finished) return;
        finished = true;
        session.active--;
        if (session.released || closed || session.active !== 0) return;
        session.timer = setTimeout(() => {
          // Remove ownership synchronously even if transport close takes time.
          void session.release().catch(() => {});
        }, idleTimeoutMs);
        (session.timer as { unref?: () => void }).unref?.();
      };
    };
    return async (request: Request, handleOptions?: HandleRequestOptions) => {
      if (closed) return failure(503, "Server closed");
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session || session.authenticatedOwner !== authenticatedSessionOwner(handleOptions)) {
          return failure(404, "Session not found");
        }
        cancelIdle(session);
        session.active++;
        const finish = finishRequest(session);
        try {
          const pending = session.transport.handleRequest(request, handleOptions);
          // DELETE closes its own session before producing its successful 200 response.
          const response = await (request.method === "DELETE" ? pending : responseUntilClosed(
            pending, session.pendingResponses, () => session.released,
            () => failure(closed ? 503 : 404, closed ? "Server closed" : "Session not found"),
          ));
          return await releaseAfterResponse(response, finish);
        } catch (error) {
          await finish();
          throw error;
        }
      }

      const authenticatedOwner = authenticatedSessionOwner(handleOptions);
      if (authenticatedOwner === null) {
        return failure(403, "Authenticated HTTP sessions require a valid verified identity with a stable authInfo.extra.subject");
      }
      if (reservations.size >= maxSessions) return failure(503, "Session capacity reached");
      const requestServer = new McpFnServer(this.serverOptions);
      let initializedSessionId: string | undefined;
      let initializationFailed = false;
      const transport = new WebStandardStreamableHTTPServerTransport({
        ...transportOptions,
        onsessioninitialized: async (id) => {
          if (closed || session.released) throw new Error("Server closed");
          if (sessions.has(id)) throw new Error("Session ID is already in use");
          initializedSessionId = id;
          sessions.set(id, session);
          try {
            await transportOptions.onsessioninitialized?.(id);
            if (closed || session.released) throw new Error("Server closed");
          } catch (error) {
            initializationFailed = true;
            await session.release();
            throw error;
          }
        },
        onsessionclosed: async (id) => {
          if (sessions.get(id) === session) sessions.delete(id);
          try {
            await transportOptions.onsessionclosed?.(id);
          } finally {
            await session.release();
          }
        },
      });
      const session: Session = {
        transport,
        authenticatedOwner,
        pendingResponses: new Set(),
        active: 1,
        released: false,
        release: async () => {
          if (session.released) return;
          session.released = true;
          for (const settle of session.pendingResponses) settle();
          cancelIdle(session);
          if (initializedSessionId && sessions.get(initializedSessionId) === session) {
            sessions.delete(initializedSessionId);
          }
          reservations.delete(session);
          this.requestServers.delete(requestServer);
          await requestServer.close();
        },
      };
      reservations.add(session);
      this.requestServers.add(requestServer);
      const finish = finishRequest(session);
      try {
        await configureRequestServer?.(requestServer);
        if (closed || session.released) return failure(503, "Server closed");
        await requestServer.connect(transport);
        if (closed || session.released) return failure(503, "Server closed");
        const response = await responseUntilClosed(
          transport.handleRequest(request, handleOptions), session.pendingResponses,
          () => session.released,
          () => closed ? failure(503, "Server closed")
            : initializationFailed ? failure(500, "Session initialization failed")
            : failure(404, "Session not found"),
        );
        // SDK initialization can convert callback errors into an HTTP error response.
        if (!initializedSessionId || session.released || response.status >= 400) {
          return await releaseAfterResponse(response, session.release);
        }
        return await releaseAfterResponse(response, finish);
      } catch (error) {
        await session.release();
        throw error;
      }
    };
  }

  sample(
    params: McpFnSamplingParams,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnSamplingResult> {
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
    return this.protocol.listRoots(undefined, options);
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

  sendLoggingMessage(
    params: LoggingMessageNotification["params"],
    sessionId?: string,
  ) {
    return this.protocol.sendLoggingMessage(params, sessionId);
  }

  sendResourceUpdated(params: ResourceUpdatedNotification["params"]) {
    return this.protocol.sendResourceUpdated(params);
  }

  sendResourceListChanged() {
    return this.protocol.sendResourceListChanged();
  }

  sendToolListChanged() {
    return this.protocol.sendToolListChanged();
  }

  sendPromptListChanged() {
    return this.protocol.sendPromptListChanged();
  }

  async close(): Promise<void> {
    const handlerClosers = [...this.handlerClosers];
    this.handlerClosers.clear();
    await Promise.all(handlerClosers.map((close) => close()));
    const requestServers = [...this.requestServers];
    this.requestServers.clear();
    await Promise.all(requestServers.map((server) => server.close()));
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

/** Bind verified identity, never bearer-token bytes, so token refresh keeps its session. */
function authenticatedSessionOwner(options?: HandleRequestOptions): string | undefined | null {
  const auth = options?.authInfo;
  if (!auth) return undefined;
  // OAuth clientId identifies the application, not the human using it.
  // Missing subject cannot safely fall back to that shared application ID.
  if (typeof auth.clientId !== "string" || !auth.clientId.trim() ||
      typeof auth.extra?.subject !== "string" || !auth.extra.subject.trim()) return null;
  for (const claim of [auth.extra.tenantId, auth.extra.regionId]) {
    if (claim !== undefined && typeof claim !== "string") return null;
  }
  if (auth.extra.issuer !== undefined &&
      (typeof auth.extra.issuer !== "string" || !auth.extra.issuer.trim())) return null;
  return JSON.stringify([
    auth.clientId,
    auth.extra.issuer ?? null,
    auth.extra?.subject ?? null,
    auth.extra?.tenantId ?? null,
    auth.extra?.regionId ?? null,
  ]);
}
