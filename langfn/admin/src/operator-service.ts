import type { CompletionResponse, LangFn, ProviderName } from "langfn";
import { AdminError, type AdminOperationContext } from "@superfunctions/admin";

export interface LangFnOperatorScope {
  installationId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string | null;
}
export interface LangFnPageInput { cursor?: string; limit?: number }

export interface LangFnProfileRecord {
  id: string;
  scope: LangFnOperatorScope;
  name: string;
  provider: ProviderName;
  model: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface LangFnPromptRecord {
  id: string;
  scope: LangFnOperatorScope;
  name: string;
  template: string;
  createdAt: string;
  updatedAt: string;
}
export interface LangFnTraceRecord {
  id: string;
  scope: LangFnOperatorScope;
  provider: string;
  model: string;
  kind: "completion" | "chat" | "stream" | "agent" | "workflow";
  status: "running" | "succeeded" | "failed";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costTotal: number;
  currency: string;
  startedAt: string;
  endedAt: string | null;
}
export interface LangFnInvocationView {
  id: string;
  promptId: string;
  profileId: string;
  provider: string;
  model: string;
  traceId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costTotal: number;
  currency: string;
  createdAt: string;
}

/** Durable configuration persistence boundary owned by LangFn. */
export interface LangFnOperatorStore {
  listProfiles(scope: LangFnOperatorScope): Promise<LangFnProfileRecord[]>;
  getProfile(scope: LangFnOperatorScope, id: string): Promise<LangFnProfileRecord | null>;
  putProfile(value: LangFnProfileRecord): Promise<void>;
  deleteProfile(scope: LangFnOperatorScope, id: string): Promise<boolean>;
  listPrompts(scope: LangFnOperatorScope): Promise<LangFnPromptRecord[]>;
  getPrompt(scope: LangFnOperatorScope, id: string): Promise<LangFnPromptRecord | null>;
  putPrompt(value: LangFnPromptRecord): Promise<void>;
  deletePrompt(scope: LangFnOperatorScope, id: string): Promise<boolean>;
}

/** Scope-aware adapter over the application's real LangFn trace storage. */
export interface LangFnTraceReader {
  list(scope: LangFnOperatorScope): Promise<LangFnTraceRecord[]>;
  get(scope: LangFnOperatorScope, id: string): Promise<LangFnTraceRecord | null>;
}

/** Explicit in-memory implementation for tests and local development. */
export class MemoryLangFnOperatorStore implements LangFnOperatorStore {
  private readonly profiles = new Map<string, LangFnProfileRecord>();
  private readonly prompts = new Map<string, LangFnPromptRecord>();

  private key(scope: LangFnOperatorScope, id: string): string {
    return `${scope.installationId}\0${scope.workspaceId}\0${scope.projectId}\0${scope.environmentId ?? ""}\0${id}`;
  }
  private sameScope(left: LangFnOperatorScope, right: LangFnOperatorScope): boolean {
    return this.key(left, "") === this.key(right, "");
  }

  async listProfiles(scope: LangFnOperatorScope): Promise<LangFnProfileRecord[]> {
    return [...this.profiles.values()]
      .filter((value) => this.sameScope(value.scope, scope))
      .map((value) => structuredClone(value));
  }
  async getProfile(scope: LangFnOperatorScope, id: string): Promise<LangFnProfileRecord | null> {
    const value = this.profiles.get(this.key(scope, id));
    return value ? structuredClone(value) : null;
  }
  async putProfile(value: LangFnProfileRecord): Promise<void> {
    this.profiles.set(this.key(value.scope, value.id), structuredClone(value));
  }
  async deleteProfile(scope: LangFnOperatorScope, id: string): Promise<boolean> {
    return this.profiles.delete(this.key(scope, id));
  }
  async listPrompts(scope: LangFnOperatorScope): Promise<LangFnPromptRecord[]> {
    return [...this.prompts.values()]
      .filter((value) => this.sameScope(value.scope, scope))
      .map((value) => structuredClone(value));
  }
  async getPrompt(scope: LangFnOperatorScope, id: string): Promise<LangFnPromptRecord | null> {
    const value = this.prompts.get(this.key(scope, id));
    return value ? structuredClone(value) : null;
  }
  async putPrompt(value: LangFnPromptRecord): Promise<void> {
    this.prompts.set(this.key(value.scope, value.id), structuredClone(value));
  }
  async deletePrompt(scope: LangFnOperatorScope, id: string): Promise<boolean> {
    return this.prompts.delete(this.key(scope, id));
  }
}

export interface LangFnOperatorServiceOptions {
  store: LangFnOperatorStore;
  traces: LangFnTraceReader;
  /** Resolve an application-configured real LangFn client for the selected profile. */
  client(
    profile: LangFnProfileRecord,
    context: AdminOperationContext,
  ): Pick<LangFn, "complete"> | Promise<Pick<LangFn, "complete">>;
  now?: () => Date;
  createId?: () => string;
}

function requireScope(context: AdminOperationContext): LangFnOperatorScope {
  const { installationId, workspaceId, projectId, environmentId } = context.scope;
  if (!installationId || !workspaceId || !projectId) {
    throw new AdminError(
      "invalid_argument",
      "LangFn administration requires installation, workspace, and project scope identifiers.",
    );
  }
  return { installationId, workspaceId, projectId, environmentId: environmentId ?? null };
}

function page<T extends { id: string }>(items: T[], input: LangFnPageInput) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const offset = input.cursor === undefined ? 0 : Number(input.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AdminError("invalid_argument", "LangFn cursor is invalid.");
  }
  const ordered = [...items].sort((left, right) => left.id.localeCompare(right.id));
  const values = ordered.slice(offset, offset + limit);
  const next = offset + values.length;
  return { items: values, nextCursor: next < ordered.length ? String(next) : null };
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new AdminError("invalid_argument", `${label} is required.`);
  return value;
}

