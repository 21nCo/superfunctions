#!/usr/bin/env node
// Generates the fixture TypeScript SDK outside the monorepo, typechecks and
// packs it with its own pinned TypeScript, installs the tarball into a clean
// consumer project, compiles a typed consumer against it and runs that consumer
// against a local HTTP server. Run after `npm run build`. Needs registry access
// to install TypeScript. `--keep` keeps the temp directory.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "apifn-sdk-packed-")));
const keep = process.argv.includes("--keep");
const { generateSdk, SDK_TARGETS, writeSdk } = await import(pathToFileURL(path.join(packageDir, "dist/index.js")).href);
const readJson = (file) => JSON.parse(readFileSync(path.join(packageDir, "fixtures", file), "utf8"));

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}  (cwd: ${cwd})`);
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

const consumerSource = `
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ApiHttpError, TasksClient, isOperationError, type Task, type TasksClientOptions } from "@example/tasks-sdk";

const server = createServer((request, response) => {
  if (request.url === "/v1/projects/p1/tasks/t1?key=k1") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "t1", title: "Write", status: "open", assignee: null }));
  } else {
    response.writeHead(404, { "content-type": "application/problem+json" });
    response.end(JSON.stringify({ title: "Not found", status: 404 }));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };
const options: TasksClientOptions = { baseUrl: \`http://127.0.0.1:\${port}/v1\`, credentials: { apiKeyQuery: "k1" } };
const client = new TasksClient(options);
const task: Task = await client.getTask({ projectId: "p1", taskId: "t1" });
assert.deepEqual(task, { id: "t1", title: "Write", status: "open", assignee: null });
try {
  await client.getTask({ projectId: "p1", taskId: "missing" });
  assert.fail("expected a 404");
} catch (error) {
  assert.ok(error instanceof ApiHttpError);
  assert.ok(isOperationError(error, "tasks.get") && error.declared && error.status === 404);
  const title: string = error.body.title;
  assert.equal(title, "Not found");
}
server.close();
console.log(JSON.stringify({ consumer: "ok", task: task.id }));
`;

try {
  const result = generateSdk({ catalog: readJson("catalog/catalog.json"), config: readJson("typescript/sdk.config.json"), targets: SDK_TARGETS });
  if (!result.ok) throw new Error(`generation failed: ${JSON.stringify(result.diagnostics)}`);
  const sdkDir = path.join(workdir, "tasks-sdk");
  const written = await writeSdk(sdkDir, result);
  if (!written.ok) throw new Error(`write failed: ${JSON.stringify(written.diagnostics)}`);
  console.log(`generated ${result.manifest.package.name}@${result.manifest.package.version} from ${result.manifest.catalog.digest} into ${sdkDir}`);

  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], sdkDir);
  run("npm", ["run", "typecheck"], sdkDir);
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", workdir], sdkDir));
  const tarball = path.join(workdir, packed[0].filename);
  const files = packed[0].files.map((file) => file.path).sort();
  console.log(`packed ${packed[0].filename}: ${files.join(", ")}`);
  for (const required of ["apifn.sdk-manifest.json", "dist/index.js", "dist/index.d.ts", "dist/client.js", "dist/runtime.js", "package.json"]) {
    if (!files.includes(required)) throw new Error(`tarball is missing ${required}`);
  }

  const consumer = path.join(workdir, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "tasks-sdk-consumer", private: true, version: "0.0.0", type: "module" }));
  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM"], types: ["node"], strict: true, outDir: "dist", skipLibCheck: false }, include: ["src"] })
  );
  mkdirSync(path.join(consumer, "src"));
  writeFileSync(path.join(consumer, "src/main.ts"), consumerSource);
  const typescript = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf8")).devDependencies.typescript;
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball, `typescript@${typescript}`, "@types/node@20"], consumer);

  const installed = realpathSync(path.join(consumer, "node_modules/@example/tasks-sdk"));
  if (!installed.startsWith(consumer)) throw new Error(`the SDK resolved outside the consumer: ${installed}`);
  const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) throw new Error(`the SDK has runtime dependencies: ${Object.keys(manifest.dependencies)}`);
  for (const file of readdirSync(path.join(installed, "dist"), { recursive: true }).filter((name) => /\.(?:js|d\.ts)$/.test(name))) {
    const source = readFileSync(path.join(installed, "dist", file), "utf8");
    const imports = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
    const foreign = imports.filter((specifier) => !specifier.startsWith("./") && !specifier.startsWith("../"));
    if (foreign.length > 0) throw new Error(`dist/${file} imports ${foreign.join(", ")}; generated SDKs import only their own files`);
  }
  const provenance = JSON.parse(readFileSync(path.join(installed, "apifn.sdk-manifest.json"), "utf8"));
  if (provenance.catalog.digest !== result.manifest.catalog.digest) throw new Error("installed manifest has a different catalog digest");
  console.log(`installed ${installed}: no runtime dependencies, only relative imports, catalog ${provenance.catalog.digest}`);

  run(path.join(consumer, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumer);
  console.log(run("node", ["dist/main.js"], consumer).trim());
  console.log(`PACKED_SDK_OK ${packed[0].filename} in ${consumer}`);
} finally {
  if (!keep) rmSync(workdir, { recursive: true, force: true });
}
