import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildOperationCatalog, canonicalDigest, canonicalJson, createReleaseDescriptor, sha256Hex } from "@apifn/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { GENERATOR_VERSION, SDK_ARTIFACT_MANIFEST_FILE, TYPESCRIPT_TARGET_VERSION, writeSdk } from "../src/index.js";
import { RUNTIME_SOURCE } from "../src/targets/typescript/runtime-source.js";
import { cleanupTemp, clone, compile, fixtureCatalog, fixtureConfig, FIXTURES, generate, PACKAGE_DIR, readJson, tempDir } from "./helpers.js";

afterAll(cleanupTemp);

const codes = (diagnostics: Array<{ code: string; severity: string }>, severity = "error") =>
  diagnostics.filter((diagnostic) => diagnostic.severity === severity).map((diagnostic) => diagnostic.code);

/** Reverses key order at every depth: canonical inputs must not depend on it. */
function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)]));
}

describe("fixtures", () => {
  it("keep the committed catalog equal to the one built from openapi.json and manifest.json", () => {
    const built = buildOperationCatalog(readFileSync(path.join(FIXTURES, "catalog/openapi.json"), "utf8"), readJson("catalog/manifest.json"));
    expect(built.diagnostics).toEqual([]);
    const pretty = `${JSON.stringify(JSON.parse(canonicalJson(built.catalog)), null, 2)}\n`;
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(path.join(FIXTURES, "catalog/catalog.json"), pretty);
    expect(readFileSync(path.join(FIXTURES, "catalog/catalog.json"), "utf8")).toBe(pretty);
  });

  it("embed the current runtime template and the package version", () => {
    expect(RUNTIME_SOURCE).toBe(readFileSync(path.join(PACKAGE_DIR, "templates/typescript/runtime.ts"), "utf8"));
    expect(GENERATOR_VERSION).toBe(readJson(path.join(PACKAGE_DIR, "package.json")).version);
  });
});

