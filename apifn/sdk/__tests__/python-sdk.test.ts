// The generated Python SDK as a consumer gets it: built as a wheel and an sdist, installed into fresh virtual
// environments, type-checked with mypy --strict, run under pytest against a local server, and compared with the
// TypeScript client on the shared vectors. Needs Python 3.10+ and PyPI access (see python.ts).

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { validateClientFailureEvent } from "@apifn/contracts/failure-event";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeSdk, type SdkArtifactManifest } from "../src/index.js";
import { canonicalLicenseExpression } from "../src/targets/python/spdx.js";
import { buildFixtureSdk, cleanupTemp, clone, FIXTURES, fixtureCatalog, fixtureConfig, FixtureServer, generate, methodFor, okResponse, PACKAGE_DIR, paramsFor, readJson, tempDir } from "./helpers.js";
import { createVenv, findPython, PythonLog, REQUIREMENTS, venvPython } from "./python.js";

const MODULE = "example_tasks_sdk";
const CUSTOM_EXPORT = "custom_greeting";
const SETUP_MS = 15 * 60_000;

let work: string;
let log: PythonLog;
/** Interpreter of the environment with the build tools, and with them packaging. */
let tools: string;
let manifest: SdkArtifactManifest;
let sdk: string;
let wheel: string;
let sdist: string;
/** Interpreters of the environments the wheel and the sdist were installed into. */
let wheelPython: string;
let sdistPython: string;
/** A copy of tests-python outside the repository, so no repository path is importable. */
let tests: string;

beforeAll(async () => {
  work = tempDir("apifn-sdk-python-");
  log = new PythonLog(path.join(work, "python-sdk.log"));
  const python = findPython(log, work);
  tools = createVenv(log, python, path.join(work, "tools"), ["-r", REQUIREMENTS], work);

  // Generate, add custom code, and regenerate: the custom module must survive into the installed package.
  sdk = path.join(work, "example-tasks-sdk");
  const config = readJson("python/sdk.config.json");
  const first = generate(fixtureCatalog(), config);
  if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
  if (!(await writeSdk(sdk, first)).ok) throw new Error("write failed");
  writeFileSync(path.join(sdk, `src/${MODULE}/custom/__init__.py`), `from .greeting import ${CUSTOM_EXPORT}\n\n__all__: list[str] = ["${CUSTOM_EXPORT}"]\n`);
  // Custom code may import the generated names from the package, which imports it last.
  writeFileSync(
    path.join(sdk, `src/${MODULE}/custom/greeting.py`),
    `from .. import TasksClient\n\n\ndef ${CUSTOM_EXPORT}() -> str:\n    assert TasksClient.__name__ == "TasksClient"\n    return "custom code survives regeneration"\n`
  );
  const second = generate(fixtureCatalog(), config);
  const rewritten = await writeSdk(sdk, second);
  if (!rewritten.ok || rewritten.written.length + rewritten.seeded.length + rewritten.deleted.length > 0) throw new Error(`regeneration changed files: ${JSON.stringify(rewritten)}`);
  manifest = second.manifest!;
  log.note(`generated ${manifest.package.name} ${manifest.package.version} from ${manifest.catalog.digest} (release ${manifest.releaseId}) into ${sdk}`);

  const dist = path.join(work, "dist");
  log.run(tools, ["-m", "build", "--wheel", "--sdist", "--outdir", dist, sdk], { cwd: work });
  const built = readdirSync(dist);
  wheel = path.join(dist, built.find((file) => file.endsWith(".whl"))!);
  sdist = path.join(dist, built.find((file) => file.endsWith(".tar.gz"))!);
  wheelPython = createVenv(log, python, path.join(work, "wheel-env"), [wheel, "-r", REQUIREMENTS], work);
  sdistPython = createVenv(log, python, path.join(work, "sdist-env"), [sdist], work);
  tests = path.join(work, "tests");
  cpSync(path.join(PACKAGE_DIR, "tests-python"), tests, { recursive: true });
}, SETUP_MS);

afterAll(() => {
  log?.keep();
  cleanupTemp();
});

const testEnv = () => ({ APIFN_SDK_MODULE: MODULE, APIFN_SDK_FIXTURES: FIXTURES });

