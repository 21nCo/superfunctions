import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildOperationCatalog, canonicalJson, createReleaseDescriptor, sha256Hex, type CatalogParameter, type JsonValue } from "@apifn/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { GENERATOR_VERSION, SDK_ARTIFACT_MANIFEST_FILE, TYPESCRIPT_TARGET_VERSION, writeSdk } from "../src/index.js";
import { parameterSupport } from "../src/targets/typescript/operations.js";
import { RUNTIME_SOURCE } from "../src/targets/typescript/runtime-source.js";
import { aliasCycleCuts } from "../src/targets/typescript/schema.js";
import { cleanupTemp, clone, compile, fixtureCatalog, fixtureConfig, FIXTURES, generate, PACKAGE_DIR, readJson, tempDir } from "./helpers.js";

afterAll(cleanupTemp);

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

  // The constructor, Promise resolution (then), JSON serialization (toJSON) and Object.prototype members.
  for (const name of ["constructor", "then", "toJSON", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "toLocaleString"]) {
    it(`names an operation called ${name}, which JavaScript calls implicitly on the client`, () => {
      const catalog = fixtureCatalog();
      const index = catalog.operations.findIndex((operation: any) => operation.id === "system.health");
      catalog.operations[index].name = name;
      const collisions = generate(catalog).diagnostics.filter((diagnostic) => diagnostic.code === "SDK_NAME_COLLISION");
      expect(collisions).toEqual([expect.objectContaining({ severity: "error", operation: "system.health", pointer: `/operations/${index}/name` })]);
      expect(collisions[0].message).toContain(`"${name}"`);
    });
  }
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

  it("widens references inside tuples that TypeScript resolves eagerly in a cycle", async () => {
    const catalog = fixtureCatalog();
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    Object.assign(catalog.schemas, {
      // type TupleUnion = [TupleUnion[]?, ...number[]] | {...} is a circular type alias.
      TupleUnion: { anyOf: [{ type: "array", prefixItems: [{ type: "array", items: ref("TupleUnion") }], items: { type: "number" } }, { type: "object", properties: { a: { type: "string" } }, required: ["a"] }] },
      // type TupleAllOf = [string?, ...TupleAllOf[][]] & {...} is too.
      TupleAllOf: { allOf: [{ type: "array", prefixItems: [{ type: "string" }], items: { type: "array", items: ref("TupleAllOf") } }, { type: "object", properties: { k: { type: "number" } } }] },
      // Inside an object type the reference stays precise.
      TupleBoxed: { type: "array", prefixItems: [{ type: "object", properties: { next: ref("TupleBoxed") } }], items: false },
    });
    catalog.schemas.Task.properties.probe = { anyOf: [ref("TupleUnion"), ref("TupleAllOf"), ref("TupleBoxed")] };
    const result = generate(catalog);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "SDK_SCHEMA_CYCLE").map(({ pointer }) => pointer)).toEqual(["/schemas/TupleAllOf", "/schemas/TupleUnion"]);
    const dir = tempDir();
    expect((await writeSdk(dir, result)).ok).toBe(true);
    expect(compile(dir)).toEqual([]);
    const models = readFileSync(path.join(dir, "src/models.ts"), "utf8");
    expect(models).toContain("export type TupleUnion = ([unknown[]?, ...number[]]) | ({");
    expect(models).toContain("export type TupleAllOf = ([string?, ...unknown[][]]) & ({");
    expect(models).toContain("export type TupleBoxed = [({\n  next?: TupleBoxed;\n})?];");
  });

  it("compiles a seeded corpus of recursive component schema graphs", async () => {
    // A fixed linear congruential generator keeps the corpus identical on every run.
    let seed = 20261022;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(values: T[]): T => values[Math.floor(random() * values.length)];
    const shape = (names: string[], depth: number): unknown => {
      const ref = () => ({ $ref: `#/components/schemas/${pick(names)}` });
      const primitive = () => ({ type: pick(["string", "number", "boolean", "null"]) });
      const sub = () => (depth > 2 ? pick([ref, primitive])() : shape(names, depth + 1));
      return pick<() => unknown>([
        ref,
        ref,
        primitive,
        () => ({ anyOf: [sub(), sub()] }),
        () => ({ oneOf: [sub(), sub()] }),
        () => ({ allOf: [sub(), sub()] }),
        () => ({ allOf: [sub(), { type: "object", properties: { k: primitive() } }] }),
        () => ({ type: "array", items: sub() }),
        () => ({ type: ["array", "null"], items: sub() }),
        () => ({ type: "object", properties: { p: sub() }, required: ["p"] }),
        () => ({ type: "object", additionalProperties: sub() }),
        () => ({ type: "array", prefixItems: [sub()], items: sub() }),
        () => ({ type: "array", prefixItems: [sub(), sub()], minItems: 1, items: false }),
        () => ({ type: "array", items: { type: "array", prefixItems: [sub()], items: sub() } }),
        () => ({ ...ref(), description: "with siblings", properties: { z: sub() } }),
      ])();
    };
    let cycles = 0;
    for (let round = 0; round < 2; round++) {
      const catalog = fixtureCatalog();
      const members: Array<{ $ref: string }> = [];
      for (let graph = 0; graph < 64; graph++) {
        const names = ["A", "B", "C"].map((letter) => `Corpus${round}x${graph}${letter}`);
        for (const name of names) {
          catalog.schemas[name] = shape(names, 0);
          members.push({ $ref: `#/components/schemas/${name}` });
        }
      }
      catalog.schemas.Task.properties.probe = { anyOf: members };
      const result = generate(catalog);
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      cycles += result.diagnostics.filter((diagnostic) => diagnostic.code === "SDK_SCHEMA_CYCLE").length;
      const dir = tempDir();
      expect((await writeSdk(dir, result)).ok).toBe(true);
      expect(compile(dir)).toEqual([]);
    }
    // The corpus exercises the cycle repair rather than only acyclic graphs.
    expect(cycles).toBeGreaterThan(50);
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
  // A required parameter an API key credential supplies is optional input; others stay required.
  await client.findTasks({ projectId: "p" });
  // @ts-expect-error projectId is required
  await client.findTasks({ key: "k" });
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

describe("parameter support (shared vectors)", () => {
  const vectors: any[] = readJson("vectors/parameters.json").cases;

  /** The fixture catalog plus one GET operation `vectors.v<index>` (method `vector<index>`) per vector, with its parameter and schemas. */
  function vectorCatalog(cases: Array<{ vector: any; index: number }>): any {
    const catalog = fixtureCatalog();
    const template = catalog.operations.find((operation: any) => operation.id === "tasks.get");
    for (const { vector, index } of cases) {
      const parameter = { allowReserved: false, deprecated: false, description: null, ...vector.parameter };
      const route = parameter.in === "path" ? `/vectors/${index}/{${parameter.name}}` : `/vectors/${index}`;
      catalog.operations.push({ ...clone(template), id: `vectors.v${index}`, name: `vector${index}`, openapiOperationId: `vector${index}`, path: route, parameters: [parameter] });
      Object.assign(catalog.schemas, clone(vector.schemas ?? {}));
    }
    return catalog;
  }

  for (const [index, vector] of vectors.entries()) {
    it(vector.name, () => {
      const result = generate(vectorCatalog([{ vector, index }]));
      expect(result.ok).toBe(true);
      const { included, excluded } = result.manifest!.operations;
      const id = `vectors.v${index}`;
      if (!vector.expect.supported) {
        expect(included.map((entry) => entry.id)).not.toContain(id);
        const entry = excluded.find((candidate) => candidate.id === id)!;
        expect(entry.reason).toBe("unsupported");
        expect(entry.details.join("\n")).toContain(vector.expect.reason);
        return;
      }
      expect(included.map((entry) => entry.id)).toContain(id);
      const client = result.files.find((file) => file.path === "src/client.ts")!.contents;
      const field = client.match(new RegExp(`export interface Vector${index}Params \\{[\\s\\S]*?\\n\\}`))![0];
      expect(/\b(?:ParamValue|DeepObjectValue)</.test(field)).toBe(vector.expect.admitsUnserializable);
    });
  }

  it("fails generation by default on a parameter the client cannot serialize, naming it", () => {
    const index = vectors.findIndex((vector) => vector.name === "a required nested object member of a deepObject");
    const catalog = vectorCatalog([{ vector: vectors[index], index }]);
    for (const operation of catalog.operations) if (operation.id === "reports.upload" || operation.id === "session.get") operation.sdk.include = false;
    const config = fixtureConfig();
    delete config.unsupported;
    const result = generate(catalog, config);
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => [diagnostic.code, diagnostic.operation, diagnostic.message])).toEqual([
      ["SDK_UNSUPPORTED_OPERATION", `vectors.v${index}`, `vectors.v${index}: query parameter "filter": its member "owner" admits only nested objects or arrays, which the client cannot serialize.`],
    ]);
  });

  it("compiles narrowed parameter types that accept serializable values and reject nested ones", async () => {
    const supported = vectors.map((vector, index) => ({ vector, index })).filter(({ vector }) => vector.expect.supported);
    const at = (name: string) => supported.find(({ vector }) => vector.name === name)!.index;
    const dir = tempDir();
    const result = generate(vectorCatalog(supported));
    expect(result.ok).toBe(true);
    expect((await writeSdk(dir, result)).ok).toBe(true);
    writeFileSync(
      path.join(dir, "src/custom/consumer-params.ts"),
      `import { TasksClient } from "../index.js";
const client = new TasksClient();
export async function use(): Promise<void> {
  await client.vector${at("a free-form object")}({ match: { a: 1, b: "x", c: null } });
  // @ts-expect-error nested values cannot be serialized
  await client.vector${at("a free-form object")}({ match: { a: { b: 1 } } });
  await client.vector${at("a member that is a string or an object")}({ filter: { owner: "me" } });
  // @ts-expect-error the object alternative of owner cannot be serialized
  await client.vector${at("a member that is a string or an object")}({ filter: { owner: { id: "me" } } });
  await client.vector${at("an array of nullable strings")}({ tags: ["a"] });
  // @ts-expect-error null items cannot be serialized
  await client.vector${at("an array of nullable strings")}({ tags: [null] });
  await client.vector${at("a deepObject that may also be a string")}({ filter: { owner: "me" } });
  // @ts-expect-error a deepObject parameter must be an object
  await client.vector${at("a deepObject that may also be a string")}({ filter: "me" });
  await client.vector${at("a schema without type keywords")}({ xTrace: ["a", 1] });
  // @ts-expect-error nested values cannot be serialized
  await client.vector${at("a schema without type keywords")}({ xTrace: [["a"]] });
  await client.vector${at("a flat deepObject through a component reference")}({ filter: { owner: "me", due: null } });
  await client.vector${at("an array of component enum values")}({ status: ["open"] });
}
`
    );
    expect(compile(dir)).toEqual([]);
  });

  /** Components `<prefix>0` … `<prefix><depth>`, each the allOf of two references to the next (and `extra`), ending in `last`. */
  function chain(prefix: string, depth: number, last: unknown, extra: unknown[] = []): Record<string, unknown> {
    const schemas: Record<string, unknown> = { [`${prefix}${depth}`]: last };
    for (let level = 0; level < depth; level++) {
      const next = { $ref: `#/components/schemas/${prefix}${level + 1}` };
      schemas[`${prefix}${level}`] = { allOf: [next, next, ...extra] };
    }
    return schemas;
  }

  it("analyzes each referenced component once, however often it is referenced", () => {
    const cases = [
      { name: "array items through a repeated chain", schemas: chain("Chain", 200, { type: "string" }), parameter: { in: "query", name: "tags", style: "form", explode: true, required: false, schema: { type: "array", items: { $ref: "#/components/schemas/Chain0" } } }, expect: { supported: true, admitsUnserializable: false } },
      { name: "a nested member through a repeated chain", schemas: chain("Deep", 200, { type: "object", properties: { owner: { type: "object" } } }), parameter: { in: "query", name: "filter", style: "deepObject", explode: true, required: false, schema: { $ref: "#/components/schemas/Deep0" } }, expect: { supported: false } },
      // Every level also refers back to the first, so each one is in a cycle too; the cut references are
      // unknown in an intersection, so the items are strings, as the emitted types say.
      { name: "a repeated chain that is also cyclic", schemas: chain("Loop", 200, { type: "string" }, [{ $ref: "#/components/schemas/Loop0" }]), parameter: { in: "header", name: "X-Loop", style: "simple", explode: false, required: false, schema: { type: "array", items: { $ref: "#/components/schemas/Loop0" } } }, expect: { supported: true, admitsUnserializable: false } },
    ];
    const started = performance.now();
    const result = generate(vectorCatalog(cases.map((vector, index) => ({ vector, index }))));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.ok).toBe(true);
    expect(result.manifest!.operations.excluded.find((entry) => entry.id === "vectors.v1")!.details).toEqual([
      'query parameter "filter": its member "owner" admits only nested objects or arrays, which the client cannot serialize.',
    ]);
    const client = result.files.find((file) => file.path === "src/client.ts")!.contents;
    for (const index of [0, 2]) {
      expect(result.manifest!.operations.included.map((entry) => entry.id)).toContain(`vectors.v${index}`);
      const params = client.match(new RegExp(`export interface Vector${index}Params \\{[\\s\\S]*?\\n\\}`))![0];
      expect(/\bParamValue</.test(params), cases[index]!.name).toBe(cases[index]!.expect.admitsUnserializable);
    }
  });

  it("gives each parameter the same support whichever operations are analyzed with it, and in whatever order", () => {
    // Hop0 … Hop80 each refer to the next; Hop80 is an array of strings, so array items that are any HopN are arrays.
    const hops = chain("Hop", 80, { type: "array", items: { type: "string" } });
    // Pick0 … Pick80 likewise, ending in an object whose member "owner" is an object.
    const picks = chain("Pick", 80, { type: "object", properties: { owner: { type: "object", properties: { id: { type: "string" } } } } });
    const items = (component: string) => ({ name: component, schemas: { ...hops, ...picks }, parameter: { in: "query", name: "tags", style: "form", explode: true, required: false, schema: { type: "array", items: { $ref: `#/components/schemas/${component}` } } } });
    const members = (component: string) => ({ name: component, schemas: { ...hops, ...picks }, parameter: { in: "query", name: "filter", style: "deepObject", explode: true, required: false, schema: { $ref: `#/components/schemas/${component}` } } });
    const vectors = [items("Hop0"), items("Hop60"), members("Pick0"), members("Pick60")];
    const itemReason = 'query parameter "tags": its array items admit no string, number or boolean, the only items the client can serialize.';
    const memberReason = 'query parameter "filter": its member "owner" admits only nested objects or arrays, which the client cannot serialize.';

    /** Each vector's support when generated in `order`, with vector i as operation `vectors.v<ids[i]>`. */
    const outcomes = (order: number[], ids: number[]) => {
      const result = generate(vectorCatalog(order.map((position) => ({ vector: vectors[position]!, index: ids[position]! }))));
      expect(result.ok).toBe(true);
      return Object.fromEntries(
        order.map((position) => {
          const id = `vectors.v${ids[position]}`;
          const excluded = result.manifest!.operations.excluded.find((entry) => entry.id === id);
          return [vectors[position]!.name, excluded ? excluded.details : "included"];
        })
      );
    };
    const expected = { Hop0: [itemReason], Hop60: [itemReason], Pick0: [memberReason], Pick60: [memberReason] };
    for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 0, 3, 2], [2, 3, 0, 1]]) {
      // Operation IDs in both directions too, in case analysis follows them.
      expect(outcomes(order, [0, 1, 2, 3])).toEqual(expected);
      expect(outcomes(order, [3, 2, 1, 0])).toEqual(expected);
    }
    for (const [position, vector] of vectors.entries()) expect(outcomes([position], [0, 1, 2, 3])[vector.name]).toEqual(expected[vector.name as keyof typeof expected]);
  });

  it("analyzes objects with tens of thousands of members in linear time, reporting members in declaration order", () => {
    const wide = (count: number, nested: number[]): CatalogParameter => {
      const properties: Record<string, JsonValue> = {};
      for (let member = 0; member < count; member++) {
        properties[`p${member}`] = nested.includes(member) ? { type: "object", properties: { id: { type: "string" } } } : { type: "string" };
      }
      return { in: "query", name: "filter", style: "deepObject", explode: true, required: false, deprecated: false, allowReserved: false, description: null, schema: { type: "object", properties, additionalProperties: false } };
    };
    const reason = (member: number) => `query parameter "filter": its member "p${member}" admits only nested objects or arrays, which the client cannot serialize.`;

    // Only the analysis is timed, not emission: about 80 ms here for 128k members, where a scan per member
    // (quadratic) took 16 s. The ceiling leaves slow shared runners room and still catches that.
    const parameter = wide(128_000, [100, 127_000]);
    const started = performance.now();
    const support = parameterSupport(parameter, {});
    expect(performance.now() - started).toBeLessThan(2000);
    expect(support.reasons).toEqual([reason(100), reason(127_000)]);

    // The same reasons and types reach the generated package.
    const cases = [
      { name: "wide and flat", parameter: wide(2000, []) },
      { name: "wide with nested members", parameter: wide(2000, [100, 1900]) },
    ];
    const result = generate(vectorCatalog(cases.map((vector, index) => ({ vector, index }))));
    expect(result.ok).toBe(true);
    expect(result.manifest!.operations.included.map((entry) => entry.id)).toContain("vectors.v0");
    expect(result.manifest!.operations.excluded.find((entry) => entry.id === "vectors.v1")!.details).toEqual([reason(100), reason(1900)]);
    const client = result.files.find((file) => file.path === "src/client.ts")!.contents;
    expect(client.match(/export interface Vector0Params \{[\s\S]*?\n\}/)![0]).not.toMatch(/\bDeepObjectValue</);
  });

  /** Components `<prefix>0` … `<prefix><length>`, each an alias of the next, ending in `last`. */
  function links(prefix: string, length: number, last: unknown): Record<string, unknown> {
    const schemas: Record<string, unknown> = { [`${prefix}${length}`]: last };
    for (let level = 0; level < length; level++) schemas[`${prefix}${level}`] = { $ref: `#/components/schemas/${prefix}${level + 1}` };
    return schemas;
  }

  it("follows component reference chains of any length, used or not, without exhausting the call stack", () => {
    // Chains of 12,000 references: one a parameter uses, one a response uses that closes a cycle back to
    // its start, and one nothing uses. A recursive search overflowed the stack at about 4,000.
    const length = 12_000;
    const ring = links("Ring", length, { $ref: "#/components/schemas/Ring0" });
    const vector = { name: "a long alias chain", schemas: { ...links("Link", length, { type: "string" }), ...ring, ...links("Spare", length, { type: "string" }) }, parameter: { in: "query", name: "tag", style: "form", explode: true, required: false, schema: { $ref: "#/components/schemas/Link0" } } };
    const catalog = vectorCatalog([{ vector, index: 0 }]);
    const operation = catalog.operations.find((entry: any) => entry.id === "vectors.v0");
    operation.responses.find((response: any) => response.status === "200").contents[0].schema = { $ref: "#/components/schemas/Ring0" };

    expect(aliasCycleCuts(ring)).toEqual(new Map([[`Ring${length}`, ["Ring0"]]]));
    const result = generate(catalog);
    expect(result.ok).toBe(true);
    expect(result.manifest!.operations.included.map((entry) => entry.id)).toContain("vectors.v0");
    const client = result.files.find((file) => file.path === "src/client.ts")!.contents;
    expect(client.match(/export interface Vector0Params \{[\s\S]*?\n\}/)![0]).not.toMatch(/\bParamValue</);
  });

  it("cuts alias cycles exactly where a recursive depth-first search in sorted order would", () => {
    /** The recursive search the iterative one replaced, as the reference. */
    const recursiveCuts = (schemas: Record<string, unknown>) => {
      const names = Object.keys(schemas).sort();
      const edges = new Map(names.map((name) => [name, [...new Set(((schemas[name] as { allOf: Array<{ $ref: string }> }).allOf).map((member) => member.$ref.slice("#/components/schemas/".length)))].filter((target) => target in schemas).sort()]));
      const state = new Map<string, string>();
      const cuts = new Map<string, string[]>();
      const visit = (name: string) => {
        state.set(name, "open");
        for (const target of edges.get(name)!) {
          if (state.get(target) === "open") cuts.set(name, [...(cuts.get(name) ?? []), target]);
          else if (!state.has(target)) visit(target);
        }
        state.set(name, "done");
      };
      for (const name of names) if (!state.has(name)) visit(name);
      return cuts;
    };
    // Seeded random graphs of up to 12 components with up to 4 references each, some to missing components.
    let seed = 7;
    const random = (bound: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    for (let graph = 0; graph < 300; graph++) {
      const size = 1 + random(12);
      const schemas: Record<string, unknown> = {};
      for (let node = 0; node < size; node++) {
        schemas[`S${node}`] = { allOf: Array.from({ length: random(5) }, () => ({ $ref: `#/components/schemas/S${random(size + 2)}` })) };
      }
      expect([...aliasCycleCuts(schemas)]).toEqual([...recursiveCuts(schemas)]);
    }
  });

  it("types a cut alias cycle as unknown in the analysis, as in the emitted types", async () => {
    // Pair = string | Wrap and Wrap = Pair: the emitted Wrap cuts its reference to unknown, so Pair admits anything.
    const cycle = {
      name: "an alias cycle",
      schemas: { Pair: { anyOf: [{ type: "string" }, { $ref: "#/components/schemas/Wrap" }] }, Wrap: { allOf: [{ $ref: "#/components/schemas/Pair" }] } },
      parameter: { in: "query", name: "pairs", style: "form", explode: true, required: true, schema: { type: "array", items: { $ref: "#/components/schemas/Pair" } } },
    };
    // A recursive object through a property stays precise: its child member is only ever an object.
    const tree = {
      name: "a recursive object",
      schemas: { Node: { type: "object", properties: { name: { type: "string" }, child: { $ref: "#/components/schemas/Node" } } } },
      parameter: { in: "query", name: "node", style: "deepObject", explode: true, required: false, schema: { $ref: "#/components/schemas/Node" } },
    };
    const result = generate(vectorCatalog([{ vector: cycle, index: 0 }, { vector: tree, index: 1 }]));
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "SDK_SCHEMA_CYCLE").length).toBeGreaterThan(0);
    expect(result.manifest!.operations.excluded.find((entry) => entry.id === "vectors.v1")!.details).toEqual([
      'query parameter "node": its member "child" admits only nested objects or arrays, which the client cannot serialize.',
    ]);
    const dir = tempDir();
    expect((await writeSdk(dir, result)).ok).toBe(true);
    writeFileSync(
      path.join(dir, "src/custom/consumer-cycle.ts"),
      `import { TasksClient } from "../index.js";
const client = new TasksClient();
export async function use(): Promise<void> {
  await client.vector0({ pairs: ["a", 1] });
  // @ts-expect-error nested values cannot be serialized
  await client.vector0({ pairs: [["a"]] });
}
`
    );
    expect(compile(dir)).toEqual([]);
  });
});
