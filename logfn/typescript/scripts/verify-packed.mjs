#!/usr/bin/env node
// Packs @logfn/core, installs the tarball offline into a clean consumer
// outside the repository and runs ESM, CommonJS and typed consumers against
// it: enrichment, sampling, bounded delivery to a local collector, redaction
// before the HTTP sink and failure isolation. Run after `npm run build`.
// `--keep` keeps the temp directory.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "../..");
const workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "logfn-packed-")));
const keep = process.argv.includes("--keep");

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}  (cwd: ${cwd})`);
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

const esmConsumer = `
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createLogger, enrichContext, sample, sinkHttp, REDACTED } from "@logfn/core";

const received = [];
let failNext = 0;
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    if (failNext > 0) {
      failNext -= 1;
      response.writeHead(503).end();
      return;
    }
    received.push(...JSON.parse(body).events);
    response.writeHead(204).end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = \`http://127.0.0.1:\${server.address().port}/ingest\`;
const quiet = { onError: () => {} };

// Enrichment and sampling ahead of HTTP delivery.
const randoms = [0.1, 0.9];
const sink = sinkHttp({ url, batch: 10, flushIntervalMs: 60_000, ...quiet });
const logger = createLogger({
  name: "consumer",
  level: "debug",
  pipeline: [
    enrichContext({ service: "consumer" }, () => ({ pid: 1 })),
    sample({ debug: 0.5 }, { random: () => randoms.shift() ?? 0.99 }),
  ],
  sinks: [sink],
});
logger.debug("kept by sampling");
logger.debug("dropped by sampling");
await logger.flush();
assert.deepEqual(received.map((event) => event.msg), ["kept by sampling"]);
assert.deepEqual(received[0].ctx, { service: "consumer", pid: 1 });

// Bounded queue: the oldest events are dropped, flush sends the rest.
received.length = 0;
const bounded = sinkHttp({ url, batch: 10, maxQueue: 3, flushIntervalMs: 60_000, ...quiet });
const boundedLogger = createLogger({ name: "bounded", sinks: [bounded] });
for (const msg of ["1", "2", "3", "4", "5"]) boundedLogger.info(msg);
assert.equal(bounded.stats().queued, 3);
assert.equal(bounded.stats().dropped, 2);
await boundedLogger.flush();
assert.deepEqual(received.map((event) => event.msg), ["3", "4", "5"]);

// A 503 is retried; redaction happens inside the sink without a pipeline stage.
received.length = 0;
failNext = 1;
const retrying = sinkHttp({ url, batch: 1, retry: { attempts: 3, backoffMs: 5 }, ...quiet });
createLogger({ name: "secret", sinks: [retrying] }).error("db postgres://svc:pw-1@db/app", { apiKey: "ak-1" });
await retrying.flush();
assert.equal(received.length, 1);
assert.equal(received[0].msg, \`db postgres://\${REDACTED}@db/app\`);
assert.deepEqual(received[0].ctx, { apiKey: REDACTED });
assert.equal(retrying.stats().sent, 1);

// Failing sinks never throw into the caller.
const unreachable = sinkHttp({ url: "http://127.0.0.1:9/ingest", batch: 1, retry: { attempts: 1 }, timeoutMs: 2_000, ...quiet });
const errors = [];
const fragile = createLogger({
  name: "fragile",
  sinks: [() => { throw new Error("sync"); }, async () => { throw new Error("async"); }, unreachable],
  onError: (error) => errors.push(error.message),
});
fragile.info("still fine");
await fragile.flush();
assert.deepEqual(errors.sort(), ["async", "sync"]);
assert.equal(unreachable.stats().dropped, 1);

server.close();
console.log(JSON.stringify({ consumer: "esm", ok: true }));
`;

const cjsConsumer = `
const assert = require("node:assert/strict");
const core = require("@logfn/core");
const browser = require("@logfn/core/browser");
const server = require("@logfn/core/server");
const vectors = require("@logfn/core/conformance/redaction-vectors.json");
assert.equal(typeof core.createLogger, "function");
assert.equal(typeof browser.captureBrowserErrors, "function");
assert.equal(browser.registerProcessHandlers, undefined);
assert.equal(typeof server.registerProcessHandlers, "function");
assert.equal(server.captureBrowserErrors, undefined);
assert.equal(vectors.marker, core.REDACTED);
const events = [];
const logger = core.createLogger({ name: "cjs", pipeline: [core.redactSecFn()], sinks: [(batch) => events.push(...batch)] });
logger.info("token=abc", { nested: { password: "pw" } });
assert.deepEqual(events[0].ctx, { nested: { password: core.REDACTED } });
assert.equal(events[0].msg, "token=" + core.REDACTED);
console.log(JSON.stringify({ consumer: "cjs", ok: true, vectors: vectors.vectors.length }));
`;

const typedConsumer = `
import { createLogger, sinkHttp, type HttpSinkStats, type LogEvent, type Sink } from "@logfn/core";
import { captureBrowserErrors } from "@logfn/core/browser";
import { registerProcessHandlers } from "@logfn/core/server";

const sink: Sink = (batch: LogEvent[]) => void batch;
const http = sinkHttp({ url: "https://collector.test/ingest", batch: 10, maxQueue: 100 });
const stats: HttpSinkStats = http.stats();
const logger = createLogger({ name: "typed", sinks: [sink, http] });
logger.error("failed", new Error("boom"));
export const helpers = [captureBrowserErrors, registerProcessHandlers, stats] as const;
`;

try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", workdir], packageDir));
  const tarball = path.join(workdir, packed[0].filename);
  const files = packed[0].files.map((file) => file.path).sort();
  console.log(`packed ${packed[0].filename}: ${files.join(", ")}`);
  for (const entry of ["index", "browser", "server"]) {
    for (const suffix of [".js", ".cjs", ".d.ts", ".d.cts"]) {
      if (!files.includes(`dist/${entry}${suffix}`)) throw new Error(`tarball is missing dist/${entry}${suffix}`);
    }
  }
  for (const required of ["conformance/redaction-vectors.json", "package.json", "README.md"]) {
    if (!files.includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  const unexpected = files.filter((file) => /^(src|test|scripts)\//.test(file));
  if (unexpected.length > 0) throw new Error(`tarball ships ${unexpected.join(", ")}`);

  const consumer = path.join(workdir, "consumer");
  mkdirSync(path.join(consumer, "src"), { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "logfn-consumer", private: true, version: "0.0.0", type: "module" }));
  run("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], consumer);

  const installed = realpathSync(path.join(consumer, "node_modules/@logfn/core"));
  if (!installed.startsWith(consumer)) throw new Error(`@logfn/core resolved outside the consumer: ${installed}`);
  const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (manifest[field] && Object.keys(manifest[field]).length > 0) throw new Error(`@logfn/core declares ${field}`);
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
  run(process.execPath, [path.join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], consumer);
  console.log(`PACKED_CONSUMER_OK ${packed[0].filename} in ${consumer}`);
} finally {
  if (!keep) rmSync(workdir, { recursive: true, force: true });
}
