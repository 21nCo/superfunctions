import { createObservabilityMiddleware, createRouter, type Router, type Route } from "@superfunctions/http";
import type { SearchAdapter } from "@searchfn/adapter-contracts";
import {
  normalizeObservability,
  type ObservabilityInput,
  type ObservationLogger,
  type SuperfunctionObservability,
} from "@superfunctions/observability";
import { errorResponse, parseJsonBody } from "./http/errors.js";
import {
  DEFAULT_LIMITS,
  type ServerLimits,
  validateObjectBody,
  validateResource,
  validateResourcesArray,
} from "./http/validation.js";
import { statusHandler, type ServerHealthSnapshot } from "./routes/status.js";
import { indexHandler } from "./routes/index.js";
import { searchHandler } from "./routes/search.js";
import { searchAllHandler } from "./routes/search-all.js";
import { removeHandler } from "./routes/remove.js";
import { clearHandler } from "./routes/clear.js";
import type { SearchFnEvent } from "./events.js";

export type ServerContext = Record<string, unknown>;
export type SearchFnAction = "status" | "index" | "search" | "searchAll" | "remove" | "clear";

interface SearchFnLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

export interface SearchFnServerConfig<TContext = unknown> {
  adapter: SearchAdapter;
  basePath?: string;
  limits?: Partial<ServerLimits>;
  /** Explicitly allow requests without a SearchFn authorization policy. */
  allowUnauthenticated?: boolean;
  /** Load per-request identity and other context from request metadata. */
  context?: (request: Request) => Promise<TContext> | TContext;
  /** Authorize the action and every validated resource in scope. Read POST fields from payload. */
  authorize?: (
    ctx: TContext,
    action: SearchFnAction,
    payload: unknown,
    request: Request,
    resources: readonly string[],
  ) => Promise<boolean> | boolean;
  observability?: ObservabilityInput<SearchFnEvent>;
}

export interface SearchFnServer<TContext = unknown> {
  router: Router<TContext>;
  close(): Promise<void>;
}

/** Redact sensitive keys from objects before logging. */
const SENSITIVE_KEYS = /apikey|password|secret|token|authorization|connectionstring/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

function redactContext(value: Record<string, unknown>): Record<string, unknown> {
  return redact(value) as Record<string, unknown>;
}

function toErrorLogContext(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }
  return {
    errorValue: String(error),
  };
}