describe("generateSdk", () => {
  it("is byte-identical for the same inputs, whatever their key order", () => {
    const first = generate();
    const second = generate(reorder(fixtureCatalog()), reorder(fixtureConfig()));
    expect(first.ok).toBe(true);
    expect(second.files).toEqual(first.files);
  });

  it("records catalog, generator, target and config provenance in the manifest", () => {
    const catalog = fixtureCatalog();
    const result = generate();
    const manifest = result.manifest!;
    const built = buildOperationCatalog(readFileSync(path.join(FIXTURES, "catalog/openapi.json"), "utf8"), readJson("catalog/manifest.json"));
    expect(manifest.catalog).toEqual({ digest: built.digest, specDigest: catalog.source.specDigest, manifestDigest: catalog.source.manifestDigest });
    expect(manifest.generator).toEqual({ name: "@apifn/sdk", version: GENERATOR_VERSION });
    expect(manifest.target).toEqual({ id: "typescript", version: TYPESCRIPT_TARGET_VERSION });
    expect(manifest.package).toEqual({ name: "@example/tasks-sdk", version: "1.0.0" });
    expect(manifest.config.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const release = createReleaseDescriptor({ catalog, generator: manifest.generator, artifacts: [{ kind: "sdk", target: "typescript", package: manifest.package }] });
    expect(manifest.releaseId).toBe(release.descriptor!.releaseId);
    const written = JSON.parse(result.files.find((file) => file.path === SDK_ARTIFACT_MANIFEST_FILE)!.contents);
    expect(written).toEqual(manifest);
    for (const entry of manifest.files) expect(entry.sha256).toBe(sha256Hex(result.files.find((file) => file.path === entry.path)!.contents));
    expect(manifest.customCode).toEqual({ root: "src/custom/", seeds: ["src/custom/index.ts"] });
    expect(manifest.files.map((entry) => entry.path)).not.toContain("src/custom/index.ts");
  });

  it("changes the config digest, and only it, when an option changes", () => {
    const config = fixtureConfig();
    config.options.timeoutMs = 3000;
    const base = generate().manifest!;
    const changed = generate(fixtureCatalog(), config).manifest!;
    expect(changed.config.digest).not.toBe(base.config.digest);
    expect(changed.catalog).toEqual(base.catalog);
  });

  it("lists every catalog operation it does not generate, with the reason", () => {
    const manifest = generate().manifest!;
    expect(manifest.complete).toBe(false);
    expect(manifest.operations.excluded.map(({ id, reason }) => [id, reason])).toEqual([
      ["legacy.tasks.list", "target-excluded"],
      ["reports.upload", "unsupported"],
      ["session.get", "unsupported"],
      ["system.ping", "sdk-include-false"],
    ]);
    const listed = [...manifest.operations.included.map((entry) => entry.id), ...manifest.operations.excluded.map((entry) => entry.id)].sort();
    expect(listed).toEqual(fixtureCatalog().operations.map((operation: any) => operation.id).sort());
    expect(manifest.operations.excluded.find((entry) => entry.id === "reports.upload")!.details[0]).toMatch(/multipart\/form-data/);
    expect(manifest.operations.excluded.find((entry) => entry.id === "session.get")!.details[0]).toMatch(/cookieAuth/);
  });

  it("fails on unsupported operations by default, writing nothing", () => {
    const config = fixtureConfig();
    delete config.unsupported;
    const result = generate(fixtureCatalog(), config);
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => [diagnostic.code, diagnostic.operation])).toEqual([
      ["SDK_UNSUPPORTED_OPERATION", "reports.upload"],
      ["SDK_UNSUPPORTED_OPERATION", "session.get"],
    ]);
  });

  it("produces a complete manifest when every included operation is supported", () => {
    const catalog = fixtureCatalog();
    for (const operation of catalog.operations) if (operation.id === "reports.upload" || operation.id === "session.get") operation.sdk.include = false;
    const config = fixtureConfig();
    delete config.unsupported;
    const result = generate(catalog, config);
    expect(result.ok).toBe(true);
    expect(result.manifest!.complete).toBe(true);
  });

  it("expects no body from a HEAD operation whatever its documented content", () => {
    const catalog = fixtureCatalog();
    const head = { ...clone(catalog.operations.find((operation: any) => operation.id === "tasks.get")), id: "tasks.head", name: "headTask", method: "head" };
    catalog.operations.push(head);
    const client = generate(catalog).files.find((file) => file.path === "src/client.ts")!.contents;
    expect(client).toMatch(/"tasks\.head": \{[^}]*?method: "HEAD",[\s\S]*?success: \["none"\],/);
    expect(client).toContain("export type HeadTaskResult = undefined;");
  });

  it("reports operations fetch cannot send: forbidden methods and bodies on GET or HEAD", () => {
    const catalog = fixtureCatalog();
    const create = catalog.operations.find((operation: any) => operation.id === "tasks.create");
    catalog.operations.push(
      { ...clone(catalog.operations.find((operation: any) => operation.id === "tasks.get")), id: "tasks.trace", name: "traceTask", method: "trace" },
      { ...clone(create), id: "tasks.query", name: "queryTasks", method: "get", parameters: [] },
      { ...clone(create), id: "tasks.probe", name: "probeTasks", method: "head", parameters: [], requestBody: { ...clone(create.requestBody), required: false } }
    );
    const excluded = generate(catalog).manifest!.operations.excluded.filter((entry) => ["tasks.trace", "tasks.query", "tasks.probe"].includes(entry.id));
    expect(excluded.map(({ id, reason, details }) => [id, reason, details])).toEqual([
      ["tasks.trace", "unsupported", ["fetch cannot send TRACE requests."]],
      ["tasks.query", "unsupported", ["fetch cannot send a request body with GET."]],
      ["tasks.probe", "unsupported", ["fetch cannot send a request body with HEAD."]],
    ]);
  });

  it("types documented non-2xx responses as errors and only 2xx responses as results", () => {
    const client = generate().files.find((file) => file.path === "src/client.ts")!.contents;
    expect(client).toContain("export type GetProjectSummaryResult = Models.ProjectSummary;");
    expect(client).toMatch(/export type GetProjectSummaryError =\n {2}\| ApiHttpError<302, Models\.Moved, true>\n {2}\| ApiHttpError<number, unknown, false>;/);
    expect(client).toMatch(/"projects\.summary\.get": \{[\s\S]*?success: \["json"\],\n {4}errors: \[\{ status: "302", kinds: \["json"\] \}\],/);
  });

  it("emits no write retry under catalog v1", () => {
    const client = generate().files.find((file) => file.path === "src/client.ts")!.contents;
    const retries = [...client.matchAll(/method: "(\w+)",[\s\S]*?retry: "(\w+)",/g)].map(([, method, retry]) => `${method}:${retry}`);
    expect(new Set(retries)).toEqual(new Set(["GET:read", "POST:never", "PUT:never", "DELETE:never"]));
  });

  it("warns that spec servers are ignored for an operation with its own servers", () => {
    const warning = generate().diagnostics.find((diagnostic) => diagnostic.code === "SDK_SERVERS_IGNORED");
    expect(warning).toMatchObject({ severity: "warning", operation: "system.health" });
  });
});

