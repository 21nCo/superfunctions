import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const runOnBuild = it.runIf(built || Boolean(process.env.CI));
// Each built-artifact case parses both bundles; size the timeout for a loaded
// CI runner rather than the 5 s default.
const BUILT_TIMEOUT = 60_000;

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  // The built-artifact cases are synchronous; yield a macrotask between them so
  // the Vitest worker can answer its RPC calls during a long run.
  await new Promise((resolve) => setImmediate(resolve));
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
  runOnBuild("inlines only the pinned SDK into the built ESM and CJS bundles", () => {
    const report = verifyBundledSdk(packageRoot);
    expect(report.bundles.map(({ bundle, stamped, versions }) => [bundle, stamped, versions])).toEqual([
      ["index.js", pinned, [pinned]],
      ["index.cjs", pinned, [pinned]],
    ]);
  }, BUILT_TIMEOUT);

  // The built dist is read once; each case writes its own copy, whose source
  // maps keep pointing at the SDK this package was built from (absolute
  // sourceRoot), with one change applied to the manifest or the bundles.
  let builtDist: Record<string, string> | undefined;
  function builtCopy(change: (dist: Record<string, string>) => void, copiedManifest = manifest): string {
    builtDist ??= Object.fromEntries(["index.js", "index.cjs"].flatMap((file) => [
      [file, readFileSync(join(packageRoot, "dist", file), "utf8")],
      [`${file}.map`, JSON.stringify({ ...JSON.parse(readFileSync(join(packageRoot, "dist", `${file}.map`), "utf8")), sourceRoot: join(packageRoot, "dist") })],
    ]));
    const dist = { ...builtDist };
    change(dist);
    const dir = mkdtempSync(join(tmpdir(), "mcpfn-auth-bundled-sdk-"));
    temporary.push(dir);
    mkdirSync(join(dir, "dist"));
    for (const [file, content] of Object.entries(dist)) writeFileSync(join(dir, "dist", file), content);
    writeFileSync(join(dir, "package.json"), JSON.stringify(copiedManifest));
    return dir;
  }

  runOnBuild("rejects the built bundle when the pin names another SDK version", () => {
    const dir = builtCopy(() => {}, {
      ...manifest,
      dependencies: { ...manifest.dependencies, "@modelcontextprotocol/sdk": "1.29.0" },
    });
    expect(() => verifyBundledSdk(dir)).toThrow(`bundles @modelcontextprotocol/sdk ${pinned} but package.json pins 1.29.0`);
  }, BUILT_TIMEOUT);

  runOnBuild("rejects a copy of the built bundle whose stamp names an older SDK", () => {
    // Pin and installed SDK as in the real build; only the bundled bytes are stale.
    const dir = builtCopy((dist) => {
      for (const file of ["index.js", "index.cjs"]) {
        dist[file] = dist[file].replace(`@modelcontextprotocol/sdk@${pinned} */`, "@modelcontextprotocol/sdk@1.29.0 */");
      }
    });
    expect(() => verifyBundledSdk(dir)).toThrow(`dist/index.js bundles @modelcontextprotocol/sdk 1.29.0 but package.json pins ${pinned}`);
  }, BUILT_TIMEOUT);

  // MCP-13 data ban: the SDK name in any executable string, template fragment
  // or constant-folded string expression fails, whatever reads it; the scan
  // parses the real ESM and CJS bundles, so comments and regexes never count.
  const doubled = (name: string, times: number) => `var ${name} = "ab";${` ${name} = ${name} + ${name};`.repeat(times)}`;
  const executableLoads = [
    "\nvoid import(\n  \"@modelcontextprotocol/sdk/server/index.js\"\n);\n",
    "\nvar server = require(\n  '@modelcontextprotocol/sdk/server/index.js'\n);\n",
    "\n/*\n * note */ require(\"@modelcontextprotocol/sdk/types.js\");\n",
    // Loads through the module object, aliased or not. The cases below, kept
    // from the earlier loader and receiver modeling, all fail on the SDK
    // string itself: no callee or receiver is classified.
    "\nvar sdk = module.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nconst mod = module; var sdk = mod.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = module?.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = module[\"require\"](\"@modelcontextprotocol/sdk\");\n",
    // A forwarding wrapper, an unresolved receiver and a reassigned or mutated
    // helper.
    "\nvar loader = { require: (id) => require(id) };\nvar sdk = loader.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = globalThis.helper.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = unknownHelper.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar h2 = { require: (id) => id }; h2 = module; h2.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar h3 = { require: (id) => id }; h3.require = require; h3.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    // Parentheses, comma sequences, aliases, constant specifiers and string
    // concatenation.
    "\nvar sdk = require((\"@modelcontextprotocol/sdk/types.js\"));\n",
    "\nvoid import((\"@modelcontextprotocol/sdk/types.js\"));\n",
    "\nvar sdk = (0, require)(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar sdk = (0, module.require)(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nconst r = require; var sdk = r(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nconst sdkId = \"@modelcontextprotocol/sdk/types.js\"; var sdk = require(sdkId);\n",
    "\nvar sdk = require(\"@modelcontextprotocol/\" + \"sdk\");\n",
    "\nconst req = createRequire(__filename); var sdk = req(\"@modelcontextprotocol/sdk/types.js\");\n",
    // A block-scoped helper, and constants folded through bindings: a cycle is
    // unrolled once, not dropped.
    "\nglobalThis.mcp13Loader = module; { const mcp13Loader = { require: (id) => id }; }\nmcp13Loader.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nvar mcp13P = \"@modelcontextprotocol/sdk\"; mcp13P = mcp13P + \"\"; require(mcp13P);\n",
    "\nvar mcp13C = \"@modelcontextprotocol/\"; mcp13C = mcp13C + \"sdk\"; require(mcp13C);\n",
    "\nvar mcp13Q = \"@modelcontextprotocol/\"; mcp13Q += \"sdk\"; require(mcp13Q);\n",
    // A helper that returns itself, is called through a computed key or is
    // rebound by eval.
    "\n{ const h4 = { require() { return this; } }; h4.require().require = require; h4.require(\"@modelcontextprotocol/sdk/types.js\"); }\n",
    "\n{ const h5 = { require: (id) => id, change() { this.require = module.require.bind(module); } }; { const require = \"change\"; h5[require](); } h5.require(\"@modelcontextprotocol/sdk/types.js\"); }\n",
    "\nvar h6 = { require: (id) => id }; (eval)(\"h6 = module\"); h6.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    // A call through a computed key that folds through a cycle.
    "\n{ let ma = \"x\", mb = \"y\"; ma = mb + \"x\"; mb = ma + \"y\"; const ko = { x: () => 0 }; ko[mb](\"@modelcontextprotocol/sdk/types.js\"); }\n",
    // An exported helper, and keys rewritten by destructuring or a loop target.
    "\nexport const h8 = { require: (id) => id }; h8.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\n{ let k = \"require\"; const h9 = { require: (id) => id, change() { this.require = require; } }; [k] = [\"change\"]; h9[k](); h9.require(\"@modelcontextprotocol/sdk/types.js\"); }\n",
    "\n{ let k = \"require\"; const h10 = { require: (id) => id, change() { this.require = require; } }; for (k of [\"change\"]) h10[k](); h10.require(\"@modelcontextprotocol/sdk/types.js\"); }\n",
    // Logical assignments, a renamed createRequire, and call/apply.
    "\nvar lp; require(lp ||= \"@modelcontextprotocol/sdk\");\nvar lr; (lr ||= require)(\"@modelcontextprotocol/sdk\");\n",
    "\nconst { createRequire: cr } = require(\"node:module\"); cr(__filename)(\"@modelcontextprotocol/sdk\");\n",
    "\nimport { createRequire as createRequire2 } from \"node:module\"; createRequire2(__filename)(\"@modelcontextprotocol/sdk\");\n",
    "\nrequire.call(null, \"@modelcontextprotocol/sdk\");\n",
    "\nrequire.apply(null, [\"@modelcontextprotocol/sdk\"]);\n",
    // Keys rewritten by loop and destructuring declarations.
    "\nvar k11 = \"require\"; const h11 = { require: (id) => id, change() { this.require = require; } }; for (var k11 of [\"change\"]) h11[k11](); h11.require(\"@modelcontextprotocol/sdk\");\n",
    "\nvar k12 = \"require\"; const h12 = { require: (id) => id, change() { this.require = require; } }; var { k12 } = { k12: \"change\" }; h12[k12](); h12.require(\"@modelcontextprotocol/sdk\");\n",
    // A bound loader, `new` and a parenthesized call dispatch.
    "\nrequire.bind(null)(\"@modelcontextprotocol/sdk\");\nconst boundRequire = module.require.bind(module); boundRequire(\"@modelcontextprotocol/sdk\");\n",
    "\nnew require(\"@modelcontextprotocol/sdk\");\n(require.call)(null, \"@modelcontextprotocol/sdk\");\n",
    // Loads that need no loader modeling under the data ban: apply through a
    // bound array, a comma-wrapped call, a prefilled bind, parameter and member
    // aliases, and a constant specifier folded through bindings or a template.
    "\nconst mcp13Args = [\"@modelcontextprotocol/sdk/types.js\"]; require.apply(null, mcp13Args);\n",
    "\n(0, require.call)(null, \"@modelcontextprotocol/sdk/types.js\");\n",
    "\nrequire.bind(null, \"@modelcontextprotocol/sdk\")();\n",
    "\n(function (load) { return load(\"@modelcontextprotocol/sdk/types.js\"); })(require);\n",
    "\nconst mcp13Loaders = { load: require }; mcp13Loaders.load(\"@modelcontextprotocol/sdk\");\nconst mcp13List = [require]; mcp13List[0](\"@modelcontextprotocol/sdk\");\n",
    "\nconst mcp13Scope = \"@modelcontextprotocol/\"; const mcp13Id = mcp13Scope + \"sdk\"; require(mcp13Id);\n",
    "\nconst mcp13T = \"@modelcontextprotocol/\"; void import(`${mcp13T}sdk/types.js`);\n",
    // The SDK name as data fails in any position, even where nothing loads it:
    // strings, templates, a path join, an identity helper, a callback, a key.
    "\nimport { join as mcp13Join } from \"node:path\"; mcp13Join(\"@modelcontextprotocol/sdk\", \"README.md\");\n",
    "\nvar HELP = \"import { Server } from '@modelcontextprotocol/sdk/server/index.js'\";\n",
    "\nvar HINT = `require('@modelcontextprotocol/sdk/types.js')`;\n",
    "\nconst helper = { require: (id) => id };\nvar sdk = helper.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    "\nfunction mcp13A() { const id = \"@modelcontextprotocol/sdk/types.js\"; return id; }\nfunction mcp13B() { const id = \"node:path\"; return require(id); }\n",
    "\n{ const k = \"require\"; const h7 = { require(id) { return id; } }; h7[k](\"@modelcontextprotocol/sdk/types.js\"); h7[(\"require\")](\"@modelcontextprotocol/sdk/types.js\"); }\n",
    "\nrequire(\"node:path\" || \"@modelcontextprotocol/sdk/types.js\");\n",
    "\n{ const callbacks = [(id) => id]; callbacks[0](\"@modelcontextprotocol/sdk\"); const identity = (id) => id; identity.description = \"label\"; identity(\"@modelcontextprotocol/sdk\"); }\n",
    // Folding is exact for the SDK name at any size: a name assembled over a
    // long += chain, behind a long doubled prefix, or as one of many branches.
    "\nvar mcp13R = \"@\"; mcp13R += \"model\"; mcp13R += \"context\"; mcp13R += \"protocol\"; mcp13R += \"/\"; mcp13R += \"s\"; mcp13R += \"d\"; mcp13R += \"k\"; f(mcp13R);\n",
    `\n${doubled("mcp13W", 12)}\nrequire(mcp13W + "@modelcontextprotocol/" + "sdk");\n`,
    `\nvar p65 = ${Array.from({ length: 64 }, (_, i) => `c${i} ? "a${i}" : `).join("")}"@modelcontextprotocol/";\nrequire(p65 + "sdk");\n`,
  ];
  const inertText = [
    // SDK text in a regex, a comment or JSDoc is not executable data.
    "\nvar SDK = /from \"@modelcontextprotocol\\/sdk\"/;\n// import(\"@modelcontextprotocol/sdk\")\n",
    "\n/** @type {import(\"@modelcontextprotocol/sdk/types.js\").Tool} */\nvar mcp13Tool;\n",
    // Protocol keys under io.modelcontextprotocol are not the SDK package name.
    "\nvar mcp13Meta = \"io.modelcontextprotocol/related-task\"; var mcp13K = `io.modelcontextprotocol/${mcp13Meta}`;\n",
    // A require method call with another specifier or a non-literal argument.
    "\nvar obj = { require: (id) => id };\nvar name = \"x\";\nobj.require(\"other-pkg\");\nobj.require(name);\n",
    // Cyclic updates terminate when folded.
    "\n{ let msg = \"\"; msg = msg + \".\"; console.log(msg); }\n",
    "\n{ let tm = \"\"; tm = `${tm}.`; console.log(tm); }\n",
    "\n{ let ma = \"x\", mb = \"y\"; ma = mb + \"x\"; mb = ma + \"y\"; console.log(ma); const ko = { x: () => 0 }; ko[mb](\"other-pkg\"); }\n",
    // Ordinary code with many distinct folded strings and no SDK name: a padded
    // template, a long += chain and a doubled binding.
    "\nvar mcp13Wide = Math.random() > 0.5; var mcp13Pad = mcp13Wide ? \"  \" : \" \";\nvar mcp13Line = `${mcp13Pad}a${mcp13Pad}b${mcp13Pad}c${mcp13Pad}d${mcp13Pad}e${mcp13Pad}f${mcp13Pad}g`;\n",
    "\nvar mcp13S = \"x\"; mcp13S += \"a\"; mcp13S += \"b\"; mcp13S += \"c\"; mcp13S += \"d\"; mcp13S += \"e\"; mcp13S += \"f\"; mcp13S += \"g\"; mcp13S += \"h\";\nvar mcp13U = mcp13S + \"!\";\n",
    `\n${doubled("mcp13D", 14)}\nvar mcp13E = mcp13D + "!";\n`,
  ];
  const artifacts = ["index.js", "index.cjs"];
  const appendToBuiltBundle = (file: string, code: string) => builtCopy((dist) => {
    dist[file] += code;
  });

  runOnBuild.each(artifacts.flatMap((file) => executableLoads.map((code, index) => ({ file, index, code }))))(
    "rejects the SDK name in executable data, split across lines or comments, wrapped, aliased or folded, in the built $file (case $index)",
    ({ file, code }) => {
      expect(() => verifyBundledSdk(appendToBuiltBundle(file, code))).toThrow(`dist/${file} references @modelcontextprotocol/sdk in executable code instead of bundling it`);
    },
    BUILT_TIMEOUT,
  );

  runOnBuild.each(artifacts.flatMap((file) => inertText.map((code, index) => ({ file, index, code }))))(
    "accepts SDK text in regexes, comments and JSDoc, protocol keys and other require specifiers in the built $file (case $index)",
    ({ file, code }) => {
      expect(() => verifyBundledSdk(appendToBuiltBundle(file, code))).not.toThrow();
    },
    BUILT_TIMEOUT,
  );

  // The diagnostic names the value and its line in the bundle.
  runOnBuild.each(artifacts)("names the SDK value and its line in the built %s", (file) => {
    const lines = readFileSync(join(packageRoot, "dist", file), "utf8").split("\n").length;
    expect(() => verifyBundledSdk(appendToBuiltBundle(file, "\nconst mcp13Scope = \"@modelcontextprotocol/\";\nrequire(mcp13Scope + \"sdk/types.js\");\n"))).toThrow(
      `instead of bundling it: "@modelcontextprotocol/sdk/types.js" at line ${lines + 2}`,
    );
    // A long folded value is named by the window where the SDK name completes.
    expect(() => verifyBundledSdk(appendToBuiltBundle(file, `\n${doubled("mcp13W", 12)}\nrequire(mcp13W + "@modelcontextprotocol/" + "sdk");\n`))).toThrow(
      `instead of bundling it: "ab@modelcontextprotocol/sdk" at line ${lines + 2}`,
    );
  }, BUILT_TIMEOUT);

  // More distinct candidates than the verifier folds fails instead of passing.
  // Candidates are distinct when they can complete the SDK name differently:
  // each value here is a different SDK name suffix and prefix around "#".
  const sdkName = "@modelcontextprotocol/sdk";
  const parts = Array.from({ length: 65 }, (_, k) => JSON.stringify(`${sdkName.slice(1 + (k % 24))}#${sdkName.slice(0, 1 + Math.floor(k / 24))}`));
  const overflow = `\nvar p65 = ${parts.map((part, k) => `c${k} ? ${part} : `).join("")}"";\nf(p65 + "x");\n`;
  runOnBuild.each(artifacts)("fails closed on more distinct candidate strings than it folds in the built %s", (file) => {
    expect(() => verifyBundledSdk(appendToBuiltBundle(file, overflow))).toThrow("more than 64 candidate strings");
  }, BUILT_TIMEOUT);
});
