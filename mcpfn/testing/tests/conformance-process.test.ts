import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ wrapper: "", children: [] as ChildProcess[], missing: false }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (_command: string, _args: string[], options: import("node:child_process").SpawnOptions) => {
    const child = actual.spawn(fixture.missing ? "/missing-conformance-runner" : process.execPath, ["-e", fixture.wrapper], options);
    fixture.children.push(child);
    return child;
  } };
});
import { runOfficialConformance } from "../src/conformance.js";
const temporary: string[] = [];
afterEach(() => {
  for (const child of fixture.children.splice(0)) {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already reaped */ }
  }
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  fixture.missing = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const options = { url: "http://127.0.0.1:1/mcp", stdio: "pipe" as const };
function useLocalRunner() {
  vi.stubGlobal("process", new Proxy(process, { get: (target, key) => key === "versions" ? { ...target.versions, node: "22.0.0" } : Reflect.get(target, key) }));
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  expect(predicate()).toBe(true);
}
function hangingTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-conformance-tree-")); temporary.push(dir);
  const pids = path.join(dir, "pids.json");
  const runner = "setInterval(() => {}, 1000)";
  fixture.wrapper = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(runner)}],{stdio:'inherit'}); require('node:fs').writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);`;
  return pids;
}
async function assertTreeGone(file: string) {
  const pids = JSON.parse(readFileSync(file, "utf8")) as number[];
  await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }));
}

it.skipIf(process.platform === "win32")("stops an overflowing wrapper and its pipe-owning child", async () => {
  useLocalRunner();
  const runner = `process.stdout.write('x'.repeat(300000)); setInterval(() => {}, 1000);`;
  fixture.wrapper = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(runner)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  const result = await runOfficialConformance(options);
  expect(result.ok).toBe(false);
  expect(result.stderr).toContain("capture limit");
}, 10000);

it.skipIf(process.platform === "win32")("times out a hanging runner and kills its pipe-owning descendant", async () => {
  useLocalRunner(); const file = hangingTree();
  const result = await runOfficialConformance({ ...options, timeoutMs: 700 });
  expect(result.ok).toBe(false); expect(result.stderr).toContain("timed out");
  await assertTreeGone(file);
}, 10000);

it.skipIf(process.platform === "win32")("aborts a running process tree and removes its abort listener", async () => {
  useLocalRunner(); const file = hangingTree(); const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const resultPromise = runOfficialConformance({ ...options, signal: controller.signal });
  await until(() => existsSync(file)); controller.abort("secret cancellation reason");
  const result = await resultPromise;
  expect(result.stderr).toContain("aborted"); expect(result.stderr).not.toContain("secret");
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  await assertTreeGone(file);
}, 10000);

it("does not spawn for an already aborted signal or invalid deadline", async () => {
  useLocalRunner(); const controller = new AbortController(); controller.abort();
  expect((await runOfficialConformance({ ...options, signal: controller.signal })).ok).toBe(false);
  for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2147483648]) {
    await expect(runOfficialConformance({ ...options, timeoutMs })).rejects.toThrow("timeoutMs");
  }
  expect(fixture.children).toHaveLength(0);
});

it.each([false, true])("cleans deadline, signal, and process listeners after completion (spawn error=%s)", async missing => {
  useLocalRunner(); fixture.missing = missing; fixture.wrapper = "process.stdout.write('ok')";
  const controller = new AbortController(); const remove = vi.spyOn(controller.signal, "removeEventListener");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"), process.listenerCount("exit")];
  const result = await runOfficialConformance({ ...options, signal: controller.signal, timeoutMs: 1000 });
  expect(result.ok).toBe(!missing);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function)); expect(clear).toHaveBeenCalled();
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"), process.listenerCount("exit")]).toEqual(before);
  const child = fixture.children.at(-1)!;
  expect(child.listenerCount("close")).toBe(0); expect(child.listenerCount("error")).toBe(0);
  controller.abort();
});

it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)("cleans owned descendants on %s and restores signal semantics", async signal => {
  useLocalRunner(); const file = hangingTree();
  const before = process.listeners(signal);
  const actualKill = process.kill.bind(process);
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, value) => {
    // Do not terminate Vitest; observe the restored default signal instead.
    if (pid === process.pid) return true;
    return actualKill(pid, value);
  });
  const resultPromise = runOfficialConformance(options);
  await until(() => existsSync(file));
  const ownedHandler = process.listeners(signal).find(listener => !before.includes(listener));
  expect(ownedHandler).toBeTypeOf("function");
  ownedHandler!();
  const result = await resultPromise;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(result.ok).toBe(false); expect(result.stderr).toContain(signal);
  expect(process.listeners(signal)).toEqual(before);
  if (before.length === 0) expect(kill).toHaveBeenCalledWith(process.pid, signal);
  else expect(kill).not.toHaveBeenCalledWith(process.pid, signal);
  await assertTreeGone(file);
}, 10000);

it.skipIf(process.platform === "win32")("reaps descendants even when their wrapper exits successfully", async () => {
  useLocalRunner();
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-conformance-tree-")); temporary.push(dir);
  const file = path.join(dir, "pids.json");
  fixture.wrapper = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify([child.pid])); child.unref();`;
  const result = await runOfficialConformance(options);
  expect(result.ok).toBe(true);
  await assertTreeGone(file);
}, 10000);

