// An interrupted writeSdk run: the next run must not mistake files the
// interrupted run already rewrote for hand edits.

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SDK_ARTIFACT_MANIFEST_FILE, writeSdk } from "../src/index.js";
import { cleanupTemp, fixtureCatalog, generate, tempDir } from "./helpers.js";

const failRename = vi.hoisted(() => ({ target: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failRename.target !== null && to === failRename.target) throw Object.assign(new Error("simulated crash"), { code: "EIO" });
      return actual.rename(from, to);
    },
  };
});

afterAll(cleanupTemp);

function catalogVersion(summary: string, extraSchema: string) {
  const catalog = fixtureCatalog();
  catalog.operations.find((operation: any) => operation.id === "tasks.get").summary = summary;
  catalog.schemas[extraSchema] = { type: "string" };
  return catalog;
}

const manifestOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, SDK_ARTIFACT_MANIFEST_FILE), "utf8"));

describe("an interrupted write", () => {
  it("keeps the previous provenance and accepts either version of each file on the next run", async () => {
    const dir = tempDir();
    const v1 = generate();
    expect((await writeSdk(dir, v1)).ok).toBe(true);

    // README.md is rewritten, then the run stops before src/client.ts, src/models.ts and the final manifest.
    const v2 = generate(catalogVersion("Get a task (v2)", "ExtraTwo"));
    failRename.target = path.join(dir, "src/client.ts");
    await expect(writeSdk(dir, v2)).rejects.toThrow("simulated crash");
    failRename.target = null;
    expect(readdirSync(path.join(dir, "src")).filter((name) => name.includes(".apifn-tmp-"))).toEqual([]);
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe(v2.files.find((file) => file.path === "README.md")!.contents);
    const interim = manifestOf(dir);
    expect(interim.catalog).toEqual(v1.manifest!.catalog);
    expect(interim.pendingFiles.map((entry: { path: string }) => entry.path)).toEqual(["README.md", "src/client.ts", "src/models.ts"]);

    const v3 = generate(catalogVersion("Get a task (v3)", "ExtraThree"));
    const rerun = await writeSdk(dir, v3);
    expect(rerun.ok).toBe(true);
    expect(rerun.diagnostics).toEqual([]);
    expect(rerun.written).toEqual(["README.md", SDK_ARTIFACT_MANIFEST_FILE, "src/client.ts", "src/models.ts"]);
    const final = manifestOf(dir);
    expect(final).toEqual(v3.manifest);
    expect(final.pendingFiles).toBeUndefined();
  });

  it("still reports a hand edit made after the interruption", async () => {
    const dir = tempDir();
    expect((await writeSdk(dir, generate())).ok).toBe(true);
    failRename.target = path.join(dir, "src/client.ts");
    await expect(writeSdk(dir, generate(catalogVersion("Get a task (v2)", "ExtraTwo")))).rejects.toThrow("simulated crash");
    failRename.target = null;
    appendFileSync(path.join(dir, "src/models.ts"), "// edited\n");
    const rerun = await writeSdk(dir, generate(catalogVersion("Get a task (v3)", "ExtraThree")));
    expect(rerun.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.pointer])).toEqual([["SDK_OWNED_FILE_MODIFIED", "src/models.ts"]]);
  });
});
