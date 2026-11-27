import { describe, expect, it } from "vitest";
import { McpFnRegistry, McpFnValidationError, type McpFnToolDefinition } from "../src/index.js";
import { fromOpenAPI, type OpenApiOperation } from "../src/openapi/index.js";
import { expectArguments, recordingExecutor, requestExtra, tool } from "./openapi-helpers.js";

const ok = { "200": { description: "OK" } };

function catalogDocument(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "catalog", version: "1.0.0" },
    paths: {
      "/pets": {
        get: { operationId: "listPets", tags: ["pets"], responses: ok },
        head: { operationId: "headPets", tags: ["pets"], responses: ok },
        post: { operationId: "createPet", tags: ["pets"], responses: ok },
        options: { operationId: "optionsPets", responses: ok },
        trace: { operationId: "tracePets", responses: ok },
      },
      "/pets/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { operationId: "getPet", tags: ["pets"], responses: ok },
        put: { operationId: "replacePet", tags: ["pets"], responses: ok },
        patch: { operationId: "updatePet", tags: ["pets"], responses: ok },
        delete: { operationId: "deletePet", tags: ["pets", "admin"], responses: ok },
      },
      "/legacy": {
        get: { operationId: "legacyList", deprecated: true, responses: ok },
        delete: { operationId: "legacyPurge", deprecated: true, responses: ok },
      },
      "/stores": { get: { operationId: "listStores", tags: ["stores"], responses: ok } },
    },
  };
}

function names(options: Partial<Parameters<typeof fromOpenAPI>[1]> = {}) {
  const result = fromOpenAPI(catalogDocument(), { executor: recordingExecutor(), ...options });
  return {
    names: result.tools.map((entry) => entry.name),
    skipped: Object.fromEntries(result.skipped.map((entry) => [entry.operation.operationId, entry.code])),
  };
}

