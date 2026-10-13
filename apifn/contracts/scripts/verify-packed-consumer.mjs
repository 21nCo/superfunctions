#!/usr/bin/env node
// Packs @apifn/contracts, installs the tarball into a clean project outside the
// monorepo and checks that every public export loads from the installed
// package (ESM and CJS) without workspace or source paths. Run after build.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "../..");
const workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "apifn-contracts-consumer-")));
const keep = process.argv.includes("--keep");

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}  (cwd: ${cwd})`);
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

const consumerEsm = `
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import * as contracts from "@apifn/contracts";
import * as failure from "@apifn/contracts/failure-event";

const require = createRequire(import.meta.url);
const json = (specifier) => JSON.parse(readFileSync(require.resolve(specifier), "utf8"));
const spec = json("@apifn/contracts/fixtures/catalog/openapi.json");
const manifest = json("@apifn/contracts/fixtures/catalog/manifest.json");
const result = contracts.buildOperationCatalog(spec, manifest);
assert.deepEqual(result.diagnostics, []);
assert.equal(contracts.canonicalJson(result.catalog), contracts.canonicalJson(json("@apifn/contracts/fixtures/catalog/catalog.json")));
assert.equal(result.digest, json("@apifn/contracts/fixtures/catalog/release-descriptor.json").catalogDigest);
assert.equal(failure.validateClientFailureEvent(json("@apifn/contracts/fixtures/client-failure/valid/http-error.json")).ok, true);
for (const name of ["manifest", "operation-catalog", "release-descriptor", "client-failure-event"]) {
  assert.ok(json(\`@apifn/contracts/schemas/\${name}.v1.schema.json\`).$id);
}
console.log(JSON.stringify({ esm: Object.keys(contracts).sort(), failureEvent: Object.keys(failure).sort(), digest: result.digest }));
`;

const consumerCjs = `
const assert = require("node:assert/strict");
const contracts = require("@apifn/contracts");
const failure = require("@apifn/contracts/failure-event");
const spec = require("@apifn/contracts/fixtures/catalog/openapi.json");
const manifest = require("@apifn/contracts/fixtures/catalog/manifest.json");
const result = contracts.buildOperationCatalog(spec, manifest);
assert.deepEqual(result.diagnostics, []);
assert.equal(result.digest, require("@apifn/contracts/fixtures/catalog/release-descriptor.json").catalogDigest);
assert.equal(failure.validateClientFailureEvent(require("@apifn/contracts/fixtures/client-failure/valid/network-minimal.json")).ok, true);
console.log(JSON.stringify({ cjs: Object.keys(contracts).sort().length, resolved: require.resolve("@apifn/contracts") }));
`;

// OpenAPI 3.0 upconversion (__tests__/upconvert-cases.json): the installed package (with the registry
// @apifn/core) and the workspace build must give the 3.1 form's whole result for 3.0 objects and text,
// keeping literals, map keys and "__proto__" keys verbatim and turning nullable schemas into null types,
// including schemas in objects reached through references (read by the type of the referencing position).
const protoRows = (specifier) => `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildOperationCatalog, canonicalJson } from ${JSON.stringify(specifier)};
const spec = ${readFileSync(path.join(packageDir, "fixtures/catalog/openapi.json"), "utf8").trim()};
const manifest = ${readFileSync(path.join(packageDir, "fixtures/catalog/manifest.json"), "utf8").trim()};
// JSON.parse, not an object literal, which would read "__proto__" as the prototype.
const cases = JSON.parse(${JSON.stringify(readFileSync(path.join(packageDir, "__tests__/upconvert-cases.json"), "utf8"))});
const specWith = (version, entry) => {
  const next = JSON.parse(JSON.stringify(spec));
  next.openapi = version;
  for (const edit of entry.edits ?? [entry]) {
    let node = next;
    for (const key of edit.path.slice(0, -1)) node = node[key];
    node[edit.path[edit.path.length - 1]] = JSON.parse(JSON.stringify(version === "3.0.3" ? edit.openapi30 : (edit.openapi31 ?? edit.openapi30)));
  }
  return next;
};
const results = {};
for (const entry of [...cases.literals, ...cases.schemas, ...cases.references]) {
  const control = canonicalJson(buildOperationCatalog(specWith("3.1.0", entry), JSON.parse(JSON.stringify(manifest))));
  const legacy = specWith("3.0.3", entry);
  for (const [form, input] of [["3.0.3", legacy], ["3.0.3 text", JSON.stringify(legacy)]]) {
    const result = canonicalJson(buildOperationCatalog(input, JSON.parse(JSON.stringify(manifest))));
    assert.equal(result, control, entry.name + " " + form);
    if (entry.name === "a __proto__ property name") {
      assert.deepEqual(Object.keys(JSON.parse(result).catalog.schemas.ProjectInput.properties.meta.properties), ["__proto__", "a"]);
    }
    // A hash per row keeps the output small; equal hashes mean byte-identical results.
    results[entry.name + " " + form] = createHash("sha256").update(result).digest("hex");
  }
}
console.log(JSON.stringify(results));
`;

try {
  const packed = JSON.parse(run("npm", ["pack", "--workspace", "@apifn/contracts", "--pack-destination", workdir, "--json"], repoRoot));
  const tarball = path.join(workdir, packed[0].filename);
  const files = packed[0].files.map((file) => file.path);
  console.log(`packed ${packed[0].filename}: ${files.length} files`);
  const leaked = files.filter((file) => /^(src|__tests__|scripts)\//.test(file) || file.endsWith(".ts") && !file.endsWith(".d.ts") && !file.endsWith(".d.cts"));
  if (leaked.length > 0) throw new Error(`tarball contains source or test files: ${leaked.join(", ")}`);

  const consumer = path.join(workdir, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "contracts-consumer", private: true, version: "0.0.0" }));
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], consumer);

  const installed = realpathSync(path.join(consumer, "node_modules/@apifn/contracts"));
  if (!installed.startsWith(consumer)) throw new Error(`@apifn/contracts resolved outside the consumer: ${installed}`);
  const core = realpathSync(path.join(consumer, "node_modules/@apifn/core"));
  if (!core.startsWith(consumer)) throw new Error(`@apifn/core resolved outside the consumer: ${core}`);
  console.log(`@apifn/core ${JSON.parse(readFileSync(path.join(core, "package.json"), "utf8")).version} installed from the registry`);

  // The failure-event entry must stay runtime-neutral: no @apifn/core or Node built-ins.
  const neutral = new Set();
  const pending = ["dist/failure-event.js", "dist/failure-event.cjs"];
  while (pending.length > 0) {
    const file = pending.pop();
    if (neutral.has(file)) continue;
    neutral.add(file);
    const source = readFileSync(path.join(installed, file), "utf8");
    if (/@apifn\/core|["']node:|require\(["'](?:fs|path|crypto)["']\)/.test(source)) {
      throw new Error(`${file} is not runtime-neutral`);
    }
    for (const match of source.matchAll(/(?:from |require\()["'](\.\/[^"']+)["']/g)) {
      pending.push(path.posix.join("dist", match[1]));
    }
  }
  console.log(`runtime-neutral failure-event graph: ${[...neutral].sort().join(", ")}`);

  writeFileSync(path.join(consumer, "esm.mjs"), consumerEsm);
  writeFileSync(path.join(consumer, "cjs.cjs"), consumerCjs);
  console.log(run("node", ["esm.mjs"], consumer).trim());
  console.log(run("node", ["cjs.cjs"], consumer).trim());
  writeFileSync(path.join(consumer, "proto.mjs"), protoRows("@apifn/contracts"));
  writeFileSync(path.join(workdir, "proto-workspace.mjs"), protoRows(pathToFileURL(path.join(packageDir, "dist/index.js")).href));
  const installedRows = run("node", ["proto.mjs"], consumer).trim();
  const workspaceRows = run("node", ["proto-workspace.mjs"], workdir).trim();
  if (installedRows !== workspaceRows) throw new Error("OpenAPI 3.0 upconversion rows differ between the installed package and the workspace build");
  console.log(`${Object.keys(JSON.parse(installedRows)).length} OpenAPI 3.0 upconversion rows match 3.1 and the workspace build`);
  console.log(`PACKED_CONSUMER_OK ${packed[0].filename} in ${consumer}`);
} finally {
  if (!keep) rmSync(workdir, { recursive: true, force: true });
}
