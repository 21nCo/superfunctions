import {
  defineAdminCapability,
  type AdminJsonSchema,
  type AdminObjectSchema,
  type AdminOperationDefinition,
  type AdminResourceDefinition,
} from "@superfunctions/admin";
import type {
  BrowseFnAcceptedOutput,
  BrowseFnCacheOutput,
  BrowseFnClearCacheInput,
  BrowseFnClearLogsInput,
  BrowseFnClearMetricsInput,
  BrowseFnGetCacheInput,
  BrowseFnGetMetricsInput,
  BrowseFnGetRateLimitInput,
  BrowseFnListLogsInput,
  BrowseFnListProvidersInput,
  BrowseFnLogListOutput,
  BrowseFnMetricsOutput,
  BrowseFnProviderListOutput,
  BrowseFnRateLimitOutput,
} from "./types.js";

const stringSchema = { type: "string", minLength: 1 } as const;
const nullableStringSchema: AdminJsonSchema = { type: ["string", "null"] };
const numberSchema = { type: "number", minimum: 0 } as const;
const nullableNumberSchema: AdminJsonSchema = { type: ["number", "null"], minimum: 0 };
const integerSchema = { type: "integer", minimum: 0 } as const;
const nullableIntegerSchema: AdminJsonSchema = { type: ["integer", "null"], minimum: 0 };
const emptyInputSchema: AdminObjectSchema = { type: "object", additionalProperties: false };
function clearInputSchema(id: "current" | "events" | "cache"): AdminObjectSchema {
  return {
    type: "object",
    properties: {
      id: { type: "string", const: id },
      reason: { type: "string", minLength: 3, maxLength: 500 },
    },
    required: ["id", "reason"],
    additionalProperties: false,
  };
}
const acceptedOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { accepted: { type: "boolean", const: true } },
  required: ["accepted"],
  additionalProperties: false,
};

const providerSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    name: stringSchema,
    kind: { type: "string", enum: ["web", "image", "geo"] },
    available: { type: "boolean", const: true },
  },
  required: ["id", "name", "kind", "available"],
  additionalProperties: false,
};

const providerMetricSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    name: stringSchema,
    requests: integerSchema,
    successes: integerSchema,
    failures: integerSchema,
    avgResponseTime: numberSchema,
  },
  required: ["name", "requests", "successes", "failures", "avgResponseTime"],
  additionalProperties: false,
};

const metricsSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", const: "current" },
    totalRequests: integerSchema,
    successRate: { type: "number", minimum: 0, maximum: 100 },
    avgResponseTime: numberSchema,
    cacheHitRate: { type: "number", minimum: 0, maximum: 100 },
    byProvider: { type: "array", items: providerMetricSchema },
  },
  required: ["id", "totalRequests", "successRate", "avgResponseTime", "cacheHitRate", "byProvider"],
  additionalProperties: false,
};

const rateLimitSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    provider: stringSchema,
    allowed: { type: "boolean" },
    remaining: nullableNumberSchema,
    resetAt: nullableNumberSchema,
    limit: nullableNumberSchema,
    retryAfterMs: nullableNumberSchema,
  },
  required: ["id", "provider", "allowed", "remaining", "resetAt", "limit", "retryAfterMs"],
  additionalProperties: false,
};

const eventSchema = {
  type: "string",
  enum: ["request", "response", "error", "cache.hit", "cache.miss", "rateLimit", "provider.fallback"],
} as const;
const outcomeSchema: AdminJsonSchema = {
  type: ["string", "null"],
  enum: ["success", "error", "fallback", "rate-limited", null],
};
const logSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    event: eventSchema,
    operation: nullableStringSchema,
    provider: nullableStringSchema,
    durationMs: nullableNumberSchema,
    outcome: outcomeSchema,
    timestamp: integerSchema,
    requestId: nullableStringSchema,
    cached: { type: ["boolean", "null"] },
    fallbackFrom: nullableStringSchema,
    fallbackTo: nullableStringSchema,
    retryAttempt: nullableIntegerSchema,
  },
  required: [
    "id", "event", "operation", "provider", "durationMs", "outcome", "timestamp",
    "requestId", "cached", "fallbackFrom", "fallbackTo", "retryAttempt",
  ],
  additionalProperties: false,
};

const cacheSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", const: "cache" },
    enabled: { type: "boolean" },
    hits: nullableIntegerSchema,
    misses: nullableIntegerSchema,
    hitRate: { type: ["number", "null"], minimum: 0, maximum: 100 },
    size: nullableIntegerSchema,
  },
  required: ["id", "enabled", "hits", "misses", "hitRate", "size"],
  additionalProperties: false,
};

