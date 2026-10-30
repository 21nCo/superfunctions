import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CONTROL_KEYS = ["DEVFN_WRAPPED_COMMAND", "DEVFN_REDACT_KEYS", "DEVFN_WRAPPER_DRAIN_MS", "DEVFN_DISCARD_OUTPUT"];

// The package's own build may not exist when its tests run, so the wrapper
// is transpiled from source into a temporary module directory.
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "devfn-wrapper-"));
  await writeFile(path.join(dir, "package.json"), '{ "type": "module" }');
  for (const name of ["wrapper", "redaction"]) {
    const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    await writeFile(path.join(dir, `${name}.js`), outputText);
  }
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function runWrapped(script: string, environment: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [path.join(dir, "wrapper.js")], {
    env: { ...process.env, ...environment, DEVFN_WRAPPED_COMMAND: JSON.stringify([process.execPath, "-e", script]), DEVFN_WRAPPER_DRAIN_MS: "500" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.send("start");
  const code = await new Promise<number | null>((resolve) => child.once("close", (exitCode) => resolve(exitCode)));
  return { code, output };
}

describe("process wrapper output", () => {
  it("keeps none of a command's output when asked to discard it, and still reports its exit", async () => {
    const seen = path.join(dir, "seen.json");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(${JSON.stringify(CONTROL_KEYS)}.filter((key) => key in process.env)));`
      + `process.stdout.write("unredactable-value"); process.stderr.write("unredactable-value"); process.exit(3)`;
    const discarded = await runWrapped(script, { DEVFN_REDACT_KEYS: "[]", DEVFN_DISCARD_OUTPUT: "1" });
    expect(discarded.code).toBe(3);
    expect(discarded.output).not.toContain("unredactable-value");
    expect(discarded.output).toContain("Output of this command is not kept");
    expect(JSON.parse(await readFile(seen, "utf8"))).toEqual([]);
  }, 30_000);

  it("keeps redacted output otherwise", async () => {
    const kept = await runWrapped('process.stdout.write(`token=${process.env.WRAPPED_TOKEN}`); process.exit(4)', { DEVFN_REDACT_KEYS: '["WRAPPED_TOKEN"]', WRAPPED_TOKEN: "wrapped-secret-5521" });
    expect(kept.code).toBe(4);
    expect(kept.output).toContain("token=");
    expect(kept.output).not.toContain("wrapped-secret-5521");
    expect(kept.output).not.toContain("Output of this command is not kept");
  }, 30_000);
});
