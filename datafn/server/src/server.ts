/**
 * DataFn Server Factory
 * Creates a Router with datafn endpoints
 */

import type { DatafnSchema, DatafnPlugin, RetentionConfig, RateLimitConfig, ObservabilityConfig } from "./core-types.js";
import { validateSchema, ensureBuiltinKv } from "@datafn/core";
import { createRouter, type Router, type Route } from "@superfunctions/http";
import type { Adapter, RedisAdapter, KVStoreAdapter } from "@superfunctions/db";
import type { AuthContext, AuthContextProvider } from "@superfunctions/auth";
import type { DbMapping, SequenceStore } from "./execution/sync/sequence-store.js";
import { createSequenceStore } from "./execution/sync/sequence-store.js";
import { createStatusHandler } from "./routes/status.js";
import { createQueryHandler } from "./routes/query.js";
import { createMutationHandler } from "./routes/mutation.js";
import { createTransactHandler } from "./routes/transact.js";
import {
  createCloneHandler,
  createPullHandler,
  createPushHandler,
  createReconcileHandler,
} from "./routes/sync.js";
import { createSeedHandler } from "./routes/seed.js";
import { DbIdempotencyStore } from "./execution/idempotency-db.js";
import { ChangeTrackingService } from "./execution/sync/change-tracking.js";
import { errorResponse, errorToEnvelope } from "./http/errors.js";
import { createRestRoutes } from "./routes/rest.js";
import { enforcePayloadLimit } from "./http/middleware.js";
import { WebSocketManager, type WebSocketClient } from "./ws.js";
import {
  RedisRateLimiter,
  MemoryRateLimiter,
  createRateLimitMiddleware,
} from "./middleware/rate-limit.js";
import { createTimingEmitter, type TimingEmitter } from "./middleware/timing.js";

/**
 * Server configuration
 */
export interface DatafnServerConfig<TContext = any> {
  /** DataFn schema (will be validated at startup) */
  schema: DatafnSchema;

  /** Database adapter (required for persistence) */
  db?: Adapter;

  /** Optional plugins */
  plugins?: DatafnPlugin[];

  /** Optional authorization callback */
  authorize?: (
    ctx: TContext,
    action:
      | "status"
      | "query"
      | "mutation"
      | "transact"
      | "seed"
      | "clone"
      | "pull"
      | "push"
      | "reconcile",
    payload: unknown,
  ) => Promise<boolean> | boolean;

  /** Optional limits configuration */
  limits?: {
    maxLimit?: number;
    maxTransactSteps?: number;
    maxPayloadBytes?: number;
    /** Max changes returned per pull request. Default: 1000. */
    maxPullLimit?: number;
  };

  /** Optional server time provider (for testing) */
  getServerTime?: () => number;

  /**
   * Optional flag to enable REST endpoint generation (default: false)
   * When true, generates REST wrappers:
   * - GET /datafn/resources/:resource (query wrapper)
   * - POST /datafn/resources/:resource (insert/merge wrapper)
   * - PATCH /datafn/resources/:resource/:id (merge wrapper)
   * - DELETE /datafn/resources/:resource/:id (delete wrapper)
   */
  rest?: boolean;

  /**
   * Optional auth context provider for per-user/tenant serverSeq isolation.
   * When provided, extracts user/tenant context from request context to create
   * isolated namespaces for change tracking (e.g., "user:123" or "tenant:456:user:123").
   * Without this, all users share the default "datafn" namespace.
   * 
   * The provider's `getContext()` receives the request context (TContext) and should
   * return an AuthContext with at least `userId`.
   * 
   * @example
   * ```typescript
   * authContextProvider: {
   *   getContext: (ctx) => ({
   *     userId: ctx.session.userId,
   *     tenantId: ctx.session.tenantId,
   *   }),
   * }
   * ```
   */
  authContextProvider?: {
    getContext: (ctx: TContext) => AuthContext | Promise<AuthContext>;
  };

  /**
   * Optional Redis adapter for atomic operations (serverSeq, rate limiting, caching).
   * When provided with appropriate dbMapping, enables high-performance atomic operations.
   * 
   * @example
   * ```typescript
   * redis: myRedisAdapter,
   * dbMapping: { serverseq: "redis" }
   * ```
   */
  redis?: RedisAdapter;

