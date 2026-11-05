#!/usr/bin/env node
// Packs @watchfn/core with the workspace packages it depends on, installs the
// tarballs into a clean consumer outside the repository and runs ESM,
// CommonJS and typed consumers against them: start, ingest, query and stop on
// the memory adapter and on a SQLite file through @superfunctions/db, the HTTP
// routes, an injected storage failure, and the minimal entry's import graph.
// Run after `npm run build` of this package and its workspace dependencies.
// Third-party packages (better-sqlite3, drizzle-orm, @types/node) come from
// the npm cache or registry; better-sqlite3 runs its install script to fetch
// or build its native binding. `--keep` keeps the temp directory.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "../..");
const workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "watchfn-packed-")));
const keep = process.argv.includes("--keep");

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}  (cwd: ${cwd})`);
  const shell = process.platform === "win32" && command === "npm";
  return execFileSync(command, shell ? args.map((arg) => `"${arg}"`) : args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell });
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const rootVersion = (name) => readJson(path.join(repoRoot, "node_modules", name, "package.json")).version;

// Workspace packages @watchfn/core needs at run time, packed from this checkout
// because their current versions are not on the registry.
const WORKSPACE_PACKAGES = ["watchfn/typescript", "packages/http", "packages/observability", "packages/db"];

const esmConsumer = `
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import { createMemoryStorage, createWatch } from "@watchfn/core";
import { createSqliteStorage } from "@watchfn/core/sqlite";
import { createWatchRouter } from "@watchfn/core/http";

// Memory adapter (test fixture, not durable).
const memory = createWatch({ storage: createMemoryStorage() });
assert.equal((await memory.ingest({ type: "early" })).ok, false);
await Promise.all([memory.start(), memory.start()]);
const receipt = await memory.ingest({ type: "sdk.failure", attributes: { operation: "tasks.get", release: "1.2.0" } });
assert.equal(receipt.ok, true);
assert.equal(receipt.durable, false);
const found = await memory.query({ type: "sdk.failure", attributes: { operation: "tasks.get" } });
assert.deepEqual(found.events, [receipt.event]);
await memory.stop();
await memory.stop();
assert.equal(memory.state, "stopped");

// Injected storage failure: a failed receipt, never a success.
const failing = createWatch({ storage: { kind: "broken", durable: true, write: async () => { throw new Error("disk full"); }, query: async () => [] } });
await failing.start();
const failed = await failing.ingest({ type: "lost" });
assert.equal(failed.ok, false);
assert.equal(failed.error.code, "storage_failed");
await failing.stop();

// Durable SQLite file through @superfunctions/db, reopened on a new connection.
const file = process.argv[2];
const first = new Database(file);
const durable = createWatch({ storage: createSqliteStorage({ adapter: drizzleAdapter({ db: drizzle(first), dialect: "sqlite" }) }) });
await durable.start();
const stored = await durable.ingestBatch([
  { type: "sdk.failure", timestamp: "2026-10-01T00:00:00Z", attributes: { operation: "tasks.get", release: "1.2.0" } },
  { type: "sdk.failure", timestamp: "2026-10-01T00:05:00Z", attributes: { operation: "tasks.list", release: "1.2.0" } },
]);
assert.equal(stored.ok, true);
assert.equal(stored.durable, true);
await durable.stop();
assert.equal(first.open, true, "stop must not close the caller's connection");
first.close();

const second = new Database(file);
const reopened = createWatch({ storage: createSqliteStorage({ adapter: drizzleAdapter({ db: drizzle(second), dialect: "sqlite" }) }) });
await reopened.start();
const byRelease = await reopened.query({ from: "2026-10-01T00:00:00Z", to: "2026-10-01T01:00:00Z", attributes: { release: "1.2.0" }, order: "asc" });
assert.deepEqual(byRelease.events, stored.events);

