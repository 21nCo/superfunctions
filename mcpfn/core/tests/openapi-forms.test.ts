import { describe, expect, it } from "vitest";
import { McpFnRegistry, McpFnValidationError } from "../src/index.js";
import { fromOpenAPI } from "../src/openapi/index.js";
import {
  expectArguments,
  fixture,
  recordingExecutor,
  tool,
} from "./openapi-helpers.js";

function convert(name: string, options: Partial<Parameters<typeof fromOpenAPI>[1]> = {}) {
  return fromOpenAPI(fixture(name), { executor: recordingExecutor(), allowMutations: true, ...options });
}

describe("fromOpenAPI closed form set (D12)", () => {
  it("converts an OpenAPI 3.0.x document, folding boolean exclusiveMinimum", () => {
    const { tools, skipped, registry } = convert("form-openapi-3.0");
    expect(skipped).toEqual([]);
    const getPet = tool(tools, "getPet");
    expect(registry.has("getPet")).toBe(true);
    expect(getPet.inputSchema).toEqual({
      type: "object",
      properties: {
        path: {
          type: "object",
          properties: { petId: { type: "integer", exclusiveMinimum: 1 } },
          required: ["petId"],
          additionalProperties: false,
        },
      },
      required: ["path"],
      additionalProperties: false,
    });
    expectArguments(getPet.inputSchema, {
      valid: [{ path: { petId: 2 } }],
      invalid: [{ path: { petId: 1 } }, {}, { path: { petId: 2 }, extra: true }, { path: { petId: 2, other: 1 } }],
    });
    expect(getPet.outputSchema).toMatchObject({ type: "object", required: ["id", "name"] });
  });

  it("converts an OpenAPI 3.1.x document, mapping dependentRequired and ignoring webhooks", () => {
    const { tools, skipped } = convert("form-openapi-3.1");
    expect(skipped).toEqual([]);
    expect(tools.map((entry) => entry.name)).toEqual(["getPet"]);
    const getPet = tool(tools, "getPet");
    expectArguments(getPet.inputSchema, { valid: [{ path: { petId: 1 } }], invalid: [{ path: { petId: 0 } }] });
    expect(getPet.outputSchema).toMatchObject({ dependencies: { name: ["id"] } });
    expectArguments(getPet.outputSchema!, {
      valid: [{ id: 1, name: null, kind: "pet" }, { id: 1 }],
      invalid: [{ name: "x" }, { id: 1, kind: "dog" }],
    });
  });

  it("resolves local schema, parameter, request body and response references", () => {
    const { tools, skipped } = convert("form-local-refs");
    expect(skipped).toEqual([]);
    const replacePet = tool(tools, "replacePet");
    expect(replacePet.inputSchema.properties).toEqual({
      path: {
        type: "object",
        properties: { petId: { $ref: "#/definitions/PetId" } },
        required: ["petId"],
        additionalProperties: false,
      },
      body: { $ref: "#/definitions/Pet" },
    });
    expect(replacePet.inputSchema.required).toEqual(["path", "body"]);
    expect(Object.keys(replacePet.inputSchema.definitions as object).sort()).toEqual(["Owner", "Pet", "PetId"]);
    expect(replacePet.operation.parameters).toEqual([
      { name: "petId", in: "path", required: true, style: "simple", explode: false, shape: "primitive" },
    ]);
    expect(replacePet.operation.requestBody).toEqual({ required: true, contentType: "application/json" });
    expectArguments(replacePet.inputSchema, {
      valid: [{ path: { petId: "rex-1" }, body: { name: "Rex", owner: { email: "owner@example.com" } } }],
      invalid: [
        { path: { petId: "Rex!" }, body: { name: "Rex" } },
        { path: { petId: "rex" } },
        { path: { petId: "rex" }, body: { owner: {} } },
        { path: { petId: "rex" }, body: { name: "Rex", owner: { email: "not-an-email" } } },
      ],
    });
    expect(replacePet.outputSchema).toMatchObject({ type: "object", required: ["name"] });
    expect(replacePet.outputSchema?.definitions).toHaveProperty("Owner");
  });

  it("terminates on recursive component schemas", () => {
    const { tools, skipped } = convert("form-recursive-refs");
    expect(skipped).toEqual([]);
    const createTree = tool(tools, "createTree");
    expect(Object.keys(createTree.inputSchema.definitions as object).sort()).toEqual(["Node", "Parent"]);
    expectArguments(createTree.inputSchema, {
      valid: [{ body: { value: "root", children: [{ value: "a", children: [{ value: "b" }] }], parent: { node: { value: "p" } } } }],
      invalid: [{ body: { value: "root", children: [{ children: [] }] } }],
    });
    // The output root inlines Node while its recursion stays under definitions.
    expect(createTree.outputSchema).toMatchObject({ type: "object", required: ["value"] });
    expectArguments(createTree.outputSchema!, { valid: [{ value: "x", children: [{ value: "y" }] }], invalid: [{ children: [] }] });
  });

  it("merges path-level and operation-level parameters with operation-level override", () => {
    const { tools } = convert("form-parameter-override");
    const listMembers = tool(tools, "listMembers");
    expect(listMembers.inputSchema.properties).toMatchObject({
      path: { properties: { org: { type: "string" } }, required: ["org"] },
      query: { properties: { limit: { type: "integer", maximum: 50 } }, required: ["limit"] },
      header: { properties: { "x-trace": { type: "string" } } },
    });
    expect(listMembers.inputSchema.required).toEqual(["path", "query"]);
    expect(listMembers.operation.parameters.map((parameter) => `${parameter.in}:${parameter.name}`)).toEqual([
      "path:org",
      "query:limit",
      "header:x-trace",
    ]);
    expectArguments(listMembers.inputSchema, {
      valid: [{ path: { org: "acme" }, query: { limit: 50 } }],
      invalid: [{ path: { org: "acme" }, query: { limit: 51 } }, { path: { org: "acme" } }],
    });
  });

  it("accepts default styles over primitives and arrays of primitives in path, query and header", () => {
    const { tools, skipped } = convert("form-parameter-styles");
    expect(skipped).toEqual([]);
    const getItems = tool(tools, "getItems");
    expect(getItems.operation.parameters).toEqual([
      { name: "ids", in: "path", required: true, style: "simple", explode: false, shape: "array" },
      { name: "tag", in: "query", required: false, style: "form", explode: true, shape: "array" },
      { name: "q", in: "query", required: false, style: "form", explode: true, shape: "primitive" },
      { name: "exact", in: "query", required: false, style: "form", explode: true, shape: "primitive" },
      { name: "x-page", in: "header", required: true, style: "simple", explode: false, shape: "primitive" },
      { name: "x-flags", in: "header", required: false, style: "simple", explode: false, shape: "array" },
    ]);
    expect(getItems.inputSchema.required).toEqual(["path", "header"]);
    expectArguments(getItems.inputSchema, {
      valid: [{ path: { ids: [1, 2] }, query: { tag: ["a"], q: "a", exact: true }, header: { "x-page": 1.5, "x-flags": ["f"] } }],
      invalid: [
        { path: { ids: ["one"] }, header: { "x-page": 1 } },
        { path: { ids: [1] }, query: { q: "c" }, header: { "x-page": 1 } },
        { path: { ids: [1] } },
      ],
    });
  });

  it("accepts an application/json body with parameters and prefers it over other media types", () => {
    const { tools } = convert("form-body-json");
    const createNote = tool(tools, "createNote");
    expect(createNote.operation.requestBody).toEqual({ required: true, contentType: "application/json; charset=utf-8" });
    expect(createNote.inputSchema.required).toEqual(["body"]);
    expectArguments(createNote.inputSchema, {
      valid: [{ body: { text: "hello" } }],
      invalid: [{ body: { text: "longer than ten" } }, {}],
    });
  });

  it("accepts a *+json body", () => {
    const { tools } = convert("form-body-plus-json");
    const patchNote = tool(tools, "patchNote");
    expect(patchNote.operation.requestBody).toEqual({ required: false, contentType: "application/merge-patch+json" });
    expect(patchNote.inputSchema.required).toEqual(["path"]);
    expectArguments(patchNote.inputSchema, {
      valid: [{ path: { id: "n1" } }, { path: { id: "n1" }, body: { text: null } }],
      invalid: [{ path: { id: "n1" }, body: { text: 1 } }],
    });
  });

  it("converts OpenAPI 3.0 nullable to a type union", () => {
    const { tools } = convert("form-nullable-3.0");
    const createProfile = tool(tools, "createProfile");
    expect(createProfile.inputSchema.properties?.body).toMatchObject({
      properties: {
        nickname: { type: ["string", "null"] },
        color: { type: ["string", "null"], enum: ["red", "blue", null] },
        address: { anyOf: [{ allOf: [{ $ref: "#/definitions/Address" }] }, { type: "null" }] },
      },
    });
    expect(JSON.stringify(createProfile.inputSchema)).not.toContain("nullable");
    expectArguments(createProfile.inputSchema, {
      valid: [{ body: { nickname: null, color: null, address: null } }, { body: { nickname: "n", color: "red", address: { city: "Oslo" } } }],
      invalid: [{ body: { nickname: 1 } }, { body: { nickname: null, color: "green" } }, { body: { nickname: null, address: {} } }],
    });
  });

  it("drops example, discriminator, xml and externalDocs", () => {
    const { tools } = convert("form-dropped-keywords");
    const createShape = tool(tools, "createShape");
    const serialized = JSON.stringify(createShape.inputSchema);
    for (const keyword of ["example", "discriminator", "xml", "externalDocs"]) {
      expect(serialized).not.toContain(`"${keyword}"`);
    }
    // The discriminator mapping is not a schema position, so Circle is not pulled in.
    expect(Object.keys(createShape.inputSchema.definitions as object)).toEqual(["Shape"]);
    expectArguments(createShape.inputSchema, { valid: [{ body: { kind: "circle" } }], invalid: [{ body: {} }] });
  });

  it("removes readOnly properties from inputs and writeOnly properties from outputs", () => {
    const { tools } = convert("form-read-only");
    const createAccount = tool(tools, "createAccount");
    const input = (createAccount.inputSchema.definitions as Record<string, Record<string, unknown>>).Account!;
    expect(Object.keys(input.properties as object)).toEqual(["name", "secretAnswer"]);
    expect(input.required).toEqual(["name", "secretAnswer"]);
    expect(Object.keys(createAccount.outputSchema!.properties!)).toEqual(["id", "createdAt", "name"]);
    expect(createAccount.outputSchema!.required).toEqual(["id", "createdAt", "name"]);
    expectArguments(createAccount.inputSchema, {
      valid: [{ body: { name: "a", secretAnswer: "test-answer" } }],
      invalid: [{ body: { name: "a" } }],
    });
  });

  it("declares an output schema only for the first 2xx application/json object response", () => {
    const { tools } = convert("form-output-schema");
    expect(tool(tools, "objectResponse").outputSchema).toEqual({
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    });
    expect(tool(tools, "arrayResponse").outputSchema).toBeUndefined();
    expect(tool(tools, "textResponse").outputSchema).toEqual({ type: "object" });
    expect(tool(tools, "nullableObjectResponse").outputSchema).toBeUndefined();
    expect(tool(tools, "noSuccessResponse").outputSchema).toBeUndefined();
  });

  it("converts the committed apifn fromRouter document", () => {
    const registry = new McpFnRegistry();
    const { tools, skipped } = fromOpenAPI(fixture("apifn-from-router"), {
      executor: recordingExecutor(),
      allowMutations: true,
      registry,
    });
    expect(skipped).toEqual([]);
    expect(tools.map((entry) => entry.name)).toEqual(["getApiHealth", "listUsers", "createUser", "deleteUser", "getUser"]);
    expect(registry.listTools().map((entry) => entry.name).sort()).toEqual(tools.map((entry) => entry.name).sort());
    expectArguments(tool(tools, "listUsers").inputSchema, {
      valid: [{}, { query: { limit: 10, cursor: "c" } }],
      invalid: [{ query: { limit: 0 } }],
    });
    expectArguments(tool(tools, "getUser").inputSchema, {
      valid: [{ path: { id: "u1" }, header: { "x-request-id": "r1" } }],
      invalid: [{ header: { "x-request-id": "r1" } }],
    });
    expectArguments(tool(tools, "createUser").inputSchema, {
      valid: [{ body: { name: "Ada" } }],
      invalid: [{ body: { name: "" } }, { body: { name: "Ada", role: "admin" } }],
    });
    expect(tool(tools, "deleteUser").annotations).toEqual({ destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(tool(tools, "listUsers").outputSchema).toMatchObject({ type: "object", required: ["items", "next"] });
  });
});

describe("fromOpenAPI skip reasons", () => {
  it("rejects a Swagger 2.0 document as a whole", () => {
    expect(() => convert("skip-swagger-2.0")).toThrow(McpFnValidationError);
    expect(() => convert("skip-swagger-2.0")).toThrow(/Swagger 2\.0/);
  });

  it("rejects documents that are not OpenAPI 3.0 or 3.1", () => {
    for (const openapi of ["3.2.0", "2.0", 3.1, undefined]) {
      expect(() => fromOpenAPI({ openapi, paths: {} } as Record<string, unknown>, { executor: recordingExecutor() })).toThrow(
        /Unsupported OpenAPI version/,
      );
    }
  });

  it.each([
    ["skip-external-ref", "listPets", "external-ref", /pets\.yaml/],
    ["skip-url-ref", "listPets", "external-ref", /https:\/\/schemas\.example\.com/],
    ["skip-cookie-parameter", "getSession", "cookie-parameter", /cookie/],
    ["skip-object-query-parameter", "search", "unsupported-parameter-schema", /object-valued/],
    ["skip-non-json-body", "upload", "non-json-body", /multipart\/form-data/],
  ])("%s skips %s with %s", (name, operationId, code, reason) => {
    const { tools, skipped } = convert(name);
    expect(tools).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ operation: { operationId }, code });
    expect(skipped[0]!.reason).toMatch(reason);
  });

  it("skips each non-default parameter style", () => {
    const { tools, skipped } = convert("skip-parameter-styles");
    expect(tools).toEqual([]);
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code, entry.reason])).toEqual(
      ["deepObject", "pipeDelimited", "spaceDelimited", "matrix", "label"].map((style) => [
        `style_${style}`,
        "unsupported-parameter-style",
        `parameter value uses style "${style}"`,
      ]),
    );
  });

  it("skips each unsupported 2020-12 keyword", () => {
    const { tools, skipped } = convert("skip-2020-12-keywords");
    expect(tools).toEqual([]);
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["usesPrefixItems", "unsupported-schema-keyword"],
      ["usesDynamicRef", "unsupported-schema-keyword"],
      ["usesUnevaluatedProperties", "unsupported-schema-keyword"],
      ["usesDependentSchemas", "unsupported-schema-keyword"],
    ]);
    expect(skipped.map((entry) => entry.reason)).toEqual([
      "schema keyword prefixItems is not supported",
      "schema keyword $dynamicRef is not supported (in #/components/schemas/Dynamic)",
      "schema keyword unevaluatedProperties is not supported",
      "schema keyword dependentSchemas is not supported",
    ]);
  });

  it("skips query arrays with explode: false and keeps converting other operations", () => {
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.0.3",
        paths: {
          "/a": { get: { operationId: "a", parameters: [{ name: "ids", in: "query", explode: false, schema: { type: "array", items: { type: "string" } } }], responses: {} } },
          "/b": { get: { operationId: "b", responses: {} } },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(tools.map((entry) => entry.name)).toEqual(["b"]);
    expect(skipped).toEqual([
      {
        operation: { method: "GET", path: "/a", operationId: "a" },
        code: "unsupported-parameter-style",
        reason: "query parameter ids uses form style with explode: false",
      },
    ]);
  });

  it("skips unresolved, unsupported and cyclic references and path item references", () => {
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/missing": { get: { operationId: "missing", responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Nope" } } } } } } },
          "/deep": { get: { operationId: "deep", parameters: [{ name: "q", in: "query", schema: { $ref: "#/components/schemas/Thing/properties/q" } }], responses: {} } },
          "/cycle": { get: { operationId: "cycle", parameters: [{ $ref: "#/components/parameters/A" }], responses: {} } },
          "/item": { $ref: "#/components/pathItems/Item" },
          "/templated/{id}": { get: { operationId: "templated", responses: {} } },
        },
        components: {
          schemas: { Thing: { type: "object", properties: { q: { type: "string" } } } },
          parameters: { A: { $ref: "#/components/parameters/B" }, B: { $ref: "#/components/parameters/A" } },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(tools).toEqual([]);
    expect(skipped.map((entry) => [entry.operation.operationId ?? entry.operation.path, entry.code])).toEqual([
      ["missing", "unresolved-ref"],
      ["deep", "unsupported-ref"],
      ["cycle", "unresolved-ref"],
      ["/item", "unsupported-ref"],
      ["templated", "missing-path-parameter"],
    ]);
  });

  it("skips an object that contains itself without a $ref", () => {
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    (schema.properties as Record<string, unknown>).self = schema;
    const { skipped } = fromOpenAPI(
      { openapi: "3.0.3", paths: { "/loop": { post: { operationId: "loop", requestBody: { content: { "application/json": { schema } } }, responses: {} } } } },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expect(skipped).toMatchObject([{ operation: { operationId: "loop" }, code: "circular-object" }]);
  });
});

