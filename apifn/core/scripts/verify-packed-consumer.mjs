#!/usr/bin/env node
// Packs @apifn/core, installs the tarball into a clean project outside the
// monorepo with @superfunctions/http 0.3.1 and without @testfn/core, and checks:
// - npm installs neither the optional @testfn/core peer nor @apifn/collections;
// - the root entry loads from ESM and CJS and builds an OpenAPI document from a
//   @superfunctions/http 0.3.1 router;
// - importing @apifn/core/testfn without testFn fails with an error naming @testfn/core;
// - after the consumer installs @testfn/core, @apifn/core/testfn loads from ESM and CJS, and
//   TypeScript (module node16, skipLibCheck false) type-checks an ESM (.mts) and a CommonJS (.cts)
//   consumer of it, so every declaration file either condition selects must compile;
// - the adapter's discover() fails with an error naming @apifn/collections until the consumer
//   installs it; then, with the packed workspace @apifn/collections next to the core tarball,
//   discover() and run() work in ESM and CJS against a flat collection served on localhost.
// Run after building @apifn/core (the package's test script runs it after vitest). Turbo builds
// @apifn/collections first and its dist is packed as is; a checkout without that dist (the tag release
// job installs only apifn/core) builds @apifn/collections from source in a scratch copy, so the adapter
// stage always runs.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HTTP_VERSION = "0.3.1";
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "../..");
const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
const testfnVersion = manifest.devDependencies?.["@testfn/core"];
// @testfn/core's own declarations reference Node globals (Buffer), so the typed consumer needs @types/node.
const typesNodeVersion = manifest.devDependencies?.["@types/node"];
const keep = process.argv.includes("--keep");
const collectionsManifest = JSON.parse(readFileSync(path.join(repoRoot, "apifn/collections/package.json"), "utf8"));
const tscBin = path.join(
  path.dirname(createRequire(path.join(packageDir, "package.json")).resolve("typescript/package.json")),
  "bin/tsc",
);

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}  (cwd: ${cwd})`);
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

// npm runs through node and its own CLI script, never through a shell: under `npm run`,
// npm_execpath names that script; on Windows (where `npm` is npm.cmd) the script ships next to
// node.exe. Elsewhere `npm` is an executable on PATH.
function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && /npm-cli\.c?js$/.test(npmCli)) return run(process.execPath, [npmCli, ...args], cwd);
  if (process.platform !== "win32") return run("npm", args, cwd);
  const bundledCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(bundledCli)) {
    throw new Error(`cannot find npm's CLI script: run this through \`npm run verify:packed\` or install npm at ${bundledCli}`);
  }
  return run(process.execPath, [bundledCli, ...args], cwd);
}

const node = (args, cwd) => run(process.execPath, args, cwd);

const collectionsDir = path.join(repoRoot, "apifn/collections");

/**
 * Packs the workspace @apifn/collections into workdir. Turbo's test task depends on its build, so its
 * dist is packed as is. Without that dist, the source is copied to a scratch directory, built with its
 * own tsup against the packed core tarball, and packed there with the original manifest.
 */
function packCollections(workdir, coreTarball) {
  const builtEntries = ["dist/index.js", "dist/index.cjs", "dist/index.d.ts"];
  if (builtEntries.every((entry) => existsSync(path.join(collectionsDir, entry)))) {
    console.log("@apifn/collections: packing the built workspace dist");
    return JSON.parse(npm(["pack", "--workspace", "@apifn/collections", "--pack-destination", workdir, "--json"], repoRoot));
  }
  const source = path.join(workdir, "collections-source");
  console.log(`@apifn/collections: ${collectionsDir}/dist is not built; building it from source in ${source}`);
  for (const entry of ["src", "package.json", "README.md", "tsconfig.json", "tsup.config.ts"]) {
    cpSync(path.join(collectionsDir, entry), path.join(source, entry), { recursive: true });
  }
  const original = readFileSync(path.join(source, "package.json"), "utf8");
  const buildManifest = JSON.parse(original);
  // Core is not on npm at this version yet; the build resolves it (and its types) from the packed tarball.
  buildManifest.dependencies["@apifn/core"] = `file:${coreTarball}`;
  delete buildManifest.devDependencies.vitest;
  writeFileSync(path.join(source, "package.json"), JSON.stringify(buildManifest, null, 2));
  npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock"], source);
  const tsupManifest = JSON.parse(readFileSync(path.join(source, "node_modules/tsup/package.json"), "utf8"));
  const tsupBin = typeof tsupManifest.bin === "string" ? tsupManifest.bin : tsupManifest.bin.tsup;
  node([path.join(source, "node_modules/tsup", tsupBin)], source);
  writeFileSync(path.join(source, "package.json"), original);
  const packed = JSON.parse(npm(["pack", "--pack-destination", workdir, "--json"], source));
  const files = new Set(packed[0].files.map((file) => file.path));
  for (const entry of builtEntries) {
    if (!files.has(entry)) throw new Error(`@apifn/collections built from source is missing ${entry}`);
  }
  return packed;
}

