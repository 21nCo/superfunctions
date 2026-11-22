import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const runOnBuild = it.runIf(built || Boolean(process.env.CI));
// Each built-artifact case parses both ~560 KB bundles; size the timeout for a
// loaded CI runner rather than the 5 s default.
const BUILT_TIMEOUT = 60_000;

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
  runOnBuild("inlines only the pinned SDK into the built ESM and CJS bundles", () => {
    const report = verifyBundledSdk(packageRoot);
    expect(report.pinned).toBe(pinned);
    expect(report.bundles.map(({ bundle, stamped, versions }) => [bundle, stamped, versions])).toEqual([
      ["index.js", pinned, [pinned]],
      ["index.cjs", pinned, [pinned]],
    ]);
  }, BUILT_TIMEOUT);

  // The built dist is read once; each case writes its own copy, whose source
  // maps keep pointing at the SDK this package was built from (absolute
  // sourceRoot), with one change applied.
  let builtDist: Record<string, string> | undefined;
  function builtCopy(change: (dist: Record<string, string>) => void): string {
    builtDist ??= Object.fromEntries(["index.js", "index.cjs"].flatMap((file) => [
      [file, readFileSync(join(packageRoot, "dist", file), "utf8")],
      [`${file}.map`, JSON.stringify({ ...JSON.parse(readFileSync(join(packageRoot, "dist", `${file}.map`), "utf8")), sourceRoot: join(packageRoot, "dist") })],
    ]));
    const dist = { ...builtDist };
    change(dist);
    const dir = mkdtempSync(join(tmpdir(), "mcpfn-core-bundled-sdk-"));
    fixtures.push(dir);
    mkdirSync(join(dir, "dist"));
    for (const [file, content] of Object.entries(dist)) writeFileSync(join(dir, "dist", file), content);
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    return dir;
  }

  runOnBuild("rejects a copy of the built bundle whose stamp names an older SDK", () => {
    // Same installed SDK and pin as the real build; only the bundled bytes are
    // stale, as in a dist built from 1.29.0 and never rebuilt.
    const dir = builtCopy((dist) => {
      for (const file of ["index.js", "index.cjs"]) {
        dist[file] = dist[file].replace(`@modelcontextprotocol/sdk@${pinned} */`, "@modelcontextprotocol/sdk@1.29.0 */");
      }
    });
    expect(() => verifyBundledSdk(dir)).toThrow(`dist/index.js bundles @modelcontextprotocol/sdk 1.29.0 but package.json pins ${pinned}`);
  }, BUILT_TIMEOUT);

  // MCP-13: the import scan reads tokens, not lines, on the real ESM and CJS bundles.
  const executableLoads = [
    "\nvoid import(\n  \"@modelcontextprotocol/sdk/server/index.js\"\n);\n",
    "\nvar server = require(\n  '@modelcontextprotocol/sdk/server/index.js'\n);\n",
    "\nvar types = __require(\n  `@modelcontextprotocol/sdk/types.js`);\n",
    "\n/*\n * note */ import(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = require(\"@modelcontextprotocol\\x2fsdk\");\n",
    "\nvar sdk = \\u0072equire(\"@modelcontextprotocol/sdk\\u{2f}types.js\");\n",
    // Every ECMAScript line terminator ends a line comment.
    "\nvar x = 1; // note\rrequire(\"@modelcontextprotocol/sdk\");\n",
    "\nvar x = 1; // note\u2028require(\"@modelcontextprotocol/sdk\");\n",
    "\nvar x = 1; // note\u2029require(\"@modelcontextprotocol/sdk\");\n",
    // CommonJS loads through the module object, aliased or not.
    "\nvar sdk = module.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nconst mod = module; var sdk = mod.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = module?.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = module[\"require\"](\"@modelcontextprotocol/sdk\");\n",
    // A require method fails closed unless its receiver is a same-file object
    // whose require member provably cannot load: a forwarding wrapper, an
    // unresolved receiver and a reassigned or mutated helper all load the SDK.
    "\nvar loader = { require: (id) => require(id) };\nvar sdk = loader.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = globalThis.helper.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = unknownHelper.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar h2 = { require: (id) => id }; h2 = module; h2.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar h3 = { require: (id) => id }; h3.require = require; h3.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    // Callee and specifier are normalized alike: parentheses, comma sequences,
    // aliases, constant specifiers and string concatenation.
    "\nvar sdk = require((\"@modelcontextprotocol/sdk/types.js\"));\n",
    "\nvoid import((\"@modelcontextprotocol/sdk/types.js\"));\n",
    "\nvar sdk = (0, require)(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = (0, module.require)(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nconst r = require; var sdk = r(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nconst sdkId = \"@modelcontextprotocol/sdk/types.js\"; var sdk = require(sdkId);\n",
    "\nvar sdk = require(\"@modelcontextprotocol/\" + \"sdk\");\n",
    "\nconst req = createRequire(__filename); var sdk = req(\"@modelcontextprotocol/sdk/types.js\");\n",
    // Bindings resolve lexically: an inner-block helper does not exempt the
    // global receiver of the same name. A cycle is unrolled once, not dropped.
    "\nglobalThis.mcp13Loader = module; { const mcp13Loader = { require: (id) => id }; }\nmcp13Loader.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar mcp13P = \"@modelcontextprotocol/sdk\"; mcp13P = mcp13P + \"\"; require(mcp13P);\n",
    "\nvar mcp13C = \"@modelcontextprotocol/\"; mcp13C = mcp13C + \"sdk\"; require(mcp13C);\n",
    "\nvar mcp13Q = \"@modelcontextprotocol/\"; mcp13Q += \"sdk\"; require(mcp13Q);\n",
    // A helper that exposes itself, is called through a computed key that
    // resolves to another method, or can be rebound by eval is not inert.
    "\n{ const h4 = { require() { return this; } }; h4.require().require = require; h4.require(\"@modelcontextprotocol/sdk/types.js\"); }\n",
    "\n{ const h5 = { require: (id) => id, change() { this.require = module.require.bind(module); } }; { const require = \"change\"; h5[require](); } h5.require(\"@modelcontextprotocol/sdk/types.js\"); }\n",
    "\nvar h6 = { require: (id) => id }; (eval)(\"h6 = module\"); h6.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    // A computed key that cannot be fully resolved (here a cycle) can name require.
    "\n{ let ma = \"x\", mb = \"y\"; ma = mb + \"x\"; mb = ma + \"y\"; const ko = { x: () => 0 }; ko[mb](\"@modelcontextprotocol/sdk/types.js\"); }\n",
    // An exported helper, or a key rewritten by destructuring or a loop target.
    "\nexport const h8 = { require: (id) => id }; h8.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\n{ let k = \"require\"; const h9 = { require: (id) => id, change() { this.require = require; } }; [k] = [\"change\"]; h9[k](); h9.require(\"@modelcontextprotocol/sdk/types.js\"); }\n",
    "\n{ let k = \"require\"; const h10 = { require: (id) => id, change() { this.require = require; } }; for (k of [\"change\"]) h10[k](); h10.require(\"@modelcontextprotocol/sdk/types.js\"); }\n",
    // Logical assignments, a renamed createRequire, and call/apply.
    "\nvar lp; require(lp ||= \"@modelcontextprotocol/sdk\");\nvar lr; (lr ||= require)(\"@modelcontextprotocol/sdk\");\n",
    "\nconst { createRequire: cr } = require(\"node:module\"); cr(__filename)(\"@modelcontextprotocol/sdk\");\n",
    "\nimport { createRequire as createRequire2 } from \"node:module\"; createRequire2(__filename)(\"@modelcontextprotocol/sdk\");\n",
    "\nrequire.call(null, \"@modelcontextprotocol/sdk\");\n",
    "\nrequire.apply(null, [\"@modelcontextprotocol/sdk\"]);\n",
  ];
  const inertText = [
    "\nlet i = 0; console.log(i++ / 2, i-- / 2);\nif (i) /[\"]/.test(\"x\");\nvar o = { a: 1 } / 2; function f() {} /[\"]/.test(\"y\");\n",
    "\nvar HELP = \"import { Server } from '@modelcontextprotocol/sdk/server/index.js'\";\n",
    "\nvar HINT = `require('@modelcontextprotocol/sdk/types.js')`;\nvar SDK = /from \"@modelcontextprotocol\\/sdk\"/;\n",
    "\n// import(\"@modelcontextprotocol/sdk/types.js\")\n/* require(\n\"@modelcontextprotocol/sdk\") */\n",
    // Division after a function expression, a regex in a template substitution
    // or after a class body, and an escaped CRLF line continuation in a string.
    "\nvar n = function () {} / 2;\nvar s = `${/[\"]/.test(\"x\")}`;\nclass C {}\n/[\"]/.test(\"z\");\nvar c = \"a\\\r\nb\";\n",
    // A require method call with another specifier or a non-literal argument.
    "\nvar obj = { require: (id) => id };\nvar name = \"x\";\nobj.require(\"other-pkg\");\nobj.require(name);\n",
    // A same-file helper whose require method only returns its argument.
    "\nconst helper = { require: (id) => id };\nvar sdk = helper.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    // An SDK string bound in another function does not reach this require.
    "\nfunction mcp13A() { const id = \"@modelcontextprotocol/sdk/types.js\"; return id; }\nfunction mcp13B() { const id = \"node:path\"; return require(id); }\n",
    // Cyclic updates terminate, as call arguments and as computed member keys.
    "\n{ let msg = \"\"; msg = msg + \".\"; console.log(msg); }\n",
    "\n{ let tm = \"\"; tm = `${tm}.`; console.log(tm); }\n",
    "\n{ let ma = \"x\", mb = \"y\"; ma = mb + \"x\"; mb = ma + \"y\"; console.log(ma); const ko = { x: () => 0 }; ko[mb](\"other-pkg\"); }\n",
    // Computed keys resolve like loader keys; a literal short-circuit is static.
    "\n{ const k = \"require\"; const h7 = { require(id) { return id; } }; h7[k](\"@modelcontextprotocol/sdk/types.js\"); h7[(\"require\")](\"@modelcontextprotocol/sdk/types.js\"); }\n",
    "\nrequire(\"node:path\" || \"@modelcontextprotocol/sdk/types.js\");\n",
    // A known non-loader call spends no resolution budget on its arguments.
    `\n{ let v0 = "a"; ${Array.from({ length: 14 }, (_, i) => `let v${i + 1} = v${i} + v${i};`).join(" ")} console.log(v14); }\n`,
  ];
  const artifacts = ["index.js", "index.cjs"];
  const appendToBuiltBundle = (file: string, code: string) => builtCopy((dist) => {
    dist[file] += code;
  });

  runOnBuild.each(artifacts.flatMap((file) => executableLoads.map((code, index) => ({ file, index, code }))))(
    "rejects SDK loads split across lines or comments, escaped, wrapped, aliased or through a loading require method, in the built $file (case $index)",
    ({ file, code }) => {
      expect(() => verifyBundledSdk(appendToBuiltBundle(file, code))).toThrow(`dist/${file} imports @modelcontextprotocol/sdk instead of bundling it`);
    },
    BUILT_TIMEOUT,
  );

  runOnBuild.each(artifacts.flatMap((file) => inertText.map((code, index) => ({ file, index, code }))))(
    "accepts valid code, SDK import text in strings, templates, regexes and comments, and inert require methods of the built $file (case $index)",
    ({ file, code }) => {
      expect(() => verifyBundledSdk(appendToBuiltBundle(file, code))).not.toThrow();
    },
    BUILT_TIMEOUT,
  );

  // More candidate specifiers than the verifier folds fails instead of passing.
  const overflow = `\nvar p65 = ${Array.from({ length: 64 }, (_, i) => `c${i} ? "a${i}" : `).join("")}"@modelcontextprotocol/";\nrequire(p65 + "sdk");\n`;
  runOnBuild.each(artifacts)("fails closed on an SDK load with more candidate specifiers than it folds in the built %s", (file) => {
    expect(() => verifyBundledSdk(appendToBuiltBundle(file, overflow))).toThrow("more than 64 candidate strings");
  }, BUILT_TIMEOUT);

  it("fails closed on a bundle it cannot scan", () => {
    expect(failure(fixture({ pin: "1.32.2", installedVersion: "1.32.2", esm: "var broken = \"unterminated;\nexport { broken };\n" })).message).toContain(
      "cannot scan the bundle for @modelcontextprotocol/sdk imports: Unterminated string literal.",
    );
  });

  it("fails closed when the values of a loader call cannot be resolved within the step budget", () => {
    let chain = "var v0 = \"a\";\n";
    for (let i = 1; i <= 30; i++) chain += `var v${i} = v${i - 1} + v${i - 1};\n`;
    expect(failure(fixture({ pin: "1.32.2", installedVersion: "1.32.2", esm: `${chain}require(v30);\n` })).message).toContain(
      "cannot resolve the values of a call in the bundle within 10000 steps",
    );
    expect(() => verifyBundledSdk(fixture({ pin: "1.32.2", installedVersion: "1.32.2", esm: `${chain}f(v30);\n` }))).not.toThrow();
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