describe("fromOpenAPI conversion edge cases", () => {
  it("applies OpenAPI 3.1 $ref siblings through allOf and ignores them in 3.0", () => {
    const paths = {
      "/a": {
        post: {
          operationId: "siblings",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Name", maxLength: 3 } } } },
          responses: {},
        },
      },
    };
    const components = { schemas: { Name: { type: "string" } } };
    const v31 = tool(fromOpenAPI({ openapi: "3.1.0", paths, components }, { executor: recordingExecutor(), allowMutations: true }).tools, "siblings");
    expect(v31.inputSchema.properties?.body).toEqual({ maxLength: 3, allOf: [{ $ref: "#/definitions/Name" }] });
    expectArguments(v31.inputSchema, { valid: [{ body: "abc" }], invalid: [{ body: "abcd" }, { body: 1 }] });
    const v30 = tool(fromOpenAPI({ openapi: "3.0.3", paths, components }, { executor: recordingExecutor(), allowMutations: true }).tools, "siblings");
    expect(v30.inputSchema.properties?.body).toEqual({ $ref: "#/definitions/Name" });
  });

  it("skips a pure $ref cycle between component schemas", () => {
    const { skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/a": { post: { operationId: "body", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } } }, responses: {} } },
          "/b": { get: { operationId: "query", parameters: [{ name: "q", in: "query", schema: { $ref: "#/components/schemas/A" } }], responses: {} } },
        },
        components: { schemas: { A: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/A" } } },
      },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["body", "unresolved-ref"],
      ["query", "unresolved-ref"],
    ]);
  });

  it("declares no output schema for HEAD", () => {
    const { tools } = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/a": { head: { operationId: "probe", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } } } } } },
      { executor: recordingExecutor() },
    );
    expect(tool(tools, "probe").outputSchema).toBeUndefined();
  });

  it("skips parameters described by content instead of schema", () => {
    const { skipped } = fromOpenAPI(
      { openapi: "3.0.3", paths: { "/a": { get: { operationId: "content", parameters: [{ name: "filter", in: "query", content: { "application/json": { schema: { type: "object" } } } }], responses: {} } } } },
      { executor: recordingExecutor() },
    );
    expect(skipped).toMatchObject([{ operation: { operationId: "content" }, code: "parameter-content" }]);
  });

  it("skips an operation whose schema mcpFn rejects at registration and registers the rest", () => {
    const registry = new McpFnRegistry();
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.0.3",
        paths: {
          "/bad": { get: { operationId: "bad", parameters: [{ name: "q", in: "query", schema: { type: "string", pattern: "(" } }], responses: {} } },
          "/good": { get: { operationId: "good", responses: {} } },
        },
      },
      { executor: recordingExecutor(), registry },
    );
    expect(tools.map((entry) => entry.name)).toEqual(["good"]);
    expect(skipped).toMatchObject([{ operation: { operationId: "bad" }, code: "invalid-schema" }]);
    expect(skipped[0]!.reason).toMatch(/Tool bad contains an invalid JSON Schema/);
    expect(registry.has("bad")).toBe(false);
  });
});
