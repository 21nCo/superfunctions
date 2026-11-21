import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BundledSdkError, bundledSdkBanner, verifyBundledSdk } from "../../../scripts/verify-mcpfn-bundled-sdk.mjs";

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

// `installedVersion` is the SDK under the fixture's node_modules (where the
// source maps point); `stamp` is the build-time banner tsup writes into each
// bundle (null: none, as in a dist built before the stamp existed).
function fixture(options: {
  pin: string;
  installedVersion: string;
  stamp?: string | null;
  esm?: string;
  sources?: string[];
}): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpfn-bundled-sdk-"));
  fixtures.push(dir);
  const sdk = join(dir, "node_modules", "@modelcontextprotocol", "sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@modelcontextprotocol/sdk", version: options.installedVersion }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "@mcpfn/fixture",
    dependencies: { "@modelcontextprotocol/sdk": options.pin },
  }));
  mkdirSync(join(dir, "dist"));
  const sources = options.sources ?? ["../node_modules/@modelcontextprotocol/sdk/src/types.ts", "../src/index.ts"];
  const stamp = options.stamp === undefined ? options.installedVersion : options.stamp;
  const banner = stamp === null ? "" : `/*! bundled @modelcontextprotocol/sdk@${stamp} */\n`;
  for (const [file, code] of [["index.js", options.esm ?? "var LATEST = \"2025-11-25\";\nexport { LATEST };\n"], ["index.cjs", "\"use strict\";\nexports.LATEST = \"2025-11-25\";\n"]]) {
    writeFileSync(join(dir, "dist", file), banner + code);
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
    expect(report.bundles.map(({ bundle, stamped, versions }) => [bundle, stamped, versions])).toEqual([
      ["index.js", pinned, [pinned]],
      ["index.cjs", pinned, [pinned]],
    ]);
  });

  it.runIf(built || Boolean(process.env.CI))("rejects a copy of the built bundle whose stamp names an older SDK", () => {
    // Same installed SDK and pin as the real build; only the bundled bytes are
    // stale, as in a dist built from 1.29.0 and never rebuilt.
    const dir = mkdtempSync(join(tmpdir(), "mcpfn-core-bundled-sdk-"));
    fixtures.push(dir);
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

  // MCP-13: the import scan reads tokens, not lines, on the real ESM and CJS bundles.
  const executableLoads = [
    "\nawait import(\n  \"@modelcontextprotocol/sdk/server/index.js\"\n);\n",
    "\nvar server = require(\n  '@modelcontextprotocol/sdk/server/index.js'\n);\n",
    "\nvar types = __require(\n  `@modelcontextprotocol/sdk/types.js`);\n",
    "\n/*\n * note */ import(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = require(\"@modelcontextprotocol\\x2fsdk\");\n",
    "\nvar sdk = \\u0072equire(\"@modelcontextprotocol/sdk\\u{2f}types.js\");\n",
  ];
  const inertText = [
    "\nlet i = 0; console.log(i++ / 2, i-- / 2);\nif (i) /[\"]/.test(\"x\");\nvar o = { a: 1 } / 2; function f() {} /[\"]/.test(\"y\");\n",
    "\nvar HELP = \"import { Server } from '@modelcontextprotocol/sdk/server/index.js'\";\n",
    "\nvar HINT = `require('@modelcontextprotocol/sdk/types.js')`;\nvar SDK = /from \"@modelcontextprotocol\\/sdk\"/;\n",
    "\n// import(\"@modelcontextprotocol/sdk/types.js\")\n/* require(\n\"@modelcontextprotocol/sdk\") */\n",
  ];
  function appendToBuiltBundle(file: string, code: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mcpfn-core-bundled-sdk-"));
    fixtures.push(dir);
    cpSync(join(packageRoot, "dist"), join(dir, "dist"), { recursive: true });
    for (const map of ["index.js.map", "index.cjs.map"]) {
      const path = join(dir, "dist", map);
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), sourceRoot: join(packageRoot, "dist") }));
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "dist", file), readFileSync(join(dir, "dist", file), "utf8") + code);
    return dir;
  }

  it.runIf(built || Boolean(process.env.CI)).each(["index.js", "index.cjs"])("rejects SDK imports split across lines or comments, or with escaped specifiers, in the built %s", (file) => {
    for (const code of executableLoads) {
      expect(() => verifyBundledSdk(appendToBuiltBundle(file, code))).toThrow(`dist/${file} imports @modelcontextprotocol/sdk instead of bundling it`);
    }
  });

  it.runIf(built || Boolean(process.env.CI)).each(["index.js", "index.cjs"])("accepts valid code and SDK import text in strings, templates, regexes and comments of the built %s", (file) => {
    for (const code of inertText) expect(() => verifyBundledSdk(appendToBuiltBundle(file, code))).not.toThrow();
  });

  it("fails closed on a bundle it cannot scan", () => {
    expect(failure(fixture({ pin: "1.32.2", installedVersion: "1.32.2", esm: "var broken = \"unterminated;\nexport { broken };\n" })).message).toContain(
      "cannot scan the bundle for @modelcontextprotocol/sdk imports: unterminated string",
    );
  });

  it("accepts a bundle whose SDK sources come from the pinned version", () => {
    const report = verifyBundledSdk(fixture({ pin: "1.32.2", installedVersion: "1.32.2" }));
    expect(report.bundles.every(({ versions }) => versions.join() === "1.32.2")).toBe(true);
  });

  it("fails when the bundled SDK and the pin disagree", () => {
    const error = failure(fixture({ pin: "1.32.2", installedVersion: "1.29.0" }));
    expect(error).toBeInstanceOf(BundledSdkError);
    expect(error.message).toContain("bundles @modelcontextprotocol/sdk 1.29.0 but package.json pins 1.32.2");
  });

  it("fails on a stale bundle even when the installed SDK already matches the pin", () => {
    const error = failure(fixture({ pin: "1.32.2", installedVersion: "1.32.2", stamp: "1.29.0" }));
    expect(error.message).toContain("dist/index.js bundles @modelcontextprotocol/sdk 1.29.0 but package.json pins 1.32.2");
  });

  it("fails on a bundle built without the SDK version stamp", () => {
    expect(failure(fixture({ pin: "1.32.2", installedVersion: "1.32.2", stamp: null })).message).toContain(
      "dist/index.js has no bundled @modelcontextprotocol/sdk version stamp",
    );
  });

  it("fails when the stamp matches but the source maps resolve another installed SDK", () => {
    expect(failure(fixture({ pin: "1.32.2", installedVersion: "1.29.0", stamp: "1.32.2" })).message).toContain(
      "resolves @modelcontextprotocol/sdk from",
    );
  });

  it("stamps the SDK version installed for the package being built", () => {
    expect(bundledSdkBanner(fixture({ pin: "1.32.2", installedVersion: "1.32.2" }))).toBe("/*! bundled @modelcontextprotocol/sdk@1.32.2 */");
  });

  it("fails when the bundle imports the SDK instead of inlining it", () => {
    const error = failure(fixture({
      pin: "1.32.2",
      installedVersion: "1.32.2",
      esm: "/**\n * import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n */\nimport { Server } from \"@modelcontextprotocol/sdk/server/index.js\";\nexport { Server };\n",
    }));
    expect(error.message).toContain("imports @modelcontextprotocol/sdk instead of bundling it");
  });

  it("fails on an esbuild __require of the SDK or an import after a same-line comment", () => {
    for (const esm of [
      "var server = __require(\"@modelcontextprotocol/sdk/server/index.js\");\n",
      "/* inlined */ import { Server } from \"@modelcontextprotocol/sdk/server/index.js\";\n",
    ]) {
      expect(failure(fixture({ pin: "1.32.2", installedVersion: "1.32.2", esm })).message).toContain("imports @modelcontextprotocol/sdk instead of bundling it");
    }
  });

  it("ignores SDK imports that appear only in bundled doc comments", () => {
    expect(() => verifyBundledSdk(fixture({
      pin: "1.32.2",
      installedVersion: "1.32.2",
      esm: "/**\n * import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';\n */\nexport const ok = true;\n",
    }))).not.toThrow();
  });

  it("fails when the SDK pin is a range or the bundle has no SDK sources", () => {
    expect(failure(fixture({ pin: "^1.32.2", installedVersion: "1.32.2" })).message).toContain("must pin @modelcontextprotocol/sdk to an exact version");
    expect(failure(fixture({ pin: "1.32.2", installedVersion: "1.32.2", sources: ["../src/index.ts"] })).message).toContain("contains no @modelcontextprotocol/sdk sources");
  });
});