/** Runs a script that must fail, and returns its stderr. */
function runExpectingFailure(file, cwd) {
  console.log(`$ node ${file}  (cwd: ${cwd}, expected to fail)`);
  const result = spawnSync(process.execPath, [file], { cwd, encoding: "utf8" });
  if (result.status === 0) throw new Error(`${file} succeeded, but importing @apifn/core/testfn without @testfn/core must fail`);
  return result.stderr;
}

// The failure must come from @apifn/core's own testfn entry, so the error names both
// the missing package and the dist file that imports it.
function assertNamesTestfn(stderr, form, entry) {
  const line = stderr.split("\n").find((text) => text.includes("@testfn/core"));
  if (!line) throw new Error(`${form} import of @apifn/core/testfn failed without naming @testfn/core:\n${stderr}`);
  if (!stderr.replaceAll("\\", "/").includes(`node_modules/@apifn/core/dist/${entry}`)) {
    throw new Error(`${form} import of @apifn/core/testfn did not fail in dist/${entry}:\n${stderr}`);
  }
  console.log(`${form} @apifn/core/testfn without testFn fails in dist/${entry}: ${line.trim()}`);
}

const rootBody = `
const router = createRouter({
  routes: [{ method: "GET", path: "/users/:id", handler: async () => Response.json({}) }],
});
const doc = core.fromRouter(router, { info: { title: "Consumer", version: "1.0.0" } });
if (!doc.paths || !doc.paths["/users/{id}"] || !doc.paths["/users/{id}"].get) {
  throw new Error("fromRouter did not describe GET /users/{id}: " + JSON.stringify(doc.paths));
}
if ("ApifnTestAdapter" in core) throw new Error("the root entry still exports ApifnTestAdapter");
console.log(JSON.stringify({ exports: Object.keys(core).length, openapi: doc.openapi, paths: Object.keys(doc.paths) }));
`;

const rootEsm = `
import * as core from "@apifn/core";
import { createRouter } from "@superfunctions/http";
${rootBody}`;

// @superfunctions/http is ESM-only with top-level await, so the CJS consumer loads it with import();
// @apifn/core itself is loaded with require().
const rootCjs = `
const core = require("@apifn/core");
import("@superfunctions/http").then(({ createRouter }) => {
${rootBody}}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`;

const testfnBody = `
const adapter = new ApifnTestAdapter();
if (adapter.name !== "apifn" || !adapter.supports("apifn")) throw new Error("unexpected adapter identity");
if (!(adapter instanceof BaseAdapter)) throw new Error("ApifnTestAdapter does not extend the installed BaseAdapter");
console.log(JSON.stringify({ adapter: adapter.name }));
`;

const testfnEsm = `
import { ApifnTestAdapter } from "@apifn/core/testfn";
import { BaseAdapter } from "@testfn/core";
${testfnBody}`;

const testfnCjs = `
const { ApifnTestAdapter } = require("@apifn/core/testfn");
const { BaseAdapter } = require("@testfn/core");
${testfnBody}`;

// The adapter loads @apifn/collections only inside discover() and run(); without it, discover() must
// reject with an error naming the package.
const collectionsMissing = `
import { ApifnTestAdapter } from "@apifn/core/testfn";
try {
  await new ApifnTestAdapter().discover(["collection"]);
} catch (error) {
  if (!String(error).includes("@apifn/collections")) throw error;
  console.log(String(error).split("\\n")[0]);
  process.exit(0);
}
throw new Error("discover() succeeded without @apifn/collections");
`;

// A flat collection (opencollection.yml next to its requests): /ping answers 200 and /missing 404, so
// run() must report Ping passed and Missing failed. The collection directory itself is the pattern,
// because recursive discovery under native ESM is a known gap (API-12).
const collectionFiles = {
  "opencollection.yml": "name: Consumer API\n",
  "environments/local.yml": "variables:\n  baseUrl: http://127.0.0.1:9\n",
  "ping.yml": "info:\n  name: Ping\n  type: http\nhttp:\n  method: GET\n  url: '{{baseUrl}}/ping'\n",
  "missing.yml": "info:\n  name: Missing\n  type: http\nhttp:\n  method: GET\n  url: '{{baseUrl}}/missing'\n",
};

