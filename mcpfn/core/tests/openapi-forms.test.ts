import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import { McpFnRegistry, McpFnValidationError } from "../src/index.js";
import { fromOpenAPI, type OpenApiSkippedOperation } from "../src/openapi/index.js";
import { NodeBudget, SchemaConverter } from "../src/openapi/schema.js";
import {
  expectArguments,
  fixture,
  recordingExecutor,
  tool,
} from "./openapi-helpers.js";

function convert(name: string, options: Partial<Parameters<typeof fromOpenAPI>[1]> = {}) {
  return fromOpenAPI(fixture(name), { executor: recordingExecutor(), allowMutations: true, ...options });
}

const PROTO_PROPERTY = "property __proto__ cannot be declared or required: the validators do not read the names every object inherits alike";
const OVERLAP = "anyOf/oneOf members that can overlap, not, if/then/else or a dependency";
const REQUIRED_ELSEWHERE = "a required list of another schema for the same object";

function constrained(name: string, by: string, keyword = "readOnly"): string {
  return `property "${name}" is ${keyword} but is also constrained by ${by}, so it cannot be removed soundly`;
}

function child(subject: string, by: string, keyword = "readOnly"): string {
  return `${subject} contains ${keyword} properties but is also constrained by ${by}, so they cannot be removed soundly`;
}

type Result = ReturnType<typeof fromOpenAPI>;

function skips(result: Result): string[][] {
  return result.skipped.map((entry) => [entry.operation.operationId!, entry.code, entry.reason]);
}

