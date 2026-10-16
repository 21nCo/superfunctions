import type { BrowseFn, BrowseFnEvent } from "browsefn";
import type { AdminOperationContext } from "@superfunctions/admin";

export type BrowseFnProviderKind = "web" | "image" | "geo";

export interface BrowseFnAdminProvider {
  id: string;
  name: string;
  kind: BrowseFnProviderKind;
  available: true;
}

export interface BrowseFnAdminProviderMetric {
  name: string;
  requests: number;
  successes: number;
  failures: number;
  avgResponseTime: number;
}

export interface BrowseFnAdminMetrics {
  id: "current";
  totalRequests: number;
  successRate: number;
  avgResponseTime: number;
  cacheHitRate: number;
  byProvider: BrowseFnAdminProviderMetric[];
}

export interface BrowseFnAdminRateLimitStatus {
  id: string;
  provider: string;
  allowed: boolean;
  remaining: number | null;
  resetAt: number | null;
  limit: number | null;
  retryAfterMs: number | null;
}

export interface BrowseFnAdminLogEntry {
  id: string;
  event: BrowseFnEvent;
  operation: string | null;
  provider: string | null;
  durationMs: number | null;
  outcome: "success" | "error" | "fallback" | "rate-limited" | null;
  timestamp: number;
  requestId: string | null;
  cached: boolean | null;
  fallbackFrom: string | null;
  fallbackTo: string | null;
  retryAttempt: number | null;
}

export interface BrowseFnAdminCacheStatus {
  id: "cache";
  enabled: boolean;
  hits: number | null;
  misses: number | null;
  hitRate: number | null;
  size: number | null;
}

export interface BrowseFnListProvidersInput {}
export interface BrowseFnProviderListOutput {
  items: BrowseFnAdminProvider[];
  nextCursor: null;
}

export interface BrowseFnGetMetricsInput {
  timeRange?: "last-hour" | "last-24h" | "last-7d" | "all";
  groupBy?: "provider";
}
export interface BrowseFnMetricsOutput { item: BrowseFnAdminMetrics }

export interface BrowseFnGetRateLimitInput { provider: string }
export interface BrowseFnRateLimitOutput { item: BrowseFnAdminRateLimitStatus }

export interface BrowseFnListLogsInput {
  event?: BrowseFnEvent;
  provider?: string;
  since?: number;
  limit?: number;
}
export interface BrowseFnLogListOutput {
  items: BrowseFnAdminLogEntry[];
  nextCursor: null;
}

export interface BrowseFnGetCacheInput {}
export interface BrowseFnCacheOutput { item: BrowseFnAdminCacheStatus }

export interface BrowseFnClearMetricsInput { id: "current"; reason: string }
export interface BrowseFnClearLogsInput { id: "events"; reason: string }
export interface BrowseFnClearCacheInput { id: "cache"; reason: string }
export interface BrowseFnAcceptedOutput { accepted: true }

export interface BrowseFnAdminService {
  listProviders(input: BrowseFnListProvidersInput, context: AdminOperationContext): Promise<BrowseFnProviderListOutput>;
  getMetrics(input: BrowseFnGetMetricsInput, context: AdminOperationContext): Promise<BrowseFnMetricsOutput>;
  clearMetrics(input: BrowseFnClearMetricsInput, context: AdminOperationContext): Promise<BrowseFnAcceptedOutput>;
  getRateLimit(input: BrowseFnGetRateLimitInput, context: AdminOperationContext): Promise<BrowseFnRateLimitOutput>;
  listLogs(input: BrowseFnListLogsInput, context: AdminOperationContext): Promise<BrowseFnLogListOutput>;
  clearLogs(input: BrowseFnClearLogsInput, context: AdminOperationContext): Promise<BrowseFnAcceptedOutput>;
  getCache(input: BrowseFnGetCacheInput, context: AdminOperationContext): Promise<BrowseFnCacheOutput>;
  clearCache(input: BrowseFnClearCacheInput, context: AdminOperationContext): Promise<BrowseFnAcceptedOutput>;
}

export interface BrowseFnAdminScope {
  installationId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  namespace: string;
  region?: string;
}

export interface BrowseFnDomainAdminServiceOptions {
  /** One environment-owned BrowseFn instance. */
  browsefn: BrowseFn;
  /** Exact ownership boundary for that instance; wildcards are not accepted. */
  scope: BrowseFnAdminScope;
}
