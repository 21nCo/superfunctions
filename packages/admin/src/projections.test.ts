import { describe, expect, it, vi } from "vitest";
import { createAdminCapabilityAdapter } from "./adapter.js";
import { createAdminClient, createCapabilityAdminClient, AdminClientError } from "./client.js";
import { createAdminDispatcher } from "./dispatcher.js";
import { projectAdminMcpTools, registerAdminMcpTools } from "./mcp.js";
import { createAdminOpenApiDocument } from "./openapi.js";
import { decodeAdminCursor, encodeAdminCursor, normalizeAdminPageLimit } from "./pagination.js";
import { createAdminRegistry } from "./registry.js";
import { testAdapter, testManifest } from "./test-fixtures.js";
import type { AdminOperationContext } from "./types.js";

const scope = { organizationId: "org", workspaceId: "workspace", projectId: "project", environmentId: "environment" };

describe("OpenAPI projection", () => {
  it("projects only enabled operations with safety, permission, tenant auth, and path parameters", () => {
    const first = testManifest("firstfn");
    const operation = first.operations[0]!;
    const firstAdapter = createAdminCapabilityAdapter(testManifest("firstfn", {
      operations: [{
        ...operation,
        inputSchema: {
          type: "object",
          properties: { ...(operation.inputSchema?.properties ?? {}), id: { type: "string", minLength: 1 } },
          required: ["id"],
          additionalProperties: false,
        },
        route: { method: "GET", path: "/records/:id" },
        target: { resource: "records", idInput: "id" },
      }],
    }), { [operation.id]: async () => ({ ok: true as const, data: { items: [] } }) });
    const registry = createAdminRegistry({ adapters: [firstAdapter, testAdapter("disabledfn")], enabledModules: ["firstfn"] });
    const document = createAdminOpenApiDocument(registry, { serverUrl: "https://console.example.test" });
    const projected = document.paths["/api/admin/v1/modules/firstfn/records/{id}"]?.get as Record<string, unknown>;
    expect(projected.operationId).toBe("firstfn.records.list");
    expect(projected["x-superfunctions-permission"]).toBe("firstfn.records.read");
    expect(projected["x-superfunctions-target"]).toEqual({ resource: "records", idInput: "id" });
    expect(document["x-superfunctions-enabled-modules"]).toEqual(["firstfn"]);
    expect(JSON.stringify(document)).not.toContain("disabledfn");
    expect(document.components.securitySchemes).toMatchObject({ authFnSession: expect.any(Object), authFnApiKey: expect.any(Object) });
  });

  it("documents destructive mutation controls without changing domain schemas", () => {
    const manifest = testManifest("examplefn");
    const base = manifest.operations[0]!;
    const destructive = testManifest("examplefn", {
      operations: [{
        ...base,
        id: "examplefn.records.delete",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        outputSchema: { type: "object", properties: { deleted: { type: "boolean" } }, required: ["deleted"], additionalProperties: false },
        route: { method: "DELETE", path: "/records/:id" },
        permission: "examplefn.records.delete",
        safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, audit: "required" },
        target: { resource: "records", idInput: "id" },
        mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      }],
    });
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(destructive, { "examplefn.records.delete": async () => ({ ok: true as const, data: { deleted: true } }) })],
      enabledModules: ["examplefn"],
    });
    const operation = createAdminOpenApiDocument(registry).paths["/api/admin/v1/modules/examplefn/records/{id}"]?.delete as { parameters?: Array<{ name: string; in: string; required: boolean }> };
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }),
      expect.objectContaining({ name: "X-Admin-Confirmation", in: "header", required: true }),
    ]));
    expect(JSON.stringify(operation)).not.toContain("_admin");
  });

  it("projects one-time secret outputs without exposing the internal redaction bypass name", () => {
    const base = testManifest("examplefn").operations[0]!;
    const manifest = testManifest("examplefn", {
      operations: [{
        ...base,
        id: "examplefn.records.issue-token",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { token: { type: "string" } },
          required: ["token"],
          additionalProperties: false,
        },
        route: { method: "POST", path: "/records/:id/token" },
        permission: "examplefn.records.write",
        safety: {
          classification: "write",
          idempotent: false,
          requiresConfirmation: true,
          audit: "required",
          confirmation: { risk: "high", method: "recent-auth", reason: "Issue a one-time access token." },
        },
        target: { resource: "records", idInput: "id" },
        redaction: { allowOutputFields: ["token"] },
        mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      }],
    });
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, {
        "examplefn.records.issue-token": async () => ({ ok: true as const, data: { token: "secret" } }),
      })],
      enabledModules: ["examplefn"],
    });
    const document = createAdminOpenApiDocument(registry);
    const projected = document.paths["/api/admin/v1/modules/examplefn/records/{id}/token"]?.post as Record<string, unknown>;
    expect(projected["x-superfunctions-redaction"]).toEqual({ oneTimeOutputFields: ["token"] });
    expect(JSON.stringify(projected)).not.toContain("allowOutputFields");

    const tools = projectAdminMcpTools({ registry, dispatcher: createAdminDispatcher({ registry }) });
    expect(tools[0]?.metadata["mcpfn/superconsole"]).toMatchObject({
      redaction: { oneTimeOutputFields: ["token"] },
    });
    expect(JSON.stringify(tools[0]?.metadata)).not.toContain("allowOutputFields");
  });

  it("rejects dangling security overrides and documents JSON query encoding and full envelopes", () => {
    const registry = createAdminRegistry({ adapters: [testAdapter()], enabledModules: ["examplefn"] });
    expect(() => createAdminOpenApiDocument(registry, {
      securitySchemes: { authFnSession: { type: "apiKey" } },
    })).toThrow(/authFnSession and authFnApiKey/);
    const document = createAdminOpenApiDocument(registry);
    const operation = document.paths["/api/admin/v1/modules/examplefn/resources/records"]?.get as {
      parameters: Array<Record<string, unknown>>;
      responses: Record<string, unknown>;
    };
    expect(operation.parameters.find((parameter) => parameter.name === "filter")).toBeUndefined();
    expect(JSON.stringify(operation.responses)).toContain("nextCursor");
    expect(JSON.stringify(document.components)).toContain("auditId");
    expect(JSON.stringify(document.components)).toContain("meta");
  });
});