/** Registered tools, each with whether it declares an output schema. */
function registered(result: Result): Array<[string, boolean]> {
  return result.tools.map((entry) => [entry.name, entry.outputSchema !== undefined]);
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
    // Account accepts additional properties, so a removed name becomes a false schema.
    expect(input.properties).toMatchObject({ id: false, createdAt: false });
    expect(input.required).toEqual(["name", "secretAnswer"]);
    expect(input).not.toHaveProperty("propertyNames");
    expect(createAccount.outputSchema!.properties).toMatchObject({ secretAnswer: false });
    expect(createAccount.outputSchema!.required).toEqual(["id", "createdAt", "name"]);
    const created = { id: "a", createdAt: "2026-01-01T00:00:00Z", name: "a" };
    expectArguments(createAccount.outputSchema!, {
      valid: [created, { ...created, nickname: "extra fields stay allowed" }],
      invalid: [{ ...created, secretAnswer: "test-answer" }],
    });
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

  it("finds readOnly and writeOnly through allOf members, skips a name another schema requires, and keeps unrelated uses of a component", () => {
    const result = convert("form-read-only-composed");
    const { tools } = result;
    const createAccount = tool(tools, "createAccount");
    const account = (createAccount.inputSchema.definitions as Record<string, Record<string, unknown>>).Account!;
    expect(account.properties).toMatchObject({ createdAt: false });
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

    // Identified marks id readOnly but its allOf sibling Named requires it,
    // so leaving id out would refuse every value Profile accepted.
    expect(skips(result)).toEqual([
      ["createProfile", "unsupported-access-flag", constrained("id", REQUIRED_ELSEWHERE)],
    ]);
    // Named itself is unchanged where nothing marks id readOnly.
    const createRecord = tool(tools, "createRecord");
    expect((createRecord.inputSchema.definitions as Record<string, Record<string, unknown>>).Named!.required).toEqual(["id", "name"]);
    expectArguments(createRecord.inputSchema, {
      valid: [{ body: { named: { id: "1", name: "a" } } }],
      invalid: [{ body: { named: { name: "a" } } }],
    });
  });

  it("finds readOnly on a 3.1 alias that adds it beside its $ref, and skips a $ref sibling flagging a name the target requires", () => {
    const { tools, skipped } = fromOpenAPI(
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
    expect(skipped.map((entry) => [entry.operation.operationId, entry.code, entry.reason])).toEqual([
      ["createTagged", "unsupported-access-flag", constrained("id", REQUIRED_ELSEWHERE)],
    ]);
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

  it("skips a body, nested or response schema that declares or requires __proto__, required, optional or split across allOf, and keeps ordinary names", () => {
    const { tools, skipped } = convert("skip-prototype-property-name");
    expect(skips({ tools, skipped } as Result)).toEqual([
      ["protoBody", "unsupported-property-name", PROTO_PROPERTY],
      ["protoNested", "unsupported-property-name", `${PROTO_PROPERTY} (in #/components/schemas/Holder)`],
      ["protoOutput", "unsupported-property-name", PROTO_PROPERTY],
      ["protoRequired", "unsupported-property-name", PROTO_PROPERTY],
      ["protoSplit", "unsupported-property-name", PROTO_PROPERTY],
      ["protoOptional", "unsupported-property-name", PROTO_PROPERTY],
    ]);
    expect(tools.map(({ name }) => name)).toEqual(["plainBody"]);
    expectArguments(tool(tools, "plainBody").inputSchema, {
      valid: [{ body: { proto: {} } }, { body: { proto: {}, name: "x" } }],
      invalid: [{ body: {} }, { body: { name: "x" } }],
    });
  });

  it("retries a closure the document budget refused once released reservations make room for it", () => {
    let refusals = 0;
    for (let reserved = 1; reserved <= 40; reserved += 1) {
      const total = new NodeBudget(40, undefined, "the document's schemas expand in total");
      const converter = new SchemaConverter("3.1", { A: { type: "object", properties: { b: { type: "string" } } } }, total);
      total.chargeNodes(reserved);
      let refused: unknown;
      try {
        converter.checkDefinitions(["A"], "input");
      } catch (error) {
        refused = error;
      }
      total.release(reserved);
      if (refused === undefined) continue;
      refusals += 1;
      expect(refused).toMatchObject({ code: "schema-too-large", message: "the document's schemas expand in total to more than 40 nodes" });
      // The work done stays charged; the closure itself is walked again, not remembered as refused.
      expect(() => converter.checkDefinitions(["A"], "input")).not.toThrow();
      expect(refused).toMatchObject({ exhausted: true });
    }
    expect(refusals).toBeGreaterThan(1);
  });

  it("skips a parameter named __proto__, required or optional, which the validators do not read alike, and keeps ordinary names", () => {
    const { tools, skipped } = convert("skip-prototype-parameter-name");
    const reason = "query parameter __proto__ cannot be declared: the validators do not read the names every object inherits alike";
    expect(skips({ tools, skipped } as Result)).toEqual([
      ["listItems", "unsupported-parameter-name", reason],
      ["listRequired", "unsupported-parameter-name", reason],
    ]);
    const plain = tool(tools, "listPlain");
    expect(plain.inputSchema.properties).toEqual({
      query: { type: "object", properties: { proto: { type: "string" } }, additionalProperties: false },
    });
    expectArguments(plain.inputSchema, { valid: [{}, { query: { proto: "x" } }], invalid: [{ query: { other: "x" } }] });
    for (const [location, name] of [["path", "__proto__"], ["header", "__proto__"]] as const) {
      const result = fromOpenAPI({
        openapi: "3.1.0",
        paths: {
          [location === "path" ? "/items/{__proto__}" : "/items"]: {
            get: {
              operationId: "getItem",
              parameters: [{ name, in: location, required: location === "path", schema: { type: "string" } }],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }, { executor: recordingExecutor() });
      expect(result.tools).toEqual([]);
      expect(result.skipped).toEqual([expect.objectContaining({ code: "unsupported-parameter-name" })]);
    }
    // Only that exact key is ignored: another spelling of the header stays an ordinary property.
    const spelled = fromOpenAPI({
      openapi: "3.1.0",
      paths: { "/items": { get: { operationId: "getItem", parameters: [{ name: "__PROTO__", in: "header", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" } } } } },
    }, { executor: recordingExecutor() });
    expect(spelled.skipped).toEqual([]);
    expectArguments(tool(spelled.tools, "getItem").inputSchema, { valid: [{ header: { __PROTO__: "ok" } }], invalid: [{}, { header: { __PROTO__: 1 } }] });
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

  it("skips readOnly inputs and writeOnly outputs that alternatives, conditions or dependencies constrain", () => {
    const result = convert("skip-access-flag-conflicts");
    expect(skips(result)).toEqual([
      ["readOnlyRequiredInOneOf", "unsupported-access-flag", constrained("id", REQUIRED_ELSEWHERE)],
      ["readOnlyInDependentRequired", "unsupported-access-flag", constrained("id", "dependentRequired")],
      ["readOnlyRequiredInThen", "unsupported-access-flag", constrained("id", REQUIRED_ELSEWHERE)],
      ["readOnlyInNot", "unsupported-access-flag", constrained("id", REQUIRED_ELSEWHERE)],
      ["readOnlyFlaggedInIf", "unsupported-access-flag", constrained("id", OVERLAP)],
      ["requiredButReadOnlyInEveryBranch", "unsupported-access-flag", constrained("id", OVERLAP)],
      ["readOnlyRequiredByReferencedBranch", "unsupported-access-flag", constrained("id", REQUIRED_ELSEWHERE)],
      // Object members that can both match each flag id: not a plain chain, so not projected.
      ["polymorphicReadOnlyId", "unsupported-access-flag", constrained("id", OVERLAP)],
      // An output that cannot be projected skips the operation too: no tool returns unchecked structured content.
      ["writeOnlyRequiredInOneOf", "unsupported-access-flag", constrained("password", REQUIRED_ELSEWHERE, "writeOnly")],
    ]);
    expect(registered(result)).toEqual([
      // OpenAPI 3.1 (2020-12) has no `dependencies` keyword: it constrains nothing.
      ["readOnlyInDependencies", false],
      ["nullableReadOnlyReference", false],
      ["readOnlyBesideUnrelatedOneOf", false],
      ["nullableWriteOnlyReference", true],
    ]);
    const { tools } = result;
    expectArguments(tool(tools, "readOnlyInDependencies").inputSchema, {
      valid: [{ body: { kind: "a" } }],
      invalid: [{ body: { kind: "a", id: "client-chosen-id" } }],
    });
    // The nullable reference idiom: readOnly when every non-null alternative is.
    expectArguments(tool(tools, "nullableReadOnlyReference").inputSchema, {
      valid: [{ body: { name: "a" } }],
      invalid: [{ body: { name: "a", createdAt: "2026-01-01T00:00:00Z" } }, { body: { name: "a", createdAt: null } }, { body: {} }],
    });
    // A oneOf that never uses the readOnly name keeps its meaning.
    expectArguments(tool(tools, "readOnlyBesideUnrelatedOneOf").inputSchema, {
      valid: [{ body: { a: "x" } }, { body: { b: "y" } }],
      invalid: [{ body: {} }, { body: { a: "x", b: "y" } }, { body: { a: "x", id: "client-chosen-id" } }],
    });
    const output = tool(tools, "nullableWriteOnlyReference").outputSchema!;
    expect(output.required).toEqual(["name"]);
    expectArguments(output, { valid: [{ name: "a" }], invalid: [{}, { name: "a", password: "test-password" }] });
  });

  it("skips readOnly properties of objects that const, enum or minProperties constrain", () => {
    const result = convert("skip-access-flag-instance-constraints");
    expect(skips(result)).toEqual([
      ["readOnlyWithConst", "unsupported-access-flag", constrained("id", "const")],
      ["readOnlyWithEnum", "unsupported-access-flag", constrained("id", "enum")],
      ["readOnlyWithMinProperties", "unsupported-access-flag", constrained("id", "minProperties")],
      ["readOnlyWithInheritedMinProperties", "unsupported-access-flag", constrained("id", "minProperties")],
      ["readOnlyBesideConstInOneOf", "unsupported-access-flag", constrained("id", "const")],
      ["writeOnlyWithEnum", "unsupported-access-flag", constrained("password", "enum", "writeOnly")],
    ]);
    expect(registered(result)).toEqual([
      ["readOnlyWithMaxProperties", false],
      ["enumWithoutAccessFlags", false],
    ]);
    const { tools } = result;
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

  it("projects only through alternatives that accept different kinds of value", () => {
    const result = convert("skip-access-flag-oneof-overlap");
    expect(skips(result)).toEqual(
      [
        ["readOnlyConstDiscriminator", "kind"],
        ["readOnlyEnumDiscriminator", "kind"],
        ["readOnlyTypeDiscriminator", "kind"],
        ["readOnlyRequiredInOneMember", "id"],
        ["readOnlyAbsentInOneMember", "id"],
        ["readOnlyDiscriminatorInReferencedMembers", "kind"],
        ["writeOnlyOutputDiscriminator", "kind", "writeOnly"],
        ["readOnlySameInEveryMember", "id"],
        ["readOnlyDiscriminatorInAnyOf", "kind"],
      ].map(([operationId, name, keyword]) => [operationId!, "unsupported-access-flag", constrained(name!, OVERLAP, keyword)]),
    );
    expect(registered(result)).toEqual([["readOnlyNullableReference", false]]);
    // The null member of a nullable reference accepts no object, so only the object member applies to objects.
    expectArguments(tool(result.tools, "readOnlyNullableReference").inputSchema, {
      valid: [{ body: { name: "a" } }, { body: null }],
      invalid: [{ body: { name: "a", id: "client-chosen-id" } }, { body: {} }],
    });
  });

  it("skips readOnly properties flagged inside nested alternatives that can overlap", () => {
    const result = convert("skip-access-flag-oneof-nested");
    // A malformed declaration is reported before any projection is considered.
    const [invalid] = result.skipped.filter((entry) => entry.operation.operationId === "readOnlyInvalidPattern");
    expect(invalid?.code).toBe("invalid-schema");
    expect(invalid?.reason).toMatch(/^the request body schema is not a valid JSON Schema: /);
    expect(skips(result).filter(([operationId]) => operationId !== "readOnlyInvalidPattern")).toEqual(
      [
        ["readOnlyNestedOneOf", "kind"],
        ["readOnlyNestedAnyOf", "kind"],
        ["readOnlyReferencedAnyOf", "kind"],
        ["readOnlyAllOfOneOf", "kind"],
        ["readOnlyPatternDiscriminator", "id"],
        ["readOnlyMaxPropertiesInOneOf", "id"],
        ["readOnlyPropertyNamesInOneOf", "id"],
        ["readOnlyPatternNotMatching", "id"],
        ["writeOnlyNestedOutput", "kind", "writeOnly"],
      ].map(([operationId, name, keyword]) => [operationId!, "unsupported-access-flag", constrained(name!, OVERLAP, keyword)]),
    );
    expect(registered(result)).toEqual([]);
  });

  it("projects past keywords that cannot need the removed name, and skips conditions that can tell it apart", () => {
    const result = convert("skip-access-flag-name-constraints");
    expect(skips(result)).toEqual([
      ["readOnlySiblingAdditionalProperties", "unsupported-access-flag", constrained("id", OVERLAP)],
      ["readOnlyIfPattern", "unsupported-access-flag", constrained("id", "patternProperties")],
      ["readOnlyNotMaxProperties", "unsupported-access-flag", constrained("id", "maxProperties")],
      ["readOnlyBesideDependentRequired", "unsupported-access-flag", constrained("id", "dependentRequired")],
    ]);
    expect(registered(result)).toEqual([
      ["readOnlySiblingClosed", false],
      ["writeOnlyOutputSiblingAdditionalProperties", true],
      ["readOnlyClosedListing", false],
    ]);
    const { tools } = result;
    // A false schema refuses the name whatever a sibling's additionalProperties says.
    expectArguments(tool(tools, "readOnlySiblingClosed").inputSchema, {
      valid: [{ body: { x: "a" } }],
      invalid: [{ body: { id: "client-chosen-id", x: "a" } }, { body: { x: "a", other: 1 } }],
    });
    expectArguments(tool(tools, "writeOnlyOutputSiblingAdditionalProperties").outputSchema!, {
      valid: [{ user: "u" }, { user: "u", other: 1 }],
      invalid: [{ user: "u", password: 1 }, { user: "u", password: "test-password" }, {}],
    });
    // A closed object that lists the flagged property, with an unconditional maxProperties, is still converted.
    expectArguments(tool(tools, "readOnlyClosedListing").inputSchema, {
      valid: [{ body: { name: "n" } }],
      invalid: [{ body: {} }, { body: { id: "client-chosen-id", name: "n" } }, { body: { name: "n", other: 1 } }],
    });
  });

  it("skips projection below alternatives that accept the same kind of value", () => {
    const result = convert("skip-access-flag-oneof-projection");
    expect(skips(result)).toEqual([
      ["readOnlyNestedProperty", "unsupported-access-flag", child('property "data"', OVERLAP)],
      ["readOnlyArrayItems", "unsupported-access-flag", child("items", OVERLAP)],
      ["writeOnlyNestedOutput", "unsupported-access-flag", child('property "data"', OVERLAP, "writeOnly")],
      ["readOnlyIdenticalNested", "unsupported-access-flag", child('property "data"', OVERLAP)],
    ]);
    // Members that admit different kinds of value convert and keep exactly one match.
    expect(registered(result)).toEqual([["readOnlyOneOrMany", false]]);
    expectArguments(tool(result.tools, "readOnlyOneOrMany").inputSchema, {
      valid: [{ body: { label: "l" } }, { body: [{ label: "l" }, { label: "m" }] }],
      invalid: [{ body: { kind: "client-chosen", label: "l" } }, { body: [{ kind: "client-chosen", label: "l" }] }],
    });
  });

  it("skips a child value whose projected schema is not the only thing constraining it", () => {
    const result = convert("skip-access-flag-child-constraints");
    expect(skips(result)).toEqual([
      ["readOnlyChildUnderNot", "unsupported-access-flag", child('property "data"', OVERLAP)],
      ["readOnlyChildTwoSchemas", "unsupported-access-flag", child('property "data"', "another schema for the same value")],
      ["readOnlyChildPattern", "unsupported-access-flag", child('property "data"', "patternProperties of a schema for the same object")],
      ["readOnlyChildObjectEnum", "unsupported-access-flag", child('property "data"', "const or enum")],
      ["readOnlyUniqueItems", "unsupported-access-flag", child("items", "uniqueItems")],
      ["readOnlyItemsUnderIf", "unsupported-access-flag", child("items", OVERLAP)],
      [
        "readOnlyMapSibling",
        "unsupported-access-flag",
        child("additionalProperties", "properties of another schema for the same object"),
      ],
      ["writeOnlyChildUnderNot", "unsupported-access-flag", child('property "login"', OVERLAP, "writeOnly")],
    ]);
    // A map of objects with readOnly properties, and a string enum beside the
    // object member, constrain nothing else and still convert.
    expect(registered(result)).toEqual([
      ["readOnlyMap", false],
      ["readOnlyBesideStringEnum", false],
    ]);
    const { tools } = result;
    expectArguments(tool(tools, "readOnlyMap").inputSchema, {
      valid: [{ body: {} }, { body: { a: { label: "l" }, b: { label: "m" } } }],
      invalid: [{ body: { a: { kind: "client-chosen", label: "l" } } }, { body: { a: {} } }],
    });
    expectArguments(tool(tools, "readOnlyBesideStringEnum").inputSchema, {
      valid: [{ body: { data: { label: "l" } } }, { body: "none" }],
      invalid: [{ body: { data: { kind: "client-chosen", label: "l" } } }, { body: "other" }],
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

describe("fromOpenAPI bounded and dialect-aware conversion", () => {
  const ok = { "200": { description: "OK" } };
  const options = () => ({ executor: recordingExecutor(), allowMutations: true });
  const body = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
  const json = (schema: unknown) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });

  it("skips readOnly properties of anyOf members that can overlap, and never evaluates document patterns", () => {
    const overlapping = {
      anyOf: [
        {
          type: "object",
          properties: { id: { type: "string", readOnly: true }, name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        { type: "object", properties: { kind: { type: "string" } } },
      ],
    };
    const name = `${"a".repeat(28)}!`;
    const patterned = {
      type: "object",
      properties: { [name]: { type: "string", readOnly: true }, label: { type: "string" } },
      patternProperties: { "^(a+)+$": { type: "string" } },
    };
    const started = performance.now();
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/a": { post: { operationId: "make", requestBody: body(overlapping), responses: ok } },
          "/b": { post: { operationId: "patterned", requestBody: body(patterned), responses: ok } },
        },
      },
      options(),
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(skips(result)).toEqual([["make", "unsupported-access-flag", constrained("id", OVERLAP)]]);
    // The flagged name is refused by a false schema, whatever the pattern matches.
    // (Validating that name would run the pattern itself, in either engine.)
    const patternedInput = tool(result.tools, "patterned").inputSchema;
    expect((patternedInput.properties!.body as { properties: Record<string, unknown> }).properties[name]).toBe(false);
    expectArguments(patternedInput, {
      valid: [{ body: { label: "l", aaa: "x" } }],
      invalid: [{ body: { aaa: 1 } }],
    });
  });

  it("decides anchored literal patterns without running them, and stays linear in allOf members", () => {
    const person = { type: "object", properties: { id: { type: "string", readOnly: true }, name: { type: "string" } } };
    const members = Array.from({ length: 5000 }, (_, index) => ({ properties: { [`p${index}`]: { type: "string" } } }));
    const started = performance.now();
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/prefix": {
            post: {
              operationId: "extensionPattern",
              requestBody: body({ type: "object", properties: { profile: person }, patternProperties: { "^x-": { type: "string" } } }),
              responses: ok,
            },
          },
          "/exact": {
            post: {
              operationId: "exactPattern",
              requestBody: body({ type: "object", properties: { profile: person }, patternProperties: { "^profile$": { required: ["id"] } } }),
              responses: ok,
            },
          },
          "/wide": {
            post: {
              operationId: "wideAllOf",
              requestBody: body({ allOf: [...members, { properties: { owner: person } }] }),
              responses: ok,
            },
          },
        },
      },
      options(),
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(skips(result)).toEqual([
      ["exactPattern", "unsupported-access-flag", child('property "profile"', "patternProperties of a schema for the same object")],
    ]);
    expectArguments(tool(result.tools, "extensionPattern").inputSchema, {
      valid: [{ body: { profile: { name: "n" }, "x-tag": "t" } }],
      invalid: [{ body: { profile: { id: "client-chosen-id" } } }, { body: { "x-tag": 1 } }],
    });
    expectArguments(tool(result.tools, "wideAllOf").inputSchema, {
      valid: [{ body: { owner: { name: "n" }, p0: "a" } }],
      invalid: [{ body: { owner: { id: "client-chosen-id" } } }],
    });
  });

  it("skips an unprojectable output, checking its schema as written first", () => {
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/bad": {
            get: {
              operationId: "badUnprojectable",
              responses: json({
                type: "object",
                required: ["password"],
                allOf: [{ properties: { password: { type: "string", writeOnly: true } } }],
                properties: { n: { type: "bogus" } },
              }),
            },
          },
          "/good": {
            get: {
              operationId: "goodUnprojectable",
              responses: json({
                type: "object",
                required: ["password"],
                allOf: [{ properties: { password: { type: "string", writeOnly: true } } }],
              }),
            },
          },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(result.skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["badUnprojectable", "invalid-schema"],
      ["goodUnprojectable", "unsupported-access-flag"],
    ]);
  });

  it("gives the same result for each schema of a reference cycle whatever the operation order", () => {
    // The parsed document shares the reference objects between the operations and the components.
    const refA = { $ref: "#/components/schemas/A" };
    const refB = { $ref: "#/components/schemas/B" };
    const schemas = {
      A: {
        type: "object",
        properties: {
          b: refB,
          flagged: { type: "object", minProperties: 1, properties: { id: { type: "string", readOnly: true } } },
        },
      },
      B: { type: "object", properties: { a: refA } },
    };
    const run = (order: Array<[string, unknown]>) =>
      fromOpenAPI(
        {
          openapi: "3.1.0",
          paths: Object.fromEntries(
            order.map(([name, schema]) => [`/${name}`, { post: { operationId: name, requestBody: body(schema), responses: ok } }]),
          ),
          components: { schemas },
        },
        options(),
      );
    for (const order of [[["a", refA], ["b", refB]], [["b", refB], ["a", refA]]] as Array<Array<[string, unknown]>>) {
      const result = run(order);
      expect(result.tools).toEqual([]);
      expect(result.skipped.map((entry) => entry.code)).toEqual(["unsupported-access-flag", "unsupported-access-flag"]);
    }
  });

  it("skips a flagged __proto__ property like any other __proto__ property, which validators do not read from properties", () => {
    const result = fromOpenAPI(
      JSON.parse(
        JSON.stringify({
          openapi: "3.1.0",
          paths: {
            "/in": { post: { operationId: "protoInput", requestBody: body({ type: "object", properties: { PROTO: { type: "string", readOnly: true } } }), responses: ok } },
            "/out": { get: { operationId: "protoOutput", responses: json({ type: "object", properties: { PROTO: { type: "string", writeOnly: true } } }) } },
          },
        }).replaceAll("PROTO", "__proto__"),
      ),
      options(),
    );
    expect(skips(result)).toEqual([
      ["protoInput", "unsupported-property-name", PROTO_PROPERTY],
      ["protoOutput", "unsupported-property-name", PROTO_PROPERTY],
    ]);
  });

  it("skips a property dependency that names __proto__, as a key or in its list, under 3.0 and 3.1, and keeps ordinary dependencies", () => {
    const operation = (version: "3.0.3" | "3.1.0", keyword: string, dependency: unknown) => JSON.parse(JSON.stringify({
      openapi: version,
      paths: {
        "/in": { post: { operationId: "protoDependency", requestBody: body({ type: "object", [keyword]: dependency }), responses: ok } },
        "/plain": { post: { operationId: "plainDependency", requestBody: body({ type: "object", [keyword]: { flag: ["name"] } }), responses: ok } },
      },
    }).replaceAll("PROTO", "__proto__")) as Record<string, unknown>;
    for (const [version, keyword] of [["3.1.0", "dependentRequired"], ["3.0.3", "dependencies"]] as const) {
      for (const dependency of [{ flag: ["PROTO"] }, { PROTO: ["flag"] }]) {
        const result = fromOpenAPI(operation(version, keyword, dependency), options());
        expect(skips(result)).toEqual([["protoDependency", "unsupported-property-name", PROTO_PROPERTY]]);
        expectArguments(tool(result.tools, "plainDependency").inputSchema, {
          valid: [{ body: {} }, { body: { flag: 1, name: "x" } }],
          invalid: [{ body: { flag: 1 } }],
        });
      }
    }
    // One wide map shared by every operation is read once, not once per operation.
    const shared: Record<string, string[]> = {};
    for (let index = 0; index < 9_600; index += 1) shared[`p${index}`] = [index === 9_599 ? "__proto__" : `q${index}`];
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 9_600; index += 1) {
      paths[`/op${index}`] = { post: { operationId: `op${index}`, requestBody: body({ type: "object", dependentRequired: shared }), responses: ok } };
    }
    paths["/plain"] = { post: { operationId: "plainDependency", requestBody: body({ type: "object", dependentRequired: { flag: ["name"] } }), responses: ok } };
    const started = performance.now();
    const wide = fromOpenAPI({ openapi: "3.1.0", paths }, options());
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(new Set(wide.skipped.map(({ code }) => code))).toEqual(new Set(["unsupported-property-name"]));
    expect(wide.skipped).toHaveLength(9_600);
    expect(wide.tools.map(({ name }) => name)).toEqual(["plainDependency"]);
  });

  it("skips a schema or parameter naming any property every object inherits, as under @cfworker/json-schema", () => {
    const result = fromOpenAPI({
      openapi: "3.0.3",
      paths: {
        "/a": { post: { operationId: "declared", requestBody: body({ type: "object", properties: { toString: { type: "string" } } }), responses: ok } },
        "/b": { post: { operationId: "required", requestBody: body({ type: "object", required: ["constructor"] }), responses: ok } },
        "/c": { post: { operationId: "dependency", requestBody: body({ type: "object", dependencies: { valueOf: { required: ["x"] } } }), responses: ok } },
        "/d": { get: { operationId: "parameter", parameters: [{ name: "isPrototypeOf", in: "query", schema: { type: "string" } }], responses: ok } },
        "/e": { get: { operationId: "output", responses: json({ type: "object", properties: { hasOwnProperty: { type: "string" } } }) } },
        "/f": { post: { operationId: "plain", requestBody: body({ type: "object", required: ["ToString"], properties: { ToString: { type: "string" } } }), responses: ok } },
      },
    }, options());
    const reason = (name: string) => PROTO_PROPERTY.replace("__proto__", name);
    expect(skips(result)).toEqual([
      ["declared", "unsupported-property-name", reason("toString")],
      ["required", "unsupported-property-name", reason("constructor")],
      ["dependency", "unsupported-property-name", reason("valueOf")],
      ["parameter", "unsupported-parameter-name", "query parameter isPrototypeOf cannot be declared: the validators do not read the names every object inherits alike"],
      ["output", "unsupported-property-name", reason("hasOwnProperty")],
    ]);
    expect(result.tools.map(({ name }) => name)).toEqual(["plain"]);
  });

  it("keeps schema-less JSON bodies, large document arrays and unrelated deep reference chains out of the way", () => {
    const aliases: Record<string, unknown> = { Leaf: { type: "object", properties: { id: { type: "string", readOnly: true } } } };
    for (let index = 0; index < 20_000; index += 1) {
      aliases[`Alias${index}`] = { $ref: `#/components/schemas/${index === 0 ? "Leaf" : `Alias${index - 1}`}` };
    }
    aliases.Holder = { type: "object", properties: { deep: { $ref: "#/components/schemas/Alias19999" } } };
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        "x-data": Array.from({ length: 200_000 }, (_, index) => index),
        paths: {
          "/raw": { post: { operationId: "schemaLess", requestBody: { required: true, content: { "application/json": {} } }, responses: ok } },
          "/deep": { post: { operationId: "deepChain", requestBody: body({ $ref: "#/components/schemas/Holder" }), responses: ok } },
        },
        components: { schemas: aliases },
      },
      options(),
    );
    expect(registered(result)).toEqual([["schemaLess", false]]);
    expectArguments(tool(result.tools, "schemaLess").inputSchema, { valid: [{ body: { any: ["json"] } }], invalid: [{}] });
    expect(result.skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([["deepChain", "schema-too-large"]]);
  });

  it("checks a discarded or writeOnly-flagged response as written, before leaving properties out", () => {
    const malformed = { type: "object", properties: { secret: { type: "bogus", writeOnly: true }, n: { type: "integer" } } };
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/head": { head: { operationId: "headMalformed", responses: json(malformed) } },
          "/list": { get: { operationId: "listMalformed", responses: json({ type: "array", items: malformed }) } },
          "/get": { get: { operationId: "getMalformed", responses: json(malformed) } },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(result.skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["headMalformed", "invalid-schema"],
      ["listMalformed", "invalid-schema"],
      ["getMalformed", "invalid-schema"],
    ]);
  });

  it("skips inputs and outputs that expand shared objects, keeping the rest", () => {
    let node: Record<string, unknown> = { type: "string" };
    let literal: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 20; depth += 1) {
      node = { type: "object", properties: { a: node, b: node } };
      literal = { a: literal, b: literal };
    }
    const started = performance.now();
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/dag": {
            get: { operationId: "dagOutput", responses: json(node) },
            post: { operationId: "dagInput", requestBody: body(node), responses: ok },
          },
          "/default": { post: { operationId: "dagDefault", requestBody: body({ type: "object", default: literal }), responses: ok } },
          "/tree": { get: { operationId: "tree", responses: json({ $ref: "#/components/schemas/Resource" }) } },
        },
        components: {
          schemas: {
            Resource: {
              type: "object",
              properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/components/schemas/Resource" } } },
            },
          },
        },
      },
      options(),
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["dagOutput", "schema-too-large"],
      ["dagInput", "schema-too-large"],
      ["dagDefault", "schema-too-large"],
    ]);
    for (const entry of result.skipped) expect(entry.reason).toMatch(/^a schema repeats shared objects into \d+ nodes from \d+ source values$/);
    expect(registered(result)).toEqual([["tree", true]]);
    expectArguments(tool(result.tools, "tree").outputSchema!, {
      valid: [{ name: "r", children: [{ name: "c", children: [] }] }],
      invalid: [{ children: [{ name: 1 }] }],
    });
  });

  it("bounds the work of a whole document that shares one object between many operations", () => {
    let node: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 17; depth += 1) node = { type: "object", properties: { a: node, b: node } };
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) {
      paths[`/dag${index}`] = { post: { operationId: `dag${index}`, requestBody: body(node), responses: ok } };
    }
    const components: Record<string, unknown> = {};
    for (let index = 0; index < 50; index += 1) components[`Alias${index}`] = node;
    paths["/aliases"] = {
      post: {
        operationId: "aliases",
        requestBody: body({ allOf: Object.keys(components).map((name) => ({ $ref: `#/components/schemas/${name}` })) }),
        responses: ok,
      },
    };
    const started = performance.now();
    const result = fromOpenAPI({ openapi: "3.1.0", paths, components: { schemas: components } }, options());
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result.tools).toEqual([]);
    expect(new Set(result.skipped.map((entry) => entry.code))).toEqual(new Set(["schema-too-large"]));
  });

  it("does not let tools that reuse a large component use up a budget meant for shared objects", () => {
    // Each tool pays for its own copies (its schema and its catalog entry), within the document total.
    const properties = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [`p${index}`, { type: "string", description: "d" }]),
    );
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 150; index += 1) {
      paths[`/big${index}`] = { get: { operationId: `big${index}`, responses: json({ $ref: "#/components/schemas/Big" }) } };
    }
    // Registration compiles each schema; that cost is the registry's, so it is left out here.
    class UncompiledRegistry extends McpFnRegistry {
      override register(): this {
        return this;
      }
    }
    const result = fromOpenAPI(
      { openapi: "3.1.0", paths, components: { schemas: { Big: { type: "object", properties } } } },
      { ...options(), registry: new UncompiledRegistry() },
    );
    expect(result.skipped).toEqual([]);
    expect(result.tools.filter((entry) => entry.outputSchema !== undefined)).toHaveLength(150);
  });

  it("skips schemas in a dialect other than the OAS 3.1 base or 2020-12 one", () => {
    const documentLevel = convert("skip-unsupported-dialect");
    expect(skips(documentLevel)).toEqual([
      ["getNote", "unsupported-dialect", 'the document\'s jsonSchemaDialect "http://json-schema.org/draft-07/schema#" is not supported'],
    ]);
    expect(registered(documentLevel)).toEqual([["health", false]]);

    const draft07 = "http://json-schema.org/draft-07/schema#";
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/in": { post: { operationId: "inBody", requestBody: body({ $ref: "#/components/schemas/Name" }), responses: ok } },
          "/out": { get: { operationId: "inResponse", responses: json({ $ref: "#/components/schemas/Name" }) } },
          "/default": {
            post: {
              operationId: "defaultSchema",
              requestBody: body({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }),
              responses: ok,
            },
          },
        },
        components: {
          schemas: {
            // draft-07 would ignore maxLength beside $ref; the default dialect applies it.
            Name: { $schema: draft07, type: "object", properties: { a: { $ref: "#/components/schemas/Text", maxLength: 1 } } },
            Text: { type: "string" },
          },
        },
      },
      options(),
    );
    expect(skips(result)).toEqual([
      ["inBody", "unsupported-dialect", `schema dialect "${draft07}" is not supported (in #/components/schemas/Name)`],
      ["inResponse", "unsupported-dialect", `schema dialect "${draft07}" is not supported (in #/components/schemas/Name)`],
    ]);
    expect(registered(result)).toEqual([["defaultSchema", false]]);
    expect(JSON.stringify(tool(result.tools, "defaultSchema").inputSchema)).not.toContain("$schema");

    const plain = convert("form-openapi-3.1");
    for (const dialect of ["https://spec.openapis.org/oas/3.1/dialect/base", "https://json-schema.org/draft/2020-12/schema"]) {
      const converted = fromOpenAPI({ ...fixture("form-openapi-3.1"), jsonSchemaDialect: dialect }, options());
      expect(converted.skipped).toEqual([]);
      expect(converted.tools.map((entry) => [entry.inputSchema, entry.outputSchema])).toEqual(
        plain.tools.map((entry) => [entry.inputSchema, entry.outputSchema]),
      );
    }
    // A root that selects a supported dialect itself is read in it; an unknown OAS dialect id is not supported.
    const own = fromOpenAPI(
      {
        openapi: "3.1.0",
        jsonSchemaDialect: draft07,
        paths: {
          "/own": {
            post: {
              operationId: "ownDialect",
              requestBody: body({ $schema: "https://spec.openapis.org/oas/3.1/dialect/base", type: "object" }),
              responses: ok,
            },
          },
          "/ref": { post: { operationId: "referenced", requestBody: body({ $ref: "#/components/schemas/Own" }), responses: ok } },
          "/other": {
            post: {
              operationId: "otherOasDialect",
              requestBody: body({ $schema: "https://spec.openapis.org/oas/3.1/dialect/other", type: "object" }),
              responses: ok,
            },
          },
        },
        components: { schemas: { Own: { $schema: "https://spec.openapis.org/oas/3.1/dialect/2024-11-10", type: "object" } } },
      },
      options(),
    );
    expect(skips(own)).toEqual([
      ["otherOasDialect", "unsupported-dialect", 'schema dialect "https://spec.openapis.org/oas/3.1/dialect/other" is not supported'],
    ]);
    expect(registered(own)).toEqual([["ownDialect", false], ["referenced", false]]);
    const legacy = fromOpenAPI(
      { openapi: "3.0.3", paths: { "/in": { post: { operationId: "legacy", requestBody: body({ $schema: draft07, type: "object" }), responses: ok } } } },
      options(),
    );
    expect(skips(legacy)).toEqual([["legacy", "unsupported-dialect", `schema dialect "${draft07}" is not supported`]]);
  });

  it("ignores every OpenAPI 3.0 $ref sibling, unsupported keywords included, and still checks 3.1 siblings", () => {
    const document = (openapi: string) => ({
      openapi,
      paths: {
        "/p/{id}": {
          get: {
            operationId: "parameterSibling",
            parameters: [{ name: "id", in: "path", required: true, schema: { $ref: "#/components/schemas/Id", unevaluatedItems: false } }],
            responses: ok,
          },
        },
        "/b": {
          post: { operationId: "bodySibling", requestBody: body({ $ref: "#/components/schemas/Name", prefixItems: [] }), responses: ok },
        },
        "/r": { get: { operationId: "responseSibling", responses: json({ $ref: "#/components/schemas/Name", dependentSchemas: {} }) } },
      },
      components: { schemas: { Id: { type: "string" }, Name: { type: "object", properties: { n: { type: "string" } } } } },
    });
    const legacy = fromOpenAPI(document("3.0.3"), options());
    expect(legacy.skipped).toEqual([]);
    expect(registered(legacy)).toEqual([["parameterSibling", false], ["bodySibling", false], ["responseSibling", true]]);
    expect(skips(fromOpenAPI(document("3.1.0"), options()))).toEqual([
      ["parameterSibling", "unsupported-schema-keyword", "schema keyword unevaluatedItems is not supported"],
      ["bodySibling", "unsupported-schema-keyword", "schema keyword prefixItems is not supported"],
      ["responseSibling", "unsupported-schema-keyword", "schema keyword dependentSchemas is not supported"],
    ]);
  });

  it("skips a response schema mcpFn rejects even where it does not become the output schema", () => {
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/head": { head: { operationId: "headBad", responses: json({ type: "object", properties: { a: { type: "bogus" } } }) } },
          "/list": { get: { operationId: "listBad", responses: json({ type: "array", items: { type: "bogus" } }) } },
          "/mixed": { get: { operationId: "rootTypeBad", responses: json({ type: ["object", "bogus"] }) } },
          "/ok": {
            get: { operationId: "listGood", responses: json({ type: "array", items: { type: "string" } }) },
            head: { operationId: "headGood", responses: json({ type: "object" }) },
          },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(result.skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["headBad", "invalid-schema"],
      ["listBad", "invalid-schema"],
      ["rootTypeBad", "invalid-schema"],
    ]);
    expect(result.skipped[0]!.reason).toMatch(/^the response schema is not a valid JSON Schema: /);
    expect(registered(result)).toEqual([["listGood", false], ["headGood", false]]);
  });

  it("takes the output schema from the first successful application/json entry that has a schema", () => {
    const object = { type: "object", properties: { n: { type: "integer" } } };
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/within": {
            get: {
              operationId: "withinResponse",
              responses: { "200": { description: "OK", content: { "application/json": {}, "application/json; charset=utf-8": { schema: object } } } },
            },
          },
          "/across": {
            get: {
              operationId: "acrossResponses",
              responses: {
                "200": { description: "OK", content: { "application/json": {} } },
                "201": { description: "Created", content: { "application/json": { schema: object } } },
              },
            },
          },
          "/first": {
            get: {
              operationId: "firstSchemaWins",
              responses: {
                "200": { description: "OK", content: { "application/json": { schema: { type: "array" } } } },
                "201": { description: "Created", content: { "application/json": { schema: object } } },
              },
            },
          },
        },
      },
      { executor: recordingExecutor() },
    );
    expect(registered(result)).toEqual([["withinResponse", true], ["acrossResponses", true], ["firstSchemaWins", false]]);
    expectArguments(tool(result.tools, "acrossResponses").outputSchema!, { valid: [{ n: 1 }], invalid: [{ n: "x" }] });
  });

  it("classifies array literals in enum and const as arrays of their item kinds", () => {
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/a": { get: { operationId: "enumArrays", parameters: [{ name: "pair", in: "query", schema: { enum: [["a", "b"], ["c"]] } }], responses: ok } },
          "/b": { get: { operationId: "constArray", parameters: [{ name: "ids", in: "query", schema: { $ref: "#/components/schemas/Fixed" } }], responses: ok } },
          "/c": { get: { operationId: "objectItems", parameters: [{ name: "o", in: "query", schema: { enum: [[{ a: 1 }]] } }], responses: ok } },
        },
        components: { schemas: { Fixed: { allOf: [{ const: [1, 2] }] } } },
      },
      { executor: recordingExecutor() },
    );
    expect(skips(result)).toEqual([
      ["objectItems", "unsupported-parameter-schema", "query parameter o is an array whose items can be objects or arrays"],
    ]);
    expect(tool(result.tools, "enumArrays").operation.parameters[0]!.shape).toBe("array");
    expect(tool(result.tools, "constArray").operation.parameters[0]!.shape).toBe("array");
    expectArguments(tool(result.tools, "enumArrays").inputSchema, {
      valid: [{ query: { pair: ["a", "b"] } }, { query: { pair: ["c"] } }],
      invalid: [{ query: { pair: ["a"] } }, { query: { pair: "c" } }],
    });
  });

  it("keeps the output schema of a mixed reference that not narrows to objects", () => {
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/a": { get: { operationId: "notNull", responses: json({ $ref: "#/components/schemas/MaybeItem", not: { type: "null" } }) } },
          "/b": { get: { operationId: "allOfNotNull", responses: json({ allOf: [{ $ref: "#/components/schemas/MaybeItem" }, { not: { type: ["null"] } }] }) } },
          "/c": { get: { operationId: "stillMixed", responses: json({ $ref: "#/components/schemas/MaybeItem", not: { type: "null", minLength: 1 } }) } },
        },
        components: { schemas: { MaybeItem: { type: ["object", "null"], properties: { n: { type: "integer" } }, required: ["n"] } } },
      },
      { executor: recordingExecutor() },
    );
    expect(registered(result)).toEqual([["notNull", true], ["allOfNotNull", true], ["stillMixed", false]]);
    for (const name of ["notNull", "allOfNotNull"]) {
      expectArguments(tool(result.tools, name).outputSchema!, { valid: [{ n: 1 }], invalid: [{}, { n: "x" }] });
    }
  });

  it("decodes a percent-encoded reference fragment before reading it as a JSON Pointer", () => {
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/p/{id}": {
            put: {
              operationId: "encoded",
              parameters: [{ $ref: "#/components/p%61rameters/Id" }],
              requestBody: { $ref: "#/components/request%42odies/Body" },
              responses: { "200": { $ref: "#/components/%72esponses/Ok" } },
            },
          },
          "/bad": { get: { operationId: "malformed", parameters: [{ $ref: "#/components/parameters/%E0%A4%A" }], responses: ok } },
        },
        components: {
          parameters: { Id: { name: "id", in: "path", required: true, schema: { $ref: "#/components/sch%65mas/Text" } } },
          requestBodies: { Body: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Te%78t" } } } } },
          responses: { Ok: { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
          schemas: { Text: { type: "string" } },
        },
      },
      options(),
    );
    expect(skips(result)).toEqual([
      ["malformed", "unsupported-ref", 'reference "#/components/parameters/%E0%A4%A" is not a #/components/parameters/<name> reference'],
    ]);
    const encoded = tool(result.tools, "encoded");
    expect(encoded.outputSchema).toEqual({ type: "object" });
    expectArguments(encoded.inputSchema, { valid: [{ path: { id: "a" }, body: "b" }], invalid: [{ path: { id: 1 }, body: "b" }] });
  });

  it("reads path templates without rescanning unclosed braces", () => {
    const started = performance.now();
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          [`/x/${"{".repeat(100_000)}`]: { get: { operationId: "unclosed", responses: ok } },
          "/u/{id}/{{v}": {
            get: {
              operationId: "variables",
              parameters: [
                { name: "id", in: "path", required: true, schema: { type: "string" } },
                { name: "{v", in: "path", required: true, schema: { type: "string" } },
              ],
              responses: ok,
            },
          },
        },
      },
      options(),
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.skipped).toEqual([]);
    expect(registered(result)).toEqual([["unclosed", false], ["variables", false]]);
  });

  it("follows each parameter, request body and response alias chain once per call, with the diagnostics of a fresh walk", () => {
    const length = 3_000;
    const parameters: Record<string, unknown> = { [`p${length}`]: { name: "q", in: "query", schema: { type: "string" } } };
    for (let index = 0; index < length; index += 1) parameters[`p${index}`] = { $ref: `#/components/parameters/p${index + 1}` };
    const paths: Record<string, unknown> = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [
      `/a${index}`, { get: { operationId: `a${index}`, parameters: [{ $ref: "#/components/parameters/p0" }], responses: ok } },
    ]));
    // A prefix reaching a cycle names the cycle's first link; a walk starting on the cycle names itself.
    Object.assign(parameters, {
      x0: { $ref: "#/components/parameters/x1" }, x1: { $ref: "#/components/parameters/c0" },
      c0: { $ref: "#/components/parameters/c1" }, c1: { $ref: "#/components/parameters/c2" }, c2: { $ref: "#/components/parameters/c0" },
      m0: { $ref: "#/components/parameters/m1" }, m1: { $ref: "#/components/parameters/gone" },
    });
    for (const name of ["x0", "x1", "c1", "c2", "c0", "x0", "m0", "m1"]) {
      paths[`/${name}-${Object.keys(paths).length}`] = { get: { operationId: `ref_${name}`, parameters: [{ $ref: `#/components/parameters/${name}` }], responses: ok } };
    }
    const started = performance.now();
    const result = fromOpenAPI({ openapi: "3.1.0", paths, components: { parameters } }, options());
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result.tools).toHaveLength(3_000);
    expect(tool(result.tools, "a2999").inputSchema.properties).toEqual({
      query: { type: "object", properties: { q: { type: "string" } }, additionalProperties: false },
    });
    expect(skips(result)).toEqual([
      ["ref_x0", "unresolved-ref", "reference cycle through #/components/parameters/c0"],
      ["ref_x1", "unresolved-ref", "reference cycle through #/components/parameters/c0"],
      ["ref_c1", "unresolved-ref", "reference cycle through #/components/parameters/c1"],
      ["ref_c2", "unresolved-ref", "reference cycle through #/components/parameters/c2"],
      ["ref_c0", "unresolved-ref", "reference cycle through #/components/parameters/c0"],
      ["ref_x0", "unresolved-ref", "reference cycle through #/components/parameters/c0"],
      ["ref_m0", "unresolved-ref", "reference #/components/parameters/gone has no target"],
      ["ref_m1", "unresolved-ref", "reference #/components/parameters/gone has no target"],
    ]);
  });

  it("decodes a shared alias entry once and charges every resolution, ignored headers included, to the document total", () => {
    const parameters: Record<string, unknown> = {};
    const shared = Array.from({ length: 1_000 }, (_, index) => {
      parameters[`h${index}`] = { name: `Proxy-H${index}`, in: "header", schema: { type: "string" } };
      return { $ref: `#/components/parameters/h${index}` };
    });
    const item = { get: { parameters: shared, responses: ok } };
    const paths = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`/p${index}`, item]));
    const started = performance.now();
    const result = fromOpenAPI({ openapi: "3.1.0", paths, components: { parameters } }, options());
    expect(performance.now() - started).toBeLessThan(5_000);
    // 1,000 resolutions per operation over a document of a few thousand values: the total stops them.
    const codes = new Set(result.skipped.map((entry) => entry.code));
    expect(codes).toEqual(new Set(["schema-too-large"]));
    expect(result.tools.length).toBeGreaterThan(0);
    // Once the total refuses a resolution, no later operation reuses its outcome.
    expect(result.tools.map((entry) => entry.operation.path)).toEqual(Object.keys(paths).slice(0, result.tools.length));
    expect(result.tools.length + result.skipped.length).toBe(2_000);
  });

  it("charges every closure walk for the edges it queues, so wrappers sharing a wide hub with an invalid child stop once the total is spent", () => {
    const width = 20_000;
    const wrappers = 600;
    const schemas: Record<string, unknown> = { Bad: { prefixItems: [{ type: "string" }] } };
    const properties: Record<string, unknown> = { c0: { $ref: "#/components/schemas/Bad" } };
    for (let index = 1; index <= width; index += 1) {
      schemas[`C${index}`] = { type: "string" };
      properties[`c${index}`] = { $ref: `#/components/schemas/C${index}` };
    }
    schemas.Hub = { type: "object", properties };
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < wrappers; index += 1) {
      schemas[`W${index}`] = { type: "object", properties: { hub: { $ref: "#/components/schemas/Hub" } } };
      paths[`/w${index}`] = { get: { operationId: `w${index}`, responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/W${index}` } } } } } } };
    }
    const result = fromOpenAPI({ openapi: "3.1.0", paths, components: { schemas } }, options());
    const codes = result.skipped.map((entry) => entry.code);
    expect(codes).toHaveLength(wrappers);
    const spent = codes.indexOf("schema-too-large");
    expect(spent).toBeGreaterThan(0);
    expect(new Set(codes.slice(0, spent))).toEqual(new Set(["unsupported-schema-keyword"]));
    expect(new Set(codes.slice(spent))).toEqual(new Set(["schema-too-large"]));
  });

  it("removes flagged names from a long required list in order, with one lookup per name", () => {
    const names = Array.from({ length: 500 }, (_, index) => `n${index}`);
    const properties = Object.fromEntries(names.map((name, index) => [name, index % 2 === 0 ? { type: "string", readOnly: true } : { type: "string" }]));
    const result = fromOpenAPI({
      openapi: "3.1.0",
      paths: { "/r": { post: { operationId: "r", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties, required: names } } } }, responses: ok } } },
    }, options());
    expect(skips(result)).toEqual([]);
    const body = (tool(result.tools, "r").inputSchema.properties as Record<string, { required?: string[] }>).body!;
    expect(body.required).toEqual(names.filter((_, index) => index % 2 === 1));
  });
});

describe("fromOpenAPI projection, work and dialect bounds", () => {
  const ok = { "200": { description: "OK" } };
  const options = () => ({ executor: recordingExecutor(), allowMutations: true });
  const body = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
  const post = (operationId: string, schema: unknown) => ({ post: { operationId, requestBody: body(schema), responses: ok } });
  const json = (schema: unknown) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });

  it("skips a component flagged under a condition anywhere in the closure, whatever the branch or operation order", () => {
    const Metadata = { properties: { id: { type: "string", readOnly: true } }, required: ["id"] };
    const array = { type: "array", allOf: [{ $ref: "#/components/schemas/Metadata" }] };
    const object = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, id: { type: "string" } },
      if: { $ref: "#/components/schemas/Metadata" },
      then: { required: ["a"] },
      else: { required: ["b"] },
    };
    for (const members of [[array, object], [object, array]]) {
      for (const operations of [["first", "second"], ["second", "first"]]) {
        const schemas: Record<string, unknown> = { first: { oneOf: members }, second: { $ref: "#/components/schemas/Metadata" } };
        const result = fromOpenAPI(
          {
            openapi: "3.1.0",
            paths: Object.fromEntries(operations.map((name) => [`/${name}`, post(name, schemas[name])])),
            components: { schemas: { Metadata } },
          },
          options(),
        );
        expect(skips(result).filter(([name]) => name === "first")).toEqual([["first", "unsupported-access-flag", constrained("id", OVERLAP)]]);
      }
    }
    // Members that are disjoint by kind of value and flag only unconditionally still project.
    const disjoint = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/d": post("disjoint", { oneOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string", readOnly: true }, n: { type: "string" } } }] }) } },
      options(),
    );
    expect(disjoint.skipped).toEqual([]);
    expectArguments(tool(disjoint.tools, "disjoint").inputSchema, {
      valid: [{ body: "s" }, { body: { n: "x" } }],
      invalid: [{ body: { id: "x" } }],
    });
  });

  it("compares child schemas only among members that accept the same kind of value", () => {
    for (const flag of ["readOnly", "writeOnly"] as const) {
      const Leaf = { type: "object", properties: { id: { type: "string", [flag]: true }, v: { type: "string" } } };
      const leaf = { $ref: "#/components/schemas/Leaf" };
      // properties of an array-only member never apply, so the object member alone constrains each property.
      const array = { type: "array", properties: { child: leaf } };
      // The same member with its kind stated in a composition beside the properties.
      const composed = { allOf: [{ type: "array" }, { properties: { child: leaf } }] };
      // patternProperties never applies to an array either.
      const patterned = { type: "array", patternProperties: { "^x-": leaf } };
      const object = { type: "object", additionalProperties: leaf };
      for (const members of [[array, object], [object, array], [composed, object], [object, composed], [patterned, object]]) {
        const schema = { oneOf: members };
        const path = flag === "readOnly"
          ? post("op", schema)
          : { get: { operationId: "op", responses: json({ type: "object", properties: { data: schema } }) } };
        const result = fromOpenAPI({ openapi: "3.1.0", components: { schemas: { Leaf } }, paths: { "/x": path } }, options());
        expect(result.skipped).toEqual([]);
        const converted = tool(result.tools, "op");
        const wrap = (value: unknown) => (flag === "readOnly" ? { body: value } : { data: value });
        expectArguments((flag === "readOnly" ? converted.inputSchema : converted.outputSchema)!, {
          valid: [wrap([]), wrap({ k: { v: "x" } }), wrap({ child: { v: "x" } })],
          invalid: [wrap({ k: { id: "x" } }), wrap({ child: { id: "x" } })],
        });
      }
      // contains of an object-only member never applies to an array of leaves.
      const items = { oneOf: [{ type: "object", contains: leaf }, { type: "array", items: leaf }] };
      const listed = fromOpenAPI(
        {
          openapi: "3.1.0",
          components: { schemas: { Leaf } },
          paths: { "/x": flag === "readOnly" ? post("op", items) : { get: { operationId: "op", responses: json({ type: "object", properties: { data: items } }) } } },
        },
        options(),
      );
      expect(listed.skipped).toEqual([]);
      // Members that both accept objects still constrain the same property twice.
      const overlapping = { allOf: [{ type: "object", properties: { child: leaf } }, { type: "object", additionalProperties: leaf }] };
      const path = flag === "readOnly"
        ? post("op", overlapping)
        : { get: { operationId: "op", responses: json(overlapping) } };
      const result = fromOpenAPI({ openapi: "3.1.0", components: { schemas: { Leaf } }, paths: { "/x": path } }, options());
      expect(result.skipped.map((entry) => entry.code)).toEqual(["unsupported-access-flag"]);
    }
  });

  it("does not keep a clean result that depends on a later conflict in the same reference cycle", () => {
    // Shared reference objects, as a parsed document has them. A -> B -> A is a
    // cycle; D -> B reaches B while its result is still provisional; A's
    // property c conflicts only after that.
    const refA = { $ref: "#/components/schemas/A" };
    const refB = { $ref: "#/components/schemas/B" };
    const refD = { $ref: "#/components/schemas/D" };
    const schemas = {
      A: {
        type: "object",
        properties: { b: refB, d: refD, c: { type: "object", minProperties: 1, properties: { id: { type: "string", readOnly: true } } } },
      },
      B: { type: "object", properties: { a: refA } },
      D: { type: "object", properties: { b: refB } },
    };
    const result = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/a": post("a", refA), "/d": post("d", refD) }, components: { schemas } },
      options(),
    );
    expect(result.tools).toEqual([]);
    expect(result.skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([
      ["a", "unsupported-access-flag"],
      ["d", "unsupported-access-flag"],
    ]);
  });

  it("skips flagged items beside a tuple items list for the same array", () => {
    const flagged = { type: "object", properties: { id: { type: "string", readOnly: true } } };
    const result = fromOpenAPI(
      { openapi: "3.0.3", paths: { "/t": post("tuple", { type: "array", items: flagged, allOf: [{ items: [{ type: "object", required: ["id"] }] }] }) } },
      options(),
    );
    expect(skips(result)).toEqual([["tuple", "unsupported-access-flag", child("items", "a tuple items list for the same array")]]);
  });

  it("projects through many same-child constraints in linear work", () => {
    const Leaf = { type: "object", properties: { id: { type: "string", readOnly: true }, n: { type: "string" } } };
    const run = (count: number, registry?: McpFnRegistry) => {
      const members = Array.from({ length: count }, () => ({ properties: { child: { $ref: "#/components/schemas/Leaf" } } }));
      const items = Array.from({ length: count }, () => ({ items: { $ref: "#/components/schemas/Leaf" } }));
      return fromOpenAPI(
        {
          openapi: "3.1.0",
          paths: { "/p": post("properties", { type: "object", allOf: members }), "/i": post("items", { type: "array", allOf: items }) },
          components: { schemas: { Leaf } },
        },
        { ...options(), ...(registry ? { registry } : {}) },
      );
    };
    const small = run(3);
    expect(small.skipped).toEqual([]);
    expectArguments(tool(small.tools, "properties").inputSchema, { valid: [{ body: { child: { n: "x" } } }], invalid: [{ body: { child: { id: "x" } } }] });
    expectArguments(tool(small.tools, "items").inputSchema, { valid: [{ body: [{ n: "x" }] }], invalid: [{ body: [{ id: "x" }] }] });
    const started = performance.now();
    const large = run(5000, { register: () => undefined, has: () => false } as unknown as McpFnRegistry);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(large.skipped).toEqual([]);
  });

  it("checks a readOnly-flagged request body or parameter as written before leaving properties out", () => {
    const malformed = { type: "object", properties: { id: { type: "bogus", readOnly: true }, n: { type: "integer" } } };
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/m": post("malformedBody", malformed),
          "/q": { get: { operationId: "malformedParameter", parameters: [{ name: "q", in: "query", schema: { type: "string", properties: { x: { type: "bogus", readOnly: true } } } }], responses: ok } },
          "/v": post("validBody", { ...malformed, properties: { ...malformed.properties, id: { type: "string", readOnly: true } } }),
        },
      },
      options(),
    );
    expect(result.skipped.map((entry) => [entry.operation.operationId, entry.code, entry.reason.split(":")[0]])).toEqual([
      ["malformedBody", "invalid-schema", "the request body schema is not a valid JSON Schema"],
      ["malformedParameter", "invalid-schema", "the parameter q schema is not a valid JSON Schema"],
    ]);
    expectArguments(tool(result.tools, "validBody").inputSchema, { valid: [{ body: { n: 1 } }], invalid: [{ body: { id: "x" } }] });
  });

  it("keeps a schema's own definitions when it is checked as written beside referenced components", () => {
    const own = (bad: unknown) => ({ Unused: { type: "object", properties: { bad: { ...(bad as object), readOnly: true, writeOnly: true } } } });
    const schema = (bad: unknown, extra: object = {}) => ({
      type: "object",
      definitions: own(bad),
      properties: { value: { $ref: "#/components/schemas/Text" } },
      ...extra,
    });
    const malformed = { type: "bogus" };
    const result = fromOpenAPI(
      {
        openapi: "3.0.3",
        components: { schemas: { Text: { type: "string" } } },
        paths: {
          "/b": post("malformedBody", schema(malformed)),
          "/q": { get: { operationId: "malformedParameter", parameters: [{ name: "q", in: "query", schema: { type: "string", definitions: own(malformed), allOf: [{ $ref: "#/components/schemas/Text" }] } }], responses: ok } },
          "/r": { get: { operationId: "malformedResponse", responses: json(schema(malformed)) } },
          "/h": { head: { operationId: "malformedDiscarded", responses: json(schema(malformed)) } },
          "/v": post("validBody", schema({ type: "string" }, { required: ["value"] })),
          "/o": { get: { operationId: "validResponse", responses: json(schema({ type: "string" })) } },
        },
      },
      options(),
    );
    expect(result.skipped.map((entry) => [entry.operation.operationId, entry.code, entry.reason.split(":")[0]])).toEqual([
      ["malformedBody", "invalid-schema", "the request body schema is not a valid JSON Schema"],
      ["malformedParameter", "invalid-schema", "the parameter q schema is not a valid JSON Schema"],
      ["malformedResponse", "invalid-schema", "the response schema is not a valid JSON Schema"],
      ["malformedDiscarded", "invalid-schema", "the response schema is not a valid JSON Schema"],
    ]);
    expectArguments(tool(result.tools, "validBody").inputSchema, { valid: [{ body: { value: "x" } }], invalid: [{ body: { value: 1 } }, { body: {} }] });
    expectArguments(tool(result.tools, "validResponse").outputSchema!, { valid: [{ value: "x" }], invalid: [{ value: 1 }] });
  });

  it("checks 3.1 $defs and unflagged root output definitions as written beside referenced components", () => {
    const text = { $ref: "#/components/schemas/Text" };
    const flagged = (type: string) => ({ Unused: { type: "object", properties: { bad: { type, readOnly: true } } } });
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        components: { schemas: { Text: { type: "string" } } },
        paths: {
          "/b": post("defsBody", { type: "object", $defs: flagged("bogus"), properties: { value: text } }),
          "/u": post("defsUnflagged", { type: "object", $defs: { U: { type: "bogus" } }, properties: { value: { type: "string" } } }),
          "/r": { get: { operationId: "ownOutput", responses: json({ type: "object", definitions: { U: { type: "bogus" } }, properties: { v: text } }) } },
          "/v": post("validDefs", { type: "object", $defs: flagged("string"), definitions: { D: { type: "string" } }, properties: { value: text } }),
          "/o": { get: { operationId: "validOutput", responses: json({ type: "object", definitions: { U: { type: "string" } }, properties: { v: text } }) } },
          // Both maps beside a malformed allOf: the allOf is kept as written and refused.
          ...Object.fromEntries(
            [null, {}, [], ""].map((allOf, index) => [
              `/m${index}`,
              post(`malformedAllOf${index}`, { type: "string", definitions: { A: { type: "string" } }, $defs: { B: { type: "string" } }, allOf }),
            ]),
          ),
          // A $ref sibling allOf is checked before the reference joins it; $defs must be an object.
          "/ra": post("refEmptyAllOf", { $ref: "#/components/schemas/Text", allOf: [], definitions: { A: {} }, $defs: { B: {} } }),
          "/rq": { get: { operationId: "refEmptyAllOfQuery", parameters: [{ name: "q", in: "query", schema: { $ref: "#/components/schemas/Text", allOf: [] } }], responses: ok } },
          "/dn": post("defsNull", { type: "object", $defs: null }),
          "/dr": { get: { operationId: "defsNullOutput", responses: json({ type: "object", $defs: null }) } },
          "/dh": { head: { operationId: "defsArrayDiscarded", responses: json({ type: "object", $defs: [] }) } },
        },
      },
      options(),
    );
    expect(result.skipped.map((entry) => [entry.operation.operationId, entry.code]).sort()).toEqual([
      ["defsArrayDiscarded", "invalid-schema"],
      ["defsBody", "invalid-schema"],
      ["defsNull", "invalid-schema"],
      ["defsNullOutput", "invalid-schema"],
      ["defsUnflagged", "invalid-schema"],
      ...[0, 1, 2, 3].map((index) => [`malformedAllOf${index}`, "invalid-schema"]),
      ["ownOutput", "invalid-schema"],
      ["refEmptyAllOf", "invalid-schema"],
      ["refEmptyAllOfQuery", "invalid-schema"],
    ]);
    const body = (tool(result.tools, "validDefs").inputSchema.properties as Record<string, Record<string, unknown>>).body!;
    expect(body.$defs).toBeUndefined();
    expect(body.definitions).toEqual({ D: { type: "string" } });
    expect(body.allOf).toEqual([{ definitions: { Unused: { type: "object", properties: { bad: false } } } }]);
    expectArguments(tool(result.tools, "validDefs").inputSchema, { valid: [{ body: { value: "x" } }], invalid: [{ body: { value: 1 } }] });
    expectArguments(tool(result.tools, "validOutput").outputSchema!, { valid: [{ v: "x" }], invalid: [{ v: 1 }] });
  });

  it("compiles a response schema many operations share once, and bounds conversions by the document total", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 100 }, (_, outer) => [
        `p${outer}`,
        { type: "object", properties: Object.fromEntries(Array.from({ length: 20 }, (_, inner) => [`q${inner}`, { type: "string", maxLength: 5 }])) },
      ]),
    );
    const components = { schemas: { Big: { type: "object", properties } } };
    const shared = { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Big" } } } } };
    const heads: Record<string, unknown> = {};
    for (let index = 0; index < 600; index += 1) {
      // Each operation has its own reference object, and half share one response object.
      heads[`/h${index}`] = { head: { operationId: `h${index}`, responses: index % 2 === 0 ? shared : json({ $ref: "#/components/schemas/Big" }) } };
    }
    const started = performance.now();
    const discarded = fromOpenAPI({ openapi: "3.1.0", paths: heads, components }, options());
    expect(performance.now() - started).toBeLessThan(5000);
    expect(discarded.skipped).toEqual([]);
    expect(discarded.tools).toHaveLength(600);
    // Regions that each fit their limits still exhaust the document total when
    // many outputs convert one shared object: earlier ones succeed. (A
    // discarded response object is checked once, however many share it.)
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`f${index}`, { type: "string" }])) };
    const sharedResponse: Record<string, unknown> = {};
    for (let index = 0; index < 300; index += 1) sharedResponse[`/w${index}`] = { get: { operationId: `w${index}`, responses: json(wide) } };
    // Registration compiles each output; that cost is the registry's, so it is left out here.
    const bounded = fromOpenAPI(
      { openapi: "3.1.0", paths: sharedResponse },
      { ...options(), registry: { register: () => undefined, has: () => false } as unknown as McpFnRegistry },
    );
    expect(bounded.tools[0]?.name).toBe("w0");
    // Each tool converts the object and pays for its schema copy and its catalog copy.
    expect(bounded.tools.length).toBeGreaterThan(40);
    expect(bounded.skipped.length).toBeGreaterThan(0);
    expect(new Set(bounded.skipped.map((entry) => entry.reason))).toEqual(
      new Set([expect.stringMatching(/^the document's schemas expand in total to more than \d+ nodes$/) as unknown as string]),
    );
  }, 60_000);

  it("reads only published dialect ids as the default, refuses boolean roots under another one and drops 3.1 dependencies", () => {
    const document = (jsonSchemaDialect: string | undefined, schema: unknown) => ({
      openapi: "3.1.0",
      ...(jsonSchemaDialect ? { jsonSchemaDialect } : {}),
      paths: { "/p": post("p", schema) },
    });
    const published = ["base", "2024-10-25", "2024-11-10"].map((id) => `https://spec.openapis.org/oas/3.1/dialect/${id}`);
    for (const uri of [...published, ...published.map((id) => `${id}#`)]) {
      expect(fromOpenAPI(document(uri, { type: "object" }), options()).skipped).toEqual([]);
      expect(fromOpenAPI(document(undefined, { $schema: uri, type: "object" }), options()).skipped).toEqual([]);
    }
    for (const uri of ["https://spec.openapis.org/oas/3.1/dialect/2022-10-07", "https://spec.openapis.org/oas/3.1/dialect/2099-12-31", "https://example.com/my-dialect"]) {
      expect(fromOpenAPI(document(undefined, { $schema: uri, type: "object" }), options()).skipped.map((entry) => entry.code)).toEqual(["unsupported-dialect"]);
      for (const schema of [{ type: "object" }, true]) {
        expect(fromOpenAPI(document(uri, schema), options()).skipped.map((entry) => entry.code)).toEqual(["unsupported-dialect"]);
      }
      // A media type without a schema declares none, so no dialect applies to it.
      const schemaLess = { openapi: "3.1.0", jsonSchemaDialect: uri, paths: { "/p": { post: { operationId: "p", requestBody: { content: { "application/json": {} } }, responses: ok } } } };
      expect(fromOpenAPI(schemaLess, options()).skipped).toEqual([]);
      // A root that names a supported dialect itself is still read in it.
      expect(fromOpenAPI(document(uri, { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }), options()).skipped).toEqual([]);
    }
    const schemaLess = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/p": { post: { operationId: "p", requestBody: { content: { "application/json": {} } }, responses: ok } } } },
      options(),
    );
    expectArguments(tool(schemaLess.tools, "p").inputSchema, { valid: [{ body: { any: ["json"] } }, {}] });
    // 2020-12 has no `dependencies`: only dependentRequired applies in 3.1; 3.0 keeps the draft-07 keyword.
    const dependent = { type: "object", dependentRequired: { a: ["b"] }, dependencies: { a: ["c"] } };
    const modern = fromOpenAPI(document(undefined, dependent), options());
    expectArguments(tool(modern.tools, "p").inputSchema, { valid: [{ body: { a: 1, b: 1 } }], invalid: [{ body: { a: 1, c: 1 } }] });
    const legacy = fromOpenAPI({ openapi: "3.0.3", paths: { "/p": post("p", { type: "object", dependencies: { a: ["c"] } }) } }, options());
    expectArguments(tool(legacy.tools, "p").inputSchema, { valid: [{ body: { a: 1, c: 1 } }], invalid: [{ body: { a: 1, b: 1 } }] });
  });

  it("skips a request body whose schema is null, keeping valid siblings", () => {
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/n": { post: { operationId: "nullSchema", requestBody: { content: { "application/json": { schema: null } } }, responses: ok } },
          "/v": post("valid", { type: "object" }),
        },
      },
      options(),
    );
    expect(skips(result)).toEqual([["nullSchema", "invalid-schema", "a schema is not an object"]]);
    expect(registered(result)).toEqual([["valid", false]]);
  });

  it("shares identical schemas only frozen and only in its own registry, and keeps the catalog detached", () => {
    const resource = { type: "object", properties: { name: { type: "string" } } };
    const document = {
      openapi: "3.1.0",
      paths: Object.fromEntries(["a", "b", "c"].map((name) => [`/${name}`, { get: { operationId: name, responses: json(resource) } }])),
    };
    // A supplied registry gets a fresh object per tool, as from any caller.
    const supplied = fromOpenAPI(document, { ...options(), registry: new McpFnRegistry() });
    const [a, b] = ["a", "b"].map((name) => supplied.registry.getListedTool(name)!);
    expect(a!.outputSchema).not.toBe(b!.outputSchema);
    (a!.outputSchema!.properties!.name as { type: string }).type = "integer";
    expect(b!.outputSchema).toMatchObject({ properties: { name: { type: "string" } } });
    // Its own registry shares one frozen object; the last registration gets a fresh one.
    const own = fromOpenAPI(document, options());
    const [first, second, third] = ["a", "b", "c"].map((name) => own.registry.getListedTool(name)!);
    expect(first!.outputSchema).toBe(second!.outputSchema);
    expect(third!.outputSchema).not.toBe(second!.outputSchema);
    expect(third!.outputSchema).toEqual(second!.outputSchema);
    expect(() => {
      (first!.outputSchema!.properties!.name as { type: string }).type = "integer";
    }).toThrow(TypeError);
    // The catalog holds detached, writable copies either way.
    (tool(own.tools, "a").outputSchema!.properties!.name as { type: string }).type = "integer";
    expect(second!.outputSchema).toMatchObject({ properties: { name: { type: "string" } } });
    expect(tool(own.tools, "b").outputSchema).toMatchObject({ properties: { name: { type: "string" } } });
  });

  it("decides more than a handful of anchored literal prefixes exactly", () => {
    const patternProperties = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`^p${index}-`, { type: "string" }]));
    const Record = { type: "object", properties: { id: { type: "string", readOnly: true }, n: { type: "string" } } };
    const run = (name: string) =>
      fromOpenAPI(
        { openapi: "3.1.0", paths: { "/r": post("r", { type: "object", patternProperties, properties: { [name]: { $ref: "#/components/schemas/Record" } } }) }, components: { schemas: { Record } } },
        options(),
      );
    expect(run("record").skipped).toEqual([]);
    expect(skips(run("p39-record"))).toEqual([["r", "unsupported-access-flag", child('property "p39-record"', "patternProperties of a schema for the same object")]]);
  });

  it("ignores 3.1 dependencies in projection too, and keeps the 3.0 keyword as a constraint", () => {
    const schema = { type: "object", properties: { id: { type: "string", readOnly: true }, foo: { type: "string" }, bar: { type: "string" } }, dependencies: { foo: ["bar"] } };
    const modern = fromOpenAPI({ openapi: "3.1.0", paths: { "/p": post("p", schema) } }, options());
    expect(modern.skipped).toEqual([]);
    expectArguments(tool(modern.tools, "p").inputSchema, { valid: [{ body: { foo: "x" } }], invalid: [{ body: { id: "x" } }] });
    const legacy = fromOpenAPI({ openapi: "3.0.3", paths: { "/p": post("p", schema) } }, options());
    expect(skips(legacy)).toEqual([["p", "unsupported-access-flag", constrained("id", "dependencies")]]);
    // A sibling additionalProperties holding only 3.1 dependencies constrains nothing either.
    const nested = {
      type: "object",
      properties: { nested: { type: "object", properties: { id: { type: "string", readOnly: true } } } },
      allOf: [{ additionalProperties: { dependencies: { x: ["y"] } } }],
    };
    const sibling = fromOpenAPI({ openapi: "3.1.0", paths: { "/p": post("p", nested) } }, options());
    expect(sibling.skipped).toEqual([]);
    expectArguments(tool(sibling.tools, "p").inputSchema, { valid: [{ body: { nested: {} } }], invalid: [{ body: { nested: { id: "x" } } }] });
  });
});