function listSchema(item: AdminObjectSchema): AdminObjectSchema {
  return {
    type: "object",
    properties: { items: { type: "array", items: item }, nextCursor: { type: "null" } },
    required: ["items", "nextCursor"],
    additionalProperties: false,
  };
}

function itemSchema(item: AdminObjectSchema): AdminObjectSchema {
  return {
    type: "object",
    properties: { item },
    required: ["item"],
    additionalProperties: false,
  };
}

export const browseFnAdminResources = [
  {
    id: "providers", label: "Available providers",
    description: "Providers reported available by the mounted BrowseFn web, image, and geo services.",
    icon: "browsefn:providers", risk: "standard", minimumScope: "environment", idField: "id",
    displayFields: ["id", "name", "kind", "available"], searchableFields: ["id", "name"],
    filterableFields: ["kind"], sortableFields: ["name", "kind"], sensitiveFields: [],
  },
  {
    id: "metrics", label: "Metrics",
    description: "In-process request metrics exposed by the mounted BrowseFn facade.",
    icon: "browsefn:metrics", risk: "standard", minimumScope: "environment", idField: "id",
    displayFields: ["id", "totalRequests", "successRate", "avgResponseTime", "cacheHitRate"],
    searchableFields: [], filterableFields: [], sortableFields: [], sensitiveFields: [],
  },
  {
    id: "rate-limits", label: "Rate limits",
    description: "Last-known rate-limit status for an explicitly named provider.",
    icon: "browsefn:rate-limits", risk: "standard", minimumScope: "environment", idField: "id",
    displayFields: ["provider", "allowed", "remaining", "limit", "resetAt"],
    searchableFields: ["provider"], filterableFields: ["allowed"], sortableFields: ["provider"], sensitiveFields: [],
  },
  {
    id: "logs", label: "Event logs",
    description: "Sanitized in-process BrowseFn request lifecycle events; URLs, error bodies, and arbitrary details are excluded.",
    icon: "browsefn:logs", risk: "sensitive", minimumScope: "environment", idField: "id",
    displayFields: ["event", "operation", "provider", "outcome", "timestamp"],
    searchableFields: ["operation", "provider", "requestId"], filterableFields: ["event", "provider", "outcome"],
    sortableFields: ["timestamp"], sensitiveFields: ["requestId"],
  },
  {
    id: "cache", label: "Cache",
    description: "Aggregate state of the optional cache attached to the mounted BrowseFn facade.",
    icon: "browsefn:cache", risk: "standard", minimumScope: "environment", idField: "id",
    displayFields: ["enabled", "size", "hits", "misses", "hitRate"],
    searchableFields: [], filterableFields: ["enabled"], sortableFields: [], sensitiveFields: [],
  },
] as const satisfies readonly AdminResourceDefinition[];

const listProviders = {
  id: "browsefn.providers.list", title: "List available providers",
  description: "List providers reported available through BrowseFn's public web, image, and geo APIs.",
  inputSchema: emptyInputSchema, outputSchema: listSchema(providerSchema),
  route: { method: "GET", path: "/resources/providers" }, permission: "browsefn.providers.read", minimumScope: "environment",
  safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" },
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, target: { resource: "providers", collection: true },
} as const satisfies AdminOperationDefinition<BrowseFnListProvidersInput, BrowseFnProviderListOutput>;

const getMetricsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    timeRange: { type: "string", enum: ["last-hour", "last-24h", "last-7d", "all"] },
    groupBy: { type: "string", enum: ["provider"] },
  },
  additionalProperties: false,
};
const getMetrics = {
  id: "browsefn.metrics.get", title: "Get metrics",
  description: "Read aggregate metrics from BrowseFn's public metrics API.",
  inputSchema: getMetricsInputSchema, outputSchema: itemSchema(metricsSchema),
  route: { method: "GET", path: "/resources/metrics/current" }, permission: "browsefn.metrics.read", minimumScope: "environment",
  safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" },
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, target: { resource: "metrics", collection: true },
} as const satisfies AdminOperationDefinition<BrowseFnGetMetricsInput, BrowseFnMetricsOutput>;