function renderPrompt(template: string, variables: Record<string, string>): string {
  const missing = new Set<string>();
  const output = template.replace(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      missing.add(name);
      return "";
    }
    return value;
  });
  if (missing.size > 0) {
    throw new AdminError("invalid_argument", `Missing prompt variables: ${[...missing].sort().join(", ")}.`);
  }
  return output;
}

function invocationView(
  input: { id: string; promptId: string; profile: LangFnProfileRecord; response: CompletionResponse; createdAt: string },
): LangFnInvocationView {
  return {
    id: input.id,
    promptId: input.promptId,
    profileId: input.profile.id,
    provider: input.profile.provider,
    model: input.profile.model,
    traceId: input.response.traceId ?? input.response.trace_id ?? null,
    promptTokens: input.response.usage?.prompt_tokens ?? 0,
    completionTokens: input.response.usage?.completion_tokens ?? 0,
    totalTokens: input.response.usage?.total_tokens ?? 0,
    costTotal: input.response.cost?.total ?? 0,
    currency: input.response.cost?.currency ?? "USD",
    createdAt: input.createdAt,
  };
}

export function createLangFnOperatorService(options: LangFnOperatorServiceOptions) {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const createId = options.createId ?? (() => crypto.randomUUID());
  return {
    async listProfiles(input: LangFnPageInput, context: AdminOperationContext) {
      return page(await options.store.listProfiles(requireScope(context)), input);
    },
    async getProfile(input: { id: string }, context: AdminOperationContext) {
      const value = await options.store.getProfile(requireScope(context), input.id);
      if (!value) throw new AdminError("not_found", "LangFn model profile was not found.");
      return { item: value };
    },
    async upsertProfile(
      input: { id: string; name: string; provider: ProviderName; model: string; enabled?: boolean },
      context: AdminOperationContext,
    ) {
      const scope = requireScope(context);
      const previous = await options.store.getProfile(scope, input.id);
      const updatedAt = now();
      const value: LangFnProfileRecord = {
        id: required(input.id, "id"),
        scope,
        name: required(input.name, "name"),
        provider: input.provider,
        model: required(input.model, "model"),
        enabled: input.enabled ?? true,
        createdAt: previous?.createdAt ?? updatedAt,
        updatedAt,
      };
      await options.store.putProfile(value);
      return { accepted: true as const, item: value };
    },
    async deleteProfile(input: { id: string }, context: AdminOperationContext) {
      if (!await options.store.deleteProfile(requireScope(context), input.id)) {
        throw new AdminError("not_found", "LangFn model profile was not found.");
      }
      return { accepted: true as const };
    },
    async listPrompts(input: LangFnPageInput, context: AdminOperationContext) {
      return page(await options.store.listPrompts(requireScope(context)), input);
    },
    async getPrompt(input: { id: string }, context: AdminOperationContext) {
      const value = await options.store.getPrompt(requireScope(context), input.id);
      if (!value) throw new AdminError("not_found", "LangFn prompt was not found.");
      return { item: value };
    },
    async upsertPrompt(
      input: { id: string; name: string; template: string },
      context: AdminOperationContext,
    ) {
      const scope = requireScope(context);
      const previous = await options.store.getPrompt(scope, input.id);
      const updatedAt = now();
      const value: LangFnPromptRecord = {
        id: required(input.id, "id"),
        scope,
        name: required(input.name, "name"),
        template: required(input.template, "template"),
        createdAt: previous?.createdAt ?? updatedAt,
        updatedAt,
      };
      await options.store.putPrompt(value);
      return { accepted: true as const, item: value };
    },
    async deletePrompt(input: { id: string }, context: AdminOperationContext) {
      if (!await options.store.deletePrompt(requireScope(context), input.id)) {
        throw new AdminError("not_found", "LangFn prompt was not found.");
      }
      return { accepted: true as const };
    },
    async runPrompt(
      input: { promptId: string; profileId: string; variables?: Record<string, string> },
      context: AdminOperationContext,
    ) {
      const scope = requireScope(context);
      const [prompt, profile] = await Promise.all([
        options.store.getPrompt(scope, input.promptId),
        options.store.getProfile(scope, input.profileId),
      ]);
      if (!prompt) throw new AdminError("not_found", "LangFn prompt was not found.");
      if (!profile) throw new AdminError("not_found", "LangFn model profile was not found.");
      if (!profile.enabled) throw new AdminError("precondition_failed", "LangFn model profile is disabled.");
      const rendered = renderPrompt(prompt.template, input.variables ?? {});
      const response = await (await options.client(profile, context)).complete(rendered, {
        metadata: {
          adminRequestId: context.requestId,
          promptId: prompt.id,
          profileId: profile.id,
          projectId: scope.projectId,
        },
      });
      return {
        accepted: true as const,
        item: invocationView({ id: createId(), promptId: prompt.id, profile, response, createdAt: now() }),
      };
    },
    async listTraces(input: LangFnPageInput, context: AdminOperationContext) {
      return page(await options.traces.list(requireScope(context)), input);
    },
    async getTrace(input: { id: string }, context: AdminOperationContext) {
      const value = await options.traces.get(requireScope(context), input.id);
      if (!value) throw new AdminError("not_found", "LangFn trace was not found.");
      return { item: value };
    },
  };
}

export type LangFnOperatorService = ReturnType<typeof createLangFnOperatorService>;
