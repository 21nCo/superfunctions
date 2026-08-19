import type { ProviderName } from "langfn";
import {
  createAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminCapabilityAdapter,
  type AdminClient,
  type AdminClientRequestOptions,
  type AdminObjectSchema,
  type AdminOperationContext,
  type AdminOperationDefinition,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import type {
  LangFnInvocationView,
  LangFnOperatorService,
  LangFnPageInput,
  LangFnProfileRecord,
  LangFnPromptRecord,
  LangFnTraceRecord,
} from "./operator-service.js";

export * from "./operator-service.js";

type IdInput = { id: string };
type ProfileUpsertInput = { id: string; name: string; provider: ProviderName; model: string; enabled?: boolean };
type PromptUpsertInput = { id: string; name: string; template: string };
type PromptRunInput = { promptId: string; profileId: string; variables?: Record<string, string> };
type Page<T> = { items: T[]; nextCursor: string | null };
type Item<T> = { item: T };
type Accepted = { accepted: true };
type AcceptedItem<T> = Accepted & { item: T };

const scopeSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    installationId: { type: "string" }, workspaceId: { type: "string" }, projectId: { type: "string" },
    environmentId: { type: ["string", "null"] },
  },
  required: ["installationId", "workspaceId", "projectId", "environmentId"],
  additionalProperties: false,
};
const pageInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { cursor: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 100 } },
  additionalProperties: false,
};
const idSchema: AdminObjectSchema = {
  type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false,
};
const profileSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" }, scope: scopeSchema, name: { type: "string" },
    provider: { type: "string", enum: ["openai", "anthropic", "ollama", "google", "mistral", "custom", "mock"] },
    model: { type: "string" }, enabled: { type: "boolean" }, createdAt: { type: "string" }, updatedAt: { type: "string" },
  },
  required: ["id", "scope", "name", "provider", "model", "enabled", "createdAt", "updatedAt"],
  additionalProperties: false,
};
const promptSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" }, scope: scopeSchema, name: { type: "string" }, template: { type: "string" },
    createdAt: { type: "string" }, updatedAt: { type: "string" },
  },
  required: ["id", "scope", "name", "template", "createdAt", "updatedAt"],
  additionalProperties: false,
};
const traceSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" }, scope: scopeSchema, provider: { type: "string" }, model: { type: "string" },
    kind: { type: "string", enum: ["completion", "chat", "stream", "agent", "workflow"] },
    status: { type: "string", enum: ["running", "succeeded", "failed"] },
    promptTokens: { type: "integer", minimum: 0 }, completionTokens: { type: "integer", minimum: 0 },
    totalTokens: { type: "integer", minimum: 0 }, costTotal: { type: "number", minimum: 0 }, currency: { type: "string" },
    startedAt: { type: "string" }, endedAt: { type: ["string", "null"] },
  },
  required: ["id", "scope", "provider", "model", "kind", "status", "promptTokens", "completionTokens", "totalTokens", "costTotal", "currency", "startedAt", "endedAt"],
  additionalProperties: false,
};
const invocationSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" }, promptId: { type: "string" }, profileId: { type: "string" }, provider: { type: "string" },
    model: { type: "string" }, traceId: { type: ["string", "null"] }, promptTokens: { type: "integer", minimum: 0 },
    completionTokens: { type: "integer", minimum: 0 }, totalTokens: { type: "integer", minimum: 0 },
    costTotal: { type: "number", minimum: 0 }, currency: { type: "string" }, createdAt: { type: "string" },
  },
  required: ["id", "promptId", "profileId", "provider", "model", "traceId", "promptTokens", "completionTokens", "totalTokens", "costTotal", "currency", "createdAt"],
  additionalProperties: false,
};
const profileUpsertSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 },
    provider: { type: "string", enum: ["openai", "anthropic", "ollama", "google", "mistral", "custom", "mock"] },
    model: { type: "string", minLength: 1 }, enabled: { type: "boolean" },
  },
  required: ["id", "name", "provider", "model"],
  additionalProperties: false,
};
const promptUpsertSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, template: { type: "string", minLength: 1 } },
  required: ["id", "name", "template"],
  additionalProperties: false,
};
const promptRunSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    promptId: { type: "string", minLength: 1 }, profileId: { type: "string", minLength: 1 },
    variables: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["promptId", "profileId"],
  additionalProperties: false,
};

