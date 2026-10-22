import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateSdk, SDK_ARTIFACT_MANIFEST_FILE, writeSdk, type SdkTarget } from "../src/index.js";
import { cleanupTemp, fixtureCatalog, fixtureConfig, generate, tempDir } from "./helpers.js";

afterAll(cleanupTemp);

/** Every file under `dir` with its contents, sorted by path. */
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

/** Sets every file's mtime to the epoch so a rewrite is visible even within one clock tick. */
function age(dir: string): void {
  for (const file of Object.keys(snapshot(dir))) utimesSync(path.join(dir, file), 0, 0);
}

const modified = (dir: string) => Object.keys(snapshot(dir)).filter((file) => statSync(path.join(dir, file)).mtimeMs !== 0);

/** A minimal second target: one owned file per operation, to exercise the adapter contract outside TypeScript. */
const listTarget: SdkTarget<{ package: { name: string; version: string } }> = {
  id: "list",
  version: "1.0.0",
  customCodeRoot: "custom/",
  resolveOptions: (input) => ({ options: input as { package: { name: string; version: string } }, diagnostics: [] }),
  packageOf: (options) => options.package,
  unsupportedReasons: (operation) => (operation.method === "trace" ? ["TRACE is not supported"] : []),
  emit: (context) => ({
    files: [
      ...context.operations.map((operation) => ({ path: `ops/${operation.id}.txt`, contents: `${operation.method} ${operation.path}\n`, ownership: "generated" as const })),
      { path: "custom/notes.txt", contents: "seed\n", ownership: "seed" as const },
    ],
    diagnostics: [],
  }),
};