it.skipIf(process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 22).each(["before", "after"])("preserves a real once graceful-shutdown handler registered %s the runner", async order => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-conformance-once-")); temporary.push(dir);
  const bundled = path.join(dir, "conformance.cjs"), marker = path.join(dir, "graceful.txt");
  await build({ entryPoints: [fileURLToPath(new URL("../src/conformance.ts", import.meta.url))], outfile: bundled,
    bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent",
    define: { __MCPFN_TESTING_VERSION__: JSON.stringify("test") },
  });
  const harness = `
    const cp=require('node:child_process'), fs=require('node:fs');
    const spawn=cp.spawn;
    cp.spawn=(_command,_args,options)=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);
    const {runOfficialConformance}=require(${JSON.stringify(bundled)});
    const install=()=>process.once('SIGTERM',async()=>{await new Promise(r=>setTimeout(r,150));fs.writeFileSync(${JSON.stringify(marker)},'graceful');process.exit(0);});
    if(${JSON.stringify(order)}==='before')install();
    runOfficialConformance({url:'http://127.0.0.1:1/mcp',timeoutMs:1000});
    if(${JSON.stringify(order)}==='after')install();
    setTimeout(()=>process.kill(process.pid,'SIGTERM'),50);
  `;
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  await promisify(actual.execFile)(process.execPath, ["-e", harness], { timeout: 4000 });
  expect(readFileSync(marker, "utf8")).toBe("graceful");
}, 10000);

it.skipIf(process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 22)("kills the owned POSIX runner group when its host calls process.exit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-conformance-exit-")); temporary.push(dir);
  const bundled = path.join(dir, "conformance.cjs"), pidFile = path.join(dir, "pids.json");
  await build({ entryPoints: [fileURLToPath(new URL("../src/conformance.ts", import.meta.url))], outfile: bundled,
    bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent",
    define: { __MCPFN_TESTING_VERSION__: JSON.stringify("test") },
  });
  const harness = `const cp=require('node:child_process'),fs=require('node:fs'),spawn=cp.spawn;
    cp.spawn=(_command,_args,options)=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([child.pid]));return child;};
    const {runOfficialConformance}=require(${JSON.stringify(bundled)});
    runOfficialConformance({url:'http://127.0.0.1:1/mcp',timeoutMs:1000});setTimeout(()=>process.exit(0),50);`;
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  try {
    await promisify(actual.execFile)(process.execPath, ["-e", harness], { timeout: 4000 });
    await assertTreeGone(pidFile);
  } finally {
    if (existsSync(pidFile)) for (const pid of JSON.parse(readFileSync(pidFile, "utf8"))) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already cleaned */ }
    }
  }
}, 10000);
