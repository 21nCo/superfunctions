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
import { errorResult, jsonSafe, McpFnError, McpFnClientProfileError, McpFnValidationError, McpFnOutputValidationError } from "./errors.js";
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
};

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
    if (this.capabilities.tools) {
      this.protocol.setRequestHandler(
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
      this.protocol.setRequestHandler(
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
              clientProfiles: this.clientProfiles,
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
            // Task-augmented calls answer with a JSON-RPC error. Keep the
            // McpFn code of an argument-enrichment failure in its data
            // instead of letting the SDK drop it.
            if (isTaskRequest && currentStage === "argument-enrichment" && lifecycleError instanceof McpFnError) {
              const data = jsonSafe(lifecycleError.details);
              // Rejected client input is InvalidParams; a failing enrichment
              // hook (an unavailable tenant lookup, say) is a server error.
              const clientInput = ["MCPFN_FORGED_SERVER_ARGUMENT", "MCPFN_INVALID_PROFILE_ARGUMENTS"].includes(lifecycleError.code);
              throw new McpError(clientInput ? ErrorCode.InvalidParams : ErrorCode.InternalError, lifecycleError.message, {
                // Object details are spread; arrays and scalars keep their place
                // under `details`.
                ...(data !== null && typeof data === "object" && !Array.isArray(data)
                  ? data
                  : data === undefined ? {} : { details: data }),
                // Set after serialization so details (including a toJSON
                // method) cannot replace the McpFn code, stage or profile.
                lifecycleStage: currentStage,
                ...(profile ? { profile } : {}),
                code: lifecycleError.code,
              });
            }
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
      this.protocol.setRequestHandler(
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
      this.protocol.setRequestHandler(
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
      this.protocol.setRequestHandler(
        ReadResourceRequestSchema,
        async (request, extra) => {
          const context = await this.contextFactory(extra);
          return this.registry.readResource(request.params.uri, context, extra);
        },
      );
      if (this.capabilities.resources.subscribe) {
        this.protocol.setRequestHandler(
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
        this.protocol.setRequestHandler(
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
      this.protocol.setRequestHandler(
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
      this.protocol.setRequestHandler(
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
      this.protocol.setRequestHandler(
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
        clientProfiles: this.clientProfiles,
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
      ...transportOptions
    } = options;
    if (originPolicy !== "reject-unlisted" && originPolicy !== "off") {
      throw new McpFnError("MCPFN_INVALID_OPTIONS", 'originPolicy must be "reject-unlisted" or "off"');
    }
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

    const sessions = new Map<
      string,
      {
        server: McpFnServer<TContext>;
        transport: WebStandardStreamableHTTPServerTransport;
        /** The principal that created the session. */
        principal: string | undefined;
      }
    >();
    return async (request: Request, handleOptions?: HandleRequestOptions) => {
      const refused = rejectOrigin(request);
      if (refused) return refused;
      const principal = await sessionPrincipal({
        authInfo: handleOptions?.authInfo,
        request,
      });
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        // Another principal's session answers exactly like an unknown one.
        if (!session || session.principal !== principal) {
          return jsonRpcErrorResponse(404, -32001, "Session not found");
        }
        return session.transport.handleRequest(request, handleOptions);
      }

      const requestServer = new McpFnServer(this.serverOptions);
      let initializedSessionId: string | undefined;
      let released = false;
      let transport: WebStandardStreamableHTTPServerTransport;
      const release = async () => {
        if (released) return;
        released = true;
        if (initializedSessionId) sessions.delete(initializedSessionId);
        this.requestServers.delete(requestServer);
        await requestServer.close();
      };
      transport = new WebStandardStreamableHTTPServerTransport({
        ...transportOptions,
        onsessioninitialized: async (id) => {
          await transportOptions.onsessioninitialized?.(id);
          initializedSessionId = id;
          sessions.set(id, { server: requestServer, transport, principal });
        },
        onsessionclosed: async (id) => {
          sessions.delete(id);
          try {
            await transportOptions.onsessionclosed?.(id);
          } finally {
            await release();
          }
        },
      });
      this.requestServers.add(requestServer);

      try {
        await configureRequestServer?.(requestServer);
        await requestServer.connect(transport);
        const response = await transport.handleRequest(request, handleOptions);
        if (initializedSessionId) return response;
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
