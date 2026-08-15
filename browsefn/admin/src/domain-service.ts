import { AdminError, type AdminOperationContext } from "@superfunctions/admin";
import {
  normalizeGeoProviderId,
  normalizeImageProviderId,
  normalizeWebProviderId,
} from "browsefn";
import type {
  BrowseFnAcceptedOutput,
  BrowseFnAdminLogEntry,
  BrowseFnAdminRateLimitStatus,
  BrowseFnAdminService,
  BrowseFnClearCacheInput,
  BrowseFnClearLogsInput,
  BrowseFnClearMetricsInput,
  BrowseFnDomainAdminServiceOptions,
  BrowseFnGetCacheInput,
  BrowseFnGetMetricsInput,
  BrowseFnGetRateLimitInput,
  BrowseFnListLogsInput,
  BrowseFnListProvidersInput,
} from "./types.js";

function requireNonBlank(value: string, label: string): void {
  if (!value.trim() || value.trim() === "*") {
    throw new AdminError("invalid_argument", `BrowseFn admin binding requires a concrete ${label}.`);
  }
}

function requireIdempotency(context: AdminOperationContext): void {
  if (!context.idempotencyKey) {
    throw new AdminError("precondition_failed", "BrowseFn maintenance operations require an idempotency key.");
  }
}

function finite(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function logId(entry: { event: string; operation?: string; timestamp: number }, index: number): string {
  return `${entry.timestamp}:${entry.event}:${entry.operation ?? "unknown"}:${index}`;
}

function assertTarget(actual: string, expected: string): void {
  if (actual !== expected) throw new AdminError("invalid_argument", `BrowseFn maintenance target must be ${expected}.`);
}

function canonicalProvider(value: string): string {
  requireNonBlank(value, "provider");
  const normalized = normalizeWebProviderId(value)
    ?? normalizeImageProviderId(value)
    ?? normalizeGeoProviderId(value);
  if (!normalized) throw new AdminError("invalid_argument", "BrowseFn provider is not recognized.");
  return normalized;
}

/**
 * Binds the public BrowseFn facade for one exact deployed environment. The
 * admin layer does not reach into provider registries, loggers, metrics
 * collectors, cache internals, credentials, or browser sessions.
 */
export function createBrowseFnDomainAdminService(
  options: BrowseFnDomainAdminServiceOptions,
): BrowseFnAdminService {
  for (const key of ["installationId", "workspaceId", "projectId", "environmentId", "namespace"] as const) {
    requireNonBlank(options.scope[key], `scope.${key}`);
  }
  if (options.scope.region !== undefined) requireNonBlank(options.scope.region, "scope.region");

  const assertScope = (context: AdminOperationContext): void => {
    const actualInstallation = context.scope.installationId ?? context.scope.organizationId;
    if (
      actualInstallation !== options.scope.installationId ||
      (context.scope.organizationId !== undefined && context.scope.organizationId !== options.scope.installationId) ||
      context.scope.workspaceId !== options.scope.workspaceId ||
      context.scope.projectId !== options.scope.projectId ||
      context.scope.environmentId !== options.scope.environmentId ||
      context.scope.namespace !== options.scope.namespace ||
      (options.scope.region !== undefined && context.scope.region !== options.scope.region)
    ) {
      throw new AdminError("forbidden", "The active scope cannot access this BrowseFn environment.");
    }
  };

  return {
    async listProviders(_input: BrowseFnListProvidersInput, context) {
      assertScope(context);
      const [web, image, geo] = await Promise.all([
        options.browsefn.web.listProviders(),
        options.browsefn.images.listProviders(),
        options.browsefn.geo.listProviders(),
      ]);
      const items = ([
        ...web.map((name) => ({ id: `web:${name}`, name, kind: "web" as const, available: true as const })),
        ...image.map((name) => ({ id: `image:${name}`, name, kind: "image" as const, available: true as const })),
        ...geo.map((name) => ({ id: `geo:${name}`, name, kind: "geo" as const, available: true as const })),
      ]).sort((left, right) => left.id.localeCompare(right.id));
      return { items, nextCursor: null };
    },

    async getMetrics(input: BrowseFnGetMetricsInput, context) {
      assertScope(context);
      const metrics = await options.browsefn.getMetrics(input);
      return {
        item: {
          id: "current" as const,
          totalRequests: metrics.totalRequests,
          successRate: metrics.successRate,
          avgResponseTime: metrics.avgResponseTime,
          cacheHitRate: metrics.cacheHitRate ?? 0,
          byProvider: metrics.byProvider,
        },
      };
    },

    async clearMetrics(input: BrowseFnClearMetricsInput, context): Promise<BrowseFnAcceptedOutput> {
      assertScope(context);
      requireIdempotency(context);
      assertTarget(input.id, "current");
      options.browsefn.clearMetrics();
      return { accepted: true };
    },

    async getRateLimit(input: BrowseFnGetRateLimitInput, context) {
      assertScope(context);
      const provider = canonicalProvider(input.provider);
      const status = options.browsefn.getRateLimitStatus(provider);
      const item: BrowseFnAdminRateLimitStatus = {
        id: provider,
        provider: canonicalProvider(status.provider ?? provider),
        allowed: status.allowed !== false,
        remaining: finite(status.remaining),
        resetAt: finite(status.resetAt),
        limit: finite(status.limit),
        retryAfterMs: finite(status.retryAfterMs),
      };
      return { item };
    },

    async listLogs(input: BrowseFnListLogsInput, context) {
      assertScope(context);
      const logs = options.browsefn.getLogs({ event: input.event, provider: input.provider, since: input.since });
      const start = Math.max(0, logs.length - (input.limit ?? 100));
      const items: BrowseFnAdminLogEntry[] = logs.slice(start).map((entry, index) => ({
        id: logId(entry, start + index),
        event: entry.event,
        operation: entry.operation ?? null,
        provider: entry.provider ?? null,
        durationMs: finite(entry.duration),
        outcome: entry.outcome ?? null,
        timestamp: entry.timestamp,
        requestId: entry.requestId ?? null,
        cached: typeof entry.cached === "boolean" ? entry.cached : null,
        fallbackFrom: entry.fallbackFrom ?? null,
        fallbackTo: entry.fallbackTo ?? null,
        retryAttempt: finite(entry.retryAttempt),
      }));
      return { items, nextCursor: null };
    },

    async clearLogs(input: BrowseFnClearLogsInput, context): Promise<BrowseFnAcceptedOutput> {
      assertScope(context);
      requireIdempotency(context);
      assertTarget(input.id, "events");
      options.browsefn.clearLogs();
      return { accepted: true };
    },

    async getCache(_input: BrowseFnGetCacheInput, context) {
      assertScope(context);
      const stats = await options.browsefn.cache?.getStats();
      return {
        item: {
          id: "cache" as const,
          enabled: options.browsefn.cache?.isEnabled() === true,
          hits: stats?.hits ?? null,
          misses: stats?.misses ?? null,
          hitRate: stats?.hitRate ?? null,
          size: stats?.size ?? null,
        },
      };
    },

    async clearCache(input: BrowseFnClearCacheInput, context): Promise<BrowseFnAcceptedOutput> {
      assertScope(context);
      requireIdempotency(context);
      assertTarget(input.id, "cache");
      await options.browsefn.clearCache();
      return { accepted: true };
    },
  };
}
