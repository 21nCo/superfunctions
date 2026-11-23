// The workerd and packed-package tests read dist. These tests prove that the
// dist they read was built from the current sources, and that a stale dist is
// rebuilt or rejected rather than tested.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  distIsFresh,
  ensureFreshDist,
  sourceDigest,
  stampFile,
  writeBuildStamp,
} from "../scripts/build-stamp.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("@mcpfn/client build stamp", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixturePackage(): string {
    const root = mkdtempSync(path.join(tmpdir(), "mcpfn-client-stamp-"));
    roots.push(root);
    mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"0.0.0"}\n');
    writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
    writeFileSync(path.join(root, "tsup.config.ts"), "export default {};\n");
    writeFileSync(path.join(root, "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(path.join(root, "src", "nested", "util.ts"), "export const util = 1;\n");
    return root;
  }

  it("the dist under test was built from the current sources", () => {
    const stamp = JSON.parse(readFileSync(path.join(packageRoot, stampFile), "utf8"));
    expect(stamp.sourceDigest).toBe(sourceDigest(packageRoot));
    expect(distIsFresh(packageRoot)).toBe(true);
  });

  it("marks dist stale after a source edit, a new source file or a config change", () => {
    const root = fixturePackage();
    expect(distIsFresh(root)).toBe(false);
    writeBuildStamp(root);
    expect(distIsFresh(root)).toBe(true);

    writeFileSync(path.join(root, "src", "nested", "util.ts"), "export const util = 2;\n");
    expect(distIsFresh(root)).toBe(false);
    writeBuildStamp(root);

    writeFileSync(path.join(root, "src", "extra.ts"), "export {};\n");
    expect(distIsFresh(root)).toBe(false);
    writeBuildStamp(root);

    writeFileSync(path.join(root, "tsup.config.ts"), "export default { minify: true };\n");
    expect(distIsFresh(root)).toBe(false);
    writeBuildStamp(root);

    unlinkSync(path.join(root, stampFile));
    expect(distIsFresh(root)).toBe(false);
  });

  it("rebuilds a stale dist and leaves a fresh one alone", () => {
    const root = fixturePackage();
    writeBuildStamp(root);
    writeFileSync(path.join(root, "src", "index.ts"), "export const value = 2;\n");

    const build = vi.fn(() => writeBuildStamp(root));
    expect(ensureFreshDist(root, build)).toBe("rebuilt");
    expect(build).toHaveBeenCalledTimes(1);

    expect(ensureFreshDist(root, build)).toBe("fresh");
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("rejects a dist that is still stale after the build", () => {
    const root = fixturePackage();
    writeBuildStamp(root);
    writeFileSync(path.join(root, "src", "index.ts"), "export const value = 3;\n");

    expect(() => ensureFreshDist(root, () => {})).toThrow(/does not match its sources/);
  });
});
