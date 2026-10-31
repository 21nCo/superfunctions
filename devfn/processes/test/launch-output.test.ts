import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDir = fileURLToPath(new URL("..", import.meta.url));

// The package's own build may not exist when its tests run, so its sources
// are transpiled next to each other, where @devfn/config still resolves.
let dir: string;
beforeAll(async () => {
  await mkdir(path.join(packageDir, "node_modules", ".cache"), { recursive: true });
  dir = await mkdtemp(path.join(packageDir, "node_modules", ".cache", "devfn-launch-"));
  await writeFile(path.join(dir, "package.json"), '{ "type": "module" }');
  for (const name of await readdir(path.join(packageDir, "src"))) {
    const source = await readFile(path.join(packageDir, "src", name), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    await writeFile(path.join(dir, name.replace(/\.ts$/, ".js")), outputText);
  }
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const emit = 'process.stdout.write(`out-${process.env.LAUNCH_TOKEN}`); process.stderr.write(`err-${process.env.LAUNCH_TOKEN}`);';

describe("launched command output", () => {
  // DEVFN_DISCARD_OUTPUT is the wrapper's discard control; a host that happens
  // to hold it must not make DevFn's ordinary launches lose their output.
  it.skipIf(process.platform === "win32")("is kept and redacted when the host environment asks the wrapper to discard it", async () => {
    const root = await mkdtemp(path.join(dir, "root-"));
    const driver = path.join(dir, "driver.mjs");
    await writeFile(driver, `import { readFile } from "node:fs/promises";
import { runGatedCommand } from "./gated.js";
import { ProcessSupervisor } from "./supervisor.js";
const command = [process.execPath, "-e", ${JSON.stringify(emit)}];
const gated = await runGatedCommand(command[0], command.slice(1), { redactKeys: ["LAUNCH_TOKEN"], onLaunched: async () => undefined });
const supervisor = new ProcessSupervisor();
const managed = await supervisor.start({ name: "app", root: ${JSON.stringify(root)}, runtimeDir: ${JSON.stringify(path.join(root, "runtime"))},
  environment: { DEVFN_DISCARD_OUTPUT: "1" },
  spec: { adapter: "command", command: [process.execPath, "-e", ${JSON.stringify(`${emit} process.stdout.write("\\nready\\n" + "-".repeat(40)); setInterval(() => {}, 1000);`)}],
    envAllowlist: ["LAUNCH_TOKEN", "DEVFN_DISCARD_OUTPUT"], secretEnv: ["LAUNCH_TOKEN"], health: { type: "log", pattern: "ready", timeoutMs: 10000 } } });
await supervisor.stop(managed);
process.stdout.write(JSON.stringify({ gated, log: await readFile(managed.logPath, "utf8") }));
`);
    const { stdout } = await execFileAsync(process.execPath, [driver], { env: { ...process.env, DEVFN_DISCARD_OUTPUT: "1", LAUNCH_TOKEN: "launch-secret-7731" } });
    const { gated, log } = JSON.parse(stdout) as { gated: { stdout: string; stderr: string }; log: string };
    expect(gated).toEqual({ stdout: "out-[REDACTED]", stderr: "err-[REDACTED]" });
    expect(log).toContain("out-[REDACTED]");
    expect(log).toContain("err-[REDACTED]");
    for (const output of [gated.stdout, gated.stderr, log]) {
      expect(output).not.toContain("launch-secret-7731");
      expect(output).not.toContain("Output of this command is not kept");
    }
  }, 60_000);
});