describe("fromOpenAPI filtering (D8)", () => {
  it("exposes only GET and HEAD by default and reports every other operation", () => {
    const { names: exposed, skipped } = names();
    expect(exposed).toEqual(["listPets", "headPets", "getPet", "listStores"]);
    expect(skipped).toEqual({
      createPet: "mutation-not-allowed",
      optionsPets: "mutation-not-allowed",
      tracePets: "mutation-not-allowed",
      replacePet: "mutation-not-allowed",
      updatePet: "mutation-not-allowed",
      deletePet: "mutation-not-allowed",
      legacyList: "deprecated",
      legacyPurge: "deprecated",
    });
  });

  it("treats include as an allow-list over operationIds, tags and METHOD /path", () => {
    expect(names({ include: ["listStores"] }).names).toEqual(["listStores"]);
    expect(names({ include: ["tag:stores", "GET /pets/{id}"] }).names).toEqual(["getPet", "listStores"]);
    expect(names({ include: ["get /pets"] }).names).toEqual(["listPets"]);
    expect(names({ include: ["tag:pets"] }).skipped).toMatchObject({ listStores: "not-included", createPet: "mutation-not-allowed" });
  });

  it("lets exclude win over include", () => {
    const result = names({ include: ["tag:pets", "deletePet"], exclude: ["getPet", "tag:admin", "HEAD /pets"] });
    expect(result.names).toEqual(["listPets"]);
    expect(result.skipped).toMatchObject({ getPet: "excluded", deletePet: "excluded", headPets: "excluded" });
  });

  it("opts a mutation in only by its operationId in include or by allowMutations", () => {
    expect(names({ include: ["tag:pets", "createPet"] }).names).toEqual(["listPets", "headPets", "createPet", "getPet"]);
    // A tag or METHOD /path selector selects, but does not opt a mutation in.
    expect(names({ include: ["tag:pets", "PUT /pets/{id}"] }).skipped).toMatchObject({
      replacePet: "mutation-not-allowed",
      deletePet: "mutation-not-allowed",
    });
    expect(names({ allowMutations: true }).names).toEqual([
      "listPets", "headPets", "createPet", "optionsPets", "tracePets",
      "getPet", "replacePet", "updatePet", "deletePet", "listStores",
    ]);
  });

  it("needs includeDeprecated for deprecated operations, and still the mutation opt-in", () => {
    expect(names({ includeDeprecated: true }).names).toContain("legacyList");
    expect(names({ includeDeprecated: true }).skipped).toMatchObject({ legacyPurge: "mutation-not-allowed" });
    expect(names({ includeDeprecated: true, include: ["legacyPurge"] }).names).toEqual(["legacyPurge"]);
    expect(names({ include: ["legacyPurge"] }).skipped).toMatchObject({ legacyPurge: "deprecated" });
  });

  it("selects an operationId that reads as a tag or route exactly with { operationId }", () => {
    const document = {
      openapi: "3.1.0",
      paths: {
        "/a": { get: { operationId: "tag:pets", tags: ["other"], responses: ok } },
        "/b": { post: { operationId: "POST /b", responses: ok } },
        "/c": { get: { operationId: "plain", tags: ["pets"], responses: ok } },
        "/d": { post: { operationId: "operationId:rotate", responses: ok } },
        "/e": { post: { operationId: "rotate", responses: ok } },
      },
    };
    const run = (options: Partial<Parameters<typeof fromOpenAPI>[1]>) => {
      const result = fromOpenAPI(document, { executor: recordingExecutor(), ...options });
      return {
        names: result.tools.map((entry) => entry.name),
        skipped: Object.fromEntries(result.skipped.map((entry) => [entry.operation.operationId, entry.code])),
      };
    };
    // "tag:pets" as a string is the tag; the object form names the operationId.
    expect(run({ include: ["tag:pets"] }).names).toEqual(["plain"]);
    expect(run({ include: [{ operationId: "tag:pets" }] }).names).toEqual(["tag_pets"]);
    // The object form opts a mutation in like a plain operationId; a route never does.
    expect(run({ include: [{ operationId: "POST /b" }] }).names).toEqual(["POST__b"]);
    expect(run({ include: ["POST /b"] }).skipped).toMatchObject({ "POST /b": "mutation-not-allowed" });
    // A string never changes meaning: it still names the literal operationId.
    expect(run({ include: ["operationId:rotate"] }).names).toEqual(["operationId_rotate"]);
    expect(run({ allowMutations: true, exclude: ["operationId:rotate"] }).skipped).toMatchObject({
      "operationId:rotate": "excluded",
    });
    expect(run({ allowMutations: true, exclude: ["operationId:rotate"] }).names).toContain("rotate");
    // exclude still wins.
    expect(run({ include: [{ operationId: "POST /b" }], exclude: [{ operationId: "POST /b" }] }).skipped).toMatchObject({
      "POST /b": "excluded",
    });
    expect(() => run({ include: [{ operationId: "" }] })).toThrow(/non-empty string or \{ operationId \}/);
    // Only an own operationId key counts: an inherited one neither includes, excludes nor opts in.
    const inherited = Object.assign(Object.create({ operationId: "POST /b" }) as object, { other: "x" });
    // Nor does a non-enumerable own one beside another enumerable key.
    const hidden = Object.defineProperty({ other: "x" }, "operationId", { value: "POST /b", enumerable: false });
    for (const option of ["include", "exclude"] as const) {
      for (const selector of [inherited, hidden]) {
        expect(() => run({ [option]: [selector] })).toThrow(/non-empty string or \{ operationId \}/);
      }
    }
  });

  it("rejects malformed selectors and options", () => {
    const executor = recordingExecutor();
    expect(() => fromOpenAPI(catalogDocument(), { executor, include: [""] })).toThrow(McpFnValidationError);
    expect(() => fromOpenAPI(catalogDocument(), { executor, exclude: ["tag:"] })).toThrow(/needs a tag name/);
    expect(() => fromOpenAPI(catalogDocument(), { executor, include: "listPets" as unknown as string[] })).toThrow(/array/);
    expect(() => fromOpenAPI(catalogDocument(), {} as never)).toThrow(/executor/);
    expect(() => fromOpenAPI("openapi: 3.0.3" as never, { executor })).toThrow(/parsed OpenAPI document/);
  });
});

