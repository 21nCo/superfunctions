import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BundledSdkError, verifyBundledSdk } from "../../../scripts/verify-mcpfn-bundled-sdk.mjs";

// MCP-13: tsup inlines @modelcontextprotocol/sdk into dist (noExternal), so
// consumers run exactly the SDK code this package was built with.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const pinned: string = manifest.dependencies["@modelcontextprotocol/sdk"];
const built = existsSync(join(packageRoot, "dist", "index.js.map"));

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(options: {
  pin: string;
  bundledVersion: string;
  esm?: string;
  sources?: string[];
}): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpfn-bundled-sdk-"));
  fixtures.push(dir);
  const sdk = join(dir, "node_modules", "@modelcontextprotocol", "sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@modelcontextprotocol/sdk", version: options.bundledVersion }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "@mcpfn/fixture",
    dependencies: { "@modelcontextprotocol/sdk": options.pin },
  }));
  mkdirSync(join(dir, "dist"));
  const sources = options.sources ?? ["../node_modules/@modelcontextprotocol/sdk/src/types.ts", "../src/index.ts"];
  for (const [file, code] of [["index.js", options.esm ?? "var LATEST = \"2025-11-25\";\nexport { LATEST };\n"], ["index.cjs", "\"use strict\";\nexports.LATEST = \"2025-11-25\";\n"]]) {
    writeFileSync(join(dir, "dist", file), code);
    writeFileSync(join(dir, "dist", `${file}.map`), JSON.stringify({ version: 3, sources, sourcesContent: sources.map(() => null), mappings: "" }));
  }
  return dir;
}

function failure(dir: string): BundledSdkError {
  try {
    verifyBundledSdk(dir);
  } catch (error) {
    return error as BundledSdkError;
  }
  throw new Error("expected the bundled SDK check to fail");
}

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
    expect(report.pinned).toBe(pinned);
    expect(report.bundles.map(({ bundle, versions }) => [bundle, versions])).toEqual([
      ["index.js", [pinned]],
      ["index.cjs", [pinned]],
    ]);
  });

  it("accepts a bundle whose SDK sources come from the pinned version", () => {
    const report = verifyBundledSdk(fixture({ pin: "1.32.2", bundledVersion: "1.32.2" }));
    expect(report.bundles.every(({ versions }) => versions.join() === "1.32.2")).toBe(true);
  });

  it("fails when the bundled SDK and the pin disagree", () => {
    const error = failure(fixture({ pin: "1.32.2", bundledVersion: "1.29.0" }));
    expect(error).toBeInstanceOf(BundledSdkError);
    expect(error.message).toContain("bundles @modelcontextprotocol/sdk 1.29.0 but package.json pins 1.32.2");
  });

  it("fails when the bundle imports the SDK instead of inlining it", () => {
    const error = failure(fixture({
      pin: "1.32.2",
      bundledVersion: "1.32.2",
      esm: "/**\n * import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n */\nimport { Server } from \"@modelcontextprotocol/sdk/server/index.js\";\nexport { Server };\n",
    }));
    expect(error.message).toContain("imports @modelcontextprotocol/sdk instead of bundling it");
  });

  it("ignores SDK imports that appear only in bundled doc comments", () => {
    expect(() => verifyBundledSdk(fixture({
      pin: "1.32.2",
      bundledVersion: "1.32.2",
      esm: "/**\n * import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';\n */\nexport const ok = true;\n",
    }))).not.toThrow();
  });

  it("fails when the SDK pin is a range or the bundle has no SDK sources", () => {
    expect(failure(fixture({ pin: "^1.32.2", bundledVersion: "1.32.2" })).message).toContain("must pin @modelcontextprotocol/sdk to an exact version");
    expect(failure(fixture({ pin: "1.32.2", bundledVersion: "1.32.2", sources: ["../src/index.ts"] })).message).toContain("contains no @modelcontextprotocol/sdk sources");
  });
});
