import { describe, expect, it } from "vitest";
import { buildOperationCatalog, CATALOG_VERSION, canonicalJson, createReleaseDescriptor, type CreateReleaseInput } from "../src/index.js";
import { clone, fixture, matchFixture } from "./helpers.js";

const catalog = buildOperationCatalog(fixture("catalog/openapi.json"), fixture("catalog/manifest.json")).catalog!;

function input(overrides: Partial<CreateReleaseInput> = {}): CreateReleaseInput {
  return {
    catalog: clone(catalog),
    generator: { name: "@apifn/contracts-fixture", version: "0.1.0" },
    artifacts: [
      { kind: "sdk", target: "typescript", package: { name: "@example/projects-sdk", version: "2026.10.1" } },
      { kind: "agent-tools", target: "mcp", package: { name: "@example/projects-mcp", version: "2026.10.1" } },
      { kind: "sdk", target: "python", package: { name: "example-projects", version: "2026.10.1" } },
    ],
    ...overrides,
  };
}

describe("createReleaseDescriptor", () => {
  it("matches the committed release descriptor fixture", () => {
    const { descriptor, diagnostics } = createReleaseDescriptor(input());
    expect(diagnostics).toEqual([]);
    expect(descriptor).toEqual(matchFixture("catalog/release-descriptor.json", descriptor));
  });

  it("separates SDK inclusion, target exclusion and agent exposure per artifact", () => {
    const { descriptor } = createReleaseDescriptor(input());
    const operations = Object.fromEntries(descriptor!.artifacts.map((artifact) => [`${artifact.kind}:${artifact.target}`, artifact.operations]));
    expect(operations).toEqual({
      "agent-tools:mcp": ["projects.create", "projects.list"],
      "sdk:python": ["projects.create", "projects.delete", "projects.get", "projects.list"],
      "sdk:typescript": ["projects.archive", "projects.create", "projects.delete", "projects.get", "projects.list"],
    });
  });

  it("keeps every version axis distinct and derives a deterministic release ID", () => {
    const first = createReleaseDescriptor(input()).descriptor!;
    expect(canonicalJson(createReleaseDescriptor(input()).descriptor)).toBe(canonicalJson(first));
    expect(first).toMatchObject({
      descriptorVersion: "apifn.release-descriptor/v1",
      api: { id: "example.projects", version: "2026-10-01" },
      specDigest: catalog.source.specDigest,
      manifestDigest: catalog.source.manifestDigest,
      generator: { version: "0.1.0" },
      releaseId: expect.stringMatching(/^rel_[0-9a-f]{24}$/),
    });

    const bumped = input();
    bumped.artifacts[0].package.version = "2026.10.2";
    const regenerated = createReleaseDescriptor({ ...input(), generator: { name: "@apifn/contracts-fixture", version: "0.2.0" } }).descriptor!;
    expect(createReleaseDescriptor(bumped).descriptor!.releaseId).not.toBe(first.releaseId);
    expect(regenerated.releaseId).not.toBe(first.releaseId);
    expect(regenerated.catalogDigest).toBe(first.catalogDigest);
    expect(createReleaseDescriptor(input({ releaseId: "2026.10.1-rc.1" })).descriptor!.releaseId).toBe("2026.10.1-rc.1");
  });

  it.each(["01.0.0", "1.00.0", "1.0.0-alpha..1", "1.0.0-01", "1.0.0-", "1.0.0+", "1.0.0+a..b", "1.0"])("INVALID_RELEASE: generator version %s is not SemVer 2.0.0", (version) => {
    const result = createReleaseDescriptor(input({ generator: { name: "@apifn/sdk-typescript", version } }));
    expect(result.descriptor).toBeNull();
    expect(result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.pointer}`)).toEqual(["INVALID_RELEASE /generator/version"]);
  });

  it.each(["0.0.0", "10.20.30", "1.0.0-alpha.1", "1.0.0-0.3.7", "1.0.0-x-y.0a", "1.0.0-rc.1+build.001", "1.0.0+20261014"])("accepts generator version %s", (version) => {
    expect(createReleaseDescriptor(input({ generator: { name: "@apifn/sdk-typescript", version } })).diagnostics).toEqual([]);
  });

  it("INVALID_RELEASE: rejects malformed generators, artifacts, duplicates and release IDs", () => {
    const result = createReleaseDescriptor(
      input({
        generator: { name: "Not A Package", version: "latest" },
        releaseId: "../escape",
        artifacts: [
          { kind: "sdk", target: "typescript", package: { name: "@example/projects-sdk", version: "1.0.0" } },
          { kind: "sdk", target: "typescript", package: { name: "@example/other", version: "1.0.0" } },
          { kind: "cli" as never, target: "go", package: { name: "projects", version: "1.0.0" } },
          { kind: "sdk", target: "Rust", package: { name: "projects", version: "1.0.0" } },
          { kind: "sdk", target: "go", package: { name: "projects", version: "" } },
        ],
      })
    );
    expect(result.descriptor).toBeNull();
    expect(result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.pointer}`)).toEqual([
      "INVALID_RELEASE /generator/name",
      "INVALID_RELEASE /generator/version",
      "INVALID_RELEASE /releaseId",
      "INVALID_RELEASE /artifacts/1",
      "INVALID_RELEASE /artifacts/2/kind",
      "INVALID_RELEASE /artifacts/3/target",
      "INVALID_RELEASE /artifacts/4/package/version",
    ]);
    expect(createReleaseDescriptor({ ...input(), catalog: {} as never }).diagnostics[0].pointer).toBe("/catalog/catalogVersion");
  });

  it.each<[string, () => unknown, string[]]>([
    ["a null input", () => null, [""]],
    ["a catalog without api, source or operations", () => ({ ...input(), catalog: { catalogVersion: CATALOG_VERSION } }), [
      "/catalog/api/id", "/catalog/api/version", "/catalog/source/specDigest", "/catalog/source/manifestDigest", "/catalog/operations",
    ]],
    ["an operation without sdk flags", () => {
      const next = input();
      delete (next.catalog.operations[0] as any).sdk;
      return next;
    }, ["/catalog/operations/0"]],
    ["an operation ID outside the contract", () => {
      const next = input();
      next.catalog.operations[0].id = "Not An ID";
      return next;
    }, ["/catalog/operations/0/id"]],
    ["a catalog holding a Map", () => ({ ...input(), catalog: { ...clone(catalog), schemas: new Map() } }), ["/catalog/schemas"]],
    ["a generator given as a class instance", () => ({ ...input(), generator: new (class Generator { name = "x"; version = "1.0.0"; })() }), ["/generator"]],
    ["a throwing getter", () => Object.defineProperty(input(), "releaseId", { enumerable: true, get: () => { throw new Error("boom"); } }), [""]],
    ["a non-string release ID", () => ({ ...input(), releaseId: 7 }), ["/releaseId"]],
    ["a cycle in the catalog", () => {
      const next = input();
      (next.catalog.schemas as any).Loop = { self: next.catalog.schemas };
      return next;
    }, ["/catalog/schemas/Loop/self"]],
  ])("INVALID_RELEASE instead of throwing for %s", (_name, make, pointers) => {
    let result: ReturnType<typeof createReleaseDescriptor> | undefined;
    expect(() => {
      result = createReleaseDescriptor(make() as CreateReleaseInput);
    }).not.toThrow();
    expect(result!.descriptor).toBeNull();
    expect(result!.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.pointer}`)).toEqual(pointers.map((pointer) => `INVALID_RELEASE ${pointer}`));
  });

  it("accepts every catalog the builder accepts, however deeply its schemas nest", () => {
    const nested = (levels: number) => {
      const spec = fixture("catalog/openapi.json");
      let schema: Record<string, unknown> = { type: "string" };
      for (let level = 0; level < levels; level += 1) schema = { type: "object", properties: { a: schema } };
      // Behind a reference outside components, the parameter lands deeper in the catalog than in the document.
      spec["x-deep"] = { name: "deep", in: "query", schema };
      spec.paths["/workspaces/{workspaceId}/projects/{projectId}"].get.parameters.push({ $ref: "#/x-deep" });
      return buildOperationCatalog(spec, fixture("catalog/manifest.json"));
    };
    let levels = 100;
    while (nested(levels + 1).catalog) levels += 1;
    const deepest = nested(levels);
    expect(deepest.catalog).not.toBeNull();
    expect(nested(levels + 1).diagnostics).toEqual([expect.objectContaining({ code: "INVALID_SPEC", message: expect.stringMatching(/nests deeper than/) })]);
    const { descriptor, diagnostics } = createReleaseDescriptor({ ...input(), catalog: deepest.catalog! });
    expect(diagnostics).toEqual([]);
    expect(descriptor).not.toBeNull();
  });

  it("reads its input once, so a getter cannot change a value after it was checked", () => {
    let reads = 0;
    const generator = { version: "0.1.0" };
    Object.defineProperty(generator, "name", { enumerable: true, get: () => (reads++ === 0 ? "@apifn/contracts-fixture" : "sk_live_abcdefgh12345678") });
    const { descriptor } = createReleaseDescriptor({ ...input(), generator } as CreateReleaseInput);
    expect(reads).toBe(1);
    expect(descriptor!.generator.name).toBe("@apifn/contracts-fixture");
  });

  it.each<[string, (next: CreateReleaseInput) => void, string]>([
    ["generator.name", (next) => { next.generator.name = "sk_live_abcdefgh12345678"; }, "/generator/name"],
    ["an artifact package name", (next) => { next.artifacts[0].package.name = "sk_live_abcdefgh12345678"; }, "/artifacts/0/package/name"],
    ["releaseId", (next) => { next.releaseId = "sk_live_abcdefgh12345678"; }, "/releaseId"],
  ])("INVALID_RELEASE: a credential in %s", (_name, mutate, pointer) => {
    const next = input();
    mutate(next);
    const result = createReleaseDescriptor(next);
    expect(result.descriptor).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "INVALID_RELEASE", pointer })]);
    expect(JSON.stringify(result)).not.toContain("abcdefgh12345678");
  });
});