export async function createSearchFnServer<TContext extends ServerContext = ServerContext>(
  config: SearchFnServerConfig<TContext>,
): Promise<SearchFnServer<TContext>> {
  const {
    adapter,
    basePath = "/searchfn",
    limits: limitsOverrides,
    context,
    authorize,
  } = config;

  if (typeof authorize !== "function" && (authorize !== undefined || config.allowUnauthenticated !== true)) {
    throw new TypeError("SearchFn requires authorize or allowUnauthenticated: true");
  }

  const observability = normalizeObservability<SearchFnEvent>(config.observability)?.child({
    component: "searchfn",
  });
  const logger = searchFnLoggerFromObservability(observability?.logger);
  const limits: ServerLimits = { ...DEFAULT_LIMITS, ...limitsOverrides };
  const startTime = Date.now();
  const health: ServerHealthSnapshot = {
    state: "ok",
    failureCount: 0,
  };
  const markDegraded = (): void => {
    health.state = "degraded";
    health.failureCount += 1;
    if (health.degradedSince === undefined) {
      health.degradedSince = Date.now();
    }
  };

  function wrap(
    action: SearchFnAction,
    handler: (req: Request, body: Record<string, unknown>) => Promise<Response>,
  ): (req: Request, ctx: TContext) => Promise<Response> {
    return async (req: Request, ctx: TContext): Promise<Response> => {
      const start = Date.now();
      const logCtx: Record<string, unknown> = {
        operation: action,
        adapter: adapter.name,
      };

      logger?.debug("request.start", redactContext(logCtx));

      function endRequest(response: Response): Response {
        if (response.status >= 500) markDegraded();
        logger?.info("request.end", redactContext({
          ...logCtx,
          durationMs: Date.now() - start,
          success: response.status < 400,
          status: response.status,
        }));
        return response;
      }

      let body: Record<string, unknown> = {};
      let resources: readonly string[] = [];
      if (action !== "status") {
        const parsed = await parseJsonBody(req, limits.maxPayloadBytes);
        if (!parsed.ok) return endRequest(parsed.response);

        const { value, error } = validateObjectBody(parsed.data);
        if (error) return endRequest(error);
        body = value;

        if (action === "searchAll") {
          if (Object.prototype.hasOwnProperty.call(body, "resource")) {
            return endRequest(errorResponse("DFQL_INVALID", "Use resources for search-all", { path: "resource" }));
          }
          const resourcesError = validateResourcesArray(body.resources, limits);
          if (resourcesError) return endRequest(resourcesError);
          resources = (body.resources as string[] | null | undefined) ?? [];
          if (authorize && resources.length === 0) {
            return endRequest(errorResponse("DFQL_INVALID", "Search-all requires at least one resource with authorization enabled", {
              path: "resources",
            }));
          }
        } else {
          if (Object.prototype.hasOwnProperty.call(body, "resources")) {
            return endRequest(errorResponse("DFQL_INVALID", "Use resource for this action", { path: "resources" }));
          }
          const resourceError = validateResource(body.resource);
          if (resourceError) return endRequest(resourceError);
          resources = [body.resource as string];
        }
      }

      if (authorize) {
        try {
          const policyContext = context ? { ...ctx, ...await context(req) } : ctx;
          // Give the policy its own snapshot so it cannot change what the adapter executes.
          const payload = action === "status" ? null : structuredClone(body);
          const allowed = await authorize(policyContext, action, payload, req, [...resources]);
          if (allowed !== true) {
            logger?.warn("authorization.denied", redactContext(logCtx));
            await emitSearchFnEvent(observability, {
              type: "searchfn.authorization.denied",
              severity: "warn",
              outcome: "denied",
              metadata: {
                operation: action,
                adapter: adapter.name,
              },
            });
            return endRequest(errorResponse("FORBIDDEN", "Authorization denied"));
          }
        } catch {
          // Identity and policy errors may contain credentials or other private values.
          logger?.error("authorization.error", redactContext(logCtx));
          await emitSearchFnEvent(observability, {
            type: "searchfn.authorization.failed",
            severity: "error",
            outcome: "error",
            metadata: {
              operation: action,
              adapter: adapter.name,
            },
          });
          return endRequest(errorResponse("FORBIDDEN", "Authorization denied"));
        }
      }

      try {
        return endRequest(await handler(req, body));
      } catch (error) {
        const durationMs = Date.now() - start;
        const errorContext = {
          ...logCtx,
          durationMs,
          success: false,
          errorCode: "INTERNAL",
          ...toErrorLogContext(error),
        };
        logger?.error("request.error", redactContext(errorContext));
        await emitSearchFnEvent(observability, {
          type: "searchfn.request.failed",
          severity: "error",
          outcome: "error",
          metadata: {
            operation: action,
            adapter: adapter.name,
            durationMs,
            errorCode: "INTERNAL",
            ...toErrorLogContext(error),
          },
        });
        return endRequest(errorResponse("INTERNAL", "Unexpected server error"));
      }
    };
  }

  const routes: Route<TContext>[] = [
    {
      method: "GET",
      path: `${basePath}/status`,
      handler: wrap("status", statusHandler(adapter, startTime, () => ({ ...health }))),
    },
    {
      method: "POST",
      path: `${basePath}/index`,
      handler: wrap("index", indexHandler(adapter, limits)),
    },
    {
      method: "POST",
      path: `${basePath}/search`,
      handler: wrap("search", searchHandler(adapter, limits)),
    },
    {
      method: "POST",
      path: `${basePath}/search-all`,
      handler: wrap("searchAll", searchAllHandler(adapter, limits)),
    },
    {
      method: "POST",
      path: `${basePath}/remove`,
      handler: wrap("remove", removeHandler(adapter)),
    },
    {
      method: "POST",
      path: `${basePath}/clear`,
      handler: wrap("clear", clearHandler(adapter)),
    },
  ];

  const router = createRouter<TContext>({
    routes,
    basePath: "/",
    middleware: observability
      ? [
          createObservabilityMiddleware({
            observability,
            serverTiming: true,
            headers: { prefix: "x-searchfn" },
          }),
        ]
      : undefined,
  });

  async function close(): Promise<void> {
    if (adapter.dispose) {
      await adapter.dispose();
    }
    logger?.info("server.close", { adapter: adapter.name });
  }

  return { router, close };
}

function searchFnLoggerFromObservability(
  logger: ObservationLogger | undefined,
): SearchFnLogger | undefined {
  if (!logger) return undefined;
  return {
    debug: (message, context) => logger.debug?.(message, context),
    info: (message, context) => logger.info?.(message, context),
    warn: (message, context) => logger.warn?.(message, context),
    error: (message, context) => logger.error?.(message, context),
  };
}

async function emitSearchFnEvent(
  observability: SuperfunctionObservability<SearchFnEvent> | undefined,
  event: Omit<SearchFnEvent, "domain">,
): Promise<void> {
  await observability?.events.emit({
    domain: "searchfn",
    ...event,
  } as SearchFnEvent);
}