function pageSchema(item: AdminObjectSchema): AdminObjectSchema {
  return { type: "object", properties: { items: { type: "array", items: item }, nextCursor: { type: ["string", "null"] } }, required: ["items", "nextCursor"], additionalProperties: false };
}
function itemSchema(item: AdminObjectSchema): AdminObjectSchema {
  return { type: "object", properties: { item }, required: ["item"], additionalProperties: false };
}
function acceptedSchema(item?: AdminObjectSchema): AdminObjectSchema {
  return { type: "object", properties: { accepted: { type: "boolean", const: true }, ...(item ? { item } : {}) }, required: item ? ["accepted", "item"] : ["accepted"], additionalProperties: false };
}
function operation<TInput, TOutput>() {
  return <const TId extends string>(value: AdminOperationDefinition<TInput, TOutput> & { readonly id: TId }) => value;
}
const readSafety = { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" } as const;
const writeSafety = { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" } as const;
const destructiveSafety = (reason: string) => ({ classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "recent-auth", reason, maxAgeSeconds: 300 }, audit: "required" } as const);
const pageDefinition = { mode: "cursor", defaultLimit: 50, maxLimit: 100 } as const;
const readMcp = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

const operations = [
  operation<LangFnPageInput, Page<LangFnProfileRecord>>()({ id: "langfn.profiles.list", title: "List model profiles", description: "List configured LangFn model profiles.", inputSchema: pageInputSchema, outputSchema: pageSchema(profileSchema), route: { method: "GET", path: "/resources/profiles" }, permission: "langfn.profiles.read", minimumScope: "project", safety: readSafety, pagination: pageDefinition, mcp: readMcp, target: { resource: "profiles", collection: true } }),
  operation<IdInput, Item<LangFnProfileRecord>>()({ id: "langfn.profiles.get", title: "Get model profile", description: "Get one LangFn model profile.", inputSchema: idSchema, outputSchema: itemSchema(profileSchema), route: { method: "GET", path: "/resources/profiles/:id" }, permission: "langfn.profiles.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "profiles", idInput: "id" } }),
  operation<ProfileUpsertInput, AcceptedItem<LangFnProfileRecord>>()({ id: "langfn.profiles.upsert", title: "Upsert model profile", description: "Create or update non-secret model routing metadata.", inputSchema: profileUpsertSchema, outputSchema: acceptedSchema(profileSchema), route: { method: "POST", path: "/resources/profiles/actions/upsert" }, permission: "langfn.profiles.write", minimumScope: "project", safety: writeSafety, mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, target: { resource: "profiles", idInput: "id" } }),
  operation<IdInput, Accepted>()({ id: "langfn.profiles.delete", title: "Delete model profile", description: "Delete model routing metadata.", inputSchema: idSchema, outputSchema: acceptedSchema(), route: { method: "POST", path: "/resources/profiles/actions/delete" }, permission: "langfn.profiles.delete", minimumScope: "project", safety: destructiveSafety("Deleting a model profile prevents future prompt runs through it."), mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, target: { resource: "profiles", idInput: "id" } }),
  operation<LangFnPageInput, Page<LangFnPromptRecord>>()({ id: "langfn.prompts.list", title: "List prompts", description: "List scope-owned LangFn prompt templates.", inputSchema: pageInputSchema, outputSchema: pageSchema(promptSchema), route: { method: "GET", path: "/resources/prompts" }, permission: "langfn.prompts.read", minimumScope: "project", safety: { ...readSafety, audit: "required" }, pagination: pageDefinition, mcp: readMcp, redaction: { outputFields: ["template"] }, target: { resource: "prompts", collection: true } }),
  operation<IdInput, Item<LangFnPromptRecord>>()({ id: "langfn.prompts.get", title: "Get prompt", description: "Get one LangFn prompt template.", inputSchema: idSchema, outputSchema: itemSchema(promptSchema), route: { method: "GET", path: "/resources/prompts/:id" }, permission: "langfn.prompts.read", minimumScope: "project", safety: { ...readSafety, audit: "required" }, mcp: readMcp, redaction: { outputFields: ["template"] }, target: { resource: "prompts", idInput: "id" } }),
  operation<PromptUpsertInput, AcceptedItem<LangFnPromptRecord>>()({ id: "langfn.prompts.upsert", title: "Upsert prompt", description: "Create or update a LangFn prompt template.", inputSchema: promptUpsertSchema, outputSchema: acceptedSchema(promptSchema), route: { method: "POST", path: "/resources/prompts/actions/upsert" }, permission: "langfn.prompts.write", minimumScope: "project", safety: writeSafety, mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, redaction: { inputFields: ["template"], outputFields: ["template"] }, target: { resource: "prompts", idInput: "id" } }),
  operation<IdInput, Accepted>()({ id: "langfn.prompts.delete", title: "Delete prompt", description: "Delete a LangFn prompt template.", inputSchema: idSchema, outputSchema: acceptedSchema(), route: { method: "POST", path: "/resources/prompts/actions/delete" }, permission: "langfn.prompts.delete", minimumScope: "project", safety: destructiveSafety("Deleting a prompt prevents future invocations through it."), mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, target: { resource: "prompts", idInput: "id" } }),
  operation<PromptRunInput, AcceptedItem<LangFnInvocationView>>()({ id: "langfn.prompts.run", title: "Run prompt", description: "Invoke a configured prompt through an application-provided LangFn client and return metadata only.", inputSchema: promptRunSchema, outputSchema: acceptedSchema(invocationSchema), route: { method: "POST", path: "/resources/prompts/actions/run" }, permission: "langfn.prompts.run", minimumScope: "project", safety: { classification: "write", idempotent: false, requiresConfirmation: true, confirmation: { risk: "high", method: "recent-auth", reason: "A prompt run calls an external model and may incur usage costs.", maxAgeSeconds: 300 }, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, redaction: { inputFields: ["variables"] }, target: { resource: "prompts", idInput: "promptId" } }),
  operation<LangFnPageInput, Page<LangFnTraceRecord>>()({ id: "langfn.traces.list", title: "List traces", description: "List redacted LangFn execution traces.", inputSchema: pageInputSchema, outputSchema: pageSchema(traceSchema), route: { method: "GET", path: "/resources/traces" }, permission: "langfn.traces.read", minimumScope: "project", safety: { ...readSafety, audit: "required" }, pagination: pageDefinition, mcp: readMcp, target: { resource: "traces", collection: true } }),
  operation<IdInput, Item<LangFnTraceRecord>>()({ id: "langfn.traces.get", title: "Get trace", description: "Get one redacted LangFn execution trace.", inputSchema: idSchema, outputSchema: itemSchema(traceSchema), route: { method: "GET", path: "/resources/traces/:id" }, permission: "langfn.traces.read", minimumScope: "project", safety: { ...readSafety, audit: "required" }, mcp: readMcp, target: { resource: "traces", idInput: "id" } }),
] as const;

export const langFnAdminResources = [
  { id: "profiles", label: "Model Profiles", description: "Non-secret LangFn model routing metadata.", icon: "langfn:profiles", risk: "standard", minimumScope: "project", idField: "id", displayFields: ["id", "name", "provider", "model", "enabled"], searchableFields: ["id", "name", "provider", "model"], filterableFields: ["provider", "enabled"], sortableFields: ["name", "updatedAt"], sensitiveFields: [] },
  { id: "prompts", label: "Prompts", description: "Scope-owned LangFn prompt templates.", icon: "langfn:prompts", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "name", "updatedAt"], searchableFields: ["id", "name"], filterableFields: [], sortableFields: ["name", "updatedAt"], sensitiveFields: ["template"] },
  { id: "traces", label: "Traces", description: "Redacted LangFn execution and usage metadata.", icon: "langfn:traces", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "provider", "model", "kind", "status", "totalTokens", "costTotal", "startedAt"], searchableFields: ["id", "provider", "model"], filterableFields: ["provider", "model", "kind", "status"], sortableFields: ["startedAt", "totalTokens", "costTotal"], sensitiveFields: [] },
] as const;

export type LangFnAdminOperationId = (typeof operations)[number]["id"];
export const langFnAdminActions = operations;
export const langFnAdminCapability = defineAdminCapability({ schemaVersion: "1.0", id: "langfn", displayName: "LangFn", version: "1.1.0", description: "Scope-owned model profiles, prompt templates, real LangFn invocations, and redacted traces.", category: "intelligence", availability: "optional-product", scopeLevels: ["installation", "workspace", "project", "environment"], dependencies: [], resources: langFnAdminResources, navigation: [{ id: "langfn", label: "LangFn", path: "/modules/langfn", icon: "langfn", description: "Operate language model routing, prompts, and traces.", order: 100 }], operations });

type LangFnCapabilityClient = ReturnType<typeof createCapabilityAdminClient<typeof langFnAdminCapability>>;
export interface LangFnAdminClient extends LangFnCapabilityClient {
  readonly profiles: { list(input?: LangFnPageInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.profiles.list"]>; get(input: IdInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.profiles.get"]>; upsert(input: ProfileUpsertInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.profiles.upsert"]>; delete(input: IdInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.profiles.delete"]> };
  readonly prompts: { list(input?: LangFnPageInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.prompts.list"]>; get(input: IdInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.prompts.get"]>; upsert(input: PromptUpsertInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.prompts.upsert"]>; delete(input: IdInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.prompts.delete"]>; run(input: PromptRunInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.prompts.run"]> };
  readonly traces: { list(input?: LangFnPageInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.traces.list"]>; get(input: IdInput, options?: AdminClientRequestOptions): ReturnType<LangFnCapabilityClient["operations"]["langfn.traces.get"]> };
}

export function createLangFnAdminClient(adminClient: AdminClient): LangFnAdminClient {
  const client = createCapabilityAdminClient(langFnAdminCapability, adminClient);
  return Object.assign(client, {
    profiles: { list: (input: LangFnPageInput = {}, options?: AdminClientRequestOptions) => client.invoke("langfn.profiles.list", input, options), get: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("langfn.profiles.get", input, options), upsert: (input: ProfileUpsertInput, options?: AdminClientRequestOptions) => client.invoke("langfn.profiles.upsert", input, options), delete: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("langfn.profiles.delete", input, options) },
    prompts: { list: (input: LangFnPageInput = {}, options?: AdminClientRequestOptions) => client.invoke("langfn.prompts.list", input, options), get: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("langfn.prompts.get", input, options), upsert: (input: PromptUpsertInput, options?: AdminClientRequestOptions) => client.invoke("langfn.prompts.upsert", input, options), delete: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("langfn.prompts.delete", input, options), run: (input: PromptRunInput, options?: AdminClientRequestOptions) => client.invoke("langfn.prompts.run", input, options) },
    traces: { list: (input: LangFnPageInput = {}, options?: AdminClientRequestOptions) => client.invoke("langfn.traces.list", input, options), get: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("langfn.traces.get", input, options) },
  });
}

type ServiceMethod<TInput> = (input: TInput, context: AdminOperationContext) => Promise<unknown>;
function bind<TInput>(handler: ServiceMethod<TInput>) { return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context); }
export function createLangFnAdminAdapter(service: LangFnOperatorService): AdminCapabilityAdapter<typeof langFnAdminCapability> {
  return createAdminCapabilityAdapter(langFnAdminCapability, {
    "langfn.profiles.list": bind(service.listProfiles), "langfn.profiles.get": bind(service.getProfile), "langfn.profiles.upsert": bind(service.upsertProfile), "langfn.profiles.delete": bind(service.deleteProfile),
    "langfn.prompts.list": bind(service.listPrompts), "langfn.prompts.get": bind(service.getPrompt), "langfn.prompts.upsert": bind(service.upsertPrompt), "langfn.prompts.delete": bind(service.deletePrompt), "langfn.prompts.run": bind(service.runPrompt),
    "langfn.traces.list": bind(service.listTraces), "langfn.traces.get": bind(service.getTrace),
  });
}

export const adminCapability = langFnAdminCapability;
export const createAdminAdapter = createLangFnAdminAdapter;