describe("fromOpenAPI body fallback, synchronous schemas, per-kind alternatives and suffix search", () => {
  const ok = { "200": { description: "OK" } };
  const options = () => ({ executor: recordingExecutor(), allowMutations: true });
  const json = (schema: unknown) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });

  it("drops $async, so every produced schema validates synchronously under both engines", () => {
    const strict = { $async: true, type: "object", properties: { n: { type: "number" } }, required: ["n"] };
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: { "/a": { post: { operationId: "a", requestBody: { required: true, content: { "application/json": { schema: strict } } }, responses: json(strict) } } },
      },
      options(),
    );
    expect(result.skipped).toEqual([]);
    const converted = tool(result.tools, "a");
    expect(JSON.stringify([converted.inputSchema, converted.outputSchema])).not.toContain("$async");
    expectArguments(converted.outputSchema!, { valid: [{ n: 1 }], invalid: [{ n: "not-a-number" }, {}] });
    expectArguments(converted.inputSchema, { valid: [{ body: { n: 1 } }], invalid: [{ body: { n: "not-a-number" } }] });
  });

  it("takes the first request body entry whose schema converts, projects and compiles", () => {
    const usable = { type: "object", properties: { n: { type: "number" } } };
    for (const broken of [null, 7, { type: "bogus" }, { type: "object", properties: { id: { type: "string", readOnly: true } }, required: ["id"], not: { required: ["id"] } }]) {
      const content = { "application/json": { schema: broken }, "application/merge-patch+json": { schema: usable } };
      const result = fromOpenAPI(
        { openapi: "3.1.0", paths: { "/m": { patch: { operationId: "m", requestBody: { content }, responses: ok } } } },
        options(),
      );
      expect(result.skipped).toEqual([]);
      const converted = tool(result.tools, "m");
      expect(converted.operation.requestBody?.contentType).toBe("application/merge-patch+json");
      expectArguments(converted.inputSchema, { valid: [{ body: { n: 1 } }, {}], invalid: [{ body: { n: "x" } }] });
    }
    // A schema-less entry is usable as written; when no entry is usable, the first failure is reported.
    const schemaless = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/m": { patch: { operationId: "m", requestBody: { content: { "application/json": {}, "application/x+json": { schema: 7 } } }, responses: ok } } } },
      options(),
    );
    expect(tool(schemaless.tools, "m").operation.requestBody?.contentType).toBe("application/json");
    const none = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/m": { patch: { operationId: "m", requestBody: { content: { "application/json": { schema: 7 }, "application/x+json": { schema: { type: "bogus" } } } }, responses: ok } } } },
      options(),
    );
    expect(none.tools).toEqual([]);
    expect(none.skipped.map(({ code, reason }) => [code, reason])).toEqual([["invalid-schema", "a schema is not an object"]]);
  });

  it("checks each request body entry with no size limit of its own and converts the chosen one once", () => {
    const large = (count: number) => ({
      type: "object",
      $defs: Object.fromEntries(Array.from({ length: count }, (_, index) => [`d${index}`, {}])),
    });
    const convertBody = (content: Record<string, unknown>) =>
      fromOpenAPI(
        { openapi: "3.1.0", paths: { "/m": { patch: { operationId: "m", requestBody: { content }, responses: ok } } } },
        options(),
      );
    // A large preferred entry: checking and building the input must not count it twice.
    const half = convertBody({ "application/json": { schema: large(51_000) }, "application/example+json": { schema: { type: "string" } } });
    expect(half.skipped).toEqual([]);
    expect(tool(half.tools, "m").operation.requestBody?.contentType).toBe("application/json");
    // Past what one schema could once produce: a schema validators compile is kept; only the document's total bounds it.
    const over = convertBody({ "application/json": { schema: large(100_001) }, "application/example+json": { schema: { type: "string" } } });
    expect(over.skipped).toEqual([]);
    expect(tool(over.tools, "m").operation.requestBody?.contentType).toBe("application/json");
    expectArguments(tool(over.tools, "m").inputSchema, { valid: [{ body: {} }], invalid: [{ body: "x" }] });
  }, 60_000);

  it("converts the parameters once however many request body entries it tries", () => {
    const filter = {
      name: "filter",
      in: "query",
      schema: { type: "string", $defs: Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`d${index}`, {}])) },
    };
    const content: Record<string, unknown> = {};
    for (let index = 0; index < 256; index += 1) content[`application/v${index}+json`] = { schema: null };
    content["application/final+json"] = { schema: { type: "object", properties: { n: { type: "number" } } } };
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/m": { patch: { operationId: "m", parameters: [filter], requestBody: { content }, responses: ok } },
          "/later": { get: { operationId: "later", parameters: [{ name: "q", in: "query", schema: { type: "string" } }], responses: ok } },
        },
      },
      options(),
    );
    // Retrying 256 entries must not charge the parameter to the document total 257 times.
    expect(result.skipped).toEqual([]);
    expect(tool(result.tools, "m").operation.requestBody?.contentType).toBe("application/final+json");
    expectArguments(tool(result.tools, "m").inputSchema, { valid: [{ query: { filter: "f" }, body: { n: 1 } }], invalid: [{ body: { n: "x" } }] });
    expectArguments(tool(result.tools, "later").inputSchema, { valid: [{ query: { q: "x" } }], invalid: [{ query: { q: 1 } }] });
    // Entries sharing one failing schema are converted once.
    const bogus = { type: "bogus", $defs: filter.schema.$defs };
    const shared: Record<string, unknown> = {};
    for (let index = 0; index < 256; index += 1) shared[`application/v${index}+json`] = { schema: bogus };
    shared["application/final+json"] = content["application/final+json"];
    const reused = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/m": { patch: { operationId: "m", requestBody: { content: shared }, responses: ok } },
          "/later": { get: { operationId: "later", parameters: [{ name: "q", in: "query", schema: { type: "string" } }], responses: ok } },
        },
      },
      options(),
    );
    expect(reused.skipped).toEqual([]);
    expect(tool(reused.tools, "m").operation.requestBody?.contentType).toBe("application/final+json");
    expect(reused.tools.map(({ name }) => name)).toEqual(["m", "later"]);
  });

  it("gives every request body entry the same node budget whatever its position", () => {
    const defs = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`d${index}`, {}]));
    const filter = { name: "filter", in: "query", schema: { type: "string", $defs: defs(25_000) } };
    // A required readOnly property makes the input check compile the body as written too.
    const preferred = {
      schema: {
        type: "object",
        properties: { id: { type: "string", readOnly: true }, n: { type: "number" } },
        required: ["id"],
        $defs: defs(40_000),
      },
    };
    const fallback = { schema: { type: "string" } };
    const chosen = (content: Record<string, unknown>) => {
      const result = fromOpenAPI(
        { openapi: "3.1.0", paths: { "/m": { patch: { operationId: "m", parameters: [filter], requestBody: { content }, responses: ok } } } },
        options(),
      );
      expect(result.skipped).toEqual([]);
      return tool(result.tools, "m");
    };
    const first = chosen({ "application/preferred+json": preferred, "application/example+json": fallback });
    const afterRejected = chosen({ "application/json": { schema: null }, "application/preferred+json": preferred, "application/example+json": fallback });
    expect(first.operation.requestBody?.contentType).toBe("application/preferred+json");
    expect(afterRejected.operation.requestBody?.contentType).toBe("application/preferred+json");
    // The chosen entry is the whole input: the parameter group and the body with its readOnly property left out.
    for (const converted of [first, afterRejected]) {
      expect(converted.inputSchema.required).toBeUndefined();
      expect(Object.keys(converted.inputSchema.properties)).toEqual(["query", "body"]);
      expect((converted.inputSchema.properties.body as { properties: object }).properties).toEqual({ id: false, n: { type: "number" } });
    }
  }, 60_000);

  it("counts the members of a schema's arrays and maps as source values once, not as shared expansion", () => {
    const named = <T>(count: number, value: () => T) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`d${index}`, value()]));
    const filter = { name: "filter", in: "query", schema: { type: "string", $defs: named(100, () => ({})) } };
    const booleans = () => Array.from({ length: 1_100 }, () => true);
    // 1,100 boolean members, none shared: the body's own budget must keep each of them.
    const unshared = [
      { type: "object", allOf: booleans() },
      { type: "object", properties: named(1_100, () => true) },
      { type: "object", patternProperties: named(1_100, () => true) },
      { type: "object", $defs: named(1_100, () => true) },
    ];
    const convert = (content: Record<string, unknown>, parameters: unknown[]) =>
      fromOpenAPI(
        {
          openapi: "3.1.0",
          paths: {
            "/m": { patch: { operationId: "m", parameters, requestBody: { content }, responses: ok } },
            "/n": { get: { operationId: "n", responses: ok } },
          },
        },
        options(),
      );
    for (const schema of unshared) {
      for (const parameters of [[filter], []]) {
        for (const content of [{ "application/json": { schema } }, { "application/json": { schema }, "application/example+json": { schema: { type: "string" } } }]) {
          const result = convert(content, parameters);
          expect(result.skipped).toEqual([]);
          expect(tool(result.tools, "m").operation.requestBody?.contentType).toBe("application/json");
        }
      }
    }
    // OpenAPI 3.0 `dependencies` is converted too, so its map is source.
    const dependencies = { type: "object", dependencies: named(1_100, () => true) };
    const legacy = fromOpenAPI(
      { openapi: "3.0.3", paths: { "/m": { patch: { operationId: "m", requestBody: { content: { "application/json": { schema: dependencies } } }, responses: ok } } } },
      options(),
    );
    expect(legacy.skipped).toEqual([]);
    // One 400-member array shared by 16 wrappers is still expansion of a shared object; the sibling stays.
    const shared = booleans().slice(0, 400);
    const repeated = { type: "object", allOf: Array.from({ length: 16 }, () => ({ allOf: shared })) };
    // The same through the allOf a 3.1 $ref with siblings is rewritten to; a sparse default is not a JSON value.
    const sibling = { $ref: "#/components/schemas/S", allOf: shared };
    const rewritten = { type: "object", allOf: Array.from({ length: 16 }, () => sibling) };
    const sparse = { name: "q", in: "query", schema: { type: "string", default: new Array(90_000) } };
    let chain: Record<string, unknown> = { $ref: "#/components/schemas/S", type: "object" };
    for (let level = 1; level <= 16; level += 1) chain = { $ref: "#/components/schemas/S", allOf: [chain, chain] };
    for (const [content, parameters, code] of [
      [{ "application/json": { schema: repeated } }, [], "schema-too-large"],
      [{ "application/json": { schema: rewritten } }, [], "schema-too-large"],
      [{ "application/json": { schema: { type: "object" } } }, [sparse], "invalid-schema"],
      // A shared chain of 3.1 $refs with siblings, each level used twice.
      [{ "application/json": { schema: chain } }, [], "schema-too-large"],
    ] as const) {
      const result = fromOpenAPI(
        {
          openapi: "3.1.0",
          paths: {
            "/m": { patch: { operationId: "m", parameters, requestBody: { content }, responses: ok } },
            "/n": { get: { operationId: "n", responses: ok } },
          },
          components: { schemas: { S: { type: "object" } } },
        },
        options(),
      );
      expect(result.skipped.map((entry) => entry.code)).toEqual([code]);
      expect(result.tools.map(({ name }) => name)).toEqual(["n"]);
    }
  });

  it("does not count the members of objects the conversion does not read, such as a shared example or $ref sibling", () => {
    // One 20,000-key object that 2,000 operations share: an example, or a `properties` sibling OpenAPI 3.0 ignores beside a $ref.
    const big = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`k${index}`, { type: "string" }]));
    const schemas = [
      { type: "string", example: big },
      { $ref: "#/components/schemas/S", properties: big },
    ];
    for (const schema of schemas) {
      const paths = Object.fromEntries(
        Array.from({ length: 2_000 }, (_, index) => [`/r${index}`, { get: { operationId: `r${index}`, parameters: [{ name: "q", in: "query", schema }], responses: ok } }]),
      );
      const started = performance.now();
      const result = fromOpenAPI({ openapi: "3.0.3", paths, components: { schemas: { S: { type: "string" } } } }, options());
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result.skipped).toEqual([]);
      expect(result.tools).toHaveLength(2_000);
    }
  });

  it("lists a wide shared array, map or schema object once per call when operations keep failing on it", () => {
    const missing = { $ref: "#/components/schemas/Missing" };
    const width = 2_000;
    const members = Array.from({ length: width - 1 }, () => ({ type: "string" }));
    const array = [missing, ...members];
    const map = Object.fromEntries([["a", missing], ...members.map((member, index) => [`p${index}`, member])]);
    const annotated = { ...Object.fromEntries(members.map((_, index) => [`x-note${index}`, index])), allOf: [missing] };
    const wrappers: Array<[string, () => unknown]> = [
      ["allOf", () => ({ allOf: array })],
      ["items", () => ({ type: "array", items: array })],
      ["properties", () => ({ type: "object", properties: map })],
      ["$defs", () => ({ type: "object", $defs: map })],
      ["x-keys", () => ({ allOf: [annotated] })],
    ];
    const merge = { "application/merge-patch+json": { schema: { type: "object", properties: { n: { type: "number" } } } } };
    for (const [label, wrapper] of wrappers) {
      for (const trailing of [{}, merge]) {
        const paths: Record<string, unknown> = Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [
            `/p${index}`,
            { post: { operationId: `p${index}`, requestBody: { content: { "application/json": { schema: wrapper() }, "application/example+json": { schema: wrapper() }, ...trailing } }, responses: ok } },
          ]),
        );
        paths["/ok"] = { get: { operationId: "okGet", responses: ok } };
        const keys = Object.keys;
        const entries = Object.entries;
        let wide = 0;
        const count = <T>(listed: T[]): T[] => {
          if (listed.length >= 1_000) wide += 1;
          return listed;
        };
        Object.keys = (value: object) => count(keys(value));
        Object.entries = ((value: object) => count(entries(value))) as typeof Object.entries;
        let result: Result;
        try {
          result = fromOpenAPI({ openapi: "3.1.0", paths, components: { schemas: {} } }, options());
        } finally {
          Object.keys = keys;
          Object.entries = entries;
        }
        // One listing of the shared container for the whole call, not one per operation or body entry.
        expect([label, wide]).toEqual([label, 1]);
        if (trailing === merge) {
          expect(result.skipped).toEqual([]);
          expect(new Set(result.tools.map((entry) => entry.operation.requestBody?.contentType))).toEqual(new Set([undefined, "application/merge-patch+json"]));
          expectArguments(tool(result.tools, "p0").inputSchema, { valid: [{ body: { n: 1 } }], invalid: [{ body: { n: "x" } }] });
        } else {
          expect(new Set(result.skipped.map(({ code }) => code))).toEqual(new Set(["unresolved-ref"]));
          expect(result.skipped).toHaveLength(200);
        }
        expect(tool(result.tools, "okGet")).toBeDefined();
      }
    }
  });

  it("reads a shared $ref-sibling allOf, circular schema, default or response allOf once per call, not per operation", () => {
    const width = 2_000;
    const missing = { $ref: "#/components/schemas/Missing" };
    const strings = () => Array.from({ length: width - 1 }, () => ({ type: "string" }));
    // A 3.1 $ref sibling allOf whose first member fails.
    const siblings = [missing, ...strings()];
    // A schema with many annotations that contains itself.
    const cycle: Record<string, unknown> = Object.fromEntries(Array.from({ length: width }, (_, index) => [`x-note${index}`, index]));
    cycle.allOf = [cycle];
    // A default whose first property is itself.
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    for (let index = 0; index < width; index += 1) loop[`k${index}`] = index;
    // A response allOf whose last member fails.
    const objects = [...Array.from({ length: width - 1 }, () => ({ type: "object" })), missing];
    const cases: Array<[string, () => unknown, string]> = [
      ["$ref sibling", () => ({ $ref: "#/components/schemas/Valid", allOf: siblings }), "unresolved-ref"],
      ["circular", () => ({ allOf: [cycle] }), "circular-object"],
      ["default", () => ({ type: "object", default: loop }), "circular-object"],
    ];
    const merge = { "application/merge-patch+json": { schema: { type: "object", properties: { n: { type: "number" } } } } };
    const run = (label: string, paths: Record<string, unknown>) => {
      const document = { openapi: "3.1.0", paths: { ...paths, "/ok": { get: { operationId: "okGet", responses: ok } } }, components: { schemas: { Valid: { type: "object" } } } };
      // Members read: array iterator steps (for-of, spread, Array.from) and wide key or entry lists.
      const iterator = Object.getPrototypeOf([][Symbol.iterator]()) as { next: () => unknown };
      const next = iterator.next;
      const keys = Object.keys;
      const entries = Object.entries;
      let reads = 0;
      const listed = <T>(list: T[]): T[] => {
        if (list.length >= 100) reads += list.length;
        return list;
      };
      iterator.next = function (this: unknown) {
        reads += 1;
        return next.call(this);
      };
      Object.keys = (value: object) => listed(keys(value));
      Object.entries = ((value: object) => listed(entries(value))) as typeof Object.entries;
      let result: Result;
      try {
        result = fromOpenAPI(document, options());
      } finally {
        iterator.next = next;
        Object.keys = keys;
        Object.entries = entries;
      }
      // Reading each shared member list once per operation would be at least 200 x 2,000.
      expect([label, reads < 100 * width]).toEqual([label, true]);
      expect(tool(result.tools, "okGet")).toBeDefined();
      return result;
    };
    for (const [label, schema, code] of cases) {
      for (const trailing of [{}, merge]) {
        const result = run(
          `${label}${trailing === merge ? " with fallback" : ""}`,
          Object.fromEntries(
            Array.from({ length: 200 }, (_, index) => [`/p${index}`, { post: { operationId: `p${index}`, requestBody: { content: { "application/json": { schema: schema() }, ...trailing } }, responses: ok } }]),
          ),
        );
        if (trailing === merge) {
          expect([label, result.skipped]).toEqual([label, []]);
          expect(tool(result.tools, "p0").operation.requestBody?.contentType).toBe("application/merge-patch+json");
          expectArguments(tool(result.tools, "p0").inputSchema, { valid: [{ body: { n: 1 } }], invalid: [{ body: { n: "x" } }] });
        } else {
          expect([label, new Set(result.skipped.map((entry) => entry.code)), result.skipped.length]).toEqual([label, new Set([code]), 200]);
        }
      }
    }
    // Responses of GET and HEAD operations alike; a valid HEAD sibling still has no output schema.
    const responses = run("responses", {
      ...Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [`/r${index}`, { [index % 2 === 0 ? "get" : "head"]: { operationId: `r${index}`, responses: json({ allOf: objects }) } }]),
      ),
      "/h": { head: { operationId: "h", responses: json({ type: "object" }) } },
    });
    expect([new Set(responses.skipped.map((entry) => entry.code)), responses.skipped.length]).toEqual([new Set(["unresolved-ref"]), 200]);
    expect(tool(responses.tools, "h").outputSchema).toBeUndefined();
    // A shared 3.1 schema whose first sibling is a circular default, as a POST body beside a JSON fallback or a HEAD's discarded response.
    const copied = { default: loop, ...Object.fromEntries(Array.from({ length: width }, (_, index) => [`x-note${index}`, index])), $ref: "#/components/schemas/Valid" };
    const copies = run(
      "copied siblings",
      Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `/c${index}`,
          index % 2 === 0
            ? { post: { operationId: `c${index}`, requestBody: { content: { "application/json": { schema: copied }, ...merge } }, responses: ok } }
            : { head: { operationId: `c${index}`, responses: json(copied) } },
        ]),
      ),
    );
    expect(copies.skipped.map((entry) => entry.code)).toEqual(Array.from({ length: 100 }, () => "circular-object"));
    expect(tool(copies.tools, "c0").operation.requestBody?.contentType).toBe("application/merge-patch+json");
    // A shared default whose cycle comes after many fields, in sole request bodies and advertised object responses.
    const tail: Record<string, unknown> = Object.fromEntries(Array.from({ length: width }, (_, index) => [`k${index}`, index]));
    tail.self = tail;
    const tails = run(
      "copied cycle last",
      Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `/t${index}`,
          index % 2 === 0
            ? { post: { operationId: `t${index}`, requestBody: { content: { "application/json": { schema: { type: "object", default: tail } } } }, responses: ok } }
            : { get: { operationId: `t${index}`, responses: json({ type: "object", default: tail }) } },
        ]),
      ),
    );
    expect(tails.skipped.map((entry) => entry.code)).toEqual(Array.from({ length: 200 }, () => "circular-object"));
  });

  it("keeps a 3.1 $ref's $defs checked beside an undefined allOf, and skips arrays that shadow their own methods", () => {
    const ref = "#/components/schemas/S";
    const fallback = { "application/example+json": { schema: { type: "string" } } };
    const shadowed = Object.assign([{ type: "object" }], { map: null, constructor: null });
    const document = {
      openapi: "3.1.0",
      paths: {
        "/d": { patch: { operationId: "d", requestBody: { content: { "application/json": { schema: { $ref: ref, allOf: undefined, definitions: {}, $defs: { Bad: { required: 3 } } } }, ...fallback } }, responses: ok } },
        "/m": { patch: { operationId: "m", requestBody: { content: { "application/json": { schema: { $ref: ref, allOf: shadowed } }, ...fallback } }, responses: ok } },
        "/g": { get: { operationId: "g", responses: json({ allOf: shadowed }) } },
      },
      components: { schemas: { S: { type: "object" } } },
    };
    const result = fromOpenAPI(document, options());
    // The shadowed allOf is refused wherever it is, never read through its own `map`: the body takes its next entry.
    expect(result.skipped.map(({ operation, code }) => [operation.operationId, code])).toEqual([["g", "invalid-schema"]]);
    expect(result.tools.map((entry) => [entry.name, entry.operation.requestBody?.contentType])).toEqual([
      ["d", "application/example+json"],
      ["m", "application/example+json"],
    ]);
  });

  it("credits a 3.1 $ref's sibling allOf before its other siblings, whatever their order", () => {
    const repeated = { allOf: Array.from({ length: 300 }, () => true) };
    const properties = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${index}`, repeated]));
    const allOf = Array.from({ length: 400 }, () => true);
    const ref = "#/components/schemas/S";
    for (const schema of [{ $ref: ref, properties, allOf }, { $ref: ref, allOf, properties }]) {
      const result = fromOpenAPI(
        {
          openapi: "3.1.0",
          paths: { "/m": { patch: { operationId: "m", requestBody: { content: { "application/json": { schema }, "application/example+json": { schema: { type: "string" } } } }, responses: ok } } },
          components: { schemas: { S: { type: "object" } } },
        },
        options(),
      );
      expect(result.skipped).toEqual([]);
      expect(tool(result.tools, "m").operation.requestBody?.contentType).toBe("application/json");
    }
  });

  it("gives the same kinds of value to a shared member list whichever operation reaches it first through a reference cycle", () => {
    // R refers to A, whose items refer to B = { anyOf: L }, and L = [R]: a HEAD reaching L through R first must not fix L's kinds.
    const ref = { $ref: "#/components/schemas/A" };
    const members = [ref];
    // Also with a HEAD root distinct from the member: a cached kind set must not depend on where a cycle was cut.
    for (const [headFirst, root] of [[true, ref], [false, ref], [true, { ...ref }], [false, { ...ref }]] as const) {
      const head = { "/h": { head: { operationId: "h", responses: json(root) } } };
      const get = { "/g": { get: { operationId: "g", responses: json({ anyOf: members }) } } };
      const result = fromOpenAPI(
        {
          openapi: "3.1.0",
          paths: headFirst ? { ...head, ...get } : { ...get, ...head },
          components: {
            schemas: {
              A: { type: "object", required: ["n"], properties: { n: { type: "integer" } }, items: { $ref: "#/components/schemas/B" } },
              B: { anyOf: members },
            },
          },
        },
        options(),
      );
      expect(result.skipped).toEqual([]);
      expect(tool(result.tools, "h").outputSchema).toBeUndefined();
      expectArguments(tool(result.tools, "g").outputSchema!, { valid: [{ n: 1 }], invalid: [{}, { n: "x" }] });
    }
  });

  it("reads a $ref's siblings before its target, whether or not an earlier operation reached the target", () => {
    const irregular = {
      sparse: () => Object.assign(["object"], { length: 3 }),
      shadowed: () => Object.defineProperty(["object"], "map", { value: 1, enumerable: true }),
    };
    for (const version of ["3.1.0", "3.0.3"]) {
      for (const make of Object.values(irregular)) {
        const outcomes = [false, true].map((warm) => {
          const paths: Record<string, unknown> = {};
          if (warm) paths["/a"] = { get: { operationId: "warm", responses: json({ $ref: "#/components/schemas/Broken" }) } };
          paths["/b"] = { get: { operationId: "target", responses: json({ $ref: "#/components/schemas/Broken", type: make() }) } };
          paths["/ok"] = { get: { operationId: "ok", responses: json({ type: "object", properties: { n: { type: "integer" } } }) } };
          const result = fromOpenAPI(
            { openapi: version, paths, components: { schemas: { Broken: { $ref: "#/components/schemas/Missing" } } } },
            options(),
          );
          expect(registered(result)).toEqual([["ok", true]]);
          expectArguments(tool(result.tools, "ok").outputSchema!, { valid: [{ n: 1 }], invalid: [{ n: "x" }] });
          return result.skipped.filter((entry) => entry.operation.operationId === "target").map(({ code, reason }) => [code, reason]);
        });
        // 3.0 ignores $ref siblings, so only the target's failure remains.
        expect(outcomes[0]![0]![0]).toBe(version === "3.0.3" ? "unresolved-ref" : "invalid-schema");
        expect(outcomes[1]).toEqual(outcomes[0]);
      }
    }
  });

  it("fails a reference cycle with two failures the same way whichever operation reaches it first", () => {
    // Y and P reach each other; P also reaches F1 and Y also reaches F2, nearer to Y.
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    const schemas = () => ({
      R: { allOf: [ref("P"), ref("Y")] },
      P: { allOf: [ref("Y"), ref("F1")] },
      Y: { allOf: [ref("P"), ref("F2")] },
      F1: ref("Missing"),
      F2: { type: Object.assign(["object"], { length: 2 }) },
    });
    const run = (names: string[]) =>
      fromOpenAPI(
        {
          openapi: "3.1.0",
          paths: Object.fromEntries(names.map((name) => [`/${name}`, { get: { operationId: name, responses: json(ref(name.toUpperCase())) } }])),
          components: { schemas: schemas() },
        },
        options(),
      );
    const byOperation = (result: Result) =>
      Object.fromEntries(result.skipped.map((entry) => [entry.operation.operationId, [entry.code, entry.reason]]));
    const outcomes = [["r", "y", "p"], ["y", "r", "p"], ["p", "y", "r"], ["y", "p", "r"]].map((names) => byOperation(run(names)));
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
    expect(outcomes[0]!.y![0]).toBe("invalid-schema");
    expect(outcomes[0]!.p![0]).toBe("unresolved-ref");
  });

  /** Calls of a SchemaConverter method while `task` runs (the document is copied first, so getters cannot count them). */
  const countCalls = <T>(method: string, task: () => T): [T, number] => {
    const spy = vi.spyOn(SchemaConverter.prototype as unknown as Record<string, (...args: unknown[]) => unknown>, method);
    try {
      return [task(), spy.mock.calls.length];
    } finally {
      spy.mockRestore();
    }
  };

  it("skips a chain validators cannot compile, whatever the stack left, and bounds many operations reaching it by the document total", () => {
    const depth = 20_000;
    const build = (operations: number) => {
      const schemas: Record<string, unknown> = {};
      for (let index = 0; index < depth - 1; index += 1) schemas[`D${index}`] = { allOf: [{ $ref: `#/components/schemas/D${index + 1}` }] };
      schemas[`D${depth - 1}`] = { type: "object" };
      schemas.W = { allOf: [...Array.from({ length: 1000 }, () => ({ type: "object" })), { $ref: "#/components/schemas/D0" }] };
      schemas.Short = { allOf: [{ $ref: `#/components/schemas/D${depth - 10}` }] };
      const paths: Record<string, unknown> = { "/ok": { get: { operationId: "ok", responses: ok } } };
      for (let index = 0; index < operations; index += 1) {
        paths[`/r${index}`] = { get: { operationId: `r${index}`, responses: json({ $ref: "#/components/schemas/W" }) } };
      }
      paths["/short"] = { get: { operationId: "short", responses: json({ $ref: "#/components/schemas/Short" }) } };
      return { openapi: "3.1.0", paths, components: { schemas } };
    };
    const outcome = (result: Result) => [registered(result), [...new Set(result.skipped.map(({ code, reason }) => `${code}: ${reason}`))]];
    // Schema objects whose kinds are read: the chain once per call, plus each operation's own root.
    const [single, once] = countCalls("kindsTerms", () => outcome(fromOpenAPI(build(1), options())));
    const [repeated, walked] = countCalls("kindsTerms", () => outcome(fromOpenAPI(build(200), options())));
    expect(single).toEqual([[["ok", false], ["short", true]], ["schema-too-large: a schema or reference chain nests too deeply"]]);
    // Each tool copies the 20,000-definition closure: once the document's total is spent, the rest are skipped for it.
    expect(repeated[0]).toContainEqual(["ok", false]);
    for (const reason of repeated[1] as string[]) expect(reason).toMatch(/^schema-too-large: (a schema or reference chain nests too deeply|the document's schemas expand in total to more than \d+ nodes)$/);
    expect(once).toBeGreaterThan(depth);
    expect(walked).toBeLessThanOrEqual(once + 2 * 200);
    // Run with thousands of frames already on the stack: the same result.
    const nested = (frames: number): ReturnType<typeof outcome> =>
      frames === 0 ? outcome(fromOpenAPI(build(10), options())) : nested(frames - 1);
    expect(nested(3000)).toEqual(single);
  }, 60_000);

  it("keeps reference chains validators compile past 150 definitions for every root, after the closure's own failures", () => {
    const chain = (length: number) => {
      const schemas: Record<string, unknown> = {};
      for (let index = 0; index < length - 1; index += 1) schemas[`T${index}`] = { allOf: [{ $ref: `#/components/schemas/T${index + 1}` }] };
      schemas[`T${length - 1}`] = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
      return schemas;
    };
    // 10 operations, each through its own one-link wrapper around one 155-link tail (validators compile 160 cold).
    const document = (length: number, operations: number) => {
      const schemas = chain(length);
      const paths: Record<string, unknown> = {};
      for (let index = 0; index < operations; index += 1) {
        schemas[`W${index}`] = { allOf: [{ $ref: "#/components/schemas/T0" }] };
        paths[`/w${index}`] = { get: { operationId: `w${index}`, responses: json({ $ref: `#/components/schemas/W${index}` }) } };
      }
      paths["/short"] = { get: { operationId: "short", responses: json({ $ref: `#/components/schemas/T${length - 5}` }) } };
      return { openapi: "3.0.3", paths, components: { schemas } };
    };
    const result = fromOpenAPI(document(155, 10), options());
    expect(result.skipped).toEqual([]);
    expect(registered(result)).toEqual([...Array.from({ length: 10 }, (_, index): [string, boolean] => [`w${index}`, true]), ["short", true]]);
    expectArguments(tool(result.tools, "w9").outputSchema!, { valid: [{ n: 1 }], invalid: [{ n: "x" }] });
    // A closure's own failing component is reported, and nothing past it is
    // converted first (so its conversions cannot exhaust the call's budget).
    const [isolated, converted] = countCalls("convertedComponent", () =>
      fromOpenAPI(
        {
          openapi: "3.1.0",
          paths: {
            "/p": { post: { operationId: "post", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Root" } } } }, responses: ok } },
            "/g": { get: { operationId: "get", responses: json({ type: "object" }) } },
          },
          components: {
            schemas: {
              ...chain(190),
              Root: { type: "object", properties: { bad: { $ref: "#/components/schemas/Bad" } }, allOf: [{ $ref: "#/components/schemas/T0" }] },
              Bad: { type: "array", prefixItems: [{ type: "string" }] },
            },
          },
        },
        options(),
      ),
    );
    expect(registered(isolated)).toEqual([["get", true]]);
    expect(isolated.skipped.map(({ code }) => code)).toEqual(["unsupported-schema-keyword"]);
    expect(converted).toBeLessThan(10);
    // Chains of up to 155 definitions register as a response, a HEAD response, a body and a query parameter, under both engines.
    for (const length of [65, 150, 155]) {
      const schemas = { ...chain(length), Q: { allOf: [{ $ref: "#/components/schemas/T0" }] } };
      const ref = { $ref: "#/components/schemas/T0" };
      const valid = fromOpenAPI(
        {
          openapi: "3.0.3",
          paths: {
            "/r": {
              get: { operationId: "g", responses: json(ref) },
              head: { operationId: "h", responses: json(ref) },
              post: { operationId: "p", requestBody: { required: true, content: { "application/json": { schema: ref } } }, responses: ok },
            },
          },
          components: { schemas },
        },
        options(),
      );
      expect(registered(valid)).toEqual([["g", true], ["h", false], ["p", false]]);
      expectArguments(tool(valid.tools, "g").outputSchema!, { valid: [{ n: 1 }], invalid: [{ n: "x" }, {}] });
      expectArguments(tool(valid.tools, "p").inputSchema, { valid: [{ body: { n: 1 } }], invalid: [{ body: {} }] });
      const scalar: Record<string, unknown> = {};
      for (let index = 0; index < length - 1; index += 1) scalar[`S${index}`] = { allOf: [{ $ref: `#/components/schemas/S${index + 1}` }] };
      scalar[`S${length - 1}`] = { type: "integer" };
      const query = fromOpenAPI(
        {
          openapi: "3.0.3",
          paths: { "/q": { get: { operationId: "q", parameters: [{ name: "x", in: "query", required: true, schema: { $ref: "#/components/schemas/S0" } }], responses: ok } } },
          components: { schemas: scalar },
        },
        options(),
      );
      expect(query.skipped).toEqual([]);
      expectArguments(tool(query.tools, "q").inputSchema, { valid: [{ query: { x: 1 } }], invalid: [{ query: { x: "a" } }] });
    }
  }, 60_000);

  it("keeps applied chains validators compile, in place or through properties, and an unused $defs entry", () => {
    const schemas: Record<string, unknown> = { T154: { type: "object" }, P154: { type: "object" }, U149: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } };
    for (let index = 0; index < 154; index += 1) {
      schemas[`T${index}`] = { allOf: [{ $ref: `#/components/schemas/T${index + 1}` }] };
      schemas[`P${index}`] = { type: "object", properties: { next: { $ref: `#/components/schemas/P${index + 1}` } } };
    }
    for (let index = 0; index < 149; index += 1) schemas[`U${index}`] = { allOf: [{ $ref: `#/components/schemas/U${index + 1}` }] };
    const unused = { type: "object", properties: { a: { type: "string" } }, $defs: { x: { $ref: "#/components/schemas/T0" }, y: { $ref: "#/components/schemas/P0" } } };
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/unused": { get: { operationId: "unused", responses: json(unused) } },
          "/inPlace": { get: { operationId: "inPlace", responses: json({ $ref: "#/components/schemas/T0" }) } },
          "/property": { get: { operationId: "property", responses: json({ $ref: "#/components/schemas/P0" }) } },
          "/body": {
            post: {
              operationId: "body",
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/U0" } },
                  "application/merge-patch+json": { schema: { type: "object" } },
                },
              },
              responses: ok,
            },
          },
        },
        components: { schemas },
      },
      options(),
    );
    expect(result.skipped).toEqual([]);
    expect(registered(result)).toEqual([["unused", true], ["inPlace", true], ["property", true], ["body", false]]);
    expectArguments(tool(result.tools, "property").outputSchema!, { valid: [{ next: { next: {} } }], invalid: [{ next: 1 }] });
    expectArguments(tool(result.tools, "unused").outputSchema!, { valid: [{ a: "x" }], invalid: [{ a: 1 }] });
    // The preferred entry's 150-definition chain compiles, so it stays selected.
    const body = tool(result.tools, "body");
    expect(body.operation.requestBody?.contentType).toBe("application/json");
    expectArguments(body.inputSchema, { valid: [{ body: { n: 1 } }], invalid: [{ body: {} }] });
  });

  it("walks a tail many wrappers share once per call, in place or through properties", () => {
    const build = (operations: number, link: (next: string) => unknown) => {
      const length = 1000;
      const schemas: Record<string, unknown> = { [`T${length - 1}`]: { type: "object" } };
      for (let index = 0; index < length - 1; index += 1) schemas[`T${index}`] = link(`#/components/schemas/T${index + 1}`);
      const paths: Record<string, unknown> = { "/ok": { get: { operationId: "ok", responses: ok } } };
      for (let index = 0; index < operations; index += 1) {
        schemas[`W${index}`] = { allOf: [{ $ref: "#/components/schemas/T0" }] };
        paths[`/w${index}`] = { get: { operationId: `w${index}`, responses: json({ $ref: `#/components/schemas/W${index}` }) } };
      }
      return { openapi: "3.0.3", paths, components: { schemas } };
    };
    const links = [
      (next: string) => ({ allOf: [{ $ref: next }] }),
      (next: string) => ({ type: "object", properties: { next: { $ref: next } } }),
    ];
    // Registration compiles each schema; that cost is the registry's, so it is left out here.
    const uncompiled = { register: () => undefined, has: () => false } as unknown as McpFnRegistry;
    for (const link of links) {
      const [result, reads] = countCalls("convertedComponent", () => fromOpenAPI(build(100, link), { ...options(), registry: uncompiled }));
      expect(result.skipped).toEqual([]);
      expect(result.tools).toHaveLength(101);
      // The tail once, plus each wrapper's own component.
      expect(reads).toBeLessThanOrEqual(1000 + 2 * 100);
    }
    // A tail that fails is walked again by each wrapper, and each walk is charged to the call's total.
    const charged = vi.spyOn(NodeBudget.prototype, "chargeNodes");
    try {
      const failing = build(300, (next) => ({ type: "object", properties: { next: { $ref: next } } }));
      (failing.components.schemas as Record<string, unknown>).T999 = { type: "array", prefixItems: [{ type: "string" }] };
      const result = fromOpenAPI(failing, options());
      expect(registered(result)).toEqual([["ok", false]]);
      expect(new Set(result.skipped.map(({ code }) => code))).toEqual(new Set(["unsupported-schema-keyword"]));
      expect(charged.mock.calls.reduce((sum, [count]) => sum + count, 0)).toBeGreaterThanOrEqual(300 * 1000);
    } finally {
      charged.mockRestore();
    }
  }, 60_000);

  it("charges every copy of a closure to the call's total as it is made, literals included", () => {
    const values = Array.from({ length: 50 }, (_, index) => `v${index}`);
    const schemas = { Item: { type: "object", properties: { a: { type: "string", enum: values }, b: { type: "integer" } } } };
    const charge = (operations: number, registry?: McpFnRegistry) => {
      const charged = vi.spyOn(NodeBudget.prototype, "chargeNodes");
      const nodes = vi.spyOn(NodeBudget.prototype, "charge");
      try {
        const paths: Record<string, unknown> = {};
        for (let index = 0; index < operations; index += 1) paths[`/g${index}`] = { get: { operationId: `g${index}`, responses: json({ $ref: "#/components/schemas/Item" }) } };
        const result = fromOpenAPI({ openapi: "3.0.3", paths, components: { schemas } }, { ...options(), ...(registry ? { registry } : {}) });
        expect(result.skipped).toEqual([]);
        expect(result.tools).toHaveLength(operations);
        return charged.mock.calls.reduce((sum, [count]) => sum + count, nodes.mock.calls.length);
      } finally {
        charged.mockRestore();
        nodes.mockRestore();
      }
    };
    // Fresh copies per tool: each copy of the closure is charged, the enum's values included.
    const fresh = () => ({ register: () => undefined, has: () => false }) as unknown as McpFnRegistry;
    expect(charge(10, fresh()) - charge(5, fresh())).toBeGreaterThan(5 * values.length);
    // Tools with identical schemas share one registry copy, but each catalog entry copies the closure again: charged per tool too.
    expect(charge(10) - charge(5)).toBeGreaterThan(5 * values.length);
    // A parameter that fails its shape check never emits the closure it was checked with.
    const parameters = Array.from({ length: 20 }, (_, index) => ({ name: `p${index}`, in: "query", schema: { $ref: `#/components/schemas/Q${index}` } }));
    const wrappers = Object.fromEntries(parameters.map((_, index) => [`Q${index}`, { allOf: [{ $ref: "#/components/schemas/Shape" }] }]));
    const [rejected, emitted] = countCalls("emit", () =>
      fromOpenAPI(
        {
          openapi: "3.0.3",
          paths: { "/q": { get: { operationId: "q", parameters, responses: ok } } },
          components: { schemas: { ...wrappers, Shape: { type: "object", properties: { a: { $ref: "#/components/schemas/A" } } }, A: { type: "string" } } },
        },
        options(),
      ),
    );
    expect(rejected.skipped.map(({ code }) => code)).toEqual(["unsupported-parameter-schema"]);
    expect(emitted).toBe(0);
  });

  it("reports a validator's stack overflow as schema-too-large, the same for every tool with the same schemas", () => {
    const original = Ajv.prototype.compile;
    const overflowed = new Set<string>();
    // The first compile of each marked shape overflows, as on a cold engine; later ones would pass.
    const compile = vi.spyOn(Ajv.prototype, "compile").mockImplementation(function (this: Ajv, schema: unknown, meta?: boolean) {
      const text = JSON.stringify(schema);
      const marker = text.includes('"Deep"') ? "Deep" : text.includes('"marker"') ? "marker" : undefined;
      const shape = `${marker}:${text.includes('"value"') ? "checked" : "tool"}`;
      if (marker !== undefined && !overflowed.has(shape)) {
        overflowed.add(shape);
        throw new RangeError("Maximum call stack size exceeded");
      }
      return original.call(this, schema as never, meta);
    } as typeof original);
    try {
      const deep = json({ $ref: "#/components/schemas/Deep" });
      const inline = json({ type: "object", properties: { marker: { type: "string" } } });
      const paths: Record<string, unknown> = { "/plain": { get: { operationId: "plain", responses: json({ type: "object" }) } } };
      for (let index = 0; index < 3; index += 1) {
        paths[`/d${index}`] = { get: { operationId: `g${index}`, responses: deep }, head: { operationId: `h${index}`, responses: deep } };
        paths[`/i${index}`] = { get: { operationId: `i${index}`, responses: inline } };
      }
      // Other schemas, with or without Deep, still reach the registry.
      paths["/after"] = { get: { operationId: "after", responses: json({ type: "object", properties: { x: { type: "string" } } }) } };
      paths["/sibling"] = { get: { operationId: "sibling", responses: json({ type: "object", properties: { d: { $ref: "#/components/schemas/Deep" } } }) } };
      const result = fromOpenAPI(
        { openapi: "3.0.3", paths, components: { schemas: { Deep: { type: "object", properties: { n: { type: "integer" } } } } } },
        options(),
      );
      expect(overflowed).toEqual(new Set(["Deep:checked", "Deep:tool", "marker:tool"]));
      expect(registered(result)).toEqual([["plain", true], ["after", true], ["sibling", true]]);
      expect(skips(result).sort()).toEqual(
        ["g0", "g1", "g2", "h0", "h1", "h2", "i0", "i1", "i2"].map((name) => [name, "schema-too-large", "a schema or reference chain nests too deeply"]),
      );
    } finally {
      compile.mockRestore();
    }
  });

  it("compiles a hub many definitions reach and a ring of references, with no bound of its own on either", () => {
    // A hub whose 150 children each refer back to it nests two deep; a ring of 100 nests 100 deep.
    const schemas: Record<string, unknown> = { Hub: { type: "object", properties: {} as Record<string, unknown> } };
    for (let index = 0; index < 150; index += 1) {
      (schemas.Hub as { properties: Record<string, unknown> }).properties[`c${index}`] = { $ref: `#/components/schemas/C${index}` };
      schemas[`C${index}`] = { type: "object", properties: { n: { type: "integer" }, parent: { $ref: "#/components/schemas/Hub" } } };
      if (index < 99) schemas[`R${index}`] = { type: "object", properties: { next: { $ref: `#/components/schemas/R${index + 1}` } } };
    }
    schemas.R99 = { type: "object", properties: { next: { $ref: "#/components/schemas/R0" } } };
    const hub = { $ref: "#/components/schemas/Hub" };
    const result = fromOpenAPI(
      {
        openapi: "3.0.3",
        paths: {
          "/hub": {
            get: { operationId: "hub", responses: json(hub) },
            head: { operationId: "hubHead", responses: json(hub) },
            post: { operationId: "hubBody", requestBody: { required: true, content: { "application/json": { schema: hub }, "application/merge-patch+json": { schema: { type: "object" } } } }, responses: ok },
          },
          "/ring": { get: { operationId: "ring", responses: json({ $ref: "#/components/schemas/R0" }) } },
        },
        components: { schemas },
      },
      options(),
    );
    expect(result.skipped).toEqual([]);
    expect(registered(result)).toEqual([["hub", true], ["hubHead", false], ["hubBody", false], ["ring", true]]);
    expectArguments(tool(result.tools, "ring").outputSchema!, { valid: [{ next: { next: {} } }], invalid: [{ next: { next: 1 } }] });
    expect(tool(result.tools, "hubBody").operation.requestBody?.contentType).toBe("application/json");
    expectArguments(tool(result.tools, "hub").outputSchema!, { valid: [{ c0: { n: 1, parent: { c1: { n: 2 } } } }], invalid: [{ c0: { n: "x" } }] });
    expectArguments(tool(result.tools, "hubBody").inputSchema, { valid: [{ body: { c3: { n: 1 } } }], invalid: [{ body: { c3: { parent: { c4: { n: "x" } } } } }] });
  });

  it("takes reference edges only from what conversion made, so a malformed keyword kept as written skips only its operation", () => {
    const bad = { type: "object", properties: [{ $ref: "#/definitions/Ghost" }] };
    const result = fromOpenAPI(
      {
        openapi: "3.0.3",
        paths: {
          "/bad": {
            get: { operationId: "bad", responses: json({ $ref: "#/components/schemas/Bad" }) },
            head: { operationId: "badHead", responses: json({ $ref: "#/components/schemas/Bad" }) },
            post: {
              operationId: "badBody",
              requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Bad" } }, "application/merge-patch+json": { schema: { type: "object" } } } },
              responses: ok,
            },
          },
          "/good": { get: { operationId: "good", responses: json({ type: "object" }) } },
        },
        components: { schemas: { Bad: bad } },
      },
      options(),
    );
    expect(registered(result)).toEqual([["badBody", false], ["good", true]]);
    expect(tool(result.tools, "badBody").operation.requestBody?.contentType).toBe("application/merge-patch+json");
    expect(skips(result).map(([name, code]) => [name, code]).sort()).toEqual([["bad", "invalid-schema"], ["badHead", "invalid-schema"]]);
  });

  it("never takes an edge, in place or applied, from a malformed dependency map or a branch validators ignore", () => {
    const ghost = { $ref: "#/definitions/Ghost" };
    for (const openapi of ["3.0.3", "3.1.0"]) {
      const result = fromOpenAPI(
        {
          openapi,
          paths: {
            "/required": { get: { operationId: "required", responses: json({ $ref: "#/components/schemas/Required" }) } },
            "/dependencies": { get: { operationId: "dependencies", responses: json({ $ref: "#/components/schemas/Dependencies" }) } },
            "/good": { get: { operationId: "good", responses: json({ type: "object" }) } },
          },
          components: {
            schemas: {
              Required: { type: "object", dependentRequired: { trigger: ghost } },
              Dependencies: { type: "object", dependencies: { trigger: [ghost] } },
            },
          },
        },
        options(),
      );
      expect(result.tools.map(({ name }) => name)).toContain("good");
      expect(result.skipped.map(({ code }) => code).every((code) => code === "invalid-schema")).toBe(true);
    }
    // A 151-definition chain behind `then` without `if` is never applied, so it nests nothing.
    const schemas: Record<string, unknown> = { P150: { type: "object" } };
    for (let index = 0; index < 150; index += 1) schemas[`P${index}`] = { type: "object", properties: { next: { $ref: `#/components/schemas/P${index + 1}` } } };
    schemas.Root = { type: "object", properties: { n: { type: "integer" } }, then: { $ref: "#/components/schemas/P0" } };
    const root = { $ref: "#/components/schemas/Root" };
    const ignored = fromOpenAPI(
      {
        openapi: "3.0.3",
        paths: {
          "/r": {
            get: { operationId: "g", responses: json(root) },
            head: { operationId: "h", responses: json(root) },
            post: { operationId: "p", requestBody: { required: true, content: { "application/json": { schema: root }, "application/merge-patch+json": { schema: { type: "object" } } } }, responses: ok },
          },
        },
        components: { schemas },
      },
      options(),
    );
    expect(registered(ignored)).toEqual([["g", true], ["h", false], ["p", false]]);
    expect(tool(ignored.tools, "p").operation.requestBody?.contentType).toBe("application/json");
    expectArguments(tool(ignored.tools, "g").outputSchema!, { valid: [{ n: 1 }], invalid: [{ n: "bad" }] });
  });

  it("charges a closure by its distinct values, so a default sharing objects is refused by its own limit, not the call's", () => {
    let shared: unknown = { leaf: true };
    for (let level = 0; level < 22; level += 1) shared = { left: shared, right: shared };
    const result = fromOpenAPI(
      {
        openapi: "3.0.3",
        paths: {
          "/shared": { get: { operationId: "shared", responses: json({ $ref: "#/components/schemas/Shared" }) } },
          "/small": { get: { operationId: "small", responses: json({ type: "object", properties: { a: { type: "string" } } }) } },
        },
        components: { schemas: { Shared: { type: "object", default: shared } } },
      },
      options(),
    );
    expect(registered(result)).toEqual([["small", true]]);
    expect(skips(result).map(([name, code]) => [name, code])).toEqual([["shared", "schema-too-large"]]);
  });

  it("registers a 151-definition chain whatever order its keywords are written in, and a chain behind a lone if", () => {
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    const schemas: Record<string, unknown> = { P150: { type: "object" }, I150: { type: "object" } };
    for (let index = 0; index < 150; index += 1) {
      schemas[`P${index}`] = { type: "object", properties: { next: ref(`P${index + 1}`) } };
      // `if` without then/else asserts nothing, so validators that read it still accept every value it admits.
      schemas[`I${index}`] = { type: "object", if: ref(`I${index + 1}`) };
    }
    const members = Array.from({ length: 151 }, (_, index) => ref(`P${150 - index}`));
    const propertiesFirst = { type: "object", properties: { head: ref("P0") }, allOf: members };
    const allOfFirst = { allOf: members, type: "object", properties: { head: ref("P0") } };
    for (const openapi of ["3.0.3", "3.1.0"]) {
      const result = fromOpenAPI(
        {
          openapi,
          paths: {
            "/a": { get: { operationId: "propertiesFirst", responses: json(propertiesFirst) } },
            "/b": { get: { operationId: "allOfFirst", responses: json(allOfFirst) } },
            "/i": { get: { operationId: "loneIf", responses: json(ref("I0")) } },
          },
          components: { schemas },
        },
        options(),
      );
      expect(result.skipped).toEqual([]);
      expect(registered(result)).toEqual([["propertiesFirst", true], ["allOfFirst", true], ["loneIf", true]]);
      for (const name of ["propertiesFirst", "allOfFirst"]) {
        expectArguments(tool(result.tools, name).outputSchema!, { valid: [{ head: { next: {} } }], invalid: [{ head: 1 }, { head: { next: 1 } }] });
      }
      expectArguments(tool(result.tools, "loneIf").outputSchema!, { valid: [{}], invalid: [] });
    }
  }, 60_000);

  it("charges a rejected candidate only for what it copied, so valid siblings still fit the document's total", () => {
    let shared: unknown = { leaf: true };
    for (let level = 0; level < 24; level += 1) shared = { a: shared, b: shared };
    const big = { type: "object", properties: Object.fromEntries(Array.from({ length: 30_000 }, (_, index) => [`f${index}`, { type: "string" }])) };
    const paths: Record<string, unknown> = {};
    // Each root's own copy fails on its default before it reaches Big's 30,000-property closure.
    for (let index = 0; index < 120; index += 1) {
      paths[`/bad${index}`] = { get: { operationId: `bad${index}`, responses: json({ type: "object", default: shared, allOf: [{ $ref: "#/components/schemas/Big" }] }) } };
    }
    paths["/ok"] = { get: { operationId: "ok", responses: json({ $ref: "#/components/schemas/Small" }) } };
    const result = fromOpenAPI(
      { openapi: "3.1.0", paths, components: { schemas: { Big: big, Small: { type: "object", properties: { a: { type: "string" } } } } } },
      options(),
    );
    expect(registered(result)).toEqual([["ok", true]]);
    expect(result.skipped).toHaveLength(120);
    for (const entry of result.skipped) expect(entry.reason).toMatch(/^a schema repeats shared objects into \d+ nodes from \d+ source values$/);
    expectArguments(tool(result.tools, "ok").outputSchema!, { valid: [{ a: "x" }], invalid: [{ a: 1 }] });
  }, 60_000);

  it("reserves no catalog copies for a shared schema the validator rejects, so a valid later tool fits in either order", () => {
    const literal = () => Array.from({ length: 3000 }, (_, index) => ({ k: index }));
    const bad = { type: "object", properties: { s: { type: "string", minLength: -1 }, d: { type: "array", default: literal() } } };
    const entries: Array<[string, unknown]> = [];
    for (let index = 0; index < 800; index += 1) entries.push([`/bad${index}`, { get: { operationId: `bad${index}`, responses: json({ $ref: "#/components/schemas/Bad" }) } }]);
    entries.push(["/ok", { get: { operationId: "ok", responses: json({ type: "object", properties: { a: { type: "string" }, d: { type: "array", default: literal() } } }) } }]);
    const run = (order: Array<[string, unknown]>) =>
      fromOpenAPI({ openapi: "3.1.0", paths: Object.fromEntries(order), components: { schemas: { Bad: bad } } }, options());
    const forward = run(entries);
    const reverse = run([...entries].reverse());
    for (const result of [forward, reverse]) {
      expect(registered(result)).toEqual([["ok", true]]);
      expect(result.skipped).toHaveLength(800);
      expect(new Set(result.skipped.map(({ code, reason }) => `${code}: ${reason}`))).toEqual(
        new Set([expect.stringMatching(/^invalid-schema: the output schema is not a valid JSON Schema: .*minLength/) as unknown as string]),
      );
    }
    const key = ({ operation, code, reason }: OpenApiSkippedOperation) => `${operation.operationId} ${code} ${reason}`;
    expect(reverse.skipped.map(key).sort()).toEqual(forward.skipped.map(key).sort());
    expectArguments(tool(forward.tools, "ok").outputSchema!, { valid: [{ a: "x" }], invalid: [{ a: 1 }] });
  }, 60_000);

  it("never measures a literal many components share once per component, and stops a closure repeating it while copying", () => {
    const literal = Array.from({ length: 5000 }, (_, index) => `v${index}`);
    const schemas: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) schemas[`L${index}`] = { type: "object", default: literal };
    const root = { allOf: Object.keys(schemas).map((name) => ({ $ref: `#/components/schemas/${name}` })) };
    const values = vi.spyOn(Object, "values");
    try {
      const result = fromOpenAPI({ openapi: "3.1.0", paths: { "/l": { get: { operationId: "l", responses: json(root) } } }, components: { schemas } }, options());
      expect(skips(result).map(([name, code]) => [name, code])).toEqual([["l", "schema-too-large"]]);
      // The literal (copied by the conversion, so matched by shape) is read by the copy alone, never measured again per component.
      expect(values.mock.calls.filter(([value]) => Array.isArray(value) && value.length === literal.length)).toHaveLength(0);
    } finally {
      values.mockRestore();
    }
  });

  it("charges a check copy that meets a cycle only for what it copied, so a valid sibling still fits", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (let index = 0; index < 20_000; index += 1) cyclic[`f${index}`] = index;
    const paths: Record<string, unknown> = {};
    // HEAD responses are compiled as written, through a charged copy that meets the cycle in its first field.
    for (let index = 0; index < 200; index += 1) paths[`/h${index}`] = { head: { operationId: `h${index}`, responses: json({ type: "object", description: `h${index}`, default: cyclic }) } };
    paths["/ok"] = { get: { operationId: "ok", responses: json({ type: "object", properties: { a: { type: "string" } } }) } };
    const result = fromOpenAPI({ openapi: "3.1.0", paths }, options());
    expect(registered(result)).toEqual([["ok", true]]);
    expect(new Set(result.skipped.map(({ code }) => code))).toEqual(new Set(["circular-object"]));
    expect(result.skipped).toHaveLength(200);
  }, 60_000);

  it("charges each catalog copy of a shared schema's definitions, and each walk of a closure's references", () => {
    const literal = Array.from({ length: 25_000 }, (_, index) => index);
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) paths[`/g${index}`] = { get: { operationId: `g${index}`, responses: json({ $ref: "#/components/schemas/Item" }) } };
    const shared = fromOpenAPI({ openapi: "3.1.0", paths, components: { schemas: { Item: { type: "object", default: literal } } } }, options());
    // One registry schema, but every catalog entry copies its 25,000 values: the document's total stops them.
    expect(shared.tools.length).toBeGreaterThan(0);
    expect(shared.tools.length).toBeLessThan(200);
    expect(new Set(shared.skipped.map(({ reason }) => reason.replace(/\d+/g, "N")))).toEqual(new Set(["the document's schemas expand in total to more than N nodes"]));
    // Distinct wrappers around one wide reference graph: each closure walk is charged for its edges.
    const schemas: Record<string, unknown> = { Leaf: { type: "object" } };
    schemas.Hub = { type: "object", properties: Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`p${index}`, { $ref: `#/components/schemas/L${index}` }])) };
    for (let index = 0; index < 2000; index += 1) schemas[`L${index}`] = { $ref: "#/components/schemas/Leaf" };
    const wrapped: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      schemas[`W${index}`] = { allOf: [{ $ref: "#/components/schemas/Hub" }] };
      wrapped[`/w${index}`] = { get: { operationId: `w${index}`, responses: json({ $ref: `#/components/schemas/W${index}` }) } };
    }
    const charged = vi.spyOn(NodeBudget.prototype, "chargeNodes");
    try {
      fromOpenAPI({ openapi: "3.1.0", paths: wrapped, components: { schemas } }, { ...options(), registry: { register: () => undefined, has: () => false } as unknown as McpFnRegistry });
      expect(charged.mock.calls.reduce((sum, [count]) => sum + count, 0)).toBeGreaterThanOrEqual(100 * 2 * 2000);
    } finally {
      charged.mockRestore();
    }
  }, 60_000);

  it("gives a shallow root the same result whether or not a deeper root sharing its chain came first", () => {
    // 5,000 links: past what validators compile however warm they are.
    const schemas: Record<string, unknown> = { C4999: { type: "object" } };
    for (let index = 0; index < 4999; index += 1) schemas[`C${index}`] = { allOf: [{ $ref: `#/components/schemas/C${index + 1}` }] };
    const deep = { get: { operationId: "deep", responses: json({ $ref: "#/components/schemas/C0" }) } };
    const shallow = { get: { operationId: "shallow", responses: json({ $ref: "#/components/schemas/C4990" }) } };
    const run = (first: string) =>
      fromOpenAPI({ openapi: "3.1.0", paths: first === "deep" ? { "/d": deep, "/s": shallow } : { "/s": shallow, "/d": deep }, components: { schemas } }, options());
    for (const first of ["deep", "shallow"]) {
      const result = run(first);
      expect(registered(result)).toEqual([["shallow", true]]);
      expect(skips(result)).toEqual([["deep", "schema-too-large", "a schema or reference chain nests too deeply"]]);
      expectArguments(tool(result.tools, "shallow").outputSchema!, { valid: [{}], invalid: [] });
    }
  });

  it("skips a sparse array by its own members, not its length, wherever a schema holds one", () => {
    const sparse = (member: unknown) => {
      const array: unknown[] = [];
      array[0] = member;
      array.length = 100_000_000;
      return array;
    };
    const schemas = [
      { allOf: sparse({ type: "object" }) },
      { anyOf: sparse({ type: "object" }) },
      { oneOf: sparse({ type: "object" }) },
      { type: "array", items: sparse({ type: "string" }) },
      { type: "object", enum: sparse({}) },
    ];
    for (const schema of schemas) {
      const started = performance.now();
      const result = fromOpenAPI(
        {
          openapi: "3.1.0",
          paths: {
            "/s": { get: { operationId: "sparseGet", responses: json(schema) }, head: { operationId: "sparseHead", responses: json(schema) } },
            "/p": { post: { operationId: "sparsePost", requestBody: { content: { "application/json": { schema } } }, responses: ok } },
            "/ok": { get: { operationId: "okGet", responses: json({ type: "object" }) } },
          },
        },
        options(),
      );
      expect(performance.now() - started).toBeLessThan(1000);
      expect(result.skipped.map(({ operation, code }) => [operation.operationId, code])).toEqual([
        ["sparseGet", "invalid-schema"],
        ["sparseHead", "invalid-schema"],
        ["sparsePost", "invalid-schema"],
      ]);
      expect(result.tools.map(({ name }) => name)).toEqual(["okGet"]);
    }
  });

  it("skips, without throwing, an operation whose schema array has an own key that shadows an array method", () => {
    const arrays: Record<string, () => unknown[]> = {
      enum: () => ["a", "b"],
      type: () => ["string", "null"],
      notType: () => ["string", "null"],
      allOf: () => [{ type: "object" }],
      anyOf: () => [{ type: "object" }],
      oneOf: () => [{ type: "object" }],
      required: () => ["a"],
    };
    const schemaWith = (where: string, array: unknown[]) => {
      if (where === "enum") return { type: "string", enum: array };
      if (where === "type") return { type: array };
      if (where === "notType") return { type: "object", not: { type: array } };
      if (where === "required") return { type: "object", properties: { a: { type: "string" } }, required: array };
      return { [where]: array };
    };
    for (const method of ["map", "flatMap", "some", "every", "filter", "reduce", "constructor"]) {
      for (const [where, build] of Object.entries(arrays)) {
        const schema = schemaWith(where, Object.assign(build(), { [method]: 1 }));
        const result = fromOpenAPI(
          {
            openapi: "3.1.0",
            paths: {
              "/r": { get: { operationId: "response", responses: json(schema) } },
              "/b": { post: { operationId: "body", requestBody: { content: { "application/json": { schema } } }, responses: ok } },
              "/q": { get: { operationId: "query", parameters: [{ name: "q", in: "query", schema }], responses: ok } },
              "/ok": { get: { operationId: "okGet", responses: json({ type: "object" }) } },
            },
          },
          options(),
        );
        expect(result.skipped.map(({ operation }) => operation.operationId), `${method} on ${where}`).toEqual(["response", "body", "query"]);
        expect(result.tools.map(({ name }) => name)).toEqual(["okGet"]);
      }
    }
  });

  it("skips an operation whose effective scope or server variable list shadows an array method, before naming it", () => {
    const named: string[] = [];
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/s": { get: { operationId: "s", security: [{ oauth: Object.assign(["read"], { some: 0 }) }], responses: ok } },
          "/v": { get: { operationId: "v", servers: [{ url: "https://{r}.example.test", variables: { r: { default: "eu", enum: Object.assign(["eu"], { map: 0 }) } } }], responses: ok } },
          "/ok": { get: { operationId: "ok", security: [{ oauth: ["read"] }], responses: ok } },
        },
      },
      {
        ...options(),
        name: (operation) => {
          named.push(operation.operationId!);
          for (const requirement of operation.security ?? []) for (const scopes of Object.values(requirement)) scopes.some(Boolean);
          return operation.operationId!;
        },
      },
    );
    expect(result.skipped.map(({ operation, code }) => [operation.operationId, code])).toEqual([
      ["s", "invalid-operation"],
      ["v", "invalid-operation"],
    ]);
    expect(named).toEqual(["ok"]);
    expect(tool(result.tools, "ok").operation.security).toEqual([{ oauth: ["read"] }]);
    // One map used as both a server variables map and a security requirement is checked in each role.
    const both = { oauth: Object.assign(["read"], { some: 0 }) };
    for (const [first, second] of [["/v", "/s"], ["/s", "/v"]] as const) {
      const operations = {
        "/v": { get: { operationId: "v", servers: [{ url: "https://example.test", variables: both }], responses: ok } },
        "/s": { get: { operationId: "s", security: [both], responses: ok } },
      };
      const aliased = fromOpenAPI({ openapi: "3.1.0", paths: { [first]: operations[first], [second]: operations[second] } }, options());
      expect(aliased.skipped.map(({ operation }) => operation.operationId)).toEqual(["s"]);
    }
  });

  it("fails only the operations that reach a component holding an irregular array", () => {
    const flagged = { type: "object", properties: { a: { type: "string", readOnly: true }, b: { type: "string" } } };
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/g": { get: { operationId: "g", responses: json(flagged) } },
          "/p": { post: { operationId: "p", requestBody: { content: { "application/json": { schema: flagged } } }, responses: ok } },
          "/u": { get: { operationId: "u", responses: json({ $ref: "#/components/schemas/Unused" }) } },
        },
        components: { schemas: { Unused: { allOf: Object.assign([{ type: "object" }], { map: null }) } } },
      },
      options(),
    );
    expect(result.skipped.map(({ operation, code }) => [operation.operationId, code])).toEqual([["u", "invalid-schema"]]);
    expectArguments(tool(result.tools, "p").inputSchema, { valid: [{ body: { b: "x" } }], invalid: [{ body: { a: "x" } }] });
    expect(tool(result.tools, "g").outputSchema).toBeDefined();
  });

  it("does not remember a budget skip inside a shared schema for operations where it fits", () => {
    const small = { type: "object", properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`s${index}`, { type: "string" }])) };
    let shared: unknown = { leaf: true };
    for (let level = 0; level < 22; level += 1) shared = { left: shared, right: shared };
    const big = { type: "object", default: shared };
    const post = (operationId: string, schema: unknown) => ({ post: { operationId, requestBody: { content: { "application/json": { schema } } }, responses: ok } });
    const result = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/full": post("full", { allOf: [big, small] }), "/fits": post("fits", { allOf: [small] }) } },
      options(),
    );
    expect(result.skipped.map(({ operation, code }) => [operation.operationId, code])).toEqual([["full", "schema-too-large"]]);
    expectArguments(tool(result.tools, "fits").inputSchema, { valid: [{ body: { s0: "x" } }], invalid: [{ body: { s0: 1 } }] });
  });

  it("tries each request body entry in the whole input, checks a shared one once and falls through a too-deep one", () => {
    const fallback = { "application/example+json": { schema: { type: "string" } } };
    const patch = (operationId: string, content: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ({ patch: { operationId, requestBody: { content }, responses: ok, ...extra } });
    const contentTypes = (result: Result) => result.tools.map((entry) => [entry.name, entry.operation.requestBody?.contentType]);
    // A preferred body many operations share is checked once, not charged to the document budget per operation
    // (250 operations of 1,200 entries fit with each one's own conversion and copies, not with a check each too).
    const shared = { type: "object", $defs: Object.fromEntries(Array.from({ length: 1200 }, (_, index) => [`d${index}`, {}])) };
    const paths = Object.fromEntries(
      Array.from({ length: 250 }, (_, index) => [`/s${index}`, patch(`s${index}`, { "application/json": { schema: shared }, ...fallback })]),
    );
    const many = fromOpenAPI({ openapi: "3.1.0", paths }, options());
    expect(many.skipped).toEqual([]);
    expect(new Set(contentTypes(many).map(([, type]) => type))).toEqual(new Set(["application/json"]));
    // A preferred body that nests too deeply to compile gives way to the next entry.
    const aliases: Record<string, unknown> = { Leaf: { type: "object" } };
    for (let index = 0; index < 20_000; index += 1) {
      aliases[`Alias${index}`] = { $ref: `#/components/schemas/${index === 0 ? "Leaf" : `Alias${index - 1}`}` };
    }
    aliases.Holder = { type: "object", properties: { deep: { $ref: "#/components/schemas/Alias19999" } } };
    const large = { type: "object", $defs: Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`d${index}`, {}])) };
    const parameters = [{ name: "q", in: "query", schema: { type: "string", enum: Array.from({ length: 5000 }, (_, index) => `v${index}`) } }];
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        components: { schemas: aliases },
        paths: {
          "/combined": patch("combined", { "application/json": { schema: large }, ...fallback }, { parameters }),
          "/deep": patch("deep", { "application/json": { schema: { $ref: "#/components/schemas/Holder" } }, ...fallback }),
          "/deepOnly": patch("deepOnly", { "application/json": { schema: { $ref: "#/components/schemas/Holder" } }, "application/x+json": { schema: 7 } }),
        },
      },
      options(),
    );
    // The large preferred entry beside the parameters is kept: no schema has a size limit of its own.
    expect(contentTypes(result)).toEqual([["combined", "application/json"], ["deep", "application/example+json"]]);
    expectArguments(tool(result.tools, "combined").inputSchema, { valid: [{ query: { q: "v1" }, body: {} }], invalid: [{ body: "x" }, { query: { q: "w" } }] });
    expect(result.skipped.map(({ code, reason }) => [code, reason])).toEqual([["schema-too-large", "a schema or reference chain nests too deeply"]]);
  }, 60_000);

  it("decides alternatives per kind of value, so overlapping arrays leave the sole object member unconditional", () => {
    for (const flag of ["readOnly", "writeOnly"] as const) {
      const Leaf = { type: "object", properties: { id: { type: "string", [flag]: true }, v: { type: "string" } } };
      const object = { type: "object", properties: { child: { $ref: "#/components/schemas/Leaf" } } };
      const arrays = [{ type: "array", maxItems: 0 }, { type: "array", minItems: 1 }];
      for (const members of [[...arrays, object], [object, ...arrays], [arrays[0], object, arrays[1]]]) {
        const schema = { oneOf: members };
        const path = flag === "readOnly"
          ? { post: { operationId: "op", requestBody: { required: true, content: { "application/json": { schema } } }, responses: ok } }
          : { get: { operationId: "op", responses: json({ type: "object", properties: { data: schema } }) } };
        const result = fromOpenAPI({ openapi: "3.1.0", components: { schemas: { Leaf } }, paths: { "/x": path } }, options());
        expect(result.skipped).toEqual([]);
        const converted = tool(result.tools, "op");
        const wrap = (value: unknown) => (flag === "readOnly" ? { body: value } : { data: value });
        expectArguments((flag === "readOnly" ? converted.inputSchema : converted.outputSchema)!, {
          // Each array member keeps its own meaning.
          valid: [wrap({ child: { v: "x" } }), wrap([]), wrap(["x"])],
          invalid: [wrap({ child: { id: "x" } }), wrap("x")],
        });
      }
      // Two members that both accept an object still overlap.
      const overlapping = { oneOf: [{ type: "object", properties: { child: { $ref: "#/components/schemas/Leaf" } } }, { type: "object", required: ["k"] }, ...arrays] };
      const path = flag === "readOnly"
        ? { post: { operationId: "op", requestBody: { required: true, content: { "application/json": { schema: overlapping } } }, responses: ok } }
        : { get: { operationId: "op", responses: json({ type: "object", properties: { data: overlapping } }) } };
      const skipped = fromOpenAPI({ openapi: "3.1.0", components: { schemas: { Leaf } }, paths: { "/x": path } }, options());
      expect(skips(skipped)).toEqual([["op", "unsupported-access-flag", child('property "child"', OVERLAP, flag)]]);
    }
  });

  it("searches suffixes once per emitted stem, past taken and rejected names, in document order", () => {
    /** A supplied registry that already holds every tool name with a suffix below `occupiedBelow`. */
    class Supplied extends McpFnRegistry {
      probes = 0;
      occupiedBelow = 0;
      reject = new Set<string>();
      override has(name: string): boolean {
        this.probes += 1;
        const suffix = /_(\d+)$/.exec(name);
        return (suffix !== null && Number(suffix[1]) < this.occupiedBelow) || super.has(name);
      }
      override register(...args: Parameters<McpFnRegistry["register"]>): ReturnType<McpFnRegistry["register"]> {
        if (this.reject.delete(args[0].name)) throw new McpFnValidationError(`rejected ${args[0].name}`);
        return super.register(...args);
      }
    }
    // Distinct 128-character bases that truncate to shared stems, each used twice.
    const stem = "s".repeat(124);
    const document = (pairs: number) => {
      const paths: Record<string, unknown> = {};
      for (let index = 0; index < pairs; index += 1) {
        const operationId = stem + String(index).padStart(4, "0");
        paths[`/a${index}`] = { get: { operationId, responses: ok } };
        paths[`/b${index}`] = { get: { operationId, responses: ok } };
      }
      return { openapi: "3.1.0", paths };
    };
    const convertWith = (registry: Supplied, pairs: number) => {
      const result = fromOpenAPI(document(pairs), { executor: recordingExecutor(), registry });
      for (const { name, operation } of result.tools) {
        const suffix = name === operation.operationId ? "" : /_\d+$/.exec(name)![0];
        expect(name).toBe(operation.operationId!.slice(0, 128 - suffix.length) + suffix);
      }
      expect(new Set(result.tools.map(({ name }) => name)).size).toBe(result.tools.length);
      return result;
    };
    // /b1, the first operation to get "<stem>00_3", is rejected: /b2, next in document order, reuses that name.
    const rejecting = new Supplied();
    rejecting.reject.add(`${stem}00_3`);
    const { tools, skipped } = convertWith(rejecting, 3);
    expect(skipped.map(({ operation }) => operation.path)).toEqual(["/b1"]);
    expect(tools.map(({ name }) => name)).toEqual([`${stem}0000`, `${stem}00_2`, `${stem}0001`, `${stem}0002`, `${stem}00_3`]);
    // Names taken before the call are passed once per stem, not once per operation.
    const occupied = new Supplied();
    occupied.occupiedBelow = 300;
    expect(convertWith(occupied, 200).tools.at(1)!.name).toBe(`${stem}_300`);
    expect(occupied.probes).toBeLessThan(8 * 2 * 200);
  });
});

