import { describe, expect, it, vi } from "vitest";
import { LangFn, models } from "langfn";
import { createAdminClient, validateAdminCapabilityManifest, type AdminOperationContext } from "@superfunctions/admin";
import {
  createLangFnAdminAdapter,
  createLangFnAdminClient,
  createLangFnOperatorService,
  langFnAdminCapability,
  MemoryLangFnOperatorStore,
  type LangFnOperatorScope,
  type LangFnTraceReader,
  type LangFnTraceRecord,
} from "../index.js";

function context(projectId: string, workspaceId = "workspace", environmentId?: string): AdminOperationContext {
  return { scope: { installationId: "installation", workspaceId, projectId, environmentId }, actor: { id: "operator", permissions: ["*"] }, requestId: crypto.randomUUID(), source: "console", idempotencyKey: crypto.randomUUID() };
}
function legacyContext(projectId: string): AdminOperationContext {
  return { ...context(projectId), scope: { organizationId: "installation", workspaceId: "workspace", projectId } };
}
function scopeKey(scope: LangFnOperatorScope): string {
  return `${scope.installationId}/${scope.workspaceId}/${scope.projectId}/${scope.environmentId ?? ""}`;
}

describe("@langfn/admin", () => {
  it("publishes a valid optional exact operator surface", () => {
    expect(validateAdminCapabilityManifest(langFnAdminCapability)).toEqual([]);
    expect(langFnAdminCapability.availability).toBe("optional-product");
    expect(langFnAdminCapability.operations).toHaveLength(11);
    expect(langFnAdminCapability.operations.every((operation) => operation.minimumScope === "project")).toBe(true);
  });

  it("runs through LangFn, paginates, and isolates the complete scope", async () => {
    const traces = new Map<string, LangFnTraceRecord[]>();
    const traceReader: LangFnTraceReader = {
      async list(scope) { return structuredClone(traces.get(scopeKey(scope)) ?? []); },
      async get(scope, id) { return structuredClone((traces.get(scopeKey(scope)) ?? []).find((trace) => trace.id === id) ?? null); },
    };
    const client = new LangFn({ model: new models.MockChatModel({ responses: ["Hello Ada"], usage: { prompt_tokens: 4, completion_tokens: 2 } }) });
    const adapter = createLangFnAdminAdapter(createLangFnOperatorService({ store: new MemoryLangFnOperatorStore(), traces: traceReader, client: async () => client, createId: () => "invocation-1" }));

    expect(Object.keys(adapter.handlers)).toHaveLength(11);
    await adapter.execute("langfn.profiles.upsert", { id: "primary", name: "Primary", provider: "mock", model: "mock-1" }, context("same-project"));
    await adapter.execute("langfn.profiles.upsert", { id: "secondary", name: "Secondary", provider: "mock", model: "mock-1" }, context("same-project"));
    await adapter.execute("langfn.prompts.upsert", { id: "welcome", name: "Welcome", template: "Welcome {{name}}" }, context("same-project"));
    const run = await adapter.execute<any>("langfn.prompts.run", { promptId: "welcome", profileId: "primary", variables: { name: "Ada" } }, context("same-project"));
    expect(run.data.item).toMatchObject({ id: "invocation-1", promptTokens: 4, completionTokens: 2, totalTokens: 6 });
    expect(JSON.stringify(run)).not.toContain("Hello Ada");

    const first = await adapter.execute<any>("langfn.profiles.list", { limit: 1 }, context("same-project"));
    const second = await adapter.execute<any>("langfn.profiles.list", { limit: 1, cursor: first.data.nextCursor }, context("same-project"));
    expect(first.data.nextCursor).toBe("1");
    expect(second.data.nextCursor).toBeNull();
    const otherWorkspace = await adapter.execute<any>("langfn.profiles.list", {}, context("same-project", "other-workspace"));
    const otherEnvironment = await adapter.execute<any>("langfn.profiles.list", {}, context("same-project", "workspace", "production"));
    expect(otherWorkspace.data.items).toEqual([]);
    expect(otherEnvironment.data.items).toEqual([]);
    expect((await adapter.execute<any>("langfn.profiles.list", {}, legacyContext("same-project"))).data.items).toHaveLength(2);
  });

  it("exposes named typed methods and common capability methods", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { items: [], nextCursor: null } }), { status: 200 }));
    const client = createLangFnAdminClient(createAdminClient({ baseUrl: "https://example.test/admin", fetch: fetcher as typeof fetch }));
    await client.profiles.list();
    expect(String(fetcher.mock.calls[0]![0])).toContain("langfn.profiles.list");
    expect(client.prompts.run).toEqual(expect.any(Function));
    expect(client.traces.get).toEqual(expect.any(Function));
    expect(client.availability).toEqual(expect.any(Function));
  });
});