const adapterRunBody = `
const server = createServer((request, response) => {
  response.statusCode = request.url === "/ping" ? 200 : 404;
  response.end("{}");
});
server.listen(0, "127.0.0.1", async () => {
  try {
    const adapter = new ApifnTestAdapter();
    const tests = await adapter.discover([resolve("collection").replaceAll("\\\\", "/")]);
    const names = tests.map((test) => test.name).sort().join();
    if (names !== "Missing,Ping") throw new Error("discover() found " + JSON.stringify(tests));
    const results = await adapter.run(tests, { env: { baseUrl: "http://127.0.0.1:" + server.address().port } });
    const byName = Object.fromEntries(tests.map((test) => [test.name, results.find((result) => result.id === test.id)?.status]));
    if (byName.Ping !== "passed" || byName.Missing !== "failed") throw new Error("run() returned " + JSON.stringify(results));
    console.log(JSON.stringify(byName));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
`;

const adapterRunEsm = `
import { createServer } from "node:http";
import { resolve } from "node:path";
import { ApifnTestAdapter } from "@apifn/core/testfn";
${adapterRunBody}`;

const adapterRunCjs = `
const { createServer } = require("node:http");
const { resolve } = require("node:path");
const { ApifnTestAdapter } = require("@apifn/core/testfn");
${adapterRunBody}`;

// TypeScript consumers: with module node16 a .cts file resolves the "require" condition and must
// get CommonJS declarations (dist/testfn.d.cts); ESM declarations there fail with TS1479, and so does
// a d.cts that imports the ESM-only @testfn/core without resolution-mode "import". skipLibCheck is
// off so those declaration files are checked.
const typedConsumer = `
import { ApifnTestAdapter } from "@apifn/core/testfn";
const adapter: ApifnTestAdapter = new ApifnTestAdapter();
const supported: boolean = adapter.supports("apifn");
const name: string = adapter.name;
export { supported, name };
`;

const typedTsconfig = {
  compilerOptions: {
    module: "node16",
    moduleResolution: "node16",
    target: "ES2022",
    lib: ["ES2022"],
    types: ["node"],
    strict: true,
    noEmit: true,
    skipLibCheck: false,
  },
  files: ["typed-esm.mts", "typed-cjs.cts"],
};