describe("McpFn projection", () => {
  it("projects deterministic annotated tools that invoke the shared dispatcher", async () => {
    const manifest = testManifest();
    const registry = createAdminRegistry({
      adapters: [
        createAdminCapabilityAdapter(manifest, { "examplefn.records.list": async () => ({ ok: true as const, data: { items: [] } }) }),
        testAdapter("disabledfn"),
      ],
      enabledModules: ["examplefn"],
    });
    const dispatcher = createAdminDispatcher({ registry });
    const tools = projectAdminMcpTools({ registry, dispatcher });
    expect(tools).toHaveLength(1);
    expect(JSON.stringify(tools)).not.toContain("disabledfn");
    expect(tools[0]).toMatchObject({
      name: "superconsole_examplefn_records_list",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      metadata: { "mcpfn/superconsole": { moduleId: "examplefn", permission: "examplefn.records.read", target: { resource: "records", collection: true } } },
    });
    const context: AdminOperationContext = {
      scope,
      actor: { id: "agent", permissions: ["examplefn.records.read"] },
      requestId: "mcp_req",
      source: "console",
    };
    const result = await tools[0]!.handler({}, context, {} as never);
    expect(result).toMatchObject({ structuredContent: { ok: true, data: { items: [] }, requestId: "mcp_req" } });
    const registered: string[] = [];
    registerAdminMcpTools({ register: (tool) => registered.push(tool.name) }, { registry, dispatcher });
    expect(registered).toEqual(["superconsole_examplefn_records_list"]);
  });

  it("omits operations explicitly disabled for MCP", () => {
    const manifest = testManifest();
    const operation = manifest.operations[0]!;
    const adapter = createAdminCapabilityAdapter(testManifest("examplefn", { operations: [{ ...operation, mcp: false }] }), {
      [operation.id]: async () => ({ ok: true as const, data: { items: [] } }),
    });
    const registry = createAdminRegistry({ adapters: [adapter], enabledModules: ["examplefn"] });
    expect(projectAdminMcpTools({ registry, dispatcher: createAdminDispatcher({ registry }) })).toEqual([]);
  });
});

describe("adapter result discrimination", () => {
  it("preserves a raw domain object whose legitimate output property is named data", async () => {
    const base = testManifest().operations[0]!;
    const manifest = testManifest("examplefn", { operations: [{
      ...base,
      id: "examplefn.records.raw",
      outputSchema: {
        type: "object",
        properties: { data: { type: "string" } },
        required: ["data"],
        additionalProperties: false,
      },
    }] });
    const registry = createAdminRegistry({
      adapters: [createAdminCapabilityAdapter(manifest, { "examplefn.records.raw": async () => ({ data: "domain-value" }) })],
      enabledModules: ["examplefn"],
    });
    await expect(createAdminDispatcher({ registry }).dispatch({
      operationId: "examplefn.records.raw",
      input: {},
      context: { scope, actor: { id: "agent", permissions: ["examplefn.records.read"] }, requestId: "raw_req", source: "sdk" },
    })).resolves.toMatchObject({ ok: true, data: { data: "domain-value" } });
  });
});

