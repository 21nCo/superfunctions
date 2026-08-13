import {
  AdminError,
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminCapabilityAdapter,
  type AdminClient,
  type AdminObjectSchema,
  type AdminOperationContext,
  type AdminOperationRequest,
  type AdminResourceDefinition,
} from "@superfunctions/admin";
import type { CacheFn, CacheStats } from "@cachefn/core";

const stringSchema = { type: "string", minLength: 1 } as const;
const emptyInput: AdminObjectSchema = { type: "object", additionalProperties: false };
const keyInput: AdminObjectSchema = {
  type: "object",
  properties: { id: stringSchema },
  required: ["id"],
  additionalProperties: false,
};
const listInput: AdminObjectSchema = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 1000 },
  },
  additionalProperties: false,
};
const keySchema: AdminObjectSchema = {
  type: "object",
  properties: { id: stringSchema, exists: { type: "boolean" } },
  required: ["id", "exists"],
  additionalProperties: false,
};
const keyListSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: keySchema },
    nextCursor: { type: "null" },
  },
  required: ["items", "nextCursor"],
  additionalProperties: false,
};
const keyOutput: AdminObjectSchema = {
  type: "object",
  properties: { item: keySchema },
  required: ["item"],
  additionalProperties: false,
};
const statsSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    hits: { type: "integer", minimum: 0 }, misses: { type: "integer", minimum: 0 },
    hitRate: { type: "number", minimum: 0, maximum: 100 }, sets: { type: "integer", minimum: 0 },
    deletes: { type: "integer", minimum: 0 }, evictions: { type: "integer", minimum: 0 },
    size: { type: "integer", minimum: 0 }, memoryUsage: { type: "integer", minimum: 0 },
  },
  required: ["hits", "misses", "hitRate", "sets", "deletes", "evictions", "size"],
  additionalProperties: false,
};
const statsOutput: AdminObjectSchema = {
  type: "object",
  properties: { item: statsSchema },
  required: ["item"],
  additionalProperties: false,
};
const acceptedOutput: AdminObjectSchema = {
  type: "object",
  properties: { accepted: { const: true }, id: { type: "string" }, deleted: { type: "boolean" } },
  required: ["accepted"],
  additionalProperties: false,
};
const setInput: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    value: {},
    ttl: { type: "integer", minimum: 1 },
    tags: { type: "array", items: stringSchema, uniqueItems: true },
  },
  required: ["id", "value"],
  additionalProperties: false,
};
const tagInput: AdminObjectSchema = {
  type: "object",
  properties: { id: stringSchema },
  required: ["id"],
  additionalProperties: false,
};
const namespaceInput: AdminObjectSchema = {
  type: "object",
  properties: { id: stringSchema },
  required: ["id"],
  additionalProperties: false,
};

export const cacheFnAdminResources = [
  {
    id: "keys", label: "Keys", description: "Inspect key names in the bound CacheFn namespace without returning cached values.",
    icon: "cachefn:keys", risk: "sensitive", minimumScope: "environment", idField: "id",
    displayFields: ["id", "exists"], searchableFields: ["id"], filterableFields: [], sortableFields: ["id"],
    sensitiveFields: ["value"],
  },
  {
    id: "stats", label: "Statistics", description: "Inspect live hit, miss, eviction, and capacity counters from the bound CacheFn instance.",
    icon: "cachefn:stats", risk: "standard", minimumScope: "environment", idField: "id",
    displayFields: ["hits", "misses", "hitRate", "size"], searchableFields: [], filterableFields: [], sortableFields: [], sensitiveFields: [],
  },
  {
    id: "namespaces", label: "Namespace", description: "The deployment-bound CacheFn namespace that can be cleared as one confirmed target.",
    icon: "cachefn:namespaces", risk: "standard", minimumScope: "environment", idField: "id",
    displayFields: ["id"], searchableFields: ["id"], filterableFields: [], sortableFields: [], sensitiveFields: [],
  },
] as const satisfies readonly AdminResourceDefinition[];

const readSafety = { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" } as const;
const writeSafety = { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" } as const;
const destructiveSafety = { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "recent-auth", reason: "This operation permanently removes cached data from the selected namespace.", maxAgeSeconds: 300 }, audit: "required" } as const;
const clearSafety = { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "critical", method: "mfa", reason: "Clearing a cache namespace permanently removes every key.", maxAgeSeconds: 300 }, audit: "required" } as const;
const mcp = (readOnly: boolean, destructive = false) => ({ enabled: true, hints: { readOnly, destructive, idempotent: true, openWorld: false } }) as const;