// HTTP routes return persisted events.
const router = createWatchRouter(reopened, { authorize: (request) => request.headers.get("x-token") === "local" });
const headers = { "content-type": "application/json", "x-token": "local" };
const ingested = await router.handle(new Request("http://local/ingest", { method: "POST", headers, body: JSON.stringify({ type: "sdk.failure", attributes: { operation: "tasks.get" } }) }));
assert.equal(ingested.status, 201);
const queried = await router.handle(new Request("http://local/query", { method: "POST", headers, body: JSON.stringify({ attributes: { operation: "tasks.get" } }) }));
assert.equal(queried.status, 200);
assert.equal((await queried.json()).events.length, 2);
const denied = await router.handle(new Request("http://local/query", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
assert.equal(denied.status, 401);
await reopened.stop();
second.close();
console.log(JSON.stringify({ consumer: "esm", ok: true, durableEvents: byRelease.events.length }));
`;

const cjsConsumer = `
const assert = require("node:assert/strict");
const before = new Set(Object.keys(require.cache));
const core = require("@watchfn/core");
const loaded = Object.keys(require.cache).filter((file) => !before.has(file));
// Normalise Windows separators so the check is platform-neutral.
assert.deepEqual(loaded.map((file) => file.replace(/\\\\/g, "/").split("node_modules/").pop()), ["@watchfn/core/dist/index.cjs"]);
assert.equal(typeof core.createWatch, "function");
assert.equal(typeof require("@watchfn/core/sqlite").createSqliteStorage, "function");
// The HTTP routes are ESM only, like @superfunctions/http.
assert.throws(() => require("@watchfn/core/http"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
assert.equal(typeof require("@watchfn/core/collectors").processMetricsCollector, "function");
(async () => {
  const watch = core.createWatch({ storage: core.createMemoryStorage() });
  await watch.start();
  const receipt = await watch.ingest({ type: "cjs" });
  assert.equal(receipt.ok, true);
  assert.equal((await watch.query({ type: "cjs" })).events.length, 1);
  await watch.stop();
  console.log(JSON.stringify({ consumer: "cjs", ok: true }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

const typedConsumer = `
import { createMemoryStorage, createWatch, type EventQueryResult, type IngestReceipt, type StorageAdapter, type Watch } from "@watchfn/core";
import { createSqliteStorage } from "@watchfn/core/sqlite";
import { createWatchRouter } from "@watchfn/core/http";
import { processMetricsCollector } from "@watchfn/core/collectors";
import type { Adapter } from "@superfunctions/db";

export async function run(adapter: Adapter): Promise<EventQueryResult> {
  const storage: StorageAdapter = createSqliteStorage({ adapter });
  const watch: Watch = createWatch({ storage, collectors: [processMetricsCollector({ intervalMs: 60_000 })] });
  await watch.start();
  const receipt: IngestReceipt = await watch.ingest({ type: "typed", attributes: { ok: true } });
  if (!receipt.ok) throw new Error(receipt.error.message);
  createWatchRouter(watch, { authorize: () => true });
  const result = await watch.query({ type: "typed", order: "asc", limit: 10 });
  await watch.stop();
  return result;
}
export const memory = createWatch({ storage: createMemoryStorage({ maxEvents: 10 }) });
`;

try {
  const tarballs = [];
  for (const relative of WORKSPACE_PACKAGES) {
    const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", workdir], path.join(repoRoot, relative)));
    tarballs.push(path.join(workdir, packed[0].filename));
    if (relative === "watchfn/typescript") {
      const files = packed[0].files.map((entry) => entry.path).sort();
      console.log(`packed ${packed[0].filename}: ${files.join(", ")}`);
      const expected = ["index", "sqlite", "collectors"].flatMap((entry) => [".js", ".cjs", ".d.ts", ".d.cts"].map((suffix) => `dist/${entry}${suffix}`));
      for (const file of [...expected, "dist/http.js", "dist/http.d.ts", "README.md", "package.json"]) {
        if (!files.includes(file)) throw new Error(`tarball is missing ${file}`);
      }
      const unexpected = files.filter((file) => /^(src|test|scripts)\//.test(file));
      if (unexpected.length > 0) throw new Error(`tarball ships ${unexpected.join(", ")}`);
    } else {
      console.log(`packed ${packed[0].filename}`);
    }
  }

  const consumer = path.join(workdir, "consumer");
  mkdirSync(path.join(consumer, "src"), { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "watchfn-consumer", private: true, version: "0.0.0", type: "module" }));
  run(
    "npm",
    [
      "install",
      // No dependency's install script runs; only better-sqlite3 is rebuilt below, explicitly.
      "--ignore-scripts",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      ...tarballs,
      `better-sqlite3@${rootVersion("better-sqlite3")}`,
      `drizzle-orm@${rootVersion("drizzle-orm")}`,
      "@types/node@20",
    ],
    consumer
  );
  run("npm", ["rebuild", "better-sqlite3", "--foreground-scripts"], consumer);

  for (const name of ["@watchfn/core", "@superfunctions/db", "@superfunctions/http", "better-sqlite3"]) {
    const installed = realpathSync(path.join(consumer, "node_modules", name));
    if (!installed.startsWith(consumer)) throw new Error(`${name} resolved outside the consumer: ${installed}`);
  }
  const manifest = readJson(path.join(consumer, "node_modules/@watchfn/core/package.json"));
  console.log(`installed @watchfn/core@${manifest.version} with dependencies ${JSON.stringify(manifest.dependencies)}`);

  writeFileSync(path.join(consumer, "main.mjs"), esmConsumer);
  writeFileSync(path.join(consumer, "main.cjs"), cjsConsumer);
  console.log(run("node", ["main.mjs", path.join(consumer, "events.db")], consumer).trim());
  console.log(run("node", ["main.cjs"], consumer).trim());

  writeFileSync(path.join(consumer, "src/typed.ts"), typedConsumer);
  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM"], types: ["node"], strict: true, noEmit: true, skipLibCheck: true },
      include: ["src"],
    })
  );
  run(process.execPath, [path.join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], consumer);
  console.log(`PACKED_CONSUMER_OK ${path.basename(tarballs[0])} in ${consumer}`);
} finally {
  if (!keep) rmSync(workdir, { recursive: true, force: true });
}