describe("writeSdk", () => {
  it("writes a package, then regenerates byte-identically without touching any file", async () => {
    const dir = tempDir();
    const first = await writeSdk(dir, generate());
    expect(first.ok).toBe(true);
    expect(first.seeded).toEqual(["src/custom/index.ts"]);
    expect(first.written).toContain("src/client.ts");
    const before = snapshot(dir);
    age(dir);
    const second = await writeSdk(dir, generate());
    expect(second).toMatchObject({ ok: true, written: [], deleted: [], seeded: [] });
    expect(snapshot(dir)).toEqual(before);
    expect(modified(dir)).toEqual([]);
  });

  it("after a catalog change rewrites only changed owned files and keeps custom code and other files", async () => {
    const dir = tempDir();
    await writeSdk(dir, generate());
    writeFileSync(path.join(dir, "src/custom/index.ts"), 'export const custom = "kept";\n');
    mkdirSync(path.join(dir, "src/custom/deep"));
    writeFileSync(path.join(dir, "src/custom/deep/helper.ts"), "export const helper = 1;\n");
    writeFileSync(path.join(dir, "NOTES.md"), "mine\n");
    const before = snapshot(dir);
    age(dir);

    const catalog = fixtureCatalog();
    catalog.schemas.Task.properties.priority = { type: "integer" };
    catalog.source.specDigest = `sha256:${"1".repeat(64)}`;
    const result = await writeSdk(dir, generate(catalog));
    expect(result.ok).toBe(true);
    expect(result.written.sort()).toEqual(["README.md", "apifn.sdk-manifest.json", "src/client.ts", "src/models.ts"]);
    expect(modified(dir).sort()).toEqual(result.written.sort());
    const after = snapshot(dir);
    for (const file of ["src/custom/index.ts", "src/custom/deep/helper.ts", "NOTES.md", "src/runtime.ts", "package.json"]) expect(after[file]).toBe(before[file]);
    expect(after["src/models.ts"]).toContain("priority?: number;");
  });

  it("deletes owned files a later generation no longer produces, and nothing else", async () => {
    const dir = tempDir();
    const config = { target: "list", options: { package: { name: "list-sdk", version: "1.0.0" } } };
    const build = (catalog: unknown) => generateSdk({ catalog, config, targets: [listTarget] });
    expect((await writeSdk(dir, build(fixtureCatalog()))).ok).toBe(true);
    expect(existsSync(path.join(dir, "ops/tasks.delete.txt"))).toBe(true);
    writeFileSync(path.join(dir, "ops/mine.txt"), "user file\n");

    const catalog = fixtureCatalog();
    catalog.operations = catalog.operations.filter((operation: any) => operation.id !== "tasks.delete");
    const result = await writeSdk(dir, build(catalog));
    expect(result).toMatchObject({ ok: true, deleted: ["ops/tasks.delete.txt"] });
    expect(existsSync(path.join(dir, "ops/tasks.delete.txt"))).toBe(false);
    expect(readFileSync(path.join(dir, "ops/mine.txt"), "utf8")).toBe("user file\n");
    expect(readFileSync(path.join(dir, "custom/notes.txt"), "utf8")).toBe("seed\n");
    const manifest = JSON.parse(readFileSync(path.join(dir, SDK_ARTIFACT_MANIFEST_FILE), "utf8"));
    expect(manifest.files.map((entry: any) => entry.path)).not.toContain("ops/tasks.delete.txt");
    expect(manifest.target).toEqual({ id: "list", version: "1.0.0" });
  });

  it("refuses to replace a file it does not own, leaving the directory untouched", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src/client.ts"), "// hand-written\n");
    const before = snapshot(dir);
    const result = await writeSdk(dir, generate());
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SDK_OUTPUT_CONFLICT", pointer: "src/client.ts" })]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("replaces an edited owned file with a warning", async () => {
    const dir = tempDir();
    await writeSdk(dir, generate());
    const original = readFileSync(path.join(dir, "src/client.ts"), "utf8");
    writeFileSync(path.join(dir, "src/client.ts"), `${original}// local edit\n`);
    const result = await writeSdk(dir, generate());
    expect(result.ok).toBe(true);
    expect(result.written).toEqual(["src/client.ts"]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SDK_OWNED_FILE_MODIFIED", severity: "warning", pointer: "src/client.ts" })]);
    expect(readFileSync(path.join(dir, "src/client.ts"), "utf8")).toBe(original);
  });

  it("plans without writing in a dry run", async () => {
    const dir = tempDir();
    const result = await writeSdk(dir, generate(), { dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.written.length).toBeGreaterThan(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses to write through a symlinked directory", async () => {
    const dir = tempDir();
    const outside = tempDir();
    symlinkSync(outside, path.join(dir, "src"), "dir");
    const result = await writeSdk(dir, generate());
    expect(result.ok).toBe(false);
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === "SDK_OUTPUT_CONFLICT")).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses an unreadable previous manifest", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, SDK_ARTIFACT_MANIFEST_FILE), "{");
    const result = await writeSdk(dir, generate());
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: "SDK_OUTPUT_CONFLICT", pointer: SDK_ARTIFACT_MANIFEST_FILE });
  });

  it("writes nothing for a failed generation", async () => {
    const dir = tempDir();
    const config = fixtureConfig();
    delete config.unsupported;
    const result = await writeSdk(dir, generate(fixtureCatalog(), config));
    expect(result.ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects target output outside the package or the custom-code rules", () => {
    const bad = (files: Array<{ path: string; ownership: "generated" | "seed" }>) =>
      generateSdk({
        catalog: fixtureCatalog(),
        config: { target: "list", options: { package: { name: "list-sdk", version: "1.0.0" } } },
        targets: [{ ...listTarget, emit: () => ({ files: files.map((file) => ({ ...file, contents: "" })), diagnostics: [] }) }],
      });
    for (const files of [
      [{ path: "../escape.txt", ownership: "generated" as const }],
      [{ path: "/abs.txt", ownership: "generated" as const }],
      [{ path: "custom/owned.txt", ownership: "generated" as const }],
      [{ path: "seed.txt", ownership: "seed" as const }],
      [{ path: SDK_ARTIFACT_MANIFEST_FILE, ownership: "generated" as const }],
      [
        { path: "A.txt", ownership: "generated" as const },
        { path: "a.txt", ownership: "generated" as const },
      ],
    ]) {
      const result = bad(files);
      expect(result.ok, JSON.stringify(files)).toBe(false);
      expect(result.files).toEqual([]);
    }
  });
});