export const cacheFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "cachefn",
  displayName: "CacheFn",
  version: "1.0.0",
  description: "Real administration for a deployment-bound CacheFn instance.",
  category: "infrastructure",
  availability: "optional-product",
  scopeLevels: ["installation", "workspace", "project", "environment"],
  resources: cacheFnAdminResources,
  navigation: [{ id: "cachefn", label: "CacheFn", path: "/modules/cachefn", icon: "cachefn", description: "Operate the bound cache namespace.", order: 100 }],
  operations: [
    { id: "cachefn.keys.list", title: "List cache keys", description: "List key names without returning cached values.", inputSchema: listInput, outputSchema: keyListSchema, route: { method: "GET", path: "/resources/keys" }, permission: "cachefn.keys.read", minimumScope: "environment", safety: readSafety, target: { resource: "keys", collection: true }, redaction: { inputFields: [], outputFields: [] }, mcp: mcp(true) },
    { id: "cachefn.keys.get", title: "Inspect cache key", description: "Check whether a key exists without returning its cached value.", inputSchema: keyInput, outputSchema: keyOutput, route: { method: "GET", path: "/resources/keys/:id" }, permission: "cachefn.keys.read", minimumScope: "environment", safety: readSafety, target: { resource: "keys", idInput: "id" }, redaction: { inputFields: [], outputFields: [] }, mcp: mcp(true) },
    { id: "cachefn.stats.list", title: "Read cache statistics", description: "Read live cache counters and current size.", inputSchema: emptyInput, outputSchema: statsOutput, route: { method: "GET", path: "/resources/stats" }, permission: "cachefn.stats.read", minimumScope: "environment", safety: readSafety, target: { resource: "stats", collection: true }, redaction: { inputFields: [], outputFields: [] }, mcp: mcp(true) },
    { id: "cachefn.keys.set", title: "Set cache key", description: "Set one value in the bound cache namespace.", inputSchema: setInput, outputSchema: acceptedOutput, route: { method: "PUT", path: "/resources/keys/:id" }, permission: "cachefn.keys.set", minimumScope: "environment", safety: writeSafety, target: { resource: "keys", idInput: "id" }, redaction: { inputFields: ["value"], outputFields: [] }, mcp: mcp(false) },
    { id: "cachefn.keys.delete", title: "Delete cache key", description: "Permanently remove one key from the bound cache namespace.", inputSchema: keyInput, outputSchema: acceptedOutput, route: { method: "DELETE", path: "/resources/keys/:id" }, permission: "cachefn.keys.delete", minimumScope: "environment", safety: destructiveSafety, target: { resource: "keys", idInput: "id" }, redaction: { inputFields: [], outputFields: [] }, mcp: mcp(false, true) },
    { id: "cachefn.keys.invalidate-tag", title: "Invalidate cache tag", description: "Remove every cached value carrying a tag.", inputSchema: tagInput, outputSchema: acceptedOutput, route: { method: "POST", path: "/resources/keys/actions/invalidate-tag" }, permission: "cachefn.keys.invalidate", minimumScope: "environment", safety: writeSafety, target: { resource: "keys", collection: true }, redaction: { inputFields: [], outputFields: [] }, mcp: mcp(false) },
    { id: "cachefn.namespaces.clear", title: "Clear cache namespace", description: "Permanently remove every key in the bound cache namespace.", inputSchema: namespaceInput, outputSchema: acceptedOutput, route: { method: "POST", path: "/resources/namespaces/:id/actions/clear" }, permission: "cachefn.namespaces.clear", minimumScope: "environment", safety: clearSafety, target: { resource: "namespaces", idInput: "id" }, redaction: { inputFields: [], outputFields: [] }, mcp: mcp(false, true) },
  ] as const,
});

export type CacheFnAdminOperationId = (typeof cacheFnAdminCapability.operations)[number]["id"];
export interface CacheFnListKeysInput { pattern?: string; limit?: number }
export interface CacheFnKeyInput { id: string }
export interface CacheFnSetKeyInput extends CacheFnKeyInput { value: unknown; ttl?: number; tags?: string[] }
export interface CacheFnTagInput { id: string }
export interface CacheFnKeyListOutput { items: Array<{ id: string; exists: true }>; nextCursor: null }
export interface CacheFnKeyOutput { item: { id: string; exists: boolean } }
export interface CacheFnStatsOutput { item: CacheStats }
export interface CacheFnAcceptedOutput { accepted: true; id?: string; deleted?: boolean }

