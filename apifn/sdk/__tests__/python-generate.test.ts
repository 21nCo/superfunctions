// The Python target at generation time: provenance, selection, options, names, schema typing and the
// custom-code area. The generated package itself is built, installed and run in python-sdk.test.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createReleaseDescriptor } from "@apifn/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { PYTHON_TARGET_VERSION, SDK_ARTIFACT_MANIFEST_FILE, writeSdk } from "../src/index.js";
import { PYTHON_RUNTIME_SOURCE } from "../src/targets/python/runtime-source.js";
import { cleanupTemp, clone, fixtureCatalog, fixtureConfig, generate, PACKAGE_DIR, readJson, tempDir } from "./helpers.js";

afterAll(cleanupTemp);

const pythonConfig = (): any => readJson("python/sdk.config.json");
const generatePython = (catalog: unknown = fixtureCatalog(), config: unknown = pythonConfig()) => generate(catalog, config);
const fileOf = (result: ReturnType<typeof generate>, file: string) => result.files.find((entry) => entry.path === file)?.contents ?? "";
const errors = (result: ReturnType<typeof generate>) => result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");

/** Reverses key order at every depth: canonical inputs must not depend on it. */
function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)]));
}

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full).split(path.sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe("python target: provenance", () => {
  it("embeds the current runtime template", () => {
    expect(PYTHON_RUNTIME_SOURCE).toBe(readFileSync(path.join(PACKAGE_DIR, "templates/python/runtime.py"), "utf8"));
  });

  it("is byte-identical for the same inputs, whatever their key order, and rewrites nothing when regenerated", async () => {
    const first = generatePython();
    expect(first.ok, JSON.stringify(first.diagnostics)).toBe(true);
    expect(generatePython(reorder(fixtureCatalog()), reorder(pythonConfig())).files).toEqual(first.files);
    const dir = tempDir();
    expect((await writeSdk(dir, first)).ok).toBe(true);
    const before = snapshot(dir);
    for (const file of Object.keys(before)) utimesSync(path.join(dir, file), 0, 0);
    const second = await writeSdk(dir, generatePython());
    expect(second).toMatchObject({ ok: true, written: [], deleted: [], seeded: [] });
    expect(snapshot(dir)).toEqual(before);
    expect(Object.keys(before).filter((file) => statSync(path.join(dir, file)).mtimeMs !== 0)).toEqual([]);
  });

  it("records the TypeScript target's catalog digest, its own target and release, and the custom-code area", () => {
    const python = generatePython().manifest!;
    const typescript = generate(fixtureCatalog(), fixtureConfig()).manifest!;
    expect(python.catalog).toEqual(typescript.catalog);
    expect(python.api).toEqual(typescript.api);
    expect(python.generator).toEqual(typescript.generator);
    expect(python.target).toEqual({ id: "python", version: PYTHON_TARGET_VERSION });
    expect(python.package).toEqual({ name: "example-tasks-sdk", version: "1.0.0" });
    const release = createReleaseDescriptor({ catalog: fixtureCatalog(), generator: python.generator, artifacts: [{ kind: "sdk", target: "python", package: python.package }] });
    expect(python.releaseId).toBe(release.descriptor!.releaseId);
    expect(python.releaseId).not.toBe(typescript.releaseId);
    expect(python.customCode).toEqual({ root: "src/example_tasks_sdk/custom/", seeds: ["src/example_tasks_sdk/custom/__init__.py"] });
    expect(python.files.map((entry) => entry.path)).toEqual([
      "README.md",
      "pyproject.toml",
      "src/example_tasks_sdk/__init__.py",
      "src/example_tasks_sdk/_runtime.py",
      "src/example_tasks_sdk/client.py",
      "src/example_tasks_sdk/models.py",
      "src/example_tasks_sdk/py.typed",
    ]);
    // The generated client reports the same catalog digest and its own release in failure observations.
    const client = fileOf(generatePython(), "src/example_tasks_sdk/client.py");
    expect(client).toContain(`catalog_digest="${typescript.catalog.digest}"`);
    expect(client).toContain(`release_id="${python.releaseId}"`);
  });

  it("lists the same exclusions as the TypeScript target, marks deprecation and keeps writes unretried", () => {
    const result = generatePython();
    const manifest = result.manifest!;
    expect(manifest.complete).toBe(false);
    expect(manifest.operations.excluded).toEqual(generate(fixtureCatalog(), fixtureConfig()).manifest!.operations.excluded.map((entry) => ({ ...entry, details: expect.any(Array) })));
    expect(manifest.operations.excluded.map(({ id, reason }) => [id, reason])).toEqual([
      ["legacy.tasks.list", "target-excluded"],
      ["reports.upload", "unsupported"],
      ["session.get", "unsupported"],
      ["system.ping", "sdk-include-false"],
    ]);
    const client = fileOf(result, "src/example_tasks_sdk/client.py");
    expect(client).toContain('@_te.deprecated("Close tasks instead of deleting them. Use replace_task instead.")\n    async def delete_task(');
    expect(client.match(/retry="(?:read|idempotent|never)"/g)!.filter((entry) => entry !== 'retry="read"')).toEqual(Array(6).fill('retry="never"'));
    expect(client).not.toContain('retry="idempotent"');
  });
});

describe("python target: unsupported constructs", () => {
  it("fails by default, naming each unsupported operation and writing nothing", () => {
    const config = pythonConfig();
    delete config.unsupported;
    const result = generatePython(fixtureCatalog(), config);
    expect(result).toMatchObject({ ok: false, files: [], manifest: null });
    expect(errors(result).map((diagnostic) => [diagnostic.code, diagnostic.operation])).toEqual([
      ["SDK_UNSUPPORTED_OPERATION", "reports.upload"],
      ["SDK_UNSUPPORTED_OPERATION", "session.get"],
    ]);
    expect(errors(result)[0]!.message).toMatch(/multipart\/form-data/);
    expect(errors(result)[1]!.message).toMatch(/cookieAuth/);
  });

  it("produces a complete manifest when every included operation is supported", () => {
    const catalog = fixtureCatalog();
    for (const operation of catalog.operations) if (operation.id === "reports.upload" || operation.id === "session.get") operation.sdk.include = false;
    const config = pythonConfig();
    delete config.unsupported;
    expect(generatePython(catalog, config).manifest!.complete).toBe(true);
  });

  /** The fixture catalog plus one clone of tasks.get, edited. */
  function withOperation(edit: (operation: any, catalog: any) => void): { catalog: any; id: string } {
    const catalog = fixtureCatalog();
    const operation = { ...clone(catalog.operations.find((candidate: any) => candidate.id === "tasks.get")), id: "tasks.probe", name: "probeTask", openapiOperationId: "probeTask", path: "/probe" };
    edit(operation, catalog);
    catalog.operations.push(operation);
    return { catalog, id: "tasks.probe" };
  }

  const cases: Array<[string, (operation: any, catalog: any) => void, RegExp]> = [
    ["a cookie parameter", (operation) => operation.parameters.push({ name: "session", in: "cookie", required: false, deprecated: false, style: "form", explode: true, allowReserved: false, description: null, schema: { type: "string" } }), /cookie parameter "session"/],
    ["a request body on GET", (operation) => (operation.requestBody = { required: false, contents: [{ mediaType: "application/json", schema: {}, encoding: {} }] }), /GET request has no content/],
    ["a request body on TRACE", (operation) => ((operation.method = "trace"), (operation.requestBody = { required: true, contents: [{ mediaType: "text/plain", schema: {}, encoding: {} }] })), /TRACE request has no content/],
    ["a form request body", (operation) => ((operation.method = "post"), (operation.requestBody = { required: true, contents: [{ mediaType: "application/x-www-form-urlencoded", schema: {}, encoding: {} }] })), /application\/x-www-form-urlencoded are not supported/],
    ["a success documented only as XML", (operation) => (operation.responses = [{ status: "200", kind: "success", description: "XML", contents: [{ mediaType: "application/xml", schema: null, encoding: {} }] }]), /success response 200 media types application\/xml/],
    [
      "only an HTTP Digest security alternative",
      (operation, catalog) => {
        catalog.securitySchemes.digestAuth = { type: "http", scheme: "digest", description: null };
        operation.security = { alternatives: [[{ scheme: "digestAuth", scopes: [] }]] };
      },
      /no security alternative uses only supported schemes \(unsupported: digestAuth\)/,
    ],
  ];
  for (const [name, edit, reason] of cases) {
    it(`names ${name} and excludes the operation, never yielding a complete manifest`, () => {
      const { catalog, id } = withOperation(edit);
      const failing = pythonConfig();
      delete failing.unsupported;
      const failed = generatePython(catalog, failing);
      expect(failed.ok).toBe(false);
      expect(errors(failed).find((diagnostic) => diagnostic.operation === id)).toMatchObject({ code: "SDK_UNSUPPORTED_OPERATION", message: expect.stringMatching(reason) });
      const excluded = generatePython(catalog);
      expect(excluded.manifest!.complete).toBe(false);
      expect(excluded.manifest!.operations.excluded.find((entry) => entry.id === id)).toMatchObject({ reason: "unsupported", details: [expect.stringMatching(reason)] });
    });
  }

  it("includes a TRACE operation without a body, which only fetch cannot send", () => {
    const { catalog, id } = withOperation((operation) => (operation.method = "trace"));
    expect(generatePython(catalog).manifest!.operations.included.map((entry) => entry.id)).toContain(id);
    expect(generate(catalog, fixtureConfig()).manifest!.operations.excluded.map((entry) => entry.id)).toContain(id);
  });

  const vectors: any[] = readJson("vectors/parameters.json").cases;
  for (const [index, vector] of vectors.entries()) {
    it(`parameter vector: ${vector.name}`, () => {
      const { catalog, id } = withOperation((operation, target) => {
        const parameter = { allowReserved: false, deprecated: false, description: null, ...vector.parameter };
        operation.path = parameter.in === "path" ? `/vectors/${index}/{${parameter.name}}` : `/vectors/${index}`;
        operation.parameters = [parameter];
        Object.assign(target.schemas, clone(vector.schemas ?? {}));
      });
      const result = generatePython(catalog);
      expect(result.ok, JSON.stringify(errors(result))).toBe(true);
      if (!vector.expect.supported) {
        const entry = result.manifest!.operations.excluded.find((candidate) => candidate.id === id)!;
        expect(entry.reason).toBe("unsupported");
        expect(entry.details.join("\n")).toContain(vector.expect.reason);
        return;
      }
      const method = fileOf(result, "src/example_tasks_sdk/client.py").match(/async def probe_task\([\s\S]*?\) ->/)![0];
      expect(/_ParamValue|_DeepObjectValue/.test(method), method).toBe(vector.expect.admitsUnserializable);
    });
  }
});

describe("python target: options", () => {
  const option = (edit: (options: any) => void) => {
    const config = pythonConfig();
    edit(config.options);
    return config;
  };
  const cases: Array<[string, any, string]> = [
    ["an npm-scoped package name", option((options) => (options.package.name = "@example/tasks-sdk")), "/options/package/name"],
    ["a package name that is not normalized", option((options) => (options.package.name = "Example_Tasks")), "/options/package/name"],
    ["a SemVer prerelease that PEP 440 would rewrite", option((options) => (options.package.version = "1.0.0-beta.1")), "/options/package/version"],
    ["a version with a leading zero", option((options) => (options.package.version = "1.01")), "/options/package/version"],
    ["a module that is a keyword", option((options) => (options.module = "class")), "/options/module"],
    ["a module that is not lowercase", option((options) => (options.module = "Tasks")), "/options/module"],
    ["a module that shadows the HTTP dependency", option((options) => (options.module = "httpx")), "/options/module"],
    ["a module that shadows typing_extensions", option((options) => (options.module = "typing_extensions")), "/options/module"],
    ["a module that shadows a dependency of httpx", option((options) => (options.module = "anyio")), "/options/module"],
    ["a module that shadows a standard-library module the runtime imports", option((options) => (options.module = "asyncio")), "/options/module"],
    ["a module that shadows a standard-library module the runtime does not import", option((options) => (options.module = "sqlite3")), "/options/module"],
    ["a distribution name whose derived module shadows a dependency", option((options) => (options.package.name = "httpx")), "/options/package/name"],
    ["a distribution name whose derived module shadows typing_extensions", option((options) => (options.package.name = "typing-extensions")), "/options/package/name"],
    ["a distribution name whose derived module shadows the standard library", option((options) => (options.package.name = "asyncio")), "/options/package/name"],
    // The distribution would require itself: no import name makes it installable.
    ...["httpx", "typing-extensions", "httpcore", "anyio"].map((name): [string, any, string] => [
      `the distribution name of the runtime dependency ${name}, with a safe module`,
      option((options) => ((options.package.name = name), (options.module = "my_sdk"))),
      "/options/package/name",
    ]),
    ["a license that is not an SPDX expression", option((options) => (options.package.license = "see LICENSE, 2026")), "/options/package/license"],
    // Each of these passed a character check, then failed the build backend's license validation.
    ["a license expression missing an operand", option((options) => (options.package.license = "MIT AND")), "/options/package/license"],
    ["a license of words", option((options) => (options.package.license = "see LICENSE")), "/options/package/license"],
    ["a license with an unbalanced parenthesis", option((options) => (options.package.license = "(")), "/options/package/license"],
    ["a license that is not an SPDX identifier", option((options) => (options.package.license = "Foo-Bar")), "/options/package/license"],
    ["a license exception used as a license", option((options) => (options.package.license = "Classpath-exception-2.0")), "/options/package/license"],
    ["a license used as an exception", option((options) => (options.package.license = "MIT WITH Apache-2.0")), "/options/package/license"],
    ["a license expression that is not normalized", option((options) => (options.package.license = "mit or apache-2.0")), "/options/package/license"],
    ["a description with a line break", option((options) => (options.package.description = "two\nlines")), "/options/package/description"],
    ["a base URL with a dot segment", option((options) => (options.baseUrl = "https://api.example.test/a/../v1")), "/options/baseUrl"],
    ["a base URL with user info", option((options) => (options.baseUrl = "https://user:pw@api.example.test")), "/options/baseUrl"],
    ["a base URL with a query", option((options) => (options.baseUrl = "https://api.example.test/?region=eu")), "/options/baseUrl"],
    // A URL parser would accept these, but the runtime reads the URL as written and rejects them.
    ["a base URL without //", option((options) => (options.baseUrl = "https:example.test")), "/options/baseUrl"],
    ["a base URL with one /", option((options) => (options.baseUrl = "https:/example.test")), "/options/baseUrl"],
    ["a base URL with port 0", option((options) => (options.baseUrl = "https://example.test:0")), "/options/baseUrl"],
    ["a base URL with empty user info", option((options) => (options.baseUrl = "https://@example.test")), "/options/baseUrl"],
    ["a base URL with non-ASCII text", option((options) => (options.baseUrl = "https://api.example.test/größe")), "/options/baseUrl"],
    ["a client name that is a keyword", option((options) => (options.clientName = "None")), "/options/clientName"],
    ["a client name that is not an identifier", option((options) => (options.clientName = "tasks-client")), "/options/clientName"],
    ["a retry budget over 10", option((options) => (options.retry.maxAttempts = 11)), "/options/retry/maxAttempts"],
    ["a config that declares writes idempotent", option((options) => (options.retry.idempotentOperations = ["tasks.replace"])), "/options/retry/idempotentOperations"],
    ["a type name for an unknown schema", option((options) => (options.typeNames = { Nope: "Nope" })), "/options/typeNames/Nope"],
    ["an unknown option", option((options) => (options.servers = [])), "/options/servers"],
  ];
  for (const [name, config, pointer] of cases) {
    it(`rejects ${name}`, () => {
      const result = generatePython(fixtureCatalog(), config);
      expect(result).toMatchObject({ ok: false, files: [] });
      expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.pointer])).toContainEqual(["SDK_INVALID_CONFIG", pointer]);
    });
  }

  it("derives the import name from the distribution name, and accepts PEP 440 pre-releases", () => {
    const result = generatePython(fixtureCatalog(), option((options) => (options.package.version = "2.0.0rc1")));
    expect(result.manifest!.package.version).toBe("2.0.0rc1");
    expect(fileOf(result, "pyproject.toml")).toContain('version = "2.0.0rc1"');
    const renamed = generatePython(fixtureCatalog(), option((options) => (options.module = "tasks")));
    expect(renamed.manifest!.customCode.root).toBe("src/tasks/custom/");
    expect(fileOf(renamed, "pyproject.toml")).toContain('packages = ["src/tasks"]');
  });

  it("accepts normalized SPDX license expressions, and names the normalized form of one that is not", () => {
    for (const license of ["MIT", "Apache-2.0 OR MIT", "(MIT AND BSD-3-Clause)", "GPL-2.0-only WITH Classpath-exception-2.0", "LicenseRef-Custom", "GPL-2.0+ OR (MIT AND LicenseRef-a.b-2)", "(MIT)", "MIT AND (Apache-2.0 OR (0BSD))"]) {
      const result = generatePython(fixtureCatalog(), option((options) => (options.package.license = license)));
      expect(result.ok, `${license}: ${JSON.stringify(result.diagnostics)}`).toBe(true);
      expect(fileOf(result, "pyproject.toml")).toContain(`license = ${JSON.stringify(license)}`);
    }
    const lowercase = generatePython(fixtureCatalog(), option((options) => (options.package.license = "mit or apache-2.0 with llvm-exception")));
    expect(lowercase.diagnostics.find((diagnostic) => diagnostic.pointer === "/options/package/license")?.message).toContain('"MIT OR Apache-2.0 WITH LLVM-exception"');
    // packaging 24.2, which hatchling still allows, rejects a parenthesis opening straight after another.
    for (const license of ["((MIT))", "((MIT) AND BSD-3-Clause)", "MIT AND ((Apache-2.0))"]) {
      expect(errors(generatePython(fixtureCatalog(), option((options) => (options.package.license = license)))).map((diagnostic) => diagnostic.pointer), license).toEqual(["/options/package/license"]);
    }
  });

  it("escapes package metadata as TOML and keeps the generated files ASCII", () => {
    const result = generatePython(fixtureCatalog(), option((options) => (options.package.description = 'Tasks "SDK" \\ für Ärzte')));
    expect(fileOf(result, "pyproject.toml")).toContain('description = "Tasks \\"SDK\\" \\\\ f\\u00fcr \\u00c4rzte"');
    // Literal backslash sequences stay literal: TOML reads each value back as it was configured.
    const literal = generatePython(fixtureCatalog(), option((options) => (options.package.description = "literal \\x41, \\u00e9 and \\\\x7f")));
    expect(fileOf(literal, "pyproject.toml")).toContain('description = "literal \\\\x41, \\\\u00e9 and \\\\\\\\x7f"');
  });

  it("accepts a base URL with an explicit port, and reports a dependency's distribution name once", () => {
    const result = generatePython(fixtureCatalog(), option((options) => (options.baseUrl = "http://localhost:65535/v1")));
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(fileOf(result, "src/example_tasks_sdk/client.py")).toContain('default_base_url="http://localhost:65535/v1"');
    const derived = generatePython(fixtureCatalog(), option((options) => (options.package.name = "httpx")));
    expect(derived.diagnostics.map((diagnostic) => diagnostic.pointer)).toEqual(["/options/package/name"]);
  });

  it("reports an import name derived from an unusable distribution name at the distribution name", () => {
    for (const name of ["3d-sdk", "a".repeat(120), "class"]) {
      const result = generatePython(fixtureCatalog(), option((options) => (options.package.name = name)));
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.pointer]), name).toEqual([["SDK_INVALID_CONFIG", "/options/package/name"]]);
      expect(result.diagnostics[0]!.message).toContain("set module");
      const named = generatePython(fixtureCatalog(), option((options) => ((options.package.name = name), (options.module = "my_sdk"))));
      expect(named.ok, JSON.stringify(named.diagnostics)).toBe(true);
    }
  });

  it("requires base_url in the constructor when the config has no default", () => {
    const result = generatePython(fixtureCatalog(), option((options) => delete options.baseUrl));
    const client = fileOf(result, "src/example_tasks_sdk/client.py");
    expect(client).toContain("        base_url: str,\n");
    expect(client).toContain("    default_base_url=None,");
  });
});