  /**
   * Optional KV store adapter for simple key-value operations.
   * Must support `incr()` to be used for serverSeq generation.
   * 
   * @example
   * ```typescript
   * kvStore: myKVAdapter,
   * dbMapping: { serverseq: "kv" }
   * ```
   */
  kvStore?: KVStoreAdapter;

  /**
   * Database mapping configuration - specifies which database to use for each feature.
   * Defaults to using the main database ("db") for all features.
   * 
   * @example
   * ```typescript
   * dbMapping: {
   *   serverseq: "redis",     // Use Redis for serverSeq (atomic INCR)
   *   ratelimiting: "redis",  // Use Redis for rate limiting
   *   cache: "kv",            // Use KV store for caching
   * }
   * ```
   */
  dbMapping?: DbMapping;

  /** Data retention configuration for __datafn_changes and __datafn_idempotency tables. */
  retention?: RetentionConfig;

  /** Rate limiting configuration (RATE-001 through RATE-005). */
  rateLimit?: RateLimitConfig<TContext>;

  /** Observability configuration (OBS-001 through OBS-004). */
  observability?: ObservabilityConfig;
}

/**
 * Server instance
 */
export interface DatafnServer<TContext = any> {
  router: Router<TContext>;
  websocketHandler: {
    addClient(client: WebSocketClient): void;
    removeClient(client: WebSocketClient): void;
    handleMessage(client: WebSocketClient, data: string): void;
  };
  /** Stop the server: clears any active pruning interval. */
  close(): void;
}

/**
 * Create a DataFn server
 */
