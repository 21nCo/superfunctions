import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBundledSdk } from "../../../scripts/verify-mcpfn-bundled-sdk.mjs";

// MCP-13: tsup inlines @modelcontextprotocol/sdk into dist (noExternal), so
// consumers run exactly the SDK code this package was built with.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const pinned: string = manifest.dependencies["@modelcontextprotocol/sdk"];
const built = existsSync(join(packageRoot, "dist", "index.js.map"));

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bundled @modelcontextprotocol/sdk version", () => {
  it("pins the SDK exactly to the patched release", () => {
    expect(pinned).toBe("1.32.2");
  });

  it("resolves the pinned SDK version from this package", () => {
    const require = createRequire(join(packageRoot, "package.json"));
    let dir = dirname(require.resolve("@modelcontextprotocol/sdk/types.js"));
    while (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== "@modelcontextprotocol/sdk") {
      dir = dirname(dir);
    }
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe(pinned);
  });

  // The build script runs the same check after tsup; CI builds before this
  // test, so a missing dist only skips it in a local unbuilt checkout.
  it.runIf(built || Boolean(process.env.CI))("inlines only the pinned SDK into the built ESM and CJS bundles", () => {
    const report = verifyBundledSdk(packageRoot);
    expect(report.bundles.map(({ bundle, stamped, versions }) => [bundle, stamped, versions])).toEqual([
      ["index.js", pinned, [pinned]],
      ["index.cjs", pinned, [pinned]],
    ]);
  });

  it.runIf(built || Boolean(process.env.CI))("rejects the built bundle when the pin names another SDK version", () => {
    // The copied source maps keep pointing at the SDK this package was built
    // from (absolute sourceRoot), while the copied manifest pins 1.29.0.
    const dir = mkdtempSync(join(tmpdir(), "mcpfn-auth-bundled-sdk-"));
    temporary.push(dir);
    cpSync(join(packageRoot, "dist"), join(dir, "dist"), { recursive: true });
    for (const map of ["index.js.map", "index.cjs.map"]) {
      const path = join(dir, "dist", map);
      const sourceMap = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...sourceMap, sourceRoot: join(packageRoot, "dist") }));
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      ...manifest,
      dependencies: { ...manifest.dependencies, "@modelcontextprotocol/sdk": "1.29.0" },
    }));
    expect(() => verifyBundledSdk(dir)).toThrow(`bundles @modelcontextprotocol/sdk ${pinned} but package.json pins 1.29.0`);
  });

  it.runIf(built || Boolean(process.env.CI))("rejects a copy of the built bundle whose stamp names an older SDK", () => {
    // Pin and installed SDK as in the real build; only the bundled bytes are stale.
    const dir = mkdtempSync(join(tmpdir(), "mcpfn-auth-bundled-sdk-"));
    temporary.push(dir);
    cpSync(join(packageRoot, "dist"), join(dir, "dist"), { recursive: true });
    for (const file of ["index.js", "index.cjs"]) {
      const path = join(dir, "dist", file);
      writeFileSync(path, readFileSync(path, "utf8").replace(`@modelcontextprotocol/sdk@${pinned} */`, "@modelcontextprotocol/sdk@1.29.0 */"));
      const sourceMap = JSON.parse(readFileSync(`${path}.map`, "utf8"));
      writeFileSync(`${path}.map`, JSON.stringify({ ...sourceMap, sourceRoot: join(packageRoot, "dist") }));
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    expect(() => verifyBundledSdk(dir)).toThrow(`dist/index.js bundles @modelcontextprotocol/sdk 1.29.0 but package.json pins ${pinned}`);
  });
});
