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

const NESTED_MAX_PROPERTIES = "maxProperties inside anyOf/oneOf, not, if/then/else or a dependency";

function constrained(name: string, by: string, keyword = "readOnly"): string {
  return `property "${name}" is ${keyword} but is also constrained by ${by}, so it cannot be removed soundly`;
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
    // OAS 3.0.3: nullable adds "null" to an explicit type only; enum keeps its
    // meaning and a schema without type is unaffected.
    expect(createProfile.inputSchema.properties?.body).toMatchObject({
      properties: {
        nickname: { type: ["string", "null"] },
        color: { type: ["string", "null"], enum: ["red", "blue"] },
        shade: { type: ["string", "null"], enum: ["light", null] },
        address: { allOf: [{ $ref: "#/definitions/Address" }] },
      },
    });
    expect(JSON.stringify(createProfile.inputSchema)).not.toContain("nullable");
    expectArguments(createProfile.inputSchema, {
      valid: [
        { body: { nickname: null, shade: null } },
        { body: { nickname: "n", color: "red", shade: "light", address: { city: "Oslo" } } },
      ],
      invalid: [
        { body: { nickname: 1 } },
        { body: { nickname: null, color: null } },
        { body: { nickname: null, color: "green" } },
        { body: { nickname: null, address: null } },
        { body: { nickname: null, address: {} } },
      ],
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
    // Account accepts additional properties, so the removed names are refused by name.
    expect(input.propertyNames).toEqual({ not: { enum: ["id", "createdAt"] } });
    expectArguments(createAccount.inputSchema, {
      valid: [
        { body: { name: "a", secretAnswer: "test-answer" } },
        { body: { name: "a", secretAnswer: "test-answer", nickname: "extra fields stay allowed" } },
      ],
      invalid: [
        { body: { name: "a" } },
        { body: { name: "a", secretAnswer: "test-answer", id: "client-chosen-id" } },
        { body: { name: "a", secretAnswer: "test-answer", createdAt: "2026-01-01T00:00:00Z" } },
      ],
    });
  });

  it("finds readOnly and writeOnly through allOf members and keeps unrelated uses of a component", () => {
    const { tools } = convert("form-read-only-composed");
    const createAccount = tool(tools, "createAccount");
    const account = (createAccount.inputSchema.definitions as Record<string, Record<string, unknown>>).Account!;
    expect(Object.keys(account.properties as object)).toEqual(["name", "password"]);
    expect(account.required).toEqual(["name", "password"]);
    expectArguments(createAccount.inputSchema, {
      valid: [{ body: { name: "a", password: "test-password" } }],
      invalid: [{ body: { name: "a", password: "test-password", createdAt: "2026-01-01T00:00:00Z" } }],
    });
    // The server leaves the writeOnly password out of its response.
    expect(createAccount.outputSchema!.required).toEqual(["createdAt", "name"]);
    expectArguments(createAccount.outputSchema!, {
      valid: [{ createdAt: "2026-01-01T00:00:00Z", name: "a" }],
      invalid: [{ name: "a" }],
    });

    // Identified marks id readOnly; its allOf sibling Named requires it.
    const createProfile = tool(tools, "createProfile");
    expectArguments(createProfile.inputSchema, {
      valid: [{ body: { name: "a" } }, { body: { name: "a", nickname: "extra" } }],
      invalid: [{ body: { id: "client-chosen-id", name: "a" } }, { body: {} }],
    });
    // Named itself is unchanged where nothing marks id readOnly.
    const createRecord = tool(tools, "createRecord");
    expect((createRecord.inputSchema.definitions as Record<string, Record<string, unknown>>).Named!.required).toEqual(["id", "name"]);
    expectArguments(createRecord.inputSchema, {
      valid: [{ body: { named: { id: "1", name: "a" } } }],
      invalid: [{ body: { named: { name: "a" } } }],
    });
  });

  it("finds readOnly on a 3.1 alias that adds it beside its $ref, and on an allOf sibling of a $ref", () => {
    const { tools } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/items": {
            post: {
              operationId: "createItem",
              requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } } },
              responses: { "200": { description: "OK" } },
            },
          },
          "/tagged": {
            post: {
              operationId: "createTagged",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Named", properties: { id: { type: "string", readOnly: true } } },
                  },
                },
              },
              responses: { "200": { description: "OK" } },
            },
          },
        },
        components: {
          schemas: {
            Timestamp: { type: "string", format: "date-time" },
            ServerTime: { $ref: "#/components/schemas/Timestamp", readOnly: true },
            Item: {
              type: "object",
              properties: { createdAt: { $ref: "#/components/schemas/ServerTime" }, name: { type: "string" } },
              required: ["createdAt", "name"],
            },
            Named: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] },
          },
        },
      },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expectArguments(tool(tools, "createItem").inputSchema, {
      valid: [{ body: { name: "a" } }],
      invalid: [{ body: { name: "a", createdAt: "2026-01-01T00:00:00Z" } }],
    });
    expectArguments(tool(tools, "createTagged").inputSchema, {
      valid: [{ body: { name: "a" } }],
      invalid: [{ body: { id: "client-chosen-id", name: "a" } }],
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
    ["skip-object-query-parameter", "search", "unsupported-parameter-schema", /query parameter filter can be an object/],
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
      ["usesMinContains", "unsupported-schema-keyword"],
      ["usesMaxContains", "unsupported-schema-keyword"],
    ]);
    expect(skipped.map((entry) => entry.reason)).toEqual([
      "schema keyword prefixItems is not supported",
      "schema keyword $dynamicRef is not supported (in #/components/schemas/Dynamic)",
      "schema keyword unevaluatedProperties is not supported",
      "schema keyword dependentSchemas is not supported",
      "schema keyword minContains is not supported",
      "schema keyword maxContains is not supported",
    ]);
  });

  it("keeps contains without count bounds, which both engines validate alike", () => {
    const { tools } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/ids": {
            post: {
              operationId: "usesContains",
              requestBody: { content: { "application/json": { schema: { type: "array", items: { type: "integer" }, contains: { minimum: 10 } } } } },
              responses: { "200": { description: "OK" } },
            },
          },
        },
      },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expectArguments(tool(tools, "usesContains").inputSchema, {
      valid: [{ body: [1, 10] }, {}],
      invalid: [{ body: [1, 2] }, { body: [] }],
    });
  });

  it("skips a $ref cycle that never descends into a property or item, and keeps one that does", () => {
    const { tools, skipped } = convert("skip-nonproductive-recursion");
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["selfWithSibling", "unresolved-ref"],
      ["selfInAnyOf", "unresolved-ref"],
      ["mutualAllOf", "unresolved-ref"],
      ["cycleBelowProperty", "unresolved-ref"],
    ]);
    expect(skipped[0]!.reason).toBe(
      "#/components/schemas/SelfObject refers back to itself without descending into a property or array item",
    );
    expect(tools.map((entry) => entry.name)).toEqual(["productiveTree"]);
    expectArguments(tool(tools, "productiveTree").inputSchema, {
      valid: [{ body: { name: "root", children: [{ name: "leaf", children: [] }] } }],
      invalid: [{ body: { name: "root", children: [{ children: [] }] } }],
    });
  });

  it("skips readOnly and writeOnly properties that alternatives, conditions or dependencies constrain", () => {
    const { tools, skipped } = convert("skip-access-flag-conflicts");
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["readOnlyRequiredInOneOf", "unsupported-access-flag"],
      ["readOnlyInDependencies", "unsupported-access-flag"],
      ["readOnlyInDependentRequired", "unsupported-access-flag"],
      ["readOnlyRequiredInThen", "unsupported-access-flag"],
      ["readOnlyInNot", "unsupported-access-flag"],
      ["readOnlyFlaggedInIf", "unsupported-access-flag"],
      ["requiredButReadOnlyInEveryBranch", "unsupported-access-flag"],
      ["readOnlyRequiredByReferencedBranch", "unsupported-access-flag"],
      ["writeOnlyRequiredInOneOf", "unsupported-access-flag"],
    ]);
    expect(skipped[0]!.reason).toMatch(/property "id" is readOnly/);
    // The nullable reference idiom: readOnly when every non-null alternative is.
    expectArguments(tool(tools, "nullableReadOnlyReference").inputSchema, {
      valid: [{ body: { name: "a" } }],
      invalid: [{ body: { name: "a", createdAt: "2026-01-01T00:00:00Z" } }, { body: { name: "a", createdAt: null } }, { body: {} }],
    });
    // Each oneOf member marks id readOnly and removes it itself.
    expectArguments(tool(tools, "polymorphicReadOnlyId").inputSchema, {
      valid: [{ body: { kind: "cat", indoor: true } }, { body: { kind: "dog" } }],
      invalid: [{ body: { kind: "cat", id: "client-chosen-id" } }, { body: { kind: "fish" } }, { body: {} }],
    });
    // A oneOf that never uses the readOnly name keeps its meaning.
    expectArguments(tool(tools, "readOnlyBesideUnrelatedOneOf").inputSchema, {
      valid: [{ body: { a: "x" } }, { body: { b: "y" } }],
      invalid: [{ body: {} }, { body: { a: "x", b: "y" } }, { body: { a: "x", id: "client-chosen-id" } }],
    });
    const output = tool(tools, "nullableWriteOnlyReference").outputSchema!;
    expect(output.required).toEqual(["name"]);
    expectArguments(output, { valid: [{ name: "a" }], invalid: [{}] });
    expect(output.properties).not.toHaveProperty("password");
  });

  it("skips readOnly and writeOnly properties of objects that const, enum or minProperties constrain", () => {
    const { tools, skipped } = convert("skip-access-flag-instance-constraints");
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code, entry.reason])).toEqual([
      ["readOnlyWithConst", "unsupported-access-flag", 'property "id" is readOnly but is also constrained by const, so it cannot be removed soundly'],
      ["readOnlyWithEnum", "unsupported-access-flag", 'property "id" is readOnly but is also constrained by enum, so it cannot be removed soundly'],
      ["readOnlyWithMinProperties", "unsupported-access-flag", 'property "id" is readOnly but is also constrained by minProperties, so it cannot be removed soundly'],
      ["readOnlyWithInheritedMinProperties", "unsupported-access-flag", 'property "id" is readOnly but is also constrained by minProperties, so it cannot be removed soundly'],
      ["readOnlyBesideConstInOneOf", "unsupported-access-flag", 'property "id" is readOnly but is also constrained by const, so it cannot be removed soundly'],
      ["writeOnlyWithEnum", "unsupported-access-flag", 'property "password" is writeOnly but is also constrained by enum, so it cannot be removed soundly'],
    ]);
    // maxProperties only gets easier to meet when a property is removed.
    expectArguments(tool(tools, "readOnlyWithMaxProperties").inputSchema, {
      valid: [{ body: { label: "a" } }, { body: {} }],
      invalid: [{ body: { id: "client-chosen-id" } }, { body: { label: "a", other: 1 } }],
    });
    // An object enum without flagged properties is converted unchanged.
    expectArguments(tool(tools, "enumWithoutAccessFlags").inputSchema, {
      valid: [{ body: { label: "a" } }],
      invalid: [{ body: { label: "c" } }],
    });
  });

  it("skips readOnly and writeOnly properties whose removal would make oneOf members overlap", () => {
    const { tools, skipped } = convert("skip-access-flag-oneof-overlap");
    const oneOf = "a oneOf whose members do not all mark it the same way";
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code, entry.reason])).toEqual([
      ["readOnlyConstDiscriminator", "unsupported-access-flag", `property "kind" is readOnly but is also constrained by ${oneOf}, so it cannot be removed soundly`],
      ["readOnlyEnumDiscriminator", "unsupported-access-flag", `property "kind" is readOnly but is also constrained by ${oneOf}, so it cannot be removed soundly`],
      ["readOnlyTypeDiscriminator", "unsupported-access-flag", `property "kind" is readOnly but is also constrained by ${oneOf}, so it cannot be removed soundly`],
      ["readOnlyRequiredInOneMember", "unsupported-access-flag", `property "id" is readOnly but is also constrained by ${oneOf}, so it cannot be removed soundly`],
      ["readOnlyAbsentInOneMember", "unsupported-access-flag", `property "id" is readOnly but is also constrained by ${oneOf}, so it cannot be removed soundly`],
      ["readOnlyDiscriminatorInReferencedMembers", "unsupported-access-flag", `property "kind" is readOnly but is also constrained by ${oneOf}, so it cannot be removed soundly`],
      ["writeOnlyOutputDiscriminator", "unsupported-access-flag", `property "kind" is writeOnly but is also constrained by ${oneOf}, so it cannot be removed soundly`],
    ]);
    // Members that flag id through equal schemas, required in both, stay exclusive on the rest.
    expectArguments(tool(tools, "readOnlySameInEveryMember").inputSchema, {
      valid: [{ body: { a: "x" } }, { body: { b: "y" } }],
      invalid: [{ body: {} }, { body: { a: "x", b: "y" } }, { body: { a: "x", id: "client-chosen-id" } }],
    });
    // The null member of a nullable reference accepts no object, so it cannot start overlapping.
    expectArguments(tool(tools, "readOnlyNullableReference").inputSchema, {
      valid: [{ body: { name: "a" } }, { body: null }],
      invalid: [{ body: { name: "a", id: "client-chosen-id" } }, { body: {} }],
    });
    // anyOf members may overlap, so removing the discriminator keeps the call possible.
    expectArguments(tool(tools, "readOnlyDiscriminatorInAnyOf").inputSchema, {
      valid: [{ body: {} }],
      invalid: [{ body: { kind: "a" } }, { body: { other: 1 } }],
    });
    // Polymorphic members sharing one readOnly base property stay supported.
    const shared = convert("skip-access-flag-conflicts").tools;
    expectArguments(tool(shared, "polymorphicReadOnlyId").inputSchema, {
      valid: [{ body: { kind: "cat" } }, { body: { kind: "dog" } }],
      invalid: [{ body: { kind: "cat", id: "client-chosen-id" } }, { body: {} }],
    });
  });

  it("skips readOnly and writeOnly properties removed inside nested oneOf members or constrained by member patterns", () => {
    const { tools, skipped } = convert("skip-access-flag-oneof-nested");
    const reason = (name: string, keyword = "readOnly") =>
      `property "${name}" is ${keyword} but is also constrained by a oneOf whose members do not all mark it the same way, so it cannot be removed soundly`;
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code, entry.reason])).toEqual([
      ["readOnlyNestedOneOf", "unsupported-access-flag", reason("kind")],
      ["readOnlyNestedAnyOf", "unsupported-access-flag", reason("kind")],
      ["readOnlyReferencedAnyOf", "unsupported-access-flag", reason("kind")],
      ["readOnlyAllOfOneOf", "unsupported-access-flag", reason("kind")],
      ["readOnlyPatternDiscriminator", "unsupported-access-flag", constrained("id", 'patternProperties "^id$"')],
      ["readOnlyInvalidPattern", "unsupported-access-flag", constrained("id", 'patternProperties "("')],
      ["readOnlyMaxPropertiesInOneOf", "unsupported-access-flag", constrained("id", NESTED_MAX_PROPERTIES)],
      ["readOnlyPropertyNamesInOneOf", "unsupported-access-flag", constrained("id", "propertyNames")],
      ["writeOnlyNestedOutput", "unsupported-access-flag", reason("kind", "writeOnly")],
    ]);
    // A pattern that cannot match the removed name keeps the members exclusive on the rest.
    expectArguments(tool(tools, "readOnlyPatternNotMatching").inputSchema, {
      valid: [{ body: { a: "x" } }, { body: { b: "y", "x-tag": "t" } }],
      invalid: [{ body: {} }, { body: { a: "x", b: "y" } }, { body: { a: "x", id: "client-chosen-id" } }],
    });
  });

  it("skips readOnly and writeOnly properties any applied schema constrains beyond properties and required", () => {
    const { tools, skipped } = convert("skip-access-flag-name-constraints");
    const unlisted = "additionalProperties of a schema that does not list it";
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code, entry.reason])).toEqual([
      ["readOnlySiblingAdditionalProperties", "unsupported-access-flag", constrained("id", unlisted)],
      ["readOnlySiblingClosed", "unsupported-access-flag", constrained("id", unlisted)],
      ["readOnlyIfPattern", "unsupported-access-flag", constrained("id", 'patternProperties "^id$"')],
      ["readOnlyNotMaxProperties", "unsupported-access-flag", constrained("id", NESTED_MAX_PROPERTIES)],
      ["readOnlyBesideDependentRequired", "unsupported-access-flag", constrained("id", "dependentRequired")],
      ["writeOnlyOutputSiblingAdditionalProperties", "unsupported-access-flag", constrained("password", unlisted, "writeOnly")],
    ]);
    // A closed object that lists the flagged property, with an unconditional maxProperties, is still converted.
    expect(tools.map((entry) => entry.name)).toEqual(["readOnlyClosedListing"]);
    expectArguments(tool(tools, "readOnlyClosedListing").inputSchema, {
      valid: [{ body: { name: "n" } }],
      invalid: [{ body: {} }, { body: { id: "client-chosen-id", name: "n" } }, { body: { name: "n", other: 1 } }],
    });
  });

  it("ignores readOnly and writeOnly beside a $ref in OpenAPI 3.0, which ignores $ref siblings", () => {
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.0.3",
        paths: {
          "/accounts": {
            post: {
              operationId: "createAccount",
              requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Account" } } } },
              responses: {
                "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Credentials" } } } },
              },
            },
          },
        },
        components: {
          schemas: {
            Id: { type: "string" },
            Secret: { type: "string" },
            Account: {
              type: "object",
              properties: { id: { $ref: "#/components/schemas/Id", readOnly: true }, name: { type: "string" } },
              required: ["id", "name"],
            },
            Credentials: {
              type: "object",
              properties: { user: { type: "string" }, password: { $ref: "#/components/schemas/Secret", writeOnly: true } },
              required: ["user", "password"],
            },
          },
        },
      },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expect(skipped).toEqual([]);
    const created = tool(tools, "createAccount");
    // id stays a required, writable field the server expects.
    expectArguments(created.inputSchema, {
      valid: [{ body: { id: "client-chosen-id", name: "a" } }],
      invalid: [{ body: { name: "a" } }],
    });
    expectArguments(created.outputSchema!, {
      valid: [{ user: "a", password: "test-password" }],
      invalid: [{ user: "a" }],
    });
  });

  it("skips declared request bodies without a usable JSON media entry", () => {
    const { tools, skipped } = convert("skip-malformed-request-body");
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["requiredBodyWithoutContent", "invalid-request-body"],
      ["optionalBodyWithoutContent", "invalid-request-body"],
      ["emptyContent", "invalid-request-body"],
      ["contentNotAnObject", "invalid-request-body"],
      ["nullJsonMedia", "invalid-request-body"],
    ]);
    const fallback = tool(tools, "nullJsonMediaBesidePlusJson");
    expect(fallback.operation.requestBody).toEqual({ required: true, contentType: "application/merge-patch+json" });
    expectArguments(fallback.inputSchema, { valid: [{ body: { n: 1 } }], invalid: [{ body: { n: "x" } }, {}] });
    const anyBody = tool(tools, "jsonMediaWithoutSchema");
    expect(anyBody.operation.requestBody).toEqual({ required: true, contentType: "application/json" });
    expectArguments(anyBody.inputSchema, { valid: [{ body: { anything: [1] } }, { body: "text" }], invalid: [{}] });
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

  it("classifies parameter schemas through $ref, allOf, anyOf and oneOf", () => {
    const { tools, skipped } = convert("skip-composed-parameter-schemas");
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code, entry.reason])).toEqual([
      ["allOfObject", "unsupported-parameter-schema", "query parameter filter can be an object"],
      ["oneOfObjectOrString", "unsupported-parameter-schema", "query parameter filter can be an object"],
      ["untyped", "unsupported-parameter-schema", "query parameter filter can be an object"],
      ["untypedWithProperties", "unsupported-parameter-schema", "header parameter X-Filter can be an object"],
      ["composedObjectItems", "unsupported-parameter-schema", "query parameter filters is an array whose items can be objects or arrays"],
      ["anyOfObjectItems", "unsupported-parameter-schema", "query parameter filters is an array whose items can be objects or arrays"],
      ["arrayWithoutItems", "unsupported-parameter-schema", "query parameter filters is an array whose items can be objects or arrays"],
      ["arrayOrString", "unsupported-parameter-schema", "query parameter ids can be both an array and a single value"],
      ["nestedArray", "unsupported-parameter-schema", "query parameter matrix is an array whose items can be objects or arrays"],
      ["refToComposedObject", "unsupported-parameter-schema", "query parameter filter can be an object"],
    ]);
    // The shape given to the executor matches what the input schema accepts.
    expect(tools.map((entry) => [entry.name, entry.operation.parameters.map((parameter) => parameter.shape)])).toEqual([
      ["allOfPrimitive", ["primitive"]],
      ["enumWithoutType", ["primitive"]],
      ["nullableArray", ["array"]],
    ]);
    expectArguments(tool(tools, "allOfPrimitive").inputSchema, {
      valid: [{ query: { name: "rex" } }],
      invalid: [{ query: { name: { q: "rex" } } }, { query: { name: ["rex"] } }],
    });
    expectArguments(tool(tools, "nullableArray").inputSchema, {
      valid: [{ query: { tags: ["a", "b"] } }, { query: { tags: null } }],
      invalid: [{ query: { tags: [{ q: "a" }] } }, { query: { tags: "a" } }],
    });
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

  it("declares an object output schema for a 3.1 $ref with sibling keywords", () => {
    const { tools } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/user": {
            get: {
              operationId: "getUser",
              responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/User", description: "The user", minProperties: 2 } } } } },
            },
          },
          "/pair": {
            get: {
              operationId: "getPair",
              responses: { "200": { description: "OK", content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/User" }, { properties: { tag: { type: "string" } } }] } } } } },
            },
          },
        },
        components: { schemas: { User: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
      },
      { executor: recordingExecutor() },
    );
    const getUser = tool(tools, "getUser").outputSchema!;
    expect(getUser).toEqual({
      type: "object",
      description: "The user",
      minProperties: 2,
      allOf: [{ $ref: "#/definitions/User" }],
      definitions: { User: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    });
    expectArguments(getUser, { valid: [{ id: "u1", name: "Ada" }], invalid: [{ id: "u1" }, { name: "Ada", other: 1 }, { id: 1, name: "Ada" }] });
    expectArguments(tool(tools, "getPair").outputSchema!, { valid: [{ id: "u1", tag: "t" }], invalid: [{ tag: "t" }, { id: "u1", tag: 1 }] });
  });

  it("applies the skip rules to the selected response schema whatever its shape", () => {
    const response = (schema: unknown) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/tuple": { get: { operationId: "tupleResponse", responses: response({ type: "array", prefixItems: [{ type: "string" }] }) } },
          "/external": { get: { operationId: "externalItems", responses: response({ type: "array", items: { $ref: "other.yaml#/Pet" } }) } },
          "/list": { get: { operationId: "listResponse", responses: response({ type: "array", items: { type: "string" } }) } },
          "/either": { get: { operationId: "objectOrString", responses: response({ oneOf: [{ type: "object" }, { type: "string" }] }) } },
          "/later": {
            get: {
              operationId: "laterResponseIgnored",
              responses: { ...response({ type: "object" }), "201": { description: "Created", content: { "application/json": { schema: { prefixItems: [] } } } } },
            },
          },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["tupleResponse", "unsupported-schema-keyword"],
      ["externalItems", "external-ref"],
    ]);
    expect(tools.map((entry) => [entry.name, entry.outputSchema])).toEqual([
      ["listResponse", undefined],
      ["objectOrString", undefined],
      ["laterResponseIgnored", { type: "object" }],
    ]);
  });

  it("resolves parameters per path when path items share one operation object", () => {
    // YAML aliases and generated documents can share an operation object.
    const shared = { responses: { "200": { description: "OK" } } };
    const pathParameter = (name: string) => [{ name, in: "path", required: true, schema: { type: "string" } }];
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.0.3",
        paths: {
          "/users/{userId}/avatar": { parameters: pathParameter("userId"), get: shared },
          "/teams/{teamId}/avatar": { parameters: pathParameter("teamId"), get: shared },
          "/orgs/{orgId}/avatar": { get: shared },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(tools.map((entry) => [entry.name, entry.operation.path, entry.operation.parameters.map((parameter) => parameter.name)])).toEqual([
      ["get_users_userId_avatar", "/users/{userId}/avatar", ["userId"]],
      ["get_teams_teamId_avatar", "/teams/{teamId}/avatar", ["teamId"]],
    ]);
    expectArguments(tool(tools, "get_teams_teamId_avatar").inputSchema, {
      valid: [{ path: { teamId: "t1" } }],
      invalid: [{ path: { userId: "u1" } }],
    });
    expect(skipped).toEqual([
      {
        operation: { method: "GET", path: "/orgs/{orgId}/avatar" },
        code: "missing-path-parameter",
        reason: "path template variable {orgId} has no path parameter",
      },
    ]);
  });

  it("declares no output schema for HEAD but applies the response skip rules as for GET", () => {
    const response = (schema: unknown) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/a": { head: { operationId: "probe", responses: response({ type: "object" }) } },
          "/tuple": {
            head: { operationId: "headTuple", responses: response({ type: "array", prefixItems: [{ type: "string" }] }) },
            get: { operationId: "getTuple", responses: response({ type: "array", prefixItems: [{ type: "string" }] }) },
          },
          "/external": {
            head: { operationId: "headExternal", responses: response({ $ref: "other.yaml#/Pet" }) },
            get: { operationId: "getExternal", responses: response({ $ref: "other.yaml#/Pet" }) },
          },
          "/loop": {
            head: { operationId: "headLoop", responses: response({ $ref: "#/components/schemas/Loop" }) },
            get: { operationId: "getLoop", responses: response({ $ref: "#/components/schemas/Loop" }) },
          },
        },
        components: { schemas: { Loop: { $ref: "#/components/schemas/Loop", type: "object" } } },
      },
      { executor: recordingExecutor() },
    );
    expect(tools.map((entry) => [entry.name, entry.outputSchema])).toEqual([["probe", undefined]]);
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["headTuple", "unsupported-schema-keyword"],
      ["getTuple", "unsupported-schema-keyword"],
      ["headExternal", "external-ref"],
      ["getExternal", "external-ref"],
      ["headLoop", "unresolved-ref"],
      ["getLoop", "unresolved-ref"],
    ]);
  });

  it("ignores Paths Object extensions whatever their value", () => {
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "x-example": { get: { operationId: "notAnOperation", responses: {} } },
          "x-scalar": 5,
          "/a": { get: { operationId: "real", responses: {} } },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(tools.map((entry) => entry.name)).toEqual(["real"]);
    expect(skipped).toEqual([]);
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