let workdir;
try {
  if (!testfnVersion) throw new Error("apifn/core/package.json has no @testfn/core devDependency");
  if (!typesNodeVersion) throw new Error("apifn/core/package.json has no @types/node devDependency");
  if (collectionsManifest.dependencies?.["@apifn/core"] !== manifest.version) {
    throw new Error(`@apifn/collections pins @apifn/core ${collectionsManifest.dependencies?.["@apifn/core"]}, not ${manifest.version}`);
  }
  workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "apifn-core-consumer-")));
  const packed = JSON.parse(npm(["pack", "--workspace", "@apifn/core", "--pack-destination", workdir, "--json"], repoRoot));
  const tarball = path.join(workdir, packed[0].filename);
  const files = packed[0].files.map((file) => file.path);
  console.log(`packed ${packed[0].filename}: ${files.length} files`);
  for (const required of [
    "dist/index.js",
    "dist/index.cjs",
    "dist/testfn.js",
    "dist/testfn.cjs",
    "dist/testfn.d.ts",
    "dist/testfn.d.cts",
  ]) {
    if (!files.includes(required)) throw new Error(`tarball is missing ${required}`);
  }

  const consumer = path.join(workdir, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "apifn-core-consumer", private: true, version: "0.0.0" }));
  npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball, `@superfunctions/http@${HTTP_VERSION}`], consumer);

  const installed = realpathSync(path.join(consumer, "node_modules/@apifn/core"));
  if (!installed.startsWith(consumer)) throw new Error(`@apifn/core resolved outside the consumer: ${installed}`);
  const installedManifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  if (installedManifest.dependencies?.["@testfn/core"]) throw new Error("@apifn/core still depends on @testfn/core");
  if (installedManifest.peerDependenciesMeta?.["@testfn/core"]?.optional !== true) {
    throw new Error("@testfn/core is not an optional peer of @apifn/core");
  }
  if (existsSync(path.join(consumer, "node_modules/@testfn/core"))) {
    throw new Error("installing @apifn/core installed @testfn/core");
  }
  if (existsSync(path.join(consumer, "node_modules/@apifn/collections"))) {
    throw new Error("installing @apifn/core installed @apifn/collections");
  }
  const http = JSON.parse(readFileSync(path.join(consumer, "node_modules/@superfunctions/http/package.json"), "utf8"));
  if (http.version !== HTTP_VERSION) throw new Error(`expected @superfunctions/http ${HTTP_VERSION}, got ${http.version}`);
  console.log(`@apifn/core ${installedManifest.version} installed with @superfunctions/http ${http.version} and without @testfn/core`);
  npm(["ls", "@superfunctions/http"], consumer);

  writeFileSync(path.join(consumer, "root.mjs"), rootEsm);
  writeFileSync(path.join(consumer, "root.cjs"), rootCjs);
  console.log(`ESM root: ${node(["root.mjs"], consumer).trim()}`);
  console.log(`CJS root: ${node(["root.cjs"], consumer).trim()}`);

  writeFileSync(path.join(consumer, "testfn.mjs"), testfnEsm);
  writeFileSync(path.join(consumer, "testfn.cjs"), testfnCjs);
  writeFileSync(path.join(consumer, "missing.mjs"), `import "@apifn/core/testfn";\n`);
  writeFileSync(path.join(consumer, "missing.cjs"), `require("@apifn/core/testfn");\n`);
  assertNamesTestfn(runExpectingFailure("missing.mjs", consumer), "ESM", "testfn.js");
  assertNamesTestfn(runExpectingFailure("missing.cjs", consumer), "CJS", "testfn.cjs");

  npm(
    ["install", "--no-audit", "--no-fund", "--ignore-scripts", `@testfn/core@${testfnVersion}`, `@types/node@${typesNodeVersion}`],
    consumer,
  );
  console.log(`ESM @apifn/core/testfn with @testfn/core ${testfnVersion}: ${node(["testfn.mjs"], consumer).trim()}`);
  console.log(`CJS @apifn/core/testfn with @testfn/core ${testfnVersion}: ${node(["testfn.cjs"], consumer).trim()}`);

  writeFileSync(path.join(consumer, "typed-esm.mts"), typedConsumer);
  writeFileSync(path.join(consumer, "typed-cjs.cts"), typedConsumer);
  writeFileSync(path.join(consumer, "tsconfig.json"), JSON.stringify(typedTsconfig, null, 2));
  console.log(`$ node ${tscBin} -p tsconfig.json --traceResolution  (cwd: ${consumer})`);
  const tsc = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json", "--traceResolution"], {
    cwd: consumer,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (tsc.status !== 0) {
    const errors = `${tsc.stdout}${tsc.stderr}`.split("\n").filter((line) => /error TS\d+/.test(line));
    throw new Error(`TypeScript consumers of @apifn/core/testfn do not type-check:\n${errors.join("\n") || tsc.stderr}`);
  }
  const traced = tsc.stdout;
  for (const declaration of ["testfn.d.ts", "testfn.d.cts"]) {
    if (!traced.replaceAll("\\", "/").includes(`node_modules/@apifn/core/dist/${declaration}`)) {
      throw new Error(`TypeScript did not resolve @apifn/core/testfn to dist/${declaration}`);
    }
  }
  console.log("TypeScript node16 .mts and .cts consumers of @apifn/core/testfn type-check (dist/testfn.d.ts, dist/testfn.d.cts)");

  for (const [file, content] of Object.entries(collectionFiles)) {
    mkdirSync(path.dirname(path.join(consumer, "collection", file)), { recursive: true });
    writeFileSync(path.join(consumer, "collection", file), content);
  }
  writeFileSync(path.join(consumer, "collections-missing.mjs"), collectionsMissing);
  console.log(`discover() without @apifn/collections: ${node(["collections-missing.mjs"], consumer).trim()}`);

  // The registry @apifn/collections pins an older core, so install the workspace one built from this tree.
  const collectionsPacked = packCollections(workdir, tarball);
  npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", path.join(workdir, collectionsPacked[0].filename)], consumer);
  if (existsSync(path.join(consumer, "node_modules/@apifn/collections/node_modules/@apifn/core"))) {
    throw new Error("@apifn/collections installed its own @apifn/core instead of the packed one");
  }
  writeFileSync(path.join(consumer, "adapter-run.mjs"), adapterRunEsm);
  writeFileSync(path.join(consumer, "adapter-run.cjs"), adapterRunCjs);
  console.log(`ESM adapter discover()/run() with ${collectionsPacked[0].filename}: ${node(["adapter-run.mjs"], consumer).trim()}`);
  console.log(`CJS adapter discover()/run() with ${collectionsPacked[0].filename}: ${node(["adapter-run.cjs"], consumer).trim()}`);

  console.log(`PACKED_CONSUMER_OK ${packed[0].filename} in ${consumer}`);
} finally {
  if (workdir && !keep) rmSync(workdir, { recursive: true, force: true });
}