function clearOperation<TInput, TOutput extends BrowseFnAcceptedOutput>(
  resource: "metrics" | "logs" | "cache",
  id: "current" | "events" | "cache",
  title: string,
  confirmationReason: string,
) {
  return {
    id: `browsefn.${resource}.clear`, title,
    description: `${title} on the mounted BrowseFn environment through its public facade.`,
    inputSchema: clearInputSchema(id), outputSchema: acceptedOutputSchema,
    route: { method: "DELETE", path: `/resources/${resource}` },
    permission: `browsefn.${resource}.clear`, minimumScope: "environment",
    safety: {
      classification: "destructive", idempotent: true, requiresConfirmation: true,
      confirmation: { risk: "high", method: "explicit", reason: confirmationReason },
      audit: "required",
    },
    mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    target: { resource, idInput: "id" },
  } as const satisfies AdminOperationDefinition<TInput, TOutput>;
}

const getRateLimitInputSchema: AdminObjectSchema = {
  type: "object", properties: { provider: stringSchema }, required: ["provider"], additionalProperties: false,
};
const getRateLimit = {
  id: "browsefn.rate-limits.get", title: "Get provider rate limit",
  description: "Read the last-known rate-limit status through BrowseFn's public facade.",
  inputSchema: getRateLimitInputSchema, outputSchema: itemSchema(rateLimitSchema),
  route: { method: "GET", path: "/resources/rate-limits/:provider" }, permission: "browsefn.rate-limits.read", minimumScope: "environment",
  safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" },
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, target: { resource: "rate-limits", idInput: "provider" },
} as const satisfies AdminOperationDefinition<BrowseFnGetRateLimitInput, BrowseFnRateLimitOutput>;

const listLogsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    event: eventSchema, provider: stringSchema, since: integerSchema,
    limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
  },
  additionalProperties: false,
};
const listLogs = {
  id: "browsefn.logs.list", title: "List event logs",
  description: "List a bounded, sanitized projection of BrowseFn's in-process event log.",
  inputSchema: listLogsInputSchema, outputSchema: listSchema(logSchema),
  route: { method: "GET", path: "/resources/logs" }, permission: "browsefn.logs.read", minimumScope: "environment",
  safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "required" },
  redaction: { outputFields: ["requestId"] },
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, target: { resource: "logs", collection: true },
} as const satisfies AdminOperationDefinition<BrowseFnListLogsInput, BrowseFnLogListOutput>;

const getCache = {
  id: "browsefn.cache.get", title: "Get cache status",
  description: "Read aggregate cache state through BrowseFn's public cache API.",
  inputSchema: emptyInputSchema, outputSchema: itemSchema(cacheSchema),
  route: { method: "GET", path: "/resources/cache/current" }, permission: "browsefn.cache.read", minimumScope: "environment",
  safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" },
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, target: { resource: "cache", collection: true },
} as const satisfies AdminOperationDefinition<BrowseFnGetCacheInput, BrowseFnCacheOutput>;

export const browseFnAdminOperations = [
  listProviders,
  getMetrics,
  clearOperation<BrowseFnClearMetricsInput, BrowseFnAcceptedOutput>(
    "metrics", "current", "Clear metrics",
    "Clearing metrics irreversibly removes in-process observability history.",
  ),
  getRateLimit,
  listLogs,
  clearOperation<BrowseFnClearLogsInput, BrowseFnAcceptedOutput>(
    "logs", "events", "Clear event logs",
    "Clearing event logs irreversibly removes in-process request lifecycle evidence.",
  ),
  getCache,
  clearOperation<BrowseFnClearCacheInput, BrowseFnAcceptedOutput>(
    "cache", "cache", "Clear cache",
    "Clearing the cache removes all cached BrowseFn responses and can increase upstream traffic.",
  ),
] as const;

export const browseFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "browsefn",
  displayName: "BrowseFn",
  version: "0.1.0",
  description: "Environment-scoped provider availability, observability, rate-limit state, and cache maintenance backed by BrowseFn's public facade.",
  category: "Automation",
  availability: "required-product",
  scopeLevels: ["installation", "workspace", "project", "environment"],
  navigation: [
    { id: "browsefn.overview", label: "BrowseFn", path: "/modules/browsefn", icon: "browsefn:browser", order: 230, requiredPermission: "browsefn.providers.read" },
    { id: "browsefn.logs", label: "Event logs", path: "/modules/browsefn/logs", icon: "browsefn:logs", order: 231, requiredPermission: "browsefn.logs.read" },
  ],
  health: { operationId: "browsefn.providers.list" },
  resources: browseFnAdminResources,
  operations: browseFnAdminOperations,
});

export const adminCapability = browseFnAdminCapability;