describe("fromOpenAPI naming", () => {
  function namingDocument(paths: Record<string, unknown>) {
    return { openapi: "3.1.0", info: { title: "naming", version: "1" }, paths };
  }

  it("sanitises operationIds, applies the prefix first and truncates to 128", () => {
    const long = "x".repeat(140);
    const { tools } = fromOpenAPI(
      namingDocument({
        "/a": { get: { operationId: "users/list all", responses: ok } },
        "/b": { get: { operationId: "naïve😀", responses: ok } },
        "/c": { get: { operationId: long, responses: ok } },
      }),
      { executor: recordingExecutor(), prefix: "api v1:" },
    );
    expect(tools.map((entry) => entry.name)).toEqual([
      "api_v1_users_list_all",
      "api_v1_na_ve_",
      `api_v1_${"x".repeat(121)}`,
    ]);
  });

  it("derives a name from the method and path segments without an operationId", () => {
    const { tools } = fromOpenAPI(
      namingDocument({
        "/": { get: { responses: ok } },
        "/users/{userId}/posts": {
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
          get: { responses: ok },
          delete: { operationId: "", responses: ok },
        },
      }),
      { executor: recordingExecutor(), allowMutations: true },
    );
    expect(tools.map((entry) => entry.name)).toEqual(["get", "get_users_userId_posts", "delete_users_userId_posts"]);
  });

  it("suffixes collisions in document order, within 128 characters and around existing tools", () => {
    const long = "y".repeat(128);
    const registry = new McpFnRegistry();
    registry.register({ name: "taken", description: "existing", inputSchema: { type: "object" }, handler: () => ({ content: [] }) });
    const { tools } = fromOpenAPI(
      namingDocument({
        "/1": { get: { operationId: "dup", responses: ok } },
        "/2": { get: { operationId: "dup", responses: ok } },
        "/3": { get: { operationId: "dup_2", responses: ok } },
        "/4": { get: { operationId: "d up", responses: ok } },
        "/5": { get: { operationId: long, responses: ok } },
        "/6": { get: { operationId: long, responses: ok } },
        "/7": { get: { operationId: "taken", responses: ok } },
      }),
      { executor: recordingExecutor(), registry },
    );
    expect(tools.map((entry) => entry.name)).toEqual([
      "dup", "dup_2", "dup_2_2", "d_up", long, `${"y".repeat(126)}_2`, "taken_2",
    ]);
    expect(registry.listTools()).toHaveLength(8);
  });

  it("gives a name to the next operation when the first one is skipped at registration", () => {
    const { tools, skipped } = fromOpenAPI(
      namingDocument({
        "/1": { get: { operationId: "dup", parameters: [{ name: "q", in: "query", schema: { type: "string", pattern: "(" } }], responses: ok } },
        "/2": { get: { operationId: "dup", responses: ok } },
        "/3": { get: { operationId: "dup", responses: ok } },
      }),
      { executor: recordingExecutor() },
    );
    expect(skipped.map((entry) => [entry.operation.path, entry.code])).toEqual([["/1", "invalid-schema"]]);
    expect(tools.map((entry) => [entry.operation.path, entry.name])).toEqual([["/2", "dup"], ["/3", "dup_2"]]);
  });

  it("skips an invalid schema rejected by a registry from the other module format", () => {
    // The ESM and CommonJS entries each bundle McpFnValidationError, so
    // instanceof fails across them; the error name still identifies it.
    class OtherFormatRegistry extends McpFnRegistry {
      override register<TDefinition extends McpFnToolDefinition<undefined>>(definition: TDefinition): this {
        if (definition.name === "bad") {
          throw Object.assign(new Error("Tool bad contains an invalid JSON Schema"), { name: "McpFnValidationError" });
        }
        return super.register(definition);
      }
    }
    const { tools, skipped } = fromOpenAPI(
      namingDocument({
        "/bad": { get: { operationId: "bad", responses: ok } },
        "/good": { get: { operationId: "good", responses: ok } },
      }),
      { executor: recordingExecutor(), registry: new OtherFormatRegistry() },
    );
    expect(tools.map((entry) => entry.name)).toEqual(["good"]);
    expect(skipped).toMatchObject([{ operation: { operationId: "bad" }, code: "invalid-schema", reason: "Tool bad contains an invalid JSON Schema" }]);
  });

  it("uses the name callback and reports an invalid or duplicate result naming the operation", () => {
    const document = namingDocument({
      "/a": { get: { operationId: "first", responses: ok } },
      "/b": { get: { operationId: "second", responses: ok } },
    });
    const seen: OpenApiOperation[] = [];
    const { tools } = fromOpenAPI(document, {
      executor: recordingExecutor(),
      name: (operation) => {
        seen.push(operation);
        return `custom.${operation.operationId}`;
      },
    });
    expect(tools.map((entry) => entry.name)).toEqual(["custom.first", "custom.second"]);
    expect(seen.map((operation) => operation.path)).toEqual(["/a", "/b"]);

    const registry = new McpFnRegistry();
    expect(() => fromOpenAPI(document, { executor: recordingExecutor(), registry, name: (operation) => (operation.path === "/b" ? "bad name" : "ok") }))
      .toThrow(/invalid tool name "bad name" for GET \/b \(operationId second\)/);
    // Naming errors are raised before anything is registered.
    expect(registry.listTools()).toEqual([]);
    expect(() => fromOpenAPI(document, { executor: recordingExecutor(), name: () => "same" }))
      .toThrow(/duplicate tool name "same" for GET \/b \(operationId second\)/);
    expect(() => fromOpenAPI(document, { executor: recordingExecutor(), name: () => "x".repeat(129) })).toThrow(/invalid tool name/);
    expect(() => fromOpenAPI(document, { executor: recordingExecutor(), name: () => undefined as unknown as string })).toThrow(
      /invalid tool name undefined for GET \/a/,
    );
  });
});