describe("cursor pagination", () => {
  it("round-trips encoded scope-bound cursors and rejects cross-tenant use", () => {
    const cursor = encodeAdminCursor(scope, { updatedAt: "2026-08-13T00:00:00Z", id: "item_1" });
    expect(decodeAdminCursor(cursor, scope)).toEqual({ updatedAt: "2026-08-13T00:00:00Z", id: "item_1" });
    expect(() => decodeAdminCursor(cursor, { ...scope, environmentId: "other" })).toThrowError(/invalid for the active scope/);
    expect(normalizeAdminPageLimit(undefined, { defaultLimit: 25 })).toBe(25);
    expect(() => normalizeAdminPageLimit(201, { maxLimit: 200 })).toThrowError(/between 1 and 200/);
  });
});

describe("AdminClient", () => {
  it("adds mutation controls and returns typed envelopes", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { accepted: true }, requestId: "req" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = createAdminClient({ baseUrl: "https://console.example.test/api/admin/v1", fetch: fetcher as typeof fetch });
    await expect(client.invokeOperation<{ accepted: boolean }>("examplefn.records.rotate", { id: "1" }, {
      idempotencyKey: "idem",
      confirmationToken: "confirm",
    })).resolves.toMatchObject({ ok: true, data: { accepted: true } });
    const [, init] = fetcher.mock.calls[0]!;
    expect(init?.headers).toSatisfy((headers: Headers) => headers.get("idempotency-key") === "idem" && headers.get("x-admin-confirmation") === "confirm");
  });

  it("normalizes non-success API responses", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: "forbidden", message: "Denied", status: 403 } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }));
    const client = createAdminClient({ baseUrl: "https://console.example.test/api/admin/v1", fetch: fetcher as typeof fetch });
    await expect(client.openApi()).rejects.toMatchObject<Partial<AdminClientError>>({ status: 403, message: "Denied" });
  });

  it("covers shell surfaces and confirmation issuance with canonical envelopes", async () => {
    const observed: Array<{ url: string; init?: RequestInit }> = [];
    const client = createAdminClient({
      baseUrl: "https://console.example.test/api/admin/v1",
      fetch: (async (input, init) => {
        observed.push({ url: String(input), init });
        const path = new URL(String(input)).pathname;
        const data = path.endsWith("/confirmations")
          ? { token: "bound", expiresAt: "2026-08-13T10:00:00.000Z" }
          : { surface: path.split("/").at(-1) };
        return new Response(JSON.stringify({ ok: true, data }), { status: path.endsWith("/confirmations") ? 201 : 200 });
      }) as typeof fetch,
    });
    await client.overview();
    await client.search("failed run", { limit: 12, cursor: "next" });
    await client.audit({ module: "cifn", outcome: "failed", query: "deploy" });
    await client.settings();
    await client.mcp();
    await expect(client.issueConfirmation("examplefn.records.delete", { id: "1" })).resolves.toEqual({
      token: "bound",
      expiresAt: "2026-08-13T10:00:00.000Z",
    });
    expect(observed.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/admin/v1/overview",
      "/api/admin/v1/search",
      "/api/admin/v1/audit",
      "/api/admin/v1/settings",
      "/api/admin/v1/mcp",
      "/api/admin/v1/confirmations",
    ]);
    expect(new URL(observed[1]!.url).searchParams.get("q")).toBe("failed run");
    expect(new URL(observed[2]!.url).searchParams.get("module")).toBe("cifn");
    expect(JSON.parse(String(observed.at(-1)!.init?.body))).toEqual({ operationId: "examplefn.records.delete", input: { id: "1" } });
  });

  it("generates function operation methods, availability, and cursor page iteration", async () => {
    const manifest = testManifest("examplefn");
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const client = createAdminClient({
      baseUrl: "https://console.example.test/api/admin/v1",
      fetch: (async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        requests.push({ path, body });
        if (path.endsWith("/registry")) {
          return Response.json({ ok: true, data: { enabledModules: [manifest] } });
        }
        const cursor = body?.cursor;
        return Response.json({
          ok: true,
          data: { items: [cursor ?? "first"], nextCursor: cursor ? null : "page_2" },
          page: { nextCursor: cursor ? null : "page_2", hasMore: !cursor },
          requestId: cursor ? "req_2" : "req_1",
        });
      }) as typeof fetch,
    });
    const capability = createCapabilityAdminClient(manifest, client);

    await expect(capability.availability()).resolves.toMatchObject({
      available: true,
      moduleId: "examplefn",
      installedVersion: manifest.version,
    });
    await expect(capability.operations["examplefn.records.list"]({ limit: 1 })).resolves.toMatchObject({
      ok: true,
      requestId: "req_1",
    });
    const pages = [];
    for await (const page of capability.pages("examplefn.records.list", { limit: 1 })) pages.push(page);
    expect(pages.map((page) => page.requestId)).toEqual(["req_1", "req_2"]);
    expect(requests.at(-1)?.body).toMatchObject({ cursor: "page_2", limit: 1 });
  });
});