export interface CacheFnAdminService {
  listKeys(input: CacheFnListKeysInput, context: AdminOperationContext): Promise<CacheFnKeyListOutput>;
  getKey(input: CacheFnKeyInput, context: AdminOperationContext): Promise<CacheFnKeyOutput>;
  stats(input: Record<string, never>, context: AdminOperationContext): Promise<CacheFnStatsOutput>;
  setKey(input: CacheFnSetKeyInput, context: AdminOperationContext): Promise<CacheFnAcceptedOutput>;
  deleteKey(input: CacheFnKeyInput, context: AdminOperationContext): Promise<CacheFnAcceptedOutput>;
  invalidateTag(input: CacheFnTagInput, context: AdminOperationContext): Promise<CacheFnAcceptedOutput>;
  clear(input: CacheFnKeyInput, context: AdminOperationContext): Promise<CacheFnAcceptedOutput>;
}

function bind<TInput, TOutput>(handler: (input: TInput, context: AdminOperationContext) => Promise<TOutput>) {
  return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context);
}

export function createCacheFnAdminAdapter(service: CacheFnAdminService): AdminCapabilityAdapter<typeof cacheFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(cacheFnAdminCapability, {
    "cachefn.keys.list": bind(service.listKeys), "cachefn.keys.get": bind(service.getKey), "cachefn.stats.list": bind(service.stats),
    "cachefn.keys.set": bind(service.setKey), "cachefn.keys.delete": bind(service.deleteKey),
    "cachefn.keys.invalidate-tag": bind(service.invalidateTag), "cachefn.namespaces.clear": bind(service.clear),
  });
}

export interface CacheFnDomainAdminServiceOptions {
  cache: CacheFn<unknown>;
  environmentId: string;
  namespace?: string;
}

export function createCacheFnDomainAdminService(options: CacheFnDomainAdminServiceOptions): CacheFnAdminService {
  if (!options.environmentId.trim()) throw new AdminError("invalid_argument", "CacheFn admin binding requires an environmentId.");
  const assertScope = (context: AdminOperationContext) => {
    if (context.scope.environmentId !== options.environmentId) throw new AdminError("forbidden", "The active environment cannot access this CacheFn instance.");
    if (options.namespace !== undefined && context.scope.namespace !== options.namespace) throw new AdminError("forbidden", "The active namespace cannot access this CacheFn instance.");
  };
  return {
    async listKeys(input, context) { assertScope(context); const keys = await options.cache.keys(input.pattern); return { items: keys.slice(0, input.limit ?? 100).map((id) => ({ id, exists: true as const })), nextCursor: null }; },
    async getKey(input, context) { assertScope(context); return { item: { id: input.id, exists: await options.cache.has(input.id) } }; },
    async stats(_input, context) { assertScope(context); return { item: await options.cache.getStats() }; },
    async setKey(input, context) { assertScope(context); await options.cache.set(input.id, input.value, { ...(input.ttl ? { ttl: input.ttl } : {}), ...(input.tags ? { tags: input.tags } : {}) }); return { accepted: true, id: input.id }; },
    async deleteKey(input, context) { assertScope(context); return { accepted: true, id: input.id, deleted: await options.cache.delete(input.id) }; },
    async invalidateTag(input, context) { assertScope(context); await options.cache.invalidateByTag(input.id); return { accepted: true, id: input.id }; },
    async clear(input, context) { assertScope(context); const namespaceId = options.namespace ?? options.environmentId; if (input.id !== namespaceId) throw new AdminError("not_found", "The requested CacheFn namespace is not bound to this environment."); await options.cache.clear(); return { accepted: true, id: input.id }; },
  };
}

export function createCacheFnDomainAdminAdapter(options: CacheFnDomainAdminServiceOptions) {
  return createCacheFnAdminAdapter(createCacheFnDomainAdminService(options));
}
export function createCacheFnAdminClient(adminClient: AdminClient) { return createCapabilityAdminClient(cacheFnAdminCapability, adminClient); }
export const adminCapability = cacheFnAdminCapability;
export const createAdminAdapter = createCacheFnAdminAdapter;