describe("generated Python package", () => {
  it("builds a wheel and an sdist holding the package, its types, custom code and provenance", () => {
    const listing = (archive: string) =>
      JSON.parse(
        log.run(
          venvPython(path.join(work, "tools")),
          ["-c", "import json, sys, tarfile, zipfile; a = sys.argv[1]; print(json.dumps(sorted(zipfile.ZipFile(a).namelist() if a.endswith('.whl') else [n.split('/', 1)[1] for n in tarfile.open(a).getnames() if '/' in n])))", archive],
          { cwd: work }
        )
      ) as string[];
    expect(path.basename(wheel)).toBe("example_tasks_sdk-1.0.0-py3-none-any.whl");
    expect(listing(wheel)).toEqual(
      expect.arrayContaining([`${MODULE}/__init__.py`, `${MODULE}/_runtime.py`, `${MODULE}/client.py`, `${MODULE}/models.py`, `${MODULE}/py.typed`, `${MODULE}/apifn.sdk-manifest.json`, `${MODULE}/custom/__init__.py`, `${MODULE}/custom/greeting.py`])
    );
    expect(listing(sdist)).toEqual(expect.arrayContaining(["pyproject.toml", "README.md", "apifn.sdk-manifest.json", `src/${MODULE}/client.py`, `src/${MODULE}/custom/greeting.py`]));
  });

  it("installs from the wheel and from the sdist into fresh environments and imports with no repository path", () => {
    const empty = path.join(work, "empty");
    mkdirSync(empty, { recursive: true });
    const probe = `
import importlib.metadata, json, pathlib, sys
import ${MODULE} as sdk
root = pathlib.Path(sdk.__file__).parent
print(json.dumps({"file": sdk.__file__, "path": sys.path, "version": importlib.metadata.version("example-tasks-sdk"),
  "summary": importlib.metadata.metadata("example-tasks-sdk")["Summary"],
  "requires": importlib.metadata.requires("example-tasks-sdk"), "digest": json.loads((root / "apifn.sdk-manifest.json").read_text())["catalog"]["digest"],
  "custom": sdk.${CUSTOM_EXPORT}(), "exports": sorted(sdk.__all__)}))
`;
    const repository = path.resolve(PACKAGE_DIR, "../..");
    for (const [name, interpreter] of [["wheel", wheelPython], ["sdist", sdistPython]] as const) {
      // -I: no script directory, current directory, user site-packages or PYTHON* variables on sys.path.
      const seen = JSON.parse(log.run(interpreter, ["-I", "-c", probe], { cwd: empty }));
      const environment = path.dirname(path.dirname(interpreter));
      expect(seen.file.startsWith(environment), name).toBe(true);
      expect(seen.path.filter((entry: string) => [repository, sdk, tests, empty].some((root) => entry.startsWith(root))), name).toEqual([]);
      expect(seen.version, name).toBe("1.0.0");
      // The description, with quotes, non-ASCII text and literal backslash sequences, reads back from pyproject.toml unchanged.
      expect(seen.summary, name).toBe(readJson("python/sdk.config.json").options.package.description);
      expect(seen.requires, name).toEqual(["httpx<0.29,>=0.28.1", "typing-extensions<5,>=4.12"]);
      expect(seen.digest, name).toBe(manifest.catalog.digest);
      expect(seen.custom, name).toBe("custom code survives regeneration");
      expect(seen.exports, name).toContain(CUSTOM_EXPORT);
    }
  });

  it("type-checks the installed package and typed consumers with mypy --strict for Python 3.10", () => {
    const mypy = ["-m", "mypy", "--strict", "--python-version", "3.10", "--no-incremental"];
    log.run(wheelPython, [...mypy, "-p", MODULE], { cwd: tests });
    // typed_consumer_errors.py passes only while mypy reports each misuse its ignore comments name.
    log.run(wheelPython, [...mypy, "typed_consumer.py", "typed_consumer_errors.py"], { cwd: tests });
  });

  it("passes the pytest suite: vectors, timeouts, cancellation, retries, transports and observation", () => {
    const events = path.join(work, "events.json");
    log.run(wheelPython, ["-m", "pytest", "-p", "no:cacheprovider", "-q", "-rA", tests], {
      cwd: tests,
      env: { ...testEnv(), APIFN_SDK_CATALOG_DIGEST: manifest.catalog.digest, APIFN_SDK_CUSTOM_EXPORT: CUSTOM_EXPORT, APIFN_SDK_EVENTS_OUT: events },
    });
    // The pytest suite wrote the observations it checked; they must be valid apifn.client-failure/v1 events.
    const observed = JSON.parse(readFileSync(events, "utf8")) as unknown[];
    expect(observed).toHaveLength(3);
    for (const event of observed) expect(validateClientFailureEvent(event)).toMatchObject({ ok: true });
  });

  it("type-checks a package generated from awkward schemas and names", () => {
    const catalog = fixtureCatalog();
    Object.assign(catalog.schemas, {
      Keywords: { type: "object", required: ["class"], properties: { class: { type: "string" }, "not-an-identifier": { type: "integer" }, 'quote"d': { type: "boolean" }, ["__proto__"]: {} } },
      Literals: { enum: ['a"b', "c\\d", "é😀", "\u0007", 1, -2, 2.5, true, null] },
      Nested: { type: ["object", "null"], properties: { owner: { type: "object", required: ["id"], properties: { id: { type: "string" }, tags: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } } } } },
      Tuple: { type: "array", prefixItems: [{ type: "string" }, { $ref: "#/components/schemas/Nested" }], items: false },
      Merged: { allOf: [{ $ref: "#/components/schemas/Keywords" }, { type: "object", properties: { class: { type: "integer" }, extra: { type: "string" } } }] },
      Choice: { oneOf: [{ $ref: "#/components/schemas/Task" }, { $ref: "#/components/schemas/Problem" }, { type: "string", format: "uuid" }] },
      Mixed: { allOf: [{ type: "string" }, { $ref: "#/components/schemas/Task" }] },
      Nothing: { type: "object", additionalProperties: false },
      Never: false,
      Anything: true,
      CycleA: { anyOf: [{ $ref: "#/components/schemas/CycleB" }, { type: "number" }] },
      CycleB: { anyOf: [{ $ref: "#/components/schemas/CycleA" }, { type: "string" }] },
      Tree: { type: "object", properties: { children: { type: "array", items: { $ref: "#/components/schemas/Tree" } }, parent: { $ref: "#/components/schemas/Tree" } } },
      // One part declares x, another only requires it.
      RequiredSplit: { allOf: [{ type: "object", properties: { x: { type: "string" } } }, { type: "object", required: ["x"] }] },
      // A reference, alone or as the one allOf member, with a required name its referent leaves optional.
      Optional: { type: "object", properties: { x: { type: "string" }, w: { type: "string" } } },
      OneRefReq: { allOf: [{ $ref: "#/components/schemas/Optional" }], required: ["x"] },
      RefSiblingReq: { $ref: "#/components/schemas/Optional", required: ["x"] },
      // A wrapper that refers back to its own component: one inline TypedDict, whose field names itself.
      Linked: { type: "object", properties: { v: { type: "string" }, next: { $ref: "#/components/schemas/Linked", required: ["v"] } } },
    });
    // Parameters whose schemas also admit values the client cannot serialize are narrowed to ParamValue and DeepObjectValue.
    const lookup = catalog.operations.find((operation: any) => operation.id === "tasks.lookup");
    const parameter = { required: false, deprecated: false, allowReserved: false, description: null };
    lookup.parameters.push({ ...parameter, name: "extra", in: "query", style: "form", explode: true, schema: { type: "object" } }, { ...parameter, name: "where", in: "query", style: "deepObject", explode: true, schema: { type: ["object", "string"], additionalProperties: { type: "string" } } });
    const create = catalog.operations.find((operation: any) => operation.id === "tasks.create");
    create.requestBody.contents[0].schema = { type: "object", required: ["title"], properties: { title: { type: "string" }, meta: { type: "object", properties: { from: { $ref: "#/components/schemas/Keywords" } } } } };
    create.responses[0].contents[0].schema = { anyOf: [{ $ref: "#/components/schemas/Merged" }, { $ref: "#/components/schemas/Tuple" }, { $ref: "#/components/schemas/CycleA" }] };
    // Methods named as builtins the client's annotations use (list, str, bytes, ...), ahead of methods using them.
    const builtinNames: Record<string, string> = {
      "tasks.export": "list",
      "system.health": "str",
      "tasks.attachment.download": "bytes",
      "tasks.attachment.upload": "bytearray",
      "tasks.replace": "memoryview",
      "tasks.filter": "float",
      "tasks.archive": "int",
      "projects.summary.get": "dict",
      "tasks.find": "bool",
      "tasks.delete": "object",
    };
    for (const operation of catalog.operations) operation.name = builtinNames[operation.id] ?? operation.name;
    const config = readJson("python/sdk.config.json");
    config.options.package.name = "awkward-sdk";
    const result = generate(catalog, config);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const dir = tempDir();
    return writeSdk(dir, result).then((written) => {
      expect(written.ok).toBe(true);
      const client = readFileSync(path.join(dir, "src/awkward_sdk/client.py"), "utf8");
      expect(client).toMatch(/extra: _ParamValue \| None = None,\n[\s\S]*where: _DeepObjectValue \| None = None,/);
      expect(client).toContain("    async def list(\n");
      expect(client).toContain("        project_id: _b.str,\n");
      // The misuse module passes only while mypy reports the missing required key its ignore comment names.
      const misuse = ["RequiredSplit", "OneRefReq", "RefSiblingReq"].map((name) => `ok_${name}: ${name} = {"x": "a"}\nmissing_${name}: ${name} = {}  # type: ignore[typeddict-item]\n`);
      const linked = `linked: Linked = {"next": {"v": "a", "next": {"v": "b"}}}\nmissing_inner: Linked = {"next": {"v": "a", "next": {}}}  # type: ignore[typeddict-item]\n`;
      const calls = `\n\nasync def call(client: TasksClient) -> None:\n    await client.str()\n    await client.int(project_id="p", task_id="t")\n    await client.int(project_id=1, task_id="t")  # type: ignore[arg-type]\n`;
      writeFileSync(path.join(dir, "src/required_misuse.py"), `from awkward_sdk import Linked, OneRefReq, Optional, RefSiblingReq, RequiredSplit, TasksClient\n\noptional: Optional = {}\n${misuse.join("")}${linked}${calls}`);
      log.run(wheelPython, ["-m", "mypy", "--strict", "--python-version", "3.10", "--no-incremental", "awkward_sdk", "required_misuse.py"], { cwd: path.join(dir, "src") });
      // And it imports: every quoted type and inline TypedDict is valid at runtime too.
      const keys = log.run(wheelPython, ["-c", "import json, awkward_sdk, typing; typing.get_type_hints(awkward_sdk.Keywords); print(json.dumps(sorted(awkward_sdk.Keywords.__required_keys__)))"], { cwd: path.join(dir, "src") });
      expect(JSON.parse(keys)).toEqual(["class"]);
      const required = log.run(
        wheelPython,
        ["-c", "import json, typing, awkward_sdk as m; typing.get_type_hints(m.models._Linked_1); print(json.dumps([sorted(t.__required_keys__) for t in (m.RequiredSplit, m.OneRefReq, m.RefSiblingReq, m.Optional, m.Linked, m.models._Linked_1)]))"],
        { cwd: path.join(dir, "src") }
      );
      expect(JSON.parse(required)).toEqual([["x"], ["x"], ["x"], [], [], ["v"]]);
    });
  });
});

