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

  // MCP-13: the import scan reads tokens, not lines, on the real ESM and CJS bundles.
  const executableLoads = [
    "\nvoid import(\n  \"@modelcontextprotocol/sdk/server/index.js\"\n);\n",
    "\nvar server = require(\n  '@modelcontextprotocol/sdk/server/index.js'\n);\n",
    "\n/*\n * note */ require(\"@modelcontextprotocol/sdk/types.js\");\n",
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
  ];
  const inertText = [
    "\nvar HELP = \"import { Server } from '@modelcontextprotocol/sdk/server/index.js'\";\n",
    "\nvar HINT = `require('@modelcontextprotocol/sdk/types.js')`;\n// import(\"@modelcontextprotocol/sdk\")\n",
    // A require method call with another specifier or a non-literal argument.
    "\nvar obj = { require: (id) => id };\nvar name = \"x\";\nobj.require(\"other-pkg\");\nobj.require(name);\n",
    // A same-file helper whose require method only returns its argument.
    "\nconst helper = { require: (id) => id };\nvar sdk = helper.require(\"@modelcontextprotocol/sdk/types.js\");\n",
    // An SDK string bound in another function does not reach this require.
    "\nfunction mcp13A() { const id = \"@modelcontextprotocol/sdk/types.js\"; return id; }\nfunction mcp13B() { const id = \"node:path\"; return require(id); }\n",
    // Cyclic updates terminate, as call arguments and as computed member keys.
    "\n{ let msg = \"\"; msg = msg + \".\"; console.log(msg); }\n",
    "\n{ let tm = \"\"; tm = `${tm}.`; console.log(tm); }\n",
    "\n{ let ma = \"x\", mb = \"y\"; ma = mb + \"x\"; mb = ma + \"y\"; console.log(ma); const ko = { x: () => 0 }; ko[mb](\"@modelcontextprotocol/sdk/types.js\"); }\n",
  ];
  const artifacts = ["index.js", "index.cjs"];
  const appendToBuiltBundle = (file: string, code: string) => builtCopy((dist) => {
    dist[file] += code;
  });

  runOnBuild.each(artifacts.flatMap((file) => executableLoads.map((code, index) => ({ file, index, code }))))(
    "rejects SDK loads split across lines or comments, wrapped, aliased or through a loading require method, in the built $file (case $index)",
    ({ file, code }) => {
      expect(() => verifyBundledSdk(appendToBuiltBundle(file, code))).toThrow(`dist/${file} imports @modelcontextprotocol/sdk instead of bundling it`);
    },
    BUILT_TIMEOUT,
  );

  runOnBuild.each(artifacts.flatMap((file) => inertText.map((code, index) => ({ file, index, code }))))(
    "accepts SDK import text in strings and comments and inert require methods of the built $file (case $index)",
    ({ file, code }) => {
      expect(() => verifyBundledSdk(appendToBuiltBundle(file, code))).not.toThrow();
    },
    BUILT_TIMEOUT,
  );
});
