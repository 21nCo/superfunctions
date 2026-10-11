#!/usr/bin/env node
// Packs @apifn/contracts, installs the tarball into a clean project outside the
// monorepo and checks that every public export loads from the installed
// package (ESM and CJS) without workspace or source paths. Run after build.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  console.log(`PACKED_CONSUMER_OK ${packed[0].filename} in ${consumer}`);
} finally {
  if (!keep) rmSync(workdir, { recursive: true, force: true });
}
