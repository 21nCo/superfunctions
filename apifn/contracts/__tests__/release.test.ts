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

  it.each<[string, () => unknown, string]>([
    ["a null input", () => null, ""],
    ["a catalog without operations", () => ({ ...input(), catalog: { catalogVersion: CATALOG_VERSION } }), "/catalog"],
    ["an operation without sdk flags", () => {
      const next = input();
      delete (next.catalog.operations[0] as any).sdk;
      return next;
    }, "/catalog"],
    ["a catalog holding a Map", () => ({ ...input(), catalog: { ...clone(catalog), schemas: new Map() } }), "/catalog"],
    ["a non-string release ID", () => ({ ...input(), releaseId: 7 }), "/releaseId"],
  ])("INVALID_RELEASE instead of throwing for %s", (_name, make, pointer) => {
    let result: ReturnType<typeof createReleaseDescriptor> | undefined;
    expect(() => {
      result = createReleaseDescriptor(make() as CreateReleaseInput);
    }).not.toThrow();
    expect(result!.descriptor).toBeNull();
    expect(result!.diagnostics).toEqual([expect.objectContaining({ code: "INVALID_RELEASE", pointer })]);
  });
});
