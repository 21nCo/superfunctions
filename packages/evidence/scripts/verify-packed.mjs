#!/usr/bin/env node
// Packs @superfunctions/evidence, installs the tarball offline into a clean
// consumer outside the repository, imports it and its JSON Schema subpath in
// Node, type-checks a typed consumer, and bundles the `.` entry for the
// browser with esbuild (platform=browser, Node built-ins refused), then runs
// that bundle in a bare VM context with no Node globals. Builds the package
// first, so it never checks a missing or stale dist. `--keep` keeps the temp
// directory.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "evidence-packed-")));
const keep = process.argv.includes("--keep");
// Resolve the build tools the way the package's own scripts do: from the
// package, falling back to a hoisted workspace install above it.
const require = createRequire(path.join(packageDir, "package.json"));
const name = "@superfunctions/evidence";

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}  (cwd: ${cwd})`);
  const shell = process.platform === "win32" && command === "npm";
  return execFileSync(command, shell ? args.map((arg) => `"${arg}"`) : args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell });
}

const record = JSON.parse(readFileSync(path.join(packageDir, "test/fixtures/records/minimal.json"), "utf8"));
const options = { expectedCommit: record.source.commit, now: "2026-11-01T12:00:00Z", expiryPolicy: { "unit-test": 24 } };

const esmConsumer = `
import assert from "node:assert/strict";
import { EVIDENCE_FAILURE_CODES, evidenceRecordSchemaV1, validateEvidenceRecord } from "${name}";
import schemaFile from "${name}/schema/evidence-record.v1.json" with { type: "json" };
const record = ${JSON.stringify(record)};
const options = ${JSON.stringify(options)};
assert.deepEqual(validateEvidenceRecord(record, options), { ok: true, failures: [] });
const blocked = validateEvidenceRecord({ ...record, status: "blocked" }, options);
assert.deepEqual(blocked.failures.map((failure) => failure.code), ["EVIDENCE_NOT_PASSED"]);
assert.deepEqual(validateEvidenceRecord(undefined, options).failures, [{ code: "EVIDENCE_MISSING" }]);
assert.equal(EVIDENCE_FAILURE_CODES.length, 11);
assert.deepEqual(evidenceRecordSchemaV1, schemaFile);
assert.equal(schemaFile.$id, "urn:superfunctions:evidence-record:v1");
console.log(JSON.stringify({ consumer: "esm", ok: true }));
`;

const typedConsumer = `
import { validateEvidenceRecord, type EvidenceFailureCode, type EvidenceRecordV1, type ValidateEvidenceRecordOptions } from "${name}";
declare const record: EvidenceRecordV1;
const options: ValidateEvidenceRecordOptions = { expectedCommit: "${options.expectedCommit}", now: new Date(), expiryPolicy: { "unit-test": 24 } };
const result = validateEvidenceRecord(record, options);
export const codes: EvidenceFailureCode[] = result.failures.map((failure) => failure.code);
export const ok: boolean = result.ok;
`;

const browserConsumer = `
import { evidenceRecordSchemaV1, validateEvidenceRecord } from "${name}";
const record = ${JSON.stringify(record)};
globalThis.__evidence = { schemaId: evidenceRecordSchemaV1.$id, result: validateEvidenceRecord(record, ${JSON.stringify(options)}) };
`;

try {
  run("npm", ["run", "build"], packageDir);
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", workdir], packageDir));
  const tarball = path.join(workdir, packed[0].filename);
  const files = packed[0].files.map((file) => file.path).sort();
  console.log(`packed ${packed[0].filename}: ${files.join(", ")}`);
  for (const required of ["dist/index.js", "dist/index.d.ts", "schema/evidence-record.v1.json", "package.json", "README.md"]) {
    if (!files.includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  const unexpected = files.filter((file) => /^(src|test|scripts)\//.test(file));
  if (unexpected.length > 0) throw new Error(`tarball ships ${unexpected.join(", ")}`);

  const consumer = path.join(workdir, "consumer");
  mkdirSync(path.join(consumer, "src"), { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "evidence-consumer", private: true, version: "0.0.0", type: "module" }));
  run("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], consumer);

  const installed = realpathSync(path.join(consumer, "node_modules", name));
  if (!installed.startsWith(consumer)) throw new Error(`${name} resolved outside the consumer: ${installed}`);
  const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  const { version } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  if (manifest.version !== version) throw new Error(`expected ${name} ${version}, found ${manifest.version}`);
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (manifest[field] && Object.keys(manifest[field]).length > 0) throw new Error(`${name} declares ${field}`);
  }

  writeFileSync(path.join(consumer, "main.mjs"), esmConsumer);
  console.log(`node ${process.version}: ${run(process.execPath, ["main.mjs"], consumer).trim()}`);

  writeFileSync(path.join(consumer, "src/typed.ts"), typedConsumer);
  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: [], strict: true, noEmit: true, skipLibCheck: false },
      include: ["src"],
    }),
  );
  run(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], consumer);

  // Browser bundle: any import of a Node built-in fails to resolve here.
  writeFileSync(path.join(consumer, "browser.mjs"), browserConsumer);
  const esbuild = require("esbuild");
  const nodeBuiltins = new Set(builtinModules.flatMap((builtin) => [builtin, `node:${builtin}`]));
  const result = await esbuild.build({
    absWorkingDir: consumer,
    entryPoints: ["browser.mjs"],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
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
  if (!inputs.some((input) => input.includes(`node_modules/${name}/dist/index.js`))) throw new Error(`browser bundle did not use dist/index.js: ${inputs.join(", ")}`);
  const bundle = result.outputFiles[0].text;
  if (/\brequire\(|\bprocess\.|\bBuffer\b/.test(bundle)) throw new Error("browser bundle references require(), process or Buffer");
  // A fresh context has only the ECMAScript built-ins: no process, Buffer, require or DOM.
  const sandbox = {};
  runInNewContext(bundle, sandbox);
  const evidence = sandbox.__evidence;
  if (evidence?.schemaId !== "urn:superfunctions:evidence-record:v1" || evidence?.result?.ok !== true) {
    throw new Error(`browser bundle did not validate the record: ${JSON.stringify(evidence)}`);
  }
  console.log(`browser bundle: ${bundle.length} bytes from ${inputs.join(", ")}; ran in a bare context`);
  console.log(`PACKED_CONSUMER_OK ${packed[0].filename} in ${consumer}`);
} finally {
  if (!keep) rmSync(workdir, { recursive: true, force: true });
}
