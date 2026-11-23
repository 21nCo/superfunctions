// The workerd and packed-package tests read dist. These tests prove that the
// dist they read was built from the current sources, and that a stale dist is
// rebuilt or rejected rather than tested.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWithStamp,
  distIsFresh,
  ensureFreshDist,
  requiredArtifacts,
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

  // Like the real package, the fixture dependency does not export
  // ./package.json, so its root must be found through its exported entry.
  function withInlinedOauthCore(root: string): string {
    const dependency = path.join(root, "node_modules", "@superfunctions", "oauth-core");
    mkdirSync(path.join(dependency, "dist", "chunks"), { recursive: true });
    writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({
        name: "@superfunctions/oauth-core",
        version: "0.0.0",
        exports: { ".": { import: "./dist/index.js", require: "./dist/index.cjs" } },
      }),
    );
    writeFileSync(path.join(dependency, "dist", "index.js"), "export const redact = 1;\n");
    writeFileSync(path.join(dependency, "dist", "index.cjs"), "exports.redact = 1;\n");
    writeFileSync(path.join(dependency, "dist", "chunks", "index.js"), "export {};\n");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "0.0.0",
        devDependencies: { "@superfunctions/oauth-core": "0.0.0" },
      }),
    );
    return dependency;
  }

  it("hashes the inlined oauth-core dist, keyed by its path in the package", () => {
    const root = fixturePackage();
    const dependency = withInlinedOauthCore(root);
    writeBuildStamp(root);
    expect(distIsFresh(root)).toBe(true);

    writeFileSync(path.join(dependency, "dist", "index.js"), "export const redact = 2;\n");
    expect(distIsFresh(root)).toBe(false);
    writeBuildStamp(root);

    // Same basename and bytes moved to another directory: still a change.
    const digest = sourceDigest(root);
    rmSync(path.join(dependency, "dist", "chunks"), { recursive: true });
    mkdirSync(path.join(dependency, "dist", "other"));
    writeFileSync(path.join(dependency, "dist", "other", "index.js"), "export {};\n");
    expect(sourceDigest(root)).not.toBe(digest);
  });

  it("fails instead of skipping a declared inlined dependency that does not resolve", () => {
    const root = fixturePackage();
    const dependency = withInlinedOauthCore(root);
    writeBuildStamp(root);
    rmSync(dependency, { recursive: true });
    expect(() => distIsFresh(root)).toThrow(/@superfunctions\/oauth-core/);
  });

  it("treats a matching stamp with a missing entry-point artifact as stale", () => {
    const root = fixturePackage();
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "0.0.0",
        main: "dist/index.cjs",
        exports: { ".": { import: "./dist/index.js", require: "./dist/index.cjs" } },
        imports: { "#stub": { node: "./dist/stub.js", default: "./dist/stub-unavailable.cjs" } },
      }),
    );
    for (const file of ["index.js", "index.cjs", "stub.js", "stub-unavailable.cjs"]) {
      writeFileSync(path.join(root, "dist", file), "\n");
    }
    writeBuildStamp(root);
    expect(requiredArtifacts(root)).toEqual([
      "dist/index.cjs",
      "dist/index.js",
      "dist/stub-unavailable.cjs",
      "dist/stub.js",
    ]);
    expect(distIsFresh(root)).toBe(true);

    unlinkSync(path.join(root, "dist", "stub-unavailable.cjs"));
    expect(distIsFresh(root)).toBe(false);
  });

  it("treats a replaced, missing or extra emitted file as stale", () => {
    const root = fixturePackage();
    writeFileSync(path.join(root, "dist", "index.js"), "export const value = 1;\n");
    writeFileSync(path.join(root, "dist", "index.js.map"), "{}\n");
    writeBuildStamp(root);
    expect(distIsFresh(root)).toBe(true);

    writeFileSync(path.join(root, "dist", "index.js"), "export const value = 9;\n");
    expect(distIsFresh(root)).toBe(false);
    writeBuildStamp(root);

    unlinkSync(path.join(root, "dist", "index.js.map"));
    expect(distIsFresh(root)).toBe(false);
    writeBuildStamp(root);

    writeFileSync(path.join(root, "dist", "leftover.js"), "export {};\n");
    expect(distIsFresh(root)).toBe(false);

    // A stamp without recorded artifacts (an older stamp format) is stale too.
    writeFileSync(
      path.join(root, stampFile),
      JSON.stringify({ sourceDigest: sourceDigest(root) }),
    );
    expect(distIsFresh(root)).toBe(false);
  });

  it("stamps a build with the inputs it started from", () => {
    const root = fixturePackage();
    buildWithStamp(root, () => {
      writeFileSync(path.join(root, "dist", "index.js"), "export const value = 1;\n");
    });
    expect(distIsFresh(root)).toBe(true);
  });

  it("fails a build whose inputs changed while it ran and leaves no stamp", () => {
    const root = fixturePackage();
    writeBuildStamp(root);
    expect(() =>
      buildWithStamp(root, () => {
        writeFileSync(path.join(root, "dist", "index.js"), "export const value = 1;\n");
        // An edit saved while tsup is still emitting.
        writeFileSync(path.join(root, "src", "index.ts"), "export const value = 2;\n");
      }),
    ).toThrow(/inputs changed during the build/);
    expect(existsSync(path.join(root, stampFile))).toBe(false);
    expect(distIsFresh(root)).toBe(false);
  });

  it("the real package requires every published entry point", () => {
    expect(requiredArtifacts(packageRoot)).toEqual(
      expect.arrayContaining([
        "dist/index.js",
        "dist/index.cjs",
        "dist/stdio.js",
        "dist/stdio.cjs",
        "dist/stdio-unavailable.js",
        "dist/stdio-unavailable.cjs",
      ]),
    );
  });
});