describe("name collisions", () => {
  function withSchema(name: string) {
    const catalog = fixtureCatalog();
    catalog.schemas[name] = { type: "object" };
    return catalog;
  }

  it("names a component schema that collides with a runtime export, and resolves through typeNames", () => {
    const result = generate(withSchema("ApiError"));
    expect(result.ok).toBe(false);
    const [diagnostic] = result.diagnostics.filter((entry) => entry.code === "SDK_NAME_COLLISION");
    expect(diagnostic.message).toMatch(/"ApiError".*runtime export ApiError.*component schema "ApiError"/);
    const config = fixtureConfig();
    config.options.typeNames = { ApiError: "ApiErrorModel" };
    expect(generate(withSchema("ApiError"), config).ok).toBe(true);
  });

  it("names component schemas whose type names coincide", () => {
    const result = generate(withSchema("task-page"));
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    expect(errors.map((diagnostic) => diagnostic.code)).toEqual(["SDK_NAME_COLLISION"]);
    expect(errors[0].message).toMatch(/component schema "TaskPage" and component schema "task-page"/);
  });

  it("names a schema that collides with an operation's generated types", () => {
    const result = generate(withSchema("GetTaskResult"));
    expect(result.diagnostics.find((entry) => entry.code === "SDK_NAME_COLLISION")).toMatchObject({ operation: "tasks.get" });
  });

  it("names parameters that map to one params key", () => {
    const catalog = fixtureCatalog();
    const list = catalog.operations.find((operation: any) => operation.id === "tasks.list");
    list.parameters.push({ ...clone(list.parameters.find((parameter: any) => parameter.name === "X-Request-Id")), name: "x_request_id", in: "query", style: "form", explode: true });
    const result = generate(catalog);
    expect(result.diagnostics.find((entry) => entry.code === "SDK_NAME_COLLISION")!.message).toMatch(
      /tasks\.list: query parameter "x_request_id" and header parameter "X-Request-Id" both become the params key "xRequestId"/
    );
  });

  it("names a client or operation type that would shadow a client.ts binding or global", () => {
    for (const clientName of ["ApiRuntime", "OperationSpec", "SdkMetadata", "Models", "METADATA", "OPERATIONS", "Promise", "Record", "Uint8Array", "ArrayBuffer", "Blob", "ReadableStream"]) {
      const config = fixtureConfig();
      config.options.clientName = clientName;
      const result = generate(fixtureCatalog(), config);
      expect(result.ok, clientName).toBe(false);
      expect(result.diagnostics.find((entry) => entry.code === "SDK_NAME_COLLISION"), clientName).toMatchObject({ pointer: "/options/clientName" });
    }
  });

  it("lets component schemas use client.ts binding and global names", async () => {
    const catalog = fixtureCatalog();
    for (const name of ["ApiRuntime", "Models", "Promise", "Record", "Uint8Array", "ReadableStream"]) catalog.schemas[name] = { type: "object", properties: { x: { type: "string" } } };
    catalog.operations.find((operation: any) => operation.id === "tasks.get").responses[0].contents[0].schema = { $ref: "#/components/schemas/Promise" };
    const result = generate(catalog);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const dir = tempDir();
    expect((await writeSdk(dir, result)).ok).toBe(true);
    expect(compile(dir)).toEqual([]);
  });

  it("names an operation that would shadow the client constructor", () => {
    const catalog = fixtureCatalog();
    catalog.operations.find((operation: any) => operation.id === "tasks.get").name = "constructor";
    expect(codes(generate(catalog).diagnostics)).toContain("SDK_NAME_COLLISION");
  });
});