describe("fromOpenAPI tool metadata", () => {
  it("never exposes forbidden headers as input fields (D9)", () => {
    const headers = ["Authorization", "cookie", "HOST", "Content-Length", "Proxy-Authorization", "proxy-connection", "Accept", "Content-Type"];
    const { tools } = fromOpenAPI(
      {
        openapi: "3.0.3",
        paths: {
          "/h": {
            get: {
              operationId: "headers",
              parameters: [
                ...headers.map((name) => ({ name, in: "header", required: true, schema: { type: "string" } })),
                { name: "X-Tenant", in: "header", schema: { type: "string" } },
              ],
              responses: ok,
            },
          },
          "/only": { get: { operationId: "onlyForbidden", parameters: [{ name: "Authorization", in: "header", required: true, schema: { type: "string" } }], responses: ok } },
        },
      },
      { executor: recordingExecutor() },
    );
    const headersTool = tool(tools, "headers");
    expect(headersTool.inputSchema.properties).toEqual({
      header: { type: "object", properties: { "X-Tenant": { type: "string" } }, additionalProperties: false },
    });
    expect(headersTool.operation.parameters.map((parameter) => parameter.name)).toEqual(["X-Tenant"]);
    expectArguments(headersTool.inputSchema, { valid: [{}], invalid: [{ header: { Authorization: "test-authorization-value" } }] });
    expect(tool(tools, "onlyForbidden").inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("derives annotations from the method", () => {
    const { tools } = fromOpenAPI(catalogDocument(), { executor: recordingExecutor(), allowMutations: true });
    const annotations = Object.fromEntries(tools.map((entry) => [entry.operation.method, entry.annotations]));
    expect(annotations).toEqual({
      GET: { readOnlyHint: true, openWorldHint: true },
      HEAD: { readOnlyHint: true, openWorldHint: true },
      POST: { openWorldHint: true },
      OPTIONS: { openWorldHint: true },
      TRACE: { openWorldHint: true },
      PUT: { idempotentHint: true, openWorldHint: true },
      PATCH: { openWorldHint: true },
      DELETE: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    });
    expect(tools[0]!.annotations).toEqual(new McpFnRegistry().register({
      name: "probe", description: "probe", inputSchema: { type: "object" }, annotations: tools[0]!.annotations, handler: () => ({ content: [] }),
    }).getListedTool("probe")!.annotations);
  });

  it("joins the trimmed summary and description and caps the result at 2,000 characters", () => {
    const { tools } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/a": { get: { operationId: "both", summary: "  List pets  ", description: "\nAll of them.\n", responses: ok } },
          "/b": { get: { operationId: "long", summary: "S", description: `${"d".repeat(1996)}😀tail`, responses: ok } },
          "/c": { get: { operationId: "none", summary: "   ", responses: ok } },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(tool(tools, "both").description).toBe("List pets\n\nAll of them.");
    // "S\n\n" + 1996 characters = 1,999; the emoji's surrogate pair would straddle the cap.
    expect(tool(tools, "long").description).toBe(`S\n\n${"d".repeat(1996)}`);
    expect(tool(tools, "none").description).toBe("GET /c");
  });

  it("passes the effective servers and security to the operation and freezes it", () => {
    const { tools } = fromOpenAPI(
      {
        openapi: "3.0.3",
        servers: [{ url: "https://api.example.com" }],
        security: [{ apiKey: [] }],
        paths: {
          "/a": { servers: [{ url: "https://path.example.com" }], get: { operationId: "pathServer", responses: ok } },
          "/b": { get: { operationId: "opServer", servers: [{ url: "https://op.example.com", description: "op" }], security: [], responses: ok } },
          "/c": { get: { operationId: "docServer", responses: ok } },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(tool(tools, "pathServer").operation.servers).toEqual([{ url: "https://path.example.com" }]);
    expect(tool(tools, "opServer").operation).toMatchObject({ servers: [{ url: "https://op.example.com", description: "op" }], security: [] });
    expect(tool(tools, "docServer").operation).toMatchObject({ servers: [{ url: "https://api.example.com" }], security: [{ apiKey: [] }] });
    expect(Object.isFrozen(tool(tools, "docServer").operation.parameters)).toBe(true);
  });

  it("treats an empty servers level as absent and falls back to the next level, then to /", () => {
    const { tools } = fromOpenAPI(
      {
        openapi: "3.1.0",
        servers: [],
        paths: {
          "/a": { servers: [], get: { operationId: "emptyEverywhere", servers: [], responses: ok } },
          "/b": { servers: [{ url: "https://path.example.com" }], get: { operationId: "emptyOperation", servers: [], responses: ok } },
          "/c": { get: { operationId: "unusableEntries", servers: [{ description: "no url" }], responses: ok } },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(tool(tools, "emptyEverywhere").operation.servers).toEqual([{ url: "/" }]);
    expect(tool(tools, "emptyOperation").operation.servers).toEqual([{ url: "https://path.example.com" }]);
    expect(tool(tools, "unusableEntries").operation.servers).toEqual([{ url: "/" }]);
  });

  it("lists and validates with the registered schemas whatever is done to the returned catalog", async () => {
    const { registry, tools } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/items/{id}": {
            get: {
              operationId: "getItem",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", maxLength: 3 } }],
              responses: {
                "200": {
                  description: "OK",
                  content: { "application/json": { schema: { type: "object", properties: { n: { type: "integer" } } } } },
                },
              },
            },
          },
        },
      },
      { executor: { execute: () => ({ content: [], structuredContent: { n: 1 } }) } },
    );
    const entry = tool(tools, "getItem");
    const listedBefore = JSON.stringify(registry.listTools());
    const path = (entry.inputSchema.properties!.path as { properties: Record<string, { maxLength?: number }> }).properties;
    path.id!.maxLength = 100;
    (entry.outputSchema!.properties as Record<string, unknown>).n = { type: "string" };
    entry.annotations.readOnlyHint = false;
    expect(JSON.stringify(registry.listTools())).toBe(listedBefore);
    await expect(
      registry.callTool("getItem", { path: { id: "toolong" } }, undefined, requestExtra()),
    ).rejects.toThrow(McpFnValidationError);
    await expect(registry.callTool("getItem", { path: { id: "abc" } }, undefined, requestExtra())).resolves.toMatchObject({
      structuredContent: { n: 1 },
    });
  });

  it("is not affected by later changes to the caller's document", () => {
    const document = catalogDocument();
    const { tools } = fromOpenAPI(document, { executor: recordingExecutor() });
    ((document.paths as Record<string, Record<string, Record<string, unknown>>>)["/pets"]!.get!).operationId = "changed";
    expect(tool(tools, "listPets").operation.operationId).toBe("listPets");
  });
});

describe("fromOpenAPI executor delegation", () => {
  it("hands the executor { operation, args, signal } exactly as the registry validated them", async () => {
    const executor = recordingExecutor();
    const { registry, tools } = fromOpenAPI(
      {
        openapi: "3.0.3",
        paths: {
          "/pets/{id}": {
            put: {
              operationId: "replacePet",
              parameters: [
                { name: "id", in: "path", required: true, schema: { type: "string" } },
                { name: "dryRun", in: "query", schema: { type: "boolean" } },
              ],
              requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } } },
              responses: ok,
            },
          },
        },
      },
      { executor, include: ["replacePet"] },
    );
    const args = { path: { id: "p1" }, query: { dryRun: true }, body: { name: "Rex" } };
    const controller = new AbortController();
    const result = await registry.callTool("replacePet", args, undefined, requestExtra(controller.signal));
    expect(result).toEqual({ content: [{ type: "text", text: "sent" }] });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toStrictEqual({
      operation: tool(tools, "replacePet").operation,
      args,
      context: undefined,
      signal: controller.signal,
      hasOutputSchema: false,
    });
    expect(executor.calls[0]!.operation).toBe(tool(tools, "replacePet").operation);
    expect(executor.calls[0]!.args).toBe(args);

    await expect(registry.callTool("replacePet", { path: { id: "p1" } }, undefined, requestExtra())).rejects.toThrow(McpFnValidationError);
    await expect(registry.callTool("replacePet", { ...args, extra: 1 }, undefined, requestExtra())).rejects.toThrow(McpFnValidationError);
    expect(executor.calls).toHaveLength(1);
  });

  it("validates executor results against the output schema through the registry", async () => {
    const { registry } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: { "/count": { get: { operationId: "count", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } } } } } } } },
      },
      { executor: { execute: () => ({ content: [], structuredContent: { n: "one" } }) } },
    );
    await expect(registry.callTool("count", {}, undefined, requestExtra())).rejects.toThrow(/Invalid output from count/);
  });
});
