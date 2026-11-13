#!/usr/bin/env node
// Packs catchfn, installs the tarball offline into a clean consumer outside
// the repository, imports it from ESM and CommonJS in Node, type-checks a
// typed consumer and bundles a browser consumer with esbuild
// (platform=browser) to prove the package needs no Node built-ins.
// Builds the package first, so it never checks a missing or stale dist.
// TypeScript and esbuild resolve from the package, as in an isolated
// release install. `--keep` keeps the temp directory.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "catchfn-packed-")));
const keep = process.argv.includes("--keep");
// Resolve the build tools the way the package's own scripts do: from the
// package, falling back to a hoisted workspace install above it.
const require = createRequire(path.join(packageDir, "package.json"));

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}  (cwd: ${cwd})`);
  const shell = process.platform === "win32" && command === "npm";
  return execFileSync(command, shell ? args.map((arg) => `"${arg}"`) : args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell });
}

const esmConsumer = `
import assert from "node:assert/strict";
import { BreadcrumbCollector, ConsoleCollector, NetworkCollector, validateEvidenceEvent, redactUrl, EVIDENCE_SCHEMA_VERSION } from "catchfn";
assert.equal(EVIDENCE_SCHEMA_VERSION, 1);
const page = globalThis.fetch = async () => new Response("ok", { status: 200 });
const original = console.info;
const consoleCollector = new ConsoleCollector(5);
const network = new NetworkCollector(5);
const breadcrumbs = new BreadcrumbCollector(5);
consoleCollector.start();
network.start();
console.info("packed", { nested: true });
await fetch("/api?token=packed-secret&safe=1");
breadcrumbs.addUser("click", "save");
consoleCollector.stop();
network.stop();
assert.equal(console.info, original);
assert.equal(globalThis.fetch, page);
const events = [...consoleCollector.collect(), ...network.collect(), ...breadcrumbs.collect({ since: 0 })];
assert.deepEqual(events.map((event) => event.kind), ["console", "network", "breadcrumb"]);
for (const event of events) assert.deepEqual(validateEvidenceEvent(JSON.parse(JSON.stringify(event))), []);
assert.ok(!JSON.stringify(events).includes("packed-secret"));
assert.ok(!redactUrl("/x?token=t-secret").includes("t-secret"));
console.log(JSON.stringify({ consumer: "esm", ok: true, events: events.length }));
`;

const cjsConsumer = `
const assert = require("node:assert/strict");
const catchfn = require("catchfn");
assert.equal(typeof catchfn.ConsoleCollector, "function");
assert.equal(catchfn.evidenceEventSchema.$id, "urn:catchfn:evidence-event:v1");
const buffer = new catchfn.RingBuffer(2);
for (const timestamp of [1, 2, 3]) buffer.push({ timestamp });
assert.deepEqual(buffer.query({ since: 2, until: 3 }).map((entry) => entry.timestamp), [2, 3]);
assert.equal(catchfn.serializeEntry(Object.assign({}, { a: 1 })).a, 1);
console.log(JSON.stringify({ consumer: "cjs", ok: true }));
`;

const typedConsumer = `
import { ConsoleCollector, type EvidenceEvent, type ConsoleEvidenceEvent, type CollectWindow } from "catchfn";
const window: CollectWindow = { since: 0, until: Date.now() };
const events: ConsoleEvidenceEvent[] = new ConsoleCollector().collect(window);
export const all: EvidenceEvent[] = events;
`;

const browserConsumer = `
import { BreadcrumbCollector, ConsoleCollector, NetworkCollector, evidenceEventSchema } from "catchfn";
const collectors = [new ConsoleCollector(), new NetworkCollector()];
for (const collector of collectors) collector.start();
new BreadcrumbCollector().addNavigation(location.pathname, "/next");
globalThis.__catchfn = { collectors, schema: evidenceEventSchema };
`;

try {
  run("npm", ["run", "build"], packageDir);
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", workdir], packageDir));
  const tarball = path.join(workdir, packed[0].filename);
  const files = packed[0].files.map((file) => file.path).sort();
  console.log(`packed ${packed[0].filename}: ${files.join(", ")}`);
  for (const suffix of [".js", ".cjs", ".d.ts", ".d.cts"]) {
    if (!files.includes(`dist/index${suffix}`)) throw new Error(`tarball is missing dist/index${suffix}`);
  }
  for (const required of ["package.json", "README.md"]) {
    if (!files.includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  const unexpected = files.filter((file) => /^(src|test|scripts)\//.test(file));
  if (unexpected.length > 0) throw new Error(`tarball ships ${unexpected.join(", ")}`);

  const consumer = path.join(workdir, "consumer");
  mkdirSync(path.join(consumer, "src"), { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "catchfn-consumer", private: true, version: "0.0.0", type: "module" }));
  run("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], consumer);

  const installed = realpathSync(path.join(consumer, "node_modules/catchfn"));
  if (!installed.startsWith(consumer)) throw new Error(`catchfn resolved outside the consumer: ${installed}`);
  const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  if (manifest.version !== "0.1.0") throw new Error(`expected catchfn 0.1.0, found ${manifest.version}`);
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (manifest[field] && Object.keys(manifest[field]).length > 0) throw new Error(`catchfn declares ${field}`);
  }

  writeFileSync(path.join(consumer, "main.mjs"), esmConsumer);
  writeFileSync(path.join(consumer, "main.cjs"), cjsConsumer);
  console.log(run("node", ["main.mjs"], consumer).trim());
  console.log(run("node", ["main.cjs"], consumer).trim());

  writeFileSync(path.join(consumer, "src/typed.ts"), typedConsumer);
  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM"], types: [], strict: true, noEmit: true, skipLibCheck: false },
      include: ["src"],
    })
  );
  run(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], consumer);

  // Browser bundle: any import of a Node built-in fails to resolve here.
  writeFileSync(path.join(consumer, "browser.mjs"), browserConsumer);
  const esbuild = require("esbuild");
  const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const result = await esbuild.build({
    absWorkingDir: consumer,
    entryPoints: ["browser.mjs"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "forbid-node-builtins",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => (nodeBuiltins.has(args.path) ? { errors: [{ text: `Node built-in imported: ${args.path} from ${args.importer}` }] } : undefined));
        },
      },
    ],
  });
  const inputs = Object.keys(result.metafile.inputs);
  if (!inputs.some((input) => input.includes("node_modules/catchfn/dist/index.js"))) throw new Error(`browser bundle did not use the ESM build: ${inputs.join(", ")}`);
  const bundle = result.outputFiles[0].text;
  if (/\brequire\(|from\s*["']node:/.test(bundle)) throw new Error("browser bundle still references require() or node: imports");
  console.log(`browser bundle: ${bundle.length} bytes from ${inputs.join(", ")}`);
  console.log(`PACKED_CONSUMER_OK ${packed[0].filename} in ${consumer}`);
} finally {
  if (!keep) rmSync(workdir, { recursive: true, force: true });
}