describe("input validation", () => {
  const cases: Array<[string, () => [unknown, unknown], string, string?]> = [
    ["a non-object catalog", () => [null, fixtureConfig()], "SDK_INVALID_CATALOG"],
    ["another catalog version", () => [{ ...fixtureCatalog(), catalogVersion: "apifn.operation-catalog/v2" }, fixtureConfig()], "SDK_INVALID_CATALOG", "/catalogVersion"],
    ["a non-finite number", () => [{ ...fixtureCatalog(), extra: Infinity }, fixtureConfig()], "SDK_INVALID_CATALOG"],
    [
      "a repeated operation ID",
      () => {
        const catalog = fixtureCatalog();
        catalog.operations.push(clone(catalog.operations[0]));
        return [catalog, fixtureConfig()];
      },
      "SDK_INVALID_CATALOG",
    ],
    ["an unknown config field", () => [fixtureCatalog(), { ...fixtureConfig(), extra: 1 }], "SDK_INVALID_CONFIG", "/extra"],
    ["an unknown target", () => [fixtureCatalog(), { ...fixtureConfig(), target: "go" }], "SDK_INVALID_CONFIG", "/target"],
    ["an unknown unsupported policy", () => [fixtureCatalog(), { ...fixtureConfig(), unsupported: "skip" }], "SDK_INVALID_CONFIG", "/unsupported"],
    ["missing options", () => [fixtureCatalog(), { target: "typescript" }], "SDK_INVALID_CONFIG", "/options"],
    ["an unknown option", () => [fixtureCatalog(), { ...fixtureConfig(), options: { ...fixtureConfig().options, servers: [] } }], "SDK_INVALID_CONFIG", "/options/servers"],
  ];
  const option = (edit: (options: any) => void): (() => [unknown, unknown]) => () => {
    const config = fixtureConfig();
    edit(config.options);
    return [fixtureCatalog(), config];
  };
  cases.push(
    ["an invalid package name", option((options) => (options.package.name = "Bad Name")), "SDK_INVALID_CONFIG", "/options/package/name"],
    ["a non-SemVer package version", option((options) => (options.package.version = "1.0")), "SDK_INVALID_CONFIG", "/options/package/version"],
    ["a base URL with user info", option((options) => (options.baseUrl = "https://user:pw@api.example.test")), "SDK_INVALID_CONFIG", "/options/baseUrl"],
    ["a base URL with a query", option((options) => (options.baseUrl = "https://api.example.test/?region=eu")), "SDK_INVALID_CONFIG", "/options/baseUrl"],
    ["a retry budget over 10", option((options) => (options.retry.maxAttempts = 11)), "SDK_INVALID_CONFIG", "/options/retry/maxAttempts"],
    ["a config that declares writes idempotent", option((options) => (options.retry.idempotentOperations = ["tasks.replace"])), "SDK_INVALID_CONFIG", "/options/retry/idempotentOperations"],
    ["a type name for an unknown schema", option((options) => (options.typeNames = { Nope: "Nope" })), "SDK_INVALID_CONFIG", "/options/typeNames/Nope"],
    ["a client name that is not an identifier", option((options) => (options.clientName = "tasks-client")), "SDK_INVALID_CONFIG", "/options/clientName"]
  );
  for (const [name, input, code, pointer] of cases) {
    it(`rejects ${name}`, () => {
      const [catalog, config] = input();
      const result = generate(catalog, config);
      expect(result.ok).toBe(false);
      expect(result.files).toEqual([]);
      expect(result.diagnostics[0].code).toBe(code);
      if (pointer) expect(result.diagnostics.map((diagnostic) => diagnostic.pointer)).toContain(pointer);
    });
  }
});

