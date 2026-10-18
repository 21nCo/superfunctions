/** Build packages first. Installs real tarballs and retains the consumer as evidence. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "testfn-packed-consumer-"));
const run = (command, args, cwd = directory) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
try {
  const dependencies = {};
  for (const path of [
    "packages/observability",
    "packages/db",
    "mcpfn/core",
    "packages/admin",
    "testfn/typescript",
    "testfn/admin",
  ]) {
    const [pack] = JSON.parse(
      run(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
        join(root, path),
      ),
    );
    dependencies[pack.name] = `file:${join(directory, pack.filename)}`;
  }
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies,
      devDependencies: { typescript: "5.9.3", "@types/node": "22" },
    }),
  );
  run("npx", [
    "--yes",
    "npm@11.21.0",
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  run("npm", [
    "ci",
    "--dry-run",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  writeFileSync(
    join(directory, "consumer.mts"),
    `import {testFn,TestStorage,getTestFnSchema,VisualTester} from '@testfn/core';import {memoryAdapter} from '@superfunctions/db/adapters/memory';import {createTestFnDomainAdminService} from '@testfn/admin';const runner=testFn({framework:'vitest',signal:new AbortController().signal});const storage=new TestStorage({type:'db',adapter:memoryAdapter()});void getTestFnSchema();void createTestFnDomainAdminService({resolve:()=>({runner,storage,visual:new VisualTester({baselineDir:'b',diffDir:'d'}),environment:{platform:'test'}})});`,
  );
  writeFileSync(
    join(directory, "consumer.cts"),
    `async function consume(){const {testFn}=await import('@testfn/core');return testFn({framework:'puppeteer'});}void consume;`,
  );
  for (const mode of ["Node16", "NodeNext"]) {
    run(process.execPath, [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      mode,
      "--moduleResolution",
      mode,
      "consumer.mts",
      "consumer.cts",
    ]);
    console.log(mode + " declarations passed");
  }
  writeFileSync(
    join(directory, "smoke.mjs"),
    `import assert from 'node:assert/strict';import {testFn,TestStorage} from '@testfn/core';import {memoryAdapter} from '@superfunctions/db/adapters/memory';import {createTestFnDomainAdminService} from '@testfn/admin';const runner=testFn({framework:'vitest',reporters:[]});runner.setAdapter({name:'consumer',supports:()=>true,discover:async()=>[{id:'id',name:'name',file:'test.js'}],run:async()=>[{id:'id',status:'passed',duration:1}]});assert.equal((await runner.run()).summary.passed,1);const storage=new TestStorage({type:'db',adapter:memoryAdapter()});await storage.open();assert.deepEqual(await storage.getRecentRuns(10),[]);await storage.close();assert.equal(typeof createTestFnDomainAdminService,'function');console.log('Packed runtime passed',process.version);`,
  );
  writeFileSync(
    join(directory, "smoke-core.mjs"),
    readFileSync(join(directory, "smoke.mjs"), "utf8")
      .replace(
        "import {createTestFnDomainAdminService} from '@testfn/admin';",
        "",
      )
      .replace(
        "assert.equal(typeof createTestFnDomainAdminService,'function');",
        "",
      ),
  );
  const results = [];
  for (const version of ["18.18.0", "20.0.0", "20", "22"]) {
    const result = spawnSync(
      "npx",
      [
        "--yes",
        `--package=node@${version}`,
        "node",
        version === "18.18.0" ? "smoke-core.mjs" : "smoke.mjs",
      ],
      { cwd: directory, encoding: "utf8" },
    );
    results.push({
      version,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd: directory,
    encoding: "utf8",
  });
  writeFileSync(join(directory, "audit.json"), audit.stdout);
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log("Runtime audit:", JSON.parse(audit.stdout).metadata);
  console.log("Consumer retained:", directory);
  if (audit.status || results.some((r) => r.status)) process.exitCode = 1;
} catch (error) {
  console.error("Consumer retained:", directory);
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
}