describe("fromOpenAPI tool schema copies within the document total", () => {
  const json = (schema: unknown) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });
  const get = (operationId: string, schema: unknown) => ({ get: { operationId, responses: json(schema) } });

  it("charges an inlined output root while it is copied, a copy that then fails included", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const properties = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`p${index}`, { type: "string" }]));
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) paths[`/big${index}`] = get(`big${index}`, { $ref: "#/components/schemas/Big" });
    const document = { openapi: "3.1.0", paths, components: { schemas: { Big: { type: "object", properties, default: cyclic } } } };
    // Tools sharing schemas: the copy that failed is remembered by content, so it is made once.
    const shared = fromOpenAPI(document, { executor: recordingExecutor() });
    expect(new Set(shared.skipped.map(({ code }) => code))).toEqual(new Set(["circular-object"]));
    // A copy per tool: each failed copy is charged for what it copied, so the document total bounds them.
    const fresh = fromOpenAPI(document, { executor: recordingExecutor(), registry: new McpFnRegistry() });
    expect(fresh.skipped[0]?.code).toBe("circular-object");
    expect(fresh.skipped.map(({ code }) => code)).toContain("schema-too-large");
  }, 30_000);

  it("charges every tool's copies of a large literal its root holds, earlier operations first", () => {
    const schema = { type: "object", default: Array.from({ length: 60_000 }, (_, index) => index) };
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) paths[`/l${index}`] = get(`l${index}`, schema);
    const result = fromOpenAPI({ openapi: "3.1.0", paths }, { executor: recordingExecutor() });
    const names = result.tools.map(({ name }) => name);
    expect(names.length).toBeGreaterThan(10);
    expect(names.length).toBeLessThan(200);
    // The tools that fit are the first ones in document order.
    expect(names).toEqual(names.map((_, index) => `l${index}`));
    expect(new Set(result.skipped.map(({ code }) => code))).toEqual(new Set(["schema-too-large"]));
  });

  it("charges no catalog copies for reuses of a schema the registry refuses, so a later sibling still fits", () => {
    // Two-letter names keep the chain within the sharing key, so the operations share one schema.
    const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const name = (index: number) => `${letters[Math.floor(index / letters.length)]}${letters[index % letters.length]}`;
    const schemas: Record<string, unknown> = { [name(900)]: { type: "object", default: Array.from({ length: 60_000 }, (_, index) => index) } };
    for (let index = 0; index < 900; index += 1) schemas[name(index)] = { allOf: [{ $ref: `#/components/schemas/${name(index + 1)}` }] };
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 150; index += 1) paths[`/d${index}`] = get(`d${index}`, { $ref: `#/components/schemas/${name(0)}` });
    paths["/ok"] = get("ok", { type: "object", properties: { n: { type: "integer" } } });
    const result = fromOpenAPI({ openapi: "3.1.0", paths, components: { schemas } }, { executor: recordingExecutor() });
    expect(result.tools.map(({ name }) => name)).toEqual(["ok"]);
    expect(new Set(skips(result).map(([, code, reason]) => `${code}: ${reason}`))).toEqual(
      new Set(["schema-too-large: a schema or reference chain nests too deeply"]),
    );
  }, 60_000);
});