/** The keys a request is compared on: what the operation, credentials and body decide, not the transport. */
const TRANSPORT_HEADERS = new Set(["host", "connection", "user-agent", "accept-encoding", "accept-language", "sec-fetch-mode", "content-length", "transfer-encoding"]);

describe("license expressions", () => {
  it("are accepted, and normalized, as packaging (which hatchling validates them with) accepts and normalizes them", () => {
    const expressions = [
      "MIT", "Apache-2.0 OR MIT", "(MIT AND BSD-3-Clause)", "GPL-2.0-only WITH Classpath-exception-2.0", "LicenseRef-Custom", "GPL-2.0+", "GPL-2.0",
      "mit or apache-2.0 with llvm-exception", "licenseref-a.B-2 AND LicenseRef-A.b-2", "  MIT\u00a0OR  (Apache-2.0)", "((MIT))", "MIT AND (Apache-2.0 OR 0BSD)",
      "(MIT)", "(((MIT)))", "((MIT) AND BSD-3-Clause)", "MIT AND ((Apache-2.0))", "MIT AND (Apache-2.0 OR (0BSD))",
      "MIT AND", "see LICENSE", "(", ")", "( )", "", "Foo-Bar", "Classpath-exception-2.0", "MIT WITH Apache-2.0", "MIT WITH", "WITH Classpath-exception-2.0",
      "MIT WITH Classpath-exception-2.0 WITH LLVM-exception", "(MIT) WITH LLVM-exception", "MIT (Apache-2.0)", "MIT OR OR Apache-2.0", "LicenseRef-", "LicenseRef-a_b",
      "LicenseRef-A+", "MIT+ WITH LLVM-exception", "Apache-2.0 WITH LicenseRef-X",
    ];
    // packaging 24.2, the oldest hatchling allows, and the packaging 26.3 that requirements.txt pins.
    const floor = path.join(work, "packaging-24.2");
    log.run(tools, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-deps", "--target", floor, "packaging==24.2"], { cwd: work });
    const script = [
      "import json, sys",
      "if len(sys.argv) > 1: sys.path.insert(0, sys.argv[1])",
      "from packaging.licenses import InvalidLicenseExpression, canonicalize_license_expression",
      "def canonical(expression):",
      "    try:",
      "        return canonicalize_license_expression(expression)",
      // packaging 24.2 raises KeyError for a LicenseRef ending in +; the build backend fails on it either way.
      "    except (InvalidLicenseExpression, KeyError):",
      "        return None",
      "print(json.dumps([canonical(expression) for expression in json.load(sys.stdin)]))",
    ].join("\n");
    const canonical = (...floorPath: string[]) => JSON.parse(log.run(tools, ["-I", "-c", script, ...floorPath], { cwd: work, input: JSON.stringify(expressions) })) as Array<string | null>;
    const [current, oldest] = [canonical(), canonical(floor)];
    expect(log.run(tools, ["-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import packaging; print(packaging.__version__)", floor], { cwd: work }).trim()).toBe("24.2");
    // An expression is accepted only when both versions accept it, and then both normalize it alike.
    const expected = expressions.map((_, index) => (current[index] !== null && current[index] === oldest[index] ? current[index] : null));
    expect(expressions.filter((_, index) => current[index] !== null && oldest[index] !== null && current[index] !== oldest[index])).toEqual([]);
    expect(expressions.map(canonicalLicenseExpression)).toEqual(expected);
    // Each version is exercised: some expression only the newer one accepts.
    expect(expressions.filter((_, index) => current[index] !== null && oldest[index] === null)).toEqual(expect.arrayContaining(["((MIT))"]));
  });
});

describe("cross-language vectors", () => {
  const server = new FixtureServer();
  const catalog = fixtureCatalog();
  let typescript: any;
  let driver: ChildProcessWithoutNullStreams;
  let replies: AsyncIterator<string>;

  beforeAll(async () => {
    await server.start();
    typescript = (await buildFixtureSdk()).sdk;
    // -E -s: no PYTHON* variables or user site-packages; the script directory is the copied tests.
    driver = spawn(wheelPython, ["-E", "-s", "vector_driver.py"], { cwd: tests, env: { ...process.env, ...testEnv() } });
    driver.stderr.on("data", (chunk) => log.note(`driver: ${String(chunk)}`));
    replies = createInterface({ input: driver.stdout })[Symbol.asyncIterator]();
  }, SETUP_MS);

  afterAll(async () => {
    driver?.stdin.end();
    await server.stop();
  });

  const requests = () =>
    server.requests.map((request) => ({
      method: request.method,
      path: request.path,
      query: request.query,
      headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => !TRANSPORT_HEADERS.has(name)).sort(([a], [b]) => (a < b ? -1 : 1))),
      body: request.body.toString("base64"),
    }));
  const normalize = (value: unknown) => (value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString("base64") } : (value ?? null));
  const observation = (event: any) => ({ api: event.api, operation: event.operation, catalogDigest: event.release.catalogDigest, failure: event.failure });

  async function viaTypeScript(vector: any, settings: { credentials?: unknown; maxAttempts?: number }) {
    const events: any[] = [];
    const client = new typescript.TasksClient({ baseUrl: server.baseUrl, credentials: settings.credentials, retry: settings.maxAttempts ? { maxAttempts: settings.maxAttempts } : undefined, onFailure: (event: any) => events.push(event) });
    let outcome: unknown;
    try {
      outcome = { ok: true, result: normalize(await client[methodFor(catalog, vector.operation)](paramsFor(catalog, vector.operation, vector))) };
    } catch (error: any) {
      outcome = { ok: false, kind: error.kind, attempts: error.attempts, ...(error instanceof typescript.ApiHttpError ? { status: error.status, declared: error.declared, body: normalize(error.body) } : {}) };
    }
    return { outcome, events };
  }

  async function viaPython(vector: any, settings: { credentials?: unknown; maxAttempts?: number }) {
    driver.stdin.write(`${JSON.stringify({ baseUrl: server.baseUrl, case: vector, ...settings })}\n`);
    const line = await replies.next();
    if (line.done) throw new Error("the Python vector driver exited; see the log");
    return JSON.parse(line.value) as { outcome: unknown; events: any[] };
  }

  async function compare(vector: any, responses: any[], settings: { credentials?: unknown; maxAttempts?: number }) {
    const results = [];
    for (const run of [viaTypeScript, viaPython]) {
      server.reset(clone(responses));
      const { outcome, events } = await run(vector, settings);
      results.push({ outcome, requests: requests(), events: events.map(observation) });
      for (const event of events) expect(validateClientFailureEvent(event), JSON.stringify(event)).toMatchObject({ ok: true });
    }
    const [ts, py] = results as [any, any];
    if (py.outcome.rejectedAtCall) {
      // Python binds keyword arguments before the method runs: a missing required one is a TypeError at the call,
      // so the runtime and its observer never see it. TypeScript observes the same rejection as validation.
      delete py.outcome.rejectedAtCall;
      expect(ts.events.map((event: any) => event.failure), vector.name).toEqual([{ kind: "validation", retryable: false, attempt: 1 }]);
      expect(py.events, vector.name).toEqual([]);
      py.events = ts.events;
    }
    expect(py, vector.name).toEqual(ts);
    return ts;
  }

  const serialization = readJson("vectors/serialization.json");
  const auth = readJson("vectors/auth.json");
  const errors = readJson("vectors/errors.json");
  const retry = readJson("vectors/retry.json");
  // Beyond the shared vectors: redirects whose Location is not a valid URL, with retries on. Both clients return
  // them as they arrived, after one request.
  const redirects = [
    ["an unclosed IPv6 host", 302, "http://[::1"],
    ["an invalid IPv6 host", 301, "http://[zz]/"],
  ].map(([what, status, location]) => ({
    name: `a redirect whose Location has ${what} is returned after one request`,
    operation: "tasks.get",
    parameters: { path: { projectId: "p1", taskId: "t1" } },
    response: { status, headers: { "content-type": "text/plain", location }, body: "moved" },
  }));
  const groups: Array<[string, any[], (vector: any) => [any[], { credentials?: unknown; maxAttempts?: number }]]> = [
    ["serialization", [...serialization.cases, ...serialization.rejected], (vector) => [[okResponse(catalog, vector.operation)], {}]],
    ["auth", [...auth.cases, ...auth.rejected], (vector) => [[okResponse(catalog, vector.operation)], { credentials: vector.credentials }]],
    ["errors", errors.cases, (vector) => [[vector.response], { maxAttempts: 1 }]],
    ["redirect", redirects, (vector) => [[vector.response], {}]],
    [
      "retry",
      retry.cases,
      (vector) => [vector.responses.map((response: any) => ({ ...response, headers: { "content-type": "application/json", ...response.headers }, body: "{}" })), { credentials: { bearerAuth: "t", apiKeyQuery: "k" } }],
    ],
  ];
  for (const [group, vectors, setup] of groups) {
    it(`gives the TypeScript client's requests, results, errors and observations for every ${group} vector`, async () => {
      const summary: unknown[] = [];
      for (const vector of vectors) {
        const [responses, settings] = setup(vector);
        const result = await compare(vector, responses, settings);
        summary.push({ vector: vector.name, outcome: result.outcome, requests: result.requests.length });
      }
      log.note(`${group}: ${vectors.length} vectors equal across TypeScript and Python\n${JSON.stringify(summary)}`);
    });
  }

  it("covers every shared vector", () => {
    const count = serialization.cases.length + serialization.rejected.length + auth.cases.length + auth.rejected.length + errors.cases.length + retry.cases.length;
    expect(count).toBeGreaterThanOrEqual(60);
    expect(fixtureConfig().options.retry).toEqual(readJson("python/sdk.config.json").options.retry);
  });
});