describe("python target: names", () => {
  function withSchema(name: string, schema: unknown = { type: "object" }) {
    const catalog = fixtureCatalog();
    catalog.schemas[name] = schema;
    return catalog;
  }

  it("names a component schema that collides with a runtime export, and resolves through typeNames", () => {
    const result = generatePython(withSchema("ApiError"));
    expect(errors(result).map((diagnostic) => diagnostic.code)).toEqual(["SDK_NAME_COLLISION"]);
    expect(errors(result)[0]!.message).toMatch(/"ApiError".*runtime export ApiError.*component schema "ApiError"/);
    const config = pythonConfig();
    config.options.typeNames = { ApiError: "ApiErrorModel" };
    expect(generatePython(withSchema("ApiError"), config).ok).toBe(true);
  });

  it("names schemas whose type names coincide, are keywords or collide with operation aliases", () => {
    expect(errors(generatePython(withSchema("task-page")))[0]!.message).toMatch(/component schema "TaskPage" and component schema "task-page"/);
    expect(errors(generatePython(withSchema("none")))[0]!.message).toMatch(/"None" is generated for both a Python keyword and component schema "none"/);
    expect(errors(generatePython(withSchema("GetTaskResult")))[0]).toMatchObject({ code: "SDK_NAME_COLLISION", operation: "tasks.get" });
  });

  it("names operations whose methods coincide or replace a client member", () => {
    const catalog = fixtureCatalog();
    const health = catalog.operations.find((operation: any) => operation.id === "system.health");
    health.name = "get_task";
    expect(errors(generatePython(catalog)).map((diagnostic) => [diagnostic.code, diagnostic.operation])).toContainEqual(["SDK_NAME_COLLISION", expect.stringMatching(/^(?:tasks\.get|system\.health)$/)]);
    health.name = "aclose";
    expect(errors(generatePython(catalog))[0]!.message).toMatch(/method name "aclose" is also the method that closes the client's transport/);
  });

  it("writes builtins through the builtins module in a client whose methods shadow one", () => {
    const plain = fileOf(generatePython(fixtureCatalog()), "src/example_tasks_sdk/client.py");
    expect(plain).not.toContain("import builtins");
    expect(plain).toMatch(/^        base_url: str \| None = None,$/m);
    const catalog = fixtureCatalog();
    catalog.operations.find((operation: any) => operation.id === "system.health").name = "str";
    const result = generatePython(catalog);
    expect(result.ok, JSON.stringify(errors(result))).toBe(true);
    const client = fileOf(result, "src/example_tasks_sdk/client.py");
    expect(client).toContain("import builtins as _b\n");
    expect(client).toMatch(/^    async def str\(\n/m);
    // No bare builtin is left in the class body for the method to replace.
    const body = client.slice(client.indexOf("\nclass TasksClient:"));
    expect(body).toMatch(/^        base_url: _b\.str \| None = None,$/m);
    expect(body).not.toMatch(/(?<![\w.])(?:str|int|float|bool|bytes|bytearray|memoryview|list|dict|object)\[|(?<![\w."])(?:str|int|float|bool|bytes|bytearray|memoryview|object)(?= \||,\n|\]|\))/);
  });

  it("names parameters that become one argument, or the body and request options arguments", () => {
    const catalog = fixtureCatalog();
    const list = catalog.operations.find((operation: any) => operation.id === "tasks.list");
    list.parameters.push({ ...clone(list.parameters.find((parameter: any) => parameter.name === "X-Request-Id")), name: "x_request_id", in: "query", style: "form", explode: true });
    expect(errors(generatePython(catalog))[0]!.message).toMatch(/tasks\.list: query parameter "x_request_id" and header parameter "X-Request-Id" both become the argument "x_request_id"/);
    const create = fixtureCatalog();
    const operation = create.operations.find((candidate: any) => candidate.id === "tasks.create");
    operation.parameters.push({ ...clone(operation.parameters[1]), name: "Body" }, { ...clone(operation.parameters[1]), name: "Request-Options" });
    expect(errors(generatePython(create)).map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringMatching(/header parameter "Body" and the request body both become the argument "body"/),
      expect.stringMatching(/header parameter "Request-Options" and the request options argument both become the argument "request_options"/),
    ]);
  });

  it("writes keyword and non-identifier names so Python reads them, keeping wire names", () => {
    const catalog = fixtureCatalog();
    const list = catalog.operations.find((operation: any) => operation.id === "tasks.list");
    list.parameters.push(
      { ...clone(list.parameters[2]), name: "from", required: false },
      { ...clone(list.parameters[2]), name: "2fa", required: false },
      { ...clone(list.parameters[2]), name: "self", required: false }
    );
    const client = fileOf(generatePython(catalog), "src/example_tasks_sdk/client.py");
    for (const [argument, wire] of [["from_", "from"], ["p_2fa", "2fa"], ["self_", "self"]]) {
      expect(client).toContain(`_ParameterSpec(key="${argument}", name="${wire}"`);
      expect(client).toContain(`        ${argument}: int | None = None,\n`);
    }
  });
});

describe("python target: schema types", () => {
  it("types component objects as TypedDicts, merging allOf, and other schemas as aliases", () => {
    const models = fileOf(generatePython(), "src/example_tasks_sdk/models.py");
    expect(models).toContain('Task = _te.TypedDict(\n    "Task",\n    {\n        "assignee": _te.NotRequired["str | None"],\n        "id": "str",\n');
    expect(models).toContain('        "subtasks": _te.NotRequired["list[Task]"],\n');
    expect(models).toContain('TaskStatus: _te.TypeAlias = "_t.Literal[\\"open\\"] | _t.Literal[\\"closed\\"]"');
    // ValidationProblem = allOf [Problem, { fields }]: one TypedDict with both parts' fields.
    expect(models).toContain('ValidationProblem = _te.TypedDict(\n    "ValidationProblem",\n    {\n        "status": "int",\n        "title": "str",\n        "type": _te.NotRequired["str"],\n        "fields": _te.NotRequired["dict[str, str]"],\n');
  });

  it("types a map's values as the union of its pattern and additional property values", () => {
    const catalog = fixtureCatalog();
    const pattern = { "^x": { type: "string" }, "^n": { type: "boolean" } };
    Object.assign(catalog.schemas, {
      PatternOnly: { type: "object", patternProperties: pattern },
      PatternClosed: { type: "object", patternProperties: pattern, additionalProperties: false },
      PatternInt: { type: "object", patternProperties: pattern, additionalProperties: { type: "integer" } },
      Closed: { type: "object", additionalProperties: false },
    });
    const models = fileOf(generatePython(catalog), "src/example_tasks_sdk/models.py");
    expect(models).toContain('PatternOnly: _te.TypeAlias = "dict[str, _t.Any]"');
    expect(models).toContain('PatternClosed: _te.TypeAlias = "dict[str, bool | str]"');
    expect(models).toContain('PatternInt: _te.TypeAlias = "dict[str, bool | str | int]"');
    expect(models).toContain('Closed: _te.TypeAlias = "dict[str, _te.Never]"');
  });

  it("defaults an optional body to the runtime's OMITTED, so None is a value it sends", () => {
    const client = fileOf(generatePython(), "src/example_tasks_sdk/client.py");
    expect(client).toContain("    OMITTED as _OMITTED,\n    Omitted as _Omitted,\n");
    expect(client).toMatch(/async def search_tasks\([^)]*        body: _m\._SearchTasks_1 \| _Omitted = _OMITTED,\n/);
    expect(client).not.toMatch(/body: .*= None/);
  });

  it("requires a property that any allOf part, or the enclosing schema, requires, even a part declaring no property", () => {
    const catalog = fixtureCatalog();
    const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
    catalog.schemas.RequiredSplit = { allOf: [object({ x: { type: "string" } }), { type: "object", required: ["x"] }] };
    catalog.schemas.Enclosing = { required: ["y"], allOf: [{ $ref: "#/components/schemas/RequiredSplit" }, object({ y: { type: "integer" }, z: { type: "boolean" } })] };
    const result = generatePython(catalog);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const models = fileOf(result, "src/example_tasks_sdk/models.py");
    expect(models).toContain('RequiredSplit = _te.TypedDict(\n    "RequiredSplit",\n    {\n        "x": "str",\n    },\n)');
    expect(models).toContain('Enclosing = _te.TypedDict(\n    "Enclosing",\n    {\n        "x": "str",\n        "y": "int",\n        "z": _te.NotRequired["bool"],\n    },\n)');
  });

  it("requires a property that a reference or single allOf wrapper requires, and still aliases one that adds no requirement", () => {
    const catalog = fixtureCatalog();
    const base = { $ref: "#/components/schemas/Base" };
    catalog.schemas.Base = { type: "object", required: ["v"], properties: { v: { type: "string" }, w: { type: "string" }, x: { type: "string" } } };
    catalog.schemas.OneRefReq = { allOf: [base], required: ["x"] };
    catalog.schemas.RefSiblingReq = { $ref: "#/components/schemas/Base", required: ["x"] };
    catalog.schemas.InlineReq = { type: "object", properties: { inner: { allOf: [base], required: ["x"] } } };
    catalog.schemas.PlainAllOf = { allOf: [base] };
    // Requiring what the referent already requires, or what no part declares, adds nothing to the type.
    catalog.schemas.RequiresRequired = { $ref: "#/components/schemas/Base", required: ["v", "undeclared"] };
    catalog.schemas.OfWrapper = { $ref: "#/components/schemas/OneRefReq" };
    const result = generatePython(catalog);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const models = fileOf(result, "src/example_tasks_sdk/models.py");
    const fields = '    {\n        "v": "str",\n        "w": _te.NotRequired["str"],\n        "x": "str",\n    },\n)';
    expect(models).toContain(`Base = _te.TypedDict(\n    "Base",\n    {\n        "v": "str",\n        "w": _te.NotRequired["str"],\n        "x": _te.NotRequired["str"],\n    },\n)`);
    expect(models).toContain(`OneRefReq = _te.TypedDict(\n    "OneRefReq",\n${fields}`);
    expect(models).toContain(`RefSiblingReq = _te.TypedDict(\n    "RefSiblingReq",\n${fields}`);
    expect(models).toContain('"inner": _te.NotRequired["_InlineReq_1"]');
    expect(models).toContain(`_InlineReq_1 = _te.TypedDict(\n    "_InlineReq_1",\n${fields}`);
    expect(models).toContain('PlainAllOf: _te.TypeAlias = "Base"\n');
    expect(models).toContain('RequiresRequired: _te.TypeAlias = "Base"\n');
    expect(models).toContain('OfWrapper: _te.TypeAlias = "OneRefReq"\n');
  });

  it("merges each shared allOf reference once, so a doubling chain generates in linear time", () => {
    const catalog = fixtureCatalog();
    catalog.schemas.Base = { type: "object", required: ["x"], properties: { x: { type: "string" } } };
    let previous = "Base";
    for (let level = 1; level <= 40; level++) {
      const ref = { $ref: `#/components/schemas/${previous}` };
      catalog.schemas[`Layer${level}`] = { allOf: [ref, ref] };
      previous = `Layer${level}`;
    }
    const started = Date.now();
    const result = generatePython(catalog);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const models = fileOf(result, "src/example_tasks_sdk/models.py");
    expect(models).toContain('Layer32 = _te.TypedDict(\n    "Layer32",\n    {\n        "x": "str",\n    },\n)');
    // Past the nesting bound a layer is typed as the identical layer it refers to.
    expect(models).toContain('Layer40: _te.TypeAlias = "Layer39"\n');
  });

  it("writes inline objects of operations to models.py, typed in its namespace", () => {
    const catalog = fixtureCatalog();
    const create = catalog.operations.find((operation: any) => operation.id === "tasks.create");
    create.requestBody.contents[0].schema = { type: "object", properties: { task: { $ref: "#/components/schemas/TaskInput" }, note: { type: "object", properties: { text: { type: "string" } } } } };
    const result = generatePython(catalog);
    const models = fileOf(result, "src/example_tasks_sdk/models.py");
    // An object is named before its fields are typed, so it comes before the objects nested in it.
    expect(models).toContain('_CreateTask_1 = _te.TypedDict(\n    "_CreateTask_1",\n    {\n        "note": _te.NotRequired["_CreateTask_2"],\n        "task": _te.NotRequired["TaskInput"],\n');
    expect(models).toContain('_CreateTask_2 = _te.TypedDict(\n    "_CreateTask_2",\n    {\n        "text": _te.NotRequired["str"],\n');
    expect(models).not.toContain("_m.");
    expect(fileOf(result, "src/example_tasks_sdk/client.py")).toContain("        body: _m._CreateTask_1,\n");
  });

  it("synthesizes one TypedDict per inline object, so references back through wrappers stay linear", () => {
    const node = { $ref: "#/components/schemas/Node" };
    const generateNode = (properties: Record<string, unknown>) => {
      const catalog = fixtureCatalog();
      catalog.schemas.Node = { type: "object", properties: { v: { type: "string" }, ...properties } };
      // The same wrapper shape in array items and in an operation's response body.
      // (Named to sort after Node: an inline object is named for the schema that first needs it.)
      catalog.schemas.Wood = { type: "array", items: { ...node, required: ["v"] } };
      const get = catalog.operations.find((operation: any) => operation.id === "tasks.get");
      get.responses.find((response: any) => response.status === "200").contents[0].schema = { allOf: [node, { required: ["v"] }] };
      const started = Date.now();
      const result = generatePython(catalog);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      const models = fileOf(result, "src/example_tasks_sdk/models.py");
      return { models, inline: models.match(/^_(?:Node|Wood|GetTask)_\d+ = _te\.TypedDict\(/gm)?.length ?? 0 };
    };
    const self = generateNode({ next: { ...node, required: ["v"] } });
    expect(self.models).toContain('_Node_1 = _te.TypedDict(\n    "_Node_1",\n    {\n        "next": _te.NotRequired["_Node_1"],\n        "v": "str",\n    },\n)');
    expect(self.models).toContain('        "next": _te.NotRequired["_Node_1"],\n        "v": _te.NotRequired["str"],\n');
    expect(self.models).toContain('Wood: _te.TypeAlias = "list[_Wood_1]"');
    expect(self.models).toContain('_Wood_1 = _te.TypedDict(\n    "_Wood_1",\n    {\n        "next": _te.NotRequired["_Node_1"],\n        "v": "str",\n    },\n)');
    // Node's property, Wood's items and the response body: one TypedDict each.
    expect(self.inline).toBe(3);
    const wrappers = (count: number, wrap: (index: number) => unknown) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, wrap(index)]));
    expect(generateNode(wrappers(2, () => ({ ...node, required: ["v"] }))).inline).toBe(4);
    expect(generateNode(wrappers(2, () => ({ allOf: [node, { required: ["v"] }] }))).inline).toBe(4);
    expect(generateNode(wrappers(6, (index) => (index % 2 ? { allOf: [node, { required: ["v"] }] } : { ...node, required: ["v"] }))).inline).toBe(8);
  });

  it("types each inline TypedDict the same however deep the schema that first needs it", () => {
    const catalog = fixtureCatalog();
    const count = 300;
    const name = (index: number) => `C${String(index).padStart(3, "0")}`;
    for (let index = 0; index < count; index++) {
      const next = index + 1 < count ? { $ref: `#/components/schemas/${name(index + 1)}`, required: ["v"] } : { type: "string" };
      catalog.schemas[name(index)] = { type: "object", properties: { v: { type: "string" }, p: next } };
    }
    const started = Date.now();
    const result = generatePython(catalog);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const models = fileOf(result, "src/example_tasks_sdk/models.py");
    // Typing C000 reaches every wrapper in the chain, past the nesting bound; each still requires v.
    expect(models).not.toMatch(/"p": _te\.NotRequired\["C\d+"\]/);
    for (let index = 0; index + 1 < count; index++) {
      const inline = `_${name(index)}_1`;
      expect(models).toContain(`        "p": _te.NotRequired["${inline}"],\n`);
      expect(models).toContain(`${inline} = _te.TypedDict(\n    "${inline}",\n    {\n        "p": _te.NotRequired["${index + 2 < count ? `_${name(index + 1)}_1` : "str"}"],\n        "v": "str",\n    },\n)`);
    }
  });

  it("widens alias cycles with a warning, and keeps recursion through objects and arrays", () => {
    const catalog = fixtureCatalog();
    catalog.schemas.A = { anyOf: [{ $ref: "#/components/schemas/B" }, { type: "number" }] };
    catalog.schemas.B = { anyOf: [{ $ref: "#/components/schemas/A" }, { type: "string" }] };
    catalog.schemas.Tree = { type: "array", items: { $ref: "#/components/schemas/Tree" } };
    const result = generatePython(catalog);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "SDK_SCHEMA_CYCLE").map((diagnostic) => [diagnostic.pointer, diagnostic.message])).toEqual([
      ["/schemas/B", expect.stringMatching(/refers back to "A".*Python type alias.*typed Any/)],
    ]);
    const models = fileOf(result, "src/example_tasks_sdk/models.py");
    expect(models).toContain('A: _te.TypeAlias = "B | float"');
    expect(models).toContain('B: _te.TypeAlias = "_t.Any"');
    expect(models).toContain('Tree: _te.TypeAlias = "list[Tree]"');
  });
});

describe("python target: generated layout", () => {
  it("indents every line of a TypedDict entry alike, comments included", () => {
    const catalog = fixtureCatalog();
    catalog.schemas.Documented = { type: "object", properties: { a: { type: "string", description: "First line.\nSecond line.", deprecated: true } } };
    const models = fileOf(generatePython(catalog), "src/example_tasks_sdk/models.py");
    expect(models).toContain('    {\n        # First line.\n        # Second line.\n        #\n        # Deprecated.\n        "a": _te.NotRequired["str"],\n    },\n');
  });

  it("imports custom code after the generated names, so it can import them from the package", () => {
    const index = fileOf(generatePython(), "src/example_tasks_sdk/__init__.py");
    const custom = index.indexOf("from . import custom as _custom\n");
    expect(custom).toBeGreaterThan(index.indexOf("from .models import ("));
    expect(custom).toBeGreaterThan(index.indexOf("from .client import ("));
    expect(custom).toBeGreaterThan(index.indexOf("from ._runtime import ("));
  });
});

describe("python target: custom code", () => {
  it("never rewrites or deletes the custom-code area, including when the import name changes", async () => {
    const dir = tempDir();
    expect((await writeSdk(dir, generatePython())).seeded).toEqual(["src/example_tasks_sdk/custom/__init__.py"]);
    const seed = path.join(dir, "src/example_tasks_sdk/custom/__init__.py");
    const extra = path.join(dir, "src/example_tasks_sdk/custom/extra.py");
    writeFileSync(seed, '__all__ = ["greet"]\nfrom .extra import greet\n');
    writeFileSync(extra, "def greet() -> str:\n    return 'hi'\n");

    const changed = pythonConfig();
    changed.options.timeoutMs = 3000;
    const rewritten = await writeSdk(dir, generatePython(fixtureCatalog(), changed));
    expect(rewritten).toMatchObject({ ok: true, written: ["apifn.sdk-manifest.json", "src/example_tasks_sdk/client.py"], seeded: [], deleted: [] });
    expect(readFileSync(seed, "utf8")).toBe('__all__ = ["greet"]\nfrom .extra import greet\n');
    expect(readFileSync(extra, "utf8")).toContain("def greet");

    const moved = pythonConfig();
    moved.options.module = "tasks_sdk";
    const result = await writeSdk(dir, generatePython(fixtureCatalog(), moved));
    expect(result.ok).toBe(true);
    expect(result.seeded).toEqual(["src/tasks_sdk/custom/__init__.py"]);
    expect(result.deleted).toEqual(["src/example_tasks_sdk/__init__.py", "src/example_tasks_sdk/_runtime.py", "src/example_tasks_sdk/client.py", "src/example_tasks_sdk/models.py", "src/example_tasks_sdk/py.typed"]);
    expect(existsSync(seed) && existsSync(extra)).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(dir, SDK_ARTIFACT_MANIFEST_FILE), "utf8"));
    expect(manifest.customCode.root).toBe("src/tasks_sdk/custom/");
  });

  it("refuses to overwrite an unowned file where the package would go", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "src/example_tasks_sdk"), { recursive: true });
    writeFileSync(path.join(dir, "src/example_tasks_sdk/client.py"), "# mine\n");
    const result = await writeSdk(dir, generatePython());
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SDK_OUTPUT_CONFLICT", pointer: "src/example_tasks_sdk/client.py" })]);
    expect(readFileSync(path.join(dir, "src/example_tasks_sdk/client.py"), "utf8")).toBe("# mine\n");
  });
});