export async function createDatafnServer<TContext = any>(
  config: DatafnServerConfig<TContext>,
): Promise<DatafnServer<TContext>> {
  // Validate schema at startup
  const schemaValidation = validateSchema(config.schema);
  if (!schemaValidation.ok) {
    throw new Error(
      `Schema validation failed: ${schemaValidation.error.message}`,
    );
  }

  // Ensure built-in KV resource exists (KV-001)
  const validatedSchema = ensureBuiltinKv(schemaValidation.result);

  // Initialize database adapter if provided and implements Adapter interface
  if (
    config.db &&
    typeof config.db === "object" &&
    "initialize" in config.db &&
    typeof config.db.initialize === "function"
  ) {
    await config.db.initialize();
  }

  // Startup pruning (RET-004)
  if (config.retention?.pruneOnStartup && config.db) {
    try {
      const ct = new ChangeTrackingService(config.db, "datafn");
      if (config.retention.changeLogDays) {
        const deleted = await ct.pruneChanges(config.retention.changeLogDays);
        console.info(`Pruned ${deleted} change log entries`);
      }
      const idempotencyStoreForPrune = config.db
        ? new DbIdempotencyStore(config.db)
        : undefined;
      if (config.retention.idempotencyDays && idempotencyStoreForPrune) {
        const deleted = await idempotencyStoreForPrune.pruneIdempotency(config.retention.idempotencyDays);
        console.info(`Pruned ${deleted} idempotency entries`);
      }
    } catch (error) {
      console.warn("Startup pruning failed:", error);
    }
  }

  // Initialize Redis adapter health check if provided
  if (config.redis) {
    try {
      const healthy = await config.redis.isHealthy();
      if (!healthy) {
        console.warn("Redis adapter health check failed, will fallback to main database for secondary operations");
      }
    } catch (error) {
      console.warn("Redis adapter health check error:", error);
    }
  }

  // Create sequence store based on configuration (Redis/KV/DB fallback)
  const sequenceStore = createSequenceStore({
    db: config.db,
    redis: config.redis,
    kvStore: config.kvStore,
    dbMapping: config.dbMapping,
  });

  // Compute limits with defaults
  const limits = {
    maxLimit: config.limits?.maxLimit ?? 100,
    maxTransactSteps: config.limits?.maxTransactSteps,
    maxPayloadBytes: config.limits?.maxPayloadBytes,
    maxPullLimit: config.limits?.maxPullLimit ?? 1000,
  };

  // Observability: create timing emitter (OBS-004)
  const timingEmitter = createTimingEmitter(config.observability);

  // Rate limiting setup (RATE-001 through RATE-005)
  let rateLimitMiddleware: ((endpoint: string, ctx: TContext) => Promise<Response | null>) | null = null;

  if (config.rateLimit?.enabled) {
    const limiter = config.redis
      ? new RedisRateLimiter(config.redis)
      : new MemoryRateLimiter();

    const defaultKeyExtractor = async (ctx: TContext): Promise<string> => {
      if (config.authContextProvider) {
        try {
          const authContext = await config.authContextProvider.getContext(ctx);
          if (authContext?.userId) return String(authContext.userId);
        } catch { /* fall through */ }
      }
      return "anonymous";
    };

    rateLimitMiddleware = createRateLimitMiddleware({
      limiter,
      maxRequests: config.rateLimit.maxRequests ?? 100,
      windowSeconds: config.rateLimit.windowSeconds ?? 60,
      endpoints: config.rateLimit.endpoints,
      keyExtractor: config.rateLimit.keyExtractor ?? defaultKeyExtractor,
    });
  }

  // Periodic pruning interval (RET-005)
  let pruneInterval: ReturnType<typeof setInterval> | null = null;
  if (config.retention?.pruneIntervalMs && config.db) {
    const intervalMs = Math.max(config.retention.pruneIntervalMs, 60000);
    const dbForInterval = config.db;
    const retentionForInterval = config.retention;
    pruneInterval = setInterval(async () => {
      try {
        const ct = new ChangeTrackingService(dbForInterval, "datafn");
        if (retentionForInterval.changeLogDays) {
          const deleted = await ct.pruneChanges(retentionForInterval.changeLogDays);
          console.info(`Periodic prune: removed ${deleted} change log entries`);
        }
        const idStore = new DbIdempotencyStore(dbForInterval);
        if (retentionForInterval.idempotencyDays) {
          const deleted = await idStore.pruneIdempotency(retentionForInterval.idempotencyDays);
          console.info(`Periodic prune: removed ${deleted} idempotency entries`);
        }
      } catch (e) {
        console.warn("Periodic prune failed:", e);
      }
    }, intervalMs);
  }

  // Helper to extract namespace from context using authContextProvider
  const extractNamespace = async (ctx: TContext): Promise<string> => {
    if (!config.authContextProvider) {
      return "datafn";
    }
    try {
      const authContext = await config.authContextProvider.getContext(ctx);
      if (authContext?.userId) {
        return authContext.tenantId
          ? `tenant:${authContext.tenantId}:user:${authContext.userId}`
          : `user:${authContext.userId}`;
      }
      console.warn("authContextProvider returned context without userId, using default namespace");
      return "datafn";
    } catch (error) {
      console.error("Failed to extract auth context for namespace, using default:", error);
      return "datafn";
    }
  };

  // Create route handlers
  const statusHandler = createStatusHandler(
    validatedSchema,
    limits,
    config.getServerTime,
    config.db,
  );

  const queryHandler = createQueryHandler(
    validatedSchema,
    limits.maxLimit,
    config.db, // Pass adapter (not MemoryStore)
    config.plugins || [],
    extractNamespace,
    timingEmitter,
  );

  // Create mutation handler and idempotency store
  const idempotencyStore = config.db
    ? new DbIdempotencyStore(config.db)
    : undefined;

  const mutationHandler = createMutationHandler(
    validatedSchema,
    config.db, // Pass adapter
    idempotencyStore,
    config.plugins || [], // Pass plugins
    extractNamespace,
    sequenceStore,
    timingEmitter,
  );

  const transactHandler = createTransactHandler(
    validatedSchema,
    config.db, // Pass adapter
    idempotencyStore,
    limits,
    extractNamespace,
    sequenceStore,
  );

  const cloneHandler = createCloneHandler(
    validatedSchema,
    config.db,
    config.plugins || [],
    extractNamespace,
    sequenceStore,
  );
  const pullHandler = createPullHandler(
    validatedSchema,
    config.db,
    config.plugins || [],
    extractNamespace,
    sequenceStore,
    limits.maxPullLimit,
    timingEmitter,
  );
  const reconcileHandler = createReconcileHandler(
    validatedSchema,
    config.db,
    config.plugins || [],
    extractNamespace,
    sequenceStore,
  );

  // WebSocket Manager
  const wsManager = new WebSocketManager();

  const pushHandler = createPushHandler(
    validatedSchema,
    config.db,
    idempotencyStore,
    config.plugins || [],
    extractNamespace,
    sequenceStore,
    (seq) => wsManager.broadcastCursor(String(seq)),
    timingEmitter,
  );
  const seedHandler = createSeedHandler(config.db);

  // Authorization wrapper
  // AUTH-001: Parse JSON BEFORE authorization. Invalid JSON returns DFQL_INVALID, not FORBIDDEN.
  const withAuth = (
    action:
      | "status"
      | "query"
      | "mutation"
      | "transact"
      | "seed"
      | "clone"
      | "pull"
      | "push"
      | "reconcile",
    handler: (
      req: Request,
      ctx: TContext & { parsedBody?: unknown },
    ) => Promise<Response> | Response,
  ) => {
    return async (req: Request, ctx: TContext & { parsedBody?: unknown }): Promise<Response> => {
      // Rate limiting — applied BEFORE JSON parsing and authorization (RATE-001)
      if (rateLimitMiddleware) {
        const rateLimitResponse = await rateLimitMiddleware(action, ctx);
        if (rateLimitResponse) return rateLimitResponse;
      }

      // Enforce payload limits (LIMIT-001)
      if (limits.maxPayloadBytes) {
        const limiter = enforcePayloadLimit(limits.maxPayloadBytes);
        const limitRes = await limiter(req, async () => new Response("OK")); // Dummy next
        // Middleware logic in enforcePayloadLimit calls next() if ok.
        // If it returns a Response (error), we stop.
        // But my middleware implementation: `return next()`.
        // If I pass dummy next that returns generic Response, I can check if it matches.
        // Or better: refactor middleware to return validation result or check directly here.
        // enforcePayloadLimit returns a handler `(req, next) => Res`.
        // We can invoke it. If it returns the result of next(), we proceed.
        // Since `next` returns Promise<Response>, we can use a sentinel.
        
        // Simpler: Just verify inline or use the helper properly.
        // Helper:
        /*
        return async (req, next) => {
            // check
            if (bad) return error;
            return next();
        }
        */
        const nextSentinel = new Response("__NEXT__");
        const res = await limiter(req, async () => nextSentinel);
        if (res !== nextSentinel) {
            return res; // Error response
        }
      }

      // For POST/PUT/PATCH endpoints, parse JSON body FIRST before authorization
      // AUTH-001: Invalid JSON must return DFQL_INVALID, never FORBIDDEN
      let payload: unknown = null;

      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        const { parseJsonBody } = await import("./http/json.js");
        const parseResult = await parseJsonBody(req);

        if (!parseResult.ok) {
          // JSON parsing failed - return DFQL_INVALID immediately WITHOUT calling authorize
          return errorResponse(parseResult.error, 400);
        }

        // Parsing succeeded - use parsed data
        payload = parseResult.data;
        // Store parsed body in context so handler doesn't need to re-parse
        ctx.parsedBody = payload;
      }

      // For GET endpoints (like /datafn/status), payload remains null
      // This is correct per AUTH-001: GET /datafn/status calls authorize with null

      // Check authorization if configured - only called AFTER successful JSON parse
      if (config.authorize) {
        const authorized = await config.authorize(ctx, action, payload);
        if (!authorized) {
          return errorResponse(
            { code: "FORBIDDEN", message: "Authorization denied", details: { path: "$" } },
            403,
          );
        }
      }

      return handler(req, ctx);
    };
  };

  // Define routes
  const routes: Route<TContext>[] = [
    {
      method: "GET",
      path: "/datafn/status",
      handler: withAuth("status" as any, statusHandler) as any,
    },
    {
      method: "POST",
      path: "/datafn/query",
      handler: withAuth("query", queryHandler) as any,
    },
    {
      method: "POST",
      path: "/datafn/mutation",
      handler: withAuth("mutation", mutationHandler) as any,
    },
    {
      method: "POST",
      path: "/datafn/transact",
      handler: withAuth("transact", transactHandler) as any,
    },
    {
      method: "POST",
      path: "/datafn/clone",
      handler: withAuth("clone", cloneHandler) as any,
    },
    {
      method: "POST",
      path: "/datafn/pull",
      handler: withAuth("pull", pullHandler) as any,
    },
    {
      method: "POST",
      path: "/datafn/push",
      handler: withAuth("push", pushHandler) as any,
    },
    {
      method: "POST",
      path: "/datafn/reconcile",
      handler: withAuth("reconcile", reconcileHandler) as any,
    },
    {
      method: "POST",
      path: "/datafn/seed",
      handler: withAuth("seed", seedHandler) as any,
    },
  ];

  // Register REST routes if config.rest is true
  if (config.rest) {
    const restRoutes = createRestRoutes(
      validatedSchema,
      // Bind mutation handler's execution
      (m) =>
        mutationHandler(
          // Mock request for handler reusing logic?
          // Or we should extract the execute function.
          // `mutationHandler` is a (req) -> Res.
          // We need direct access to `executeMutation`.
          // The `createMutationHandler` creates an executor internally?
          // Let's refactor or expose it.
          // Looking at lines 117+, we create handler, not executor.
          // But usually we can reuse the handler logic by constructing a fake Request?
          // Creating fake requests is expensive/hacky.
          // Ideally `createMutationHandler` should expose the logic.
          // However, for Phase 26 we can try to reuse the handlers by creating synthetic requests
          // OR (better) we should expose `executor` from `createDatafnServer` context if possible.
          // But `createDatafnServer` creates handlers via factory functions.
          // Let's look at `createMutationHandler`. It likely instantiates a `MutationExecutor`.
          // We should probably instantiate `QueryExecutor` and `MutationExecutor` centrally in `createDatafnServer`
          // and pass them to ANY handler (including REST).
          // But that's a refactor.
          // Alternative: The REST handler constructs a DFQL request and passes it to... where?
          // It calls `executeMutation` which returns `Promise<unknown>`.
          // If we don't refactor, we can simulate:
          new Request("http://localhost/datafn/mutation", {
            method: "POST",
            body: JSON.stringify(m),
          }),
        ).then(async (res) => {
          if (!res.ok) {
            // Parse error envelope
            const env = await res.json() as { ok: boolean; error?: unknown; result?: unknown };
            if (!env.ok) throw env.error;
            return env.result;
          }
          const env = await res.json() as { ok: boolean; error?: unknown; result?: unknown };
          return env.result; // Unwrap
        }),
      (q) =>
        queryHandler(
          new Request("http://localhost/datafn/query", {
            method: "POST",
            body: JSON.stringify(q),
          }),
        ).then(async (res) => {
          const env = await res.json() as { ok: boolean; error?: unknown; result?: unknown };
          if (!env.ok) throw env.error;
          return env.result;
        }),
    );

    // Map REST routes to router format and apply auth if needed
    // REST wrappers are just alternative interfaces to mutation/query, so we check "mutation"/"query" action?
    // Or introduce "rest" action.
    // For granularity, let's map: GET -> "query", POST/PATCH/DELETE -> "mutation".
    for (const route of restRoutes) {
      const action = route.method === "GET" ? "query" : "mutation";
      routes.push({
        ...route,
        handler: withAuth(action as any, route.handler as any) as any,
      });
    }
  }

  // Create router
  const router = createRouter<TContext>({
    routes,
    basePath: "/",
  });

  return {
    router,
    websocketHandler: {
      addClient: (client) => wsManager.addClient(client),
      removeClient: (client) => wsManager.removeClient(client),
      handleMessage: (client, data) => wsManager.handleMessage(client, data),
    },
    close: () => {
      if (pruneInterval) {
        clearInterval(pruneInterval);
        pruneInterval = null;
      }
    },
  };
}