describe("generated TypeScript", () => {
  it("compiles awkward schemas and names", async () => {
    const catalog = fixtureCatalog();
    Object.assign(catalog.schemas, {
      // Parsed, so "__proto__" is an own property name as in a catalog read from JSON.
      "a/b": JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"x-y":{"type":"integer"},"*/":{"description":"*/ closes comments"}}}'),
      "1st": { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false },
      Pair: { type: "array", prefixItems: [{ type: "string" }, { type: ["number", "null"] }], minItems: 1, items: false },
      Head: { type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } },
      "é": { anyOf: [{ $ref: "#/components/schemas/a~1b" }, { const: "x" }, true] },
      Closed: { type: "object", additionalProperties: false },
      Never: false,
      Tree: { type: "object", properties: { children: { type: "array", items: { $ref: "#/components/schemas/Tree" } } } },
    });
    const result = generate(catalog);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const dir = tempDir();
    expect((await writeSdk(dir, result)).ok).toBe(true);
    expect(compile(dir)).toEqual([]);
    const models = readFileSync(path.join(dir, "src/models.ts"), "utf8");
    expect(models).toContain('export type AB = {\n  /**\n   * *\\/ closes comments\n   */\n  "*/"?: unknown;\n  __proto__?: string;\n  "x-y"?: number;\n};');
    // Positions at or past minItems (default 0) may be missing.
    expect(models).toContain("export type Model1st = [string?, number?];");
    expect(models).toContain("export type Pair = [string, (number | null)?];");
    expect(models).toContain("export type Head = [string?, ...number[]];");
    expect(models).toContain("export type É = unknown;");
    expect(models).toContain("export type Closed = { [key: string]: never };");
    expect(models).toContain("export type Tree = {\n  children?: Tree[];\n};");
  });

  it("widens references that close a cycle TypeScript cannot alias, naming each, and keeps recursion through arrays", async () => {
    const catalog = fixtureCatalog();
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    Object.assign(catalog.schemas, {
      AliasA: ref("AliasB"),
      AliasB: ref("AliasA"),
      UnionA: { anyOf: [ref("UnionB"), { type: "string" }] },
      UnionB: { anyOf: [ref("UnionA"), { type: "number" }] },
      Self: { allOf: [ref("Self"), { type: "object", properties: { x: { type: "string" } } }] },
      ListA: { anyOf: [{ type: "array", items: ref("ListB") }, { type: "string" }] },
      ListB: ref("ListA"),
    });
    catalog.schemas.Task.properties.probe = ref("AliasA");
    const result = generate(catalog);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "SDK_SCHEMA_CYCLE").map(({ severity, pointer }) => [severity, pointer])).toEqual([
      ["warning", "/schemas/AliasB"],
      ["warning", "/schemas/Self"],
      ["warning", "/schemas/UnionB"],
    ]);
    const dir = tempDir();
    expect((await writeSdk(dir, result)).ok).toBe(true);
    expect(compile(dir)).toEqual([]);
    const models = readFileSync(path.join(dir, "src/models.ts"), "utf8");
    expect(models).toContain("export type AliasA = AliasB;");
    expect(models).toContain("export type AliasB = unknown;");
    expect(models).toContain("export type UnionA = UnionB | string;");
    expect(models).toContain("export type UnionB = unknown;");
    expect(models).toContain("export type Self = {\n  x?: string;\n};");
    expect(models).toContain("export type ListA = ListB[] | string;");
    expect(models).toContain("export type ListB = ListA;");
    expect(generate(reorder(catalog)).files).toEqual(result.files);
  });

  it("types params, results and declared errors for consumers", async () => {
    const dir = tempDir();
    expect((await writeSdk(dir, generate())).ok).toBe(true);
    writeFileSync(
      path.join(dir, "src/custom/consumer-types.ts"),
      `import { TasksClient, isOperationError, type ProjectSummary, type Task, type TasksClientOptions } from "../index.js";
const client = new TasksClient({ credentials: { bearerAuth: () => "t", basicAuth: { username: "u", password: "p" } } } satisfies TasksClientOptions);
export async function use(): Promise<string> {
  const task: Task = await client.getTask({ projectId: "p", taskId: "t" });
  const text: string = await client.exportTasks({ projectId: "p" });
  await client.listTasks({ projectId: "p", tags: ["a"], filter: { owner: "me" }, status: ["open"] });
  // @ts-expect-error status values come from the TaskStatus enum
  await client.listTasks({ projectId: "p", status: ["pending"] });
  // @ts-expect-error taskId is required
  await client.getTask({ projectId: "p" });
  // @ts-expect-error TaskInput allows no extra properties
  await client.createTask({ projectId: "p", body: { title: "x", extra: 1 } });
  try {
    await client.createTask({ projectId: "p", body: { title: "x" }, idempotencyKey: "k" });
  } catch (error) {
    if (isOperationError(error, "tasks.create") && error.declared && error.status === 422) {
      const fields: Record<string, string> | undefined = error.body.fields;
      return fields?.title ?? "";
    }
  }
  const summary: ProjectSummary = await client.getProjectSummary({ projectId: "p" });
  // @ts-expect-error the documented 302 body is an error, never a result
  const moved: { location: string } = await client.getProjectSummary({ projectId: "p" });
  try {
    await client.getProjectSummary({ projectId: "p" });
  } catch (error) {
    if (isOperationError(error, "projects.summary.get") && error.declared && error.status === 302) return error.body.location;
  }
  return task.title + text + summary.openTasks + moved.location;
}
`
    );
    expect(compile(dir)).toEqual([]);
  });
});
