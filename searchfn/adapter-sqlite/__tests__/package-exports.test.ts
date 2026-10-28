import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Load the package by name from a fresh Node process, as a consumer would. */
function load(source: string, inputType: "module" | "commonjs") {
  return spawnSync(process.execPath, [`--input-type=${inputType}`, "-e", source], {
    cwd: packageDir,
    encoding: "utf8",
  });
}

describe("published entry points", () => {
  beforeAll(() => {
    if (!existsSync(new URL("../dist/index.js", import.meta.url))) {
      execFileSync("npx", ["tsup"], { cwd: packageDir, stdio: "ignore" });
    }
  }, 120_000);

  it("is ESM-only: no CommonJS entry is advertised", () => {
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("dist/index.js");
    expect(manifest.exports).toEqual({ ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } });
  });

  it("loads the built artifact through import, and require fails with a resolution error", () => {
    const imported = load(
      `const m = await import("@searchfn/adapter-sqlite"); console.log(typeof m.SqliteAdapter, typeof m.fromD1);`,
      "module",
    );
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout.trim()).toBe("function function");

    const required = load(
      `try { require("@searchfn/adapter-sqlite"); console.log("loaded"); } catch (error) { console.log(error.code); }`,
      "commonjs",
    );
    expect(required.stdout.trim()).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });
});
