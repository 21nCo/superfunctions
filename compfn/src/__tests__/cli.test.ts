import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("cli/dist/index.js");
let directory: string;
let config: string;
function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args, "--config", config], { encoding:"utf8" });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "compfn cli "));
  config = join(directory, "config.json");
  writeFileSync(config, JSON.stringify({database:{type:"memory"}}));
});
afterEach(() => rmSync(directory, {recursive:true,force:true}));

describe("CLI process contract", () => {
  it("initializes memory config and reports an empty check collection", () => {
    expect(run("init")).toMatchObject({status:0,stdout:expect.stringContaining("CompFn initialized successfully")});
    expect(run("run-checks")).toMatchObject({status:0,stdout:expect.stringContaining("No checks to run")});
  });
  it("exports parseable stdout and a JSON output file", () => {
    const result = run("export");
    expect(result.status,result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({controls:[],frameworks:[],evidence:[],mapping:[]});
    const output = join(directory,"pack.json");
    expect(run("export","--output",output).status).toBe(0);
    expect(JSON.parse(readFileSync(output,"utf8"))).toHaveProperty("exportedAt");
  });
  it("rejects missing controls, missing checks and invalid config with a failure exit", () => {
    expect(run("attest","--control-id","missing","--actor-id","user").status).toBe(1);
    expect(run("run-checks","--check-id","missing").status).toBe(1);
    writeFileSync(config,JSON.stringify({database:{type:"sqlite"}}));
    expect(run("init")).toMatchObject({status:1,stderr:expect.stringContaining(".mjs/.js/.cjs")});
    writeFileSync(config,"broken JSON");
    expect(run("export").status).toBe(1);
  });
});
