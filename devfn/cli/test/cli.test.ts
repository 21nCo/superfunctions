import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FilePortRegistry, isPortAvailable } from "@devfn/ports";
import { processBirthSignature, validateDevFnConfig } from "@devfn/config";
import { DevFnOrchestrator, readReceipt, resolveInstanceIdentity, writeReceipt } from "@devfn/core";
import { runCli } from "../src/index.js";

async function withListenerTools<T>(action: () => Promise<T>): Promise<T> {
  const toolsDir = await mkdtemp(path.join(tmpdir(), "devfn-tools-"));
  if (process.platform !== "win32") await symlink("/bin/ps", path.join(toolsDir, "ps"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = toolsDir;
    return await action();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(toolsDir, { recursive: true, force: true });
  }
}

/** The JSON fields these tests read from a CLI result. */
interface CliResult { error?: { message: string }; state?: string; invocationId?: string; allocations?: Array<{ port: number }> }

describe("devfn CLI", () => {
  it("reports the OAuth relay and refuses to start it for a domain this repository has not registered", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-oauth-relay-cli-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-oauth-relay-state-"));
    try {
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "fixture" }, profiles: { default: {} } }));
      const run = async (...args: string[]) => {
        let output = "";
        const code = await runCli(["oauth-relay", ...args, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { output += text; }, stderr: () => undefined });
        return { code, result: JSON.parse(output) as Record<string, unknown> };
      };
      expect(await run("status")).toEqual({ code: 0, result: { ok: true, relay: { running: false, routeActive: false, tickets: { valid: true, pending: 0 } } } });
      expect(await run("start", "dev.example.test")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_DOMAIN_UNREGISTERED" } } });
      expect(await run("start")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_RUNTIME_INVALID" } } });
      // A malformed host label is refused as input, before any machine state is read.
      expect(await run("start", "dev.example.test", "--host", "Bad_Label")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_OAUTH_RELAY_REJECTED" } } });
      expect(await run("stop", "dev.example.test")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_RUNTIME_INVALID" } } });
      expect(await run("restart")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_RUNTIME_INVALID" } } });
      expect(await run("stop")).toEqual({ code: 0, result: { ok: true, stopped: false, routeRemoved: false } });
      // status and stop need no project: they run outside any repository, or after it is gone.
      await rm(path.join(cwd, "devfn.config.json"));
      expect(await run("status")).toMatchObject({ code: 0, result: { ok: true, relay: { running: false } } });
      expect(await run("stop")).toEqual({ code: 0, result: { ok: true, stopped: false, routeRemoved: false } });
      expect(await run("start", "dev.example.test")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_CONFIG_NOT_FOUND" } } });
    } finally { await rm(cwd, { recursive: true, force: true }); await rm(stateDir, { recursive: true, force: true }); }
  });

  it("rejects extra domains list arguments without reading machine state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-domain-list-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-domain-state-"));
    try {
      // Reading this malformed registry would fail with another error.
      await writeFile(path.join(stateDir, "domains.json"), "{");
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "fixture" }, profiles: { default: {} } }));
      let output = "";
      expect(await runCli(["domains", "list", "typo", "--trust", "--json", "--state-dir", stateDir],
        { cwd, stdout: (text) => { output += text; }, stderr: () => undefined })).toBe(1);
      expect(JSON.parse(output)).toMatchObject({ error: { code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("no arguments") } });
    } finally { await rm(cwd, { recursive: true, force: true }); await rm(stateDir, { recursive: true, force: true }); }
  });

  it("rejects unavailable DNS-01 registration without changing machine state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-domain-cli-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-domain-state-"));
    try {
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "fixture" }, profiles: { default: {} } }));
      let output = "";
      expect(await runCli(["domains", "register", "dev.example.test", "--tls", "dns-01", "--trust", "--json", "--state-dir", stateDir],
        { cwd, stdout: (text) => { output += text; }, stderr: () => undefined })).toBe(1);
      expect(JSON.parse(output)).toMatchObject({ error: { code: "DEVFN_RUNTIME_INVALID" } });
      await expect(access(path.join(stateDir, "domains.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(cwd, { recursive: true, force: true }); await rm(stateDir, { recursive: true, force: true }); }
  });

  it("accepts --rerun-task only for starts and rejects an unknown task before any state exists", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-rerun-cli-"));
    const stateDir = path.join(cwd, "state");
    try {
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "fixture" },
        processes: { setup: { adapter: "command", command: ["node", "-e", "0"], task: {} } }, profiles: { default: { processes: ["setup"] } } }));
      const run = async (args: string[]) => {
        let stdout = "";
        const code = await runCli([...args, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
        return { code, value: JSON.parse(stdout) as { error?: { code: string; message: string } } };
      };
      expect(await run(["status", "--rerun-task", "setup"])).toMatchObject({ code: 1, value: { error: { code: "DEVFN_RUNTIME_INVALID", message: "--rerun-task applies only to up and restart." } } });
      expect(await run(["up", "--rerun-task"])).toMatchObject({ code: 1, value: { error: { code: "DEVFN_RUNTIME_INVALID", message: "--rerun-task requires a value." } } });
      expect(await run(["up", "--rerun-task", "other"])).toMatchObject({ code: 1, value: { error: { code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("names no task") } } });
      // Trust is recorded, but no lifecycle, lease or task state.
      for (const created of ["registry.json", "tasks", "runtime-id"]) await expect(access(path.join(stateDir, created))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(cwd, ".devfn"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("intercepts SIGINT and SIGTERM only while a task runs and keeps their default behavior in every other start phase", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-signal-cli-"));
    const stateDir = path.join(cwd, "state");
    const baseline = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    const added = (signal: "SIGINT" | "SIGTERM") => process.listeners(signal).filter((listener) => !baseline[signal].includes(listener));
    // Samples the listeners DevFn added while a start runs.
    const watch = () => {
      const seen = { max: 0 };
      const timer = setInterval(() => { seen.max = Math.max(seen.max, added("SIGINT").length + added("SIGTERM").length); }, 5);
      return { seen, stop: () => clearInterval(timer) };
    };
    const run = async (args: string[]) => {
      let stdout = "";
      const code = await runCli([...args, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(stdout) as { state?: string; error?: { code: string; details?: { causeCode?: string } } } };
    };
    try {
      // The daemon becomes ready only after a delay, so readiness is a long start phase.
      const server = "setTimeout(() => require('http').createServer((q, r) => r.end('ok')).listen(Number(process.env.DEVFN_PORT_WEB), '127.0.0.1'), 1500)";
      const task = "require('fs').writeFileSync('task.pid', String(process.pid)); setTimeout(() => {}, 60000)";
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "signal-fixture" }, ports: { web: {} },
        processes: {
          setup: { adapter: "command", command: [process.execPath, "-e", task], task: {} },
          web: { adapter: "command", command: [process.execPath, "-e", server], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 10_000 } },
          gated: { adapter: "command", command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], dependsOn: ["setup"] },
        },
        profiles: { default: { processes: ["web"] }, tasks: { processes: ["gated"] } } }));
      const plain = watch();
      try { expect(await run(["up"])).toMatchObject({ code: 0, value: { state: "ready" } }); }
      finally { plain.stop(); }
      expect(plain.seen.max).toBe(0);
      expect(await run(["down"])).toMatchObject({ code: 0 });

      const tasked = watch();
      const started = run(["up", "--profile", "tasks"]);
      while (!await access(path.join(cwd, "task.pid")).then(() => true, () => false)) await new Promise((resolve) => setTimeout(resolve, 20));
      // While the task runs, one listener per signal routes it to cancellation.
      expect(added("SIGINT")).toHaveLength(1);
      expect(added("SIGTERM")).toHaveLength(1);
      for (const listener of added("SIGINT")) (listener as (signal: NodeJS.Signals) => void)("SIGINT");
      // The first signal releases both, so a following SIGTERM ends DevFn at once while the task is being stopped.
      expect(added("SIGINT")).toHaveLength(0);
      expect(added("SIGTERM")).toHaveLength(0);
      const cancelled = await started;
      tasked.stop();
      expect(cancelled).toMatchObject({ code: 1, value: { error: { code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_CANCELLED" } } } });
      expect(added("SIGINT")).toHaveLength(0);
      expect(added("SIGTERM")).toHaveLength(0);
      expect(() => process.kill(Number(readFileSync(path.join(cwd, "task.pid"), "utf8")), 0)).toThrow();
    } finally {
      await runCli(["down", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: () => undefined, stderr: () => undefined }).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects invalid tail counts before command dispatch", async () => {
    for (const value of ["nope", "-1", "1.5", "9007199254740992"]) {
      let stdout = "";
      expect(await runCli(["logs", "--tail", value, "--json"], { stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ error: { code: "DEVFN_RUNTIME_INVALID", message: "--tail must be a non-negative integer." } });
    }
  });

  it("previews detection before init writes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-init-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "sample", scripts: { dev: "node server.js" } }), "utf8");
    let stdout = "";
    expect(await runCli(["init", "--json"], { cwd, stdout: (text) => { stdout += text; } })).toBe(0);
    const output = JSON.parse(stdout) as { written: boolean; preview: string };
    expect(output.written).toBe(false);
    expect(output.preview).toContain("export default");
  });

  it("writes a manifest only with explicit confirmation and adds the runtime ignore", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-init-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "sample", scripts: { dev: "node server.js" } }), "utf8");
    expect(await runCli(["init", "--yes", "--json"], { cwd, stdout: () => undefined })).toBe(0);
    expect(await readFile(path.join(cwd, "devfn.config.ts"), "utf8")).toContain("sample");
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toContain(".devfn/");
    let stdout = "";
    expect(await runCli(["status", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(0);
    expect(JSON.parse(stdout).state).toBe("stopped");
  });

  it("rejects non-TypeScript init targets", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-init-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "sample" }), "utf8");
    let stdout = "";
    expect(await runCli(["init", "--yes", "--config", "devfn.config.json", "--json"], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("DEVFN_CONFIG_INVALID");
    await expect(access(path.join(cwd, "devfn.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    stdout = "";
    expect(await runCli(["init", "--yes", "--config", "devfn.config.TS", "--json"], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(0);
    await expect(access(path.join(cwd, "devfn.config.TS"))).resolves.toBeUndefined();
  });

  it("restricts init manifests to the repository root", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-init-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "sample" }), "utf8");
    let stdout = "";
    expect(await runCli(["init", "--yes", "--config", "config/devfn.config.ts", "--json"], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(1);
    expect(JSON.parse(stdout).error.message).toContain("repository root");
    await expect(access(path.join(cwd, "config", "devfn.config.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back the generated manifest when the runtime ignore cannot be written", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-init-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "sample" }), "utf8");
    await mkdir(path.join(cwd, ".gitignore"));
    expect(await runCli(["init", "--yes", "--json"], { cwd, stdout: () => undefined, stderr: () => undefined })).toBe(1);
    await expect(access(path.join(cwd, "devfn.config.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to update a runtime ignore symlink outside the repository", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-init-"));
    const outside = path.join(await mkdtemp(path.join(tmpdir(), "devfn-outside-")), "gitignore");
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "sample" }), "utf8");
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, path.join(cwd, ".gitignore"));
    expect(await runCli(["init", "--yes", "--json"], { cwd, stdout: () => undefined, stderr: () => undefined })).toBe(1);
    expect(await readFile(outside, "utf8")).toBe("outside\n");
    await expect(access(path.join(cwd, "devfn.config.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs the local up, status, url, and down lifecycle with JSON receipts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-lifecycle-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "server.mjs"), "import http from 'node:http'; const server = http.createServer((_request, response) => { response.writeHead(200); response.end('ok'); }); server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready'));\n", "utf8");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1,
      project: { id: "fixture" },
      ports: { app: { range: [44200, 44300], env: "PORT" } },
      processes: { app: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"], health: { type: "http", port: "app", timeoutMs: 5000 } } },
      profiles: { default: { processes: ["app"] } },
    }), "utf8");

    const invoke = async (args: string[]) => {
      let stdout = "";
      const code = await runCli([...args, "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(stdout) as Record<string, unknown> };
    };

    try {
      const up = await invoke(["up", "--trust"]);
      expect(up.code, JSON.stringify(up.value)).toBe(0);
      expect(up.value.state).toBe("ready");
      const status = await invoke(["status"]);
      expect(status.value.state).toBe("ready");
      const url = await invoke(["url"]);
      expect((url.value.urls as Record<string, string>).app).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect((await invoke(["logs"])).value.app).toContain("ready");
      expect((await invoke(["logs", "--tail", "0"])).value.app).toBe("");
      const wrongStateDir = await mkdtemp(path.join(tmpdir(), "devfn-wrong-state-"));
      let wrongOutput = "";
      expect(await runCli(["down", "--trust", "--json", "--state-dir", wrongStateDir], { cwd, stdout: (text) => { wrongOutput += text; }, stderr: () => undefined })).toBe(1);
      expect(JSON.parse(wrongOutput).error.message).toContain("same --state-dir");
      const down = await invoke(["down"]);
      expect(down.value.state).toBe("stopped");
      expect((await invoke(["url"])).value.urls).toEqual({});
    } finally {
      await invoke(["down"]).catch(() => undefined);
    }
  }, 15_000);

  it("validates a changed registered domain before restart stops a ready service", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-restart-domain-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-restart-state-"));
    const manifest = path.join(cwd, "devfn.config.json");
    const base = { version: 1, project: { id: "restart-fixture" }, ports: { app: {} },
      processes: { app: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"], health: { type: "http", port: "app", timeoutMs: 5000 } } },
      profiles: { default: { processes: ["app"], proxy: false } } };
    const invoke = async (args: string[]) => {
      let stdout = "";
      const code = await runCli([...args, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(stdout) as CliResult };
    };
    try {
      await writeFile(path.join(cwd, "server.mjs"), "import { createServer } from 'node:http'; createServer((_request, response) => response.end('ready')).listen(Number(process.env.DEVFN_PORT_APP), '127.0.0.1');\n");
      await writeFile(manifest, JSON.stringify(base));
      const first = await invoke(["up"]);
      expect(first.code, JSON.stringify(first.value)).toBe(0);
      const port = first.value.allocations![0].port;
      await writeFile(manifest, JSON.stringify({ ...base, profiles: { default: { processes: ["app"], proxy: true } },
        hostnames: { app: { target: "app", domain: "unregistered.example.test" } } }));
      const failed = await invoke(["restart"]);
      expect(failed.code).toBe(1);
      expect(failed.value.error?.message).toContain("not registered");
      await writeFile(manifest, JSON.stringify(base));
      const status = await invoke(["status"]);
      expect(status.value.state).toBe("ready");
      const identity = await resolveInstanceIdentity(base.project.id, cwd);
      expect((await readReceipt(validateDevFnConfig(base), cwd, identity.instanceId))?.invocationId).toBe(first.value.invocationId);
      expect(await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text())).toBe("ready");
      const restarted = await invoke(["restart"]);
      expect(restarted.code, JSON.stringify(restarted.value)).toBe(0);
      expect(restarted.value.invocationId).not.toBe(first.value.invocationId);
      expect(restarted.value.state).toBe("ready");
      expect(restarted.value.allocations?.[0].port).toBe(port);
    } finally {
      await writeFile(manifest, JSON.stringify(base));
      await invoke(["down"]).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 25_000);

  it("restarts a live process whose configured readiness has degraded", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-readiness-recovery-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    const closeMarker = path.join(cwd, "close-listener");
    await writeFile(path.join(cwd, "server.mjs"), "import { existsSync, unlinkSync } from 'node:fs'; import http from 'node:http'; const server = http.createServer((_request, response) => { response.writeHead(200); response.end('ok'); }); server.listen(Number(process.env.PORT), '127.0.0.1'); setInterval(() => { if (existsSync(process.env.CLOSE_FILE)) { unlinkSync(process.env.CLOSE_FILE); server.close(); } }, 25);\n", "utf8");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1, project: { id: "readiness-recovery" }, ports: { app: { range: [44710, 44800], env: "PORT" } },
      processes: { app: { adapter: "command", command: [process.execPath, "server.mjs"], env: { CLOSE_FILE: closeMarker }, ports: ["app"], health: { type: "http", port: "app", timeoutMs: 5000 } } },
      profiles: { default: { processes: ["app"] } },
    }), "utf8");
    const invoke = async (args: string[]) => {
      let stdout = "";
      const code = await runCli([...args, "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(stdout) as Record<string, unknown> };
    };
    try {
      expect((await invoke(["up", "--trust"])).code).toBe(0);
      await writeFile(closeMarker, "close\n");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = await invoke(["status"]);
        if (status.value.state === "degraded") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect((await invoke(["status"])).value.state).toBe("degraded");
      const restarted = await invoke(["up"]);
      expect(restarted.code, JSON.stringify(restarted.value)).toBe(0);
      expect(restarted.value.state).toBe("ready");
      expect((await invoke(["status"])).value.state).toBe("ready");
    } finally { await invoke(["down"]).catch(() => undefined); }
  }, 20_000);

  it("recovers a stale receipt without stopping a reused PID", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-reused-receipt-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    const config = { version: 1 as const, project: { id: "reused-receipt" }, profiles: { default: {} } };
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify(config), "utf8");
    const identity = await resolveInstanceIdentity(config.project.id, cwd);
    const runtimeDir = path.join(cwd, ".devfn", "instances", identity.instanceId);
    const canonicalStateDir = await realpath(stateDir);
    const now = new Date().toISOString();
    await writeReceipt({
      version: 1, projectId: config.project.id, instanceId: identity.instanceId, invocationId: "stale-invocation", profile: "default", state: "ready",
      root: cwd, runtimeDir, stateDir: canonicalStateDir, startedAt: now, updatedAt: now, allocations: [],
      processes: [{ name: "stale", pid: process.pid, birthSignature: `${(await processBirthSignature(process.pid))!.split(":")[0]}:different-process`, command: [process.execPath], cwd, logPath: path.join(runtimeDir, "stale.log"), startedAt: now }],
      services: [], startedNodes: [{ name: "stale", kind: "process" }], routes: [], urls: {}, environmentOutputs: [],
    });
    let stdout = "";
    expect(await runCli(["up", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined }), stdout).toBe(0);
    expect(JSON.parse(stdout).state).toBe("ready");
  });

  it("keeps port leases when unjournaled proxy cleanup fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-proxy-cleanup-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    const config = { version: 1 as const, project: { id: "proxy-cleanup" }, profiles: { default: {} } };
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify(config), "utf8");
    const identity = await resolveInstanceIdentity(config.project.id, cwd);
    const runtimeDir = path.join(cwd, ".devfn", "instances", identity.instanceId);
    const canonicalStateDir = await realpath(stateDir);
    const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
    const allocations = await registry.reserve({
      projectId: config.project.id, instanceId: identity.instanceId, invocationId: "stale-invocation", profile: "default",
      requests: [{ name: "app", spec: { range: [44910, 45000] } }],
    });
    await registry.markActive("stale-invocation");
    const now = new Date().toISOString();
    await writeReceipt({
      version: 1, projectId: config.project.id, instanceId: identity.instanceId, invocationId: "stale-invocation", profile: "default", state: "ready",
      root: cwd, runtimeDir, stateDir: canonicalStateDir, startedAt: now, updatedAt: now, allocations,
      processes: [], services: [], startedNodes: [], routes: [], urls: {}, environmentOutputs: [],
    });
    await writeFile(path.join(stateDir, "proxy-routes.json"), "{not-json");
    let stdout = "";
    expect(await runCli(["up", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("DEVFN_RUNTIME_INVALID");
    expect((await registry.read()).allocations.find((item) => item.invocationId === "stale-invocation")?.state).toBe("active");
  });

  it("previews public tunnel URLs, refuses a binding without the nonproduction assertion and keeps tunnel profiles behind --allow-public", async () => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "devfn-tunnel-cli-")));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-tunnel-state-"));
    try {
      await writeFile(path.join(cwd, "credentials.json"), "{}", { mode: 0o600 });
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "fixture" }, ports: { web: {} },
        processes: { web: { adapter: "command", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"], ports: ["web"] } },
        profiles: { default: { processes: ["web"], proxy: true, tunnel: { binding: "preview", routes: ["web"] } } }, hostnames: { web: { target: "web", path: "/app" } } }));
      const run = async (...args: string[]) => {
        let output = "";
        const code = await runCli([...args, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { output += text; }, stderr: () => undefined });
        return { code, result: JSON.parse(output) as Record<string, any> };
      };
      const fields = ["--domain", "tunnel.example.test", "--account-id", "a".repeat(32), "--zone-id", "b".repeat(32), "--tunnel-id", "00000000-0000-4000-8000-000000000001",
        "--credentials-file", "credentials.json", "--api-token-env", "DEVFN_FIXTURE_TOKEN"];
      expect(await run("tunnel", "register", "preview", ...fields)).toMatchObject({ code: 1, result: { error: { message: expect.stringContaining("--nonproduction") } } });
      expect(await run("tunnel", "urls")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_RUNTIME_INVALID" } } });
      expect(await run("tunnel", "register", "preview", ...fields, "--nonproduction")).toMatchObject({ code: 0, result: { binding: { name: "preview", nonproduction: true } } });
      const urls = await run("tunnel", "urls");
      expect(urls.result).toEqual({ ok: true, binding: "preview", timing: "pre-start", urls: { web: expect.stringMatching(/^https:\/\/web-[a-z0-9-]+\.tunnel\.example\.test\/app$/) } });
      expect(JSON.stringify(await run("tunnel", "list"))).not.toContain("DEVFN_FIXTURE_TOKEN=");
      // Credential references are variable names, shown so the operator knows what a binding reads.
      expect(await run("tunnel", "list")).toMatchObject({ result: { bindings: [{ name: "preview", cloudflare: { apiTokenEnv: "DEVFN_FIXTURE_TOKEN" } }] } });
      expect(await run("up")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED" } } });
      expect(await run("tunnel", "recover", "preview")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED" } } });
      expect(await run("tunnel", "status", "preview")).toEqual({ code: 0, result: { ok: true, tunnel: { binding: "preview", connector: "stopped", hostnames: [], routed: [], urls: {}, pending: false, retired: 0, outstanding: [],
        capabilities: { provider: "cloudflare", urlTiming: "pre-start", dns: "devfn-records", gaps: [expect.stringContaining("edge certificates")] } } } });
      // ports gc still collects other released leases while it reports an orphan whose DNS removal fails (no API token in this shell).
      const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
      await registry.reserve({ projectId: "other", instanceId: "released-owner", invocationId: "released", profile: "default", requests: [{ name: "api", spec: {} }] });
      await registry.release({ invocationId: "released" });
      const orphan = "web-orphan-0123456789abcdef0123.tunnel.example.test";
      await mkdir(path.join(stateDir, "tunnels", "preview"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(stateDir, "tunnels", "preview", "state.json"), JSON.stringify({ version: 1, binding: "preview", hostnames: [{ hostname: orphan, ownerId: "orphan-owner", publishedAt: "2026-01-01T00:00:00.000Z" }], retired: [], residue: [] }));
      await mkdir(path.join(stateDir, "tunnel-owners"));
      await writeFile(path.join(stateDir, "tunnel-owners", "orphan-owner.json"), JSON.stringify({ version: 1, bindings: ["preview"] }));
      expect(await run("ports", "gc")).toMatchObject({ code: 1, result: { error: { details: { recovered: ["orphan-owner"], removed: 1, failures: [expect.stringContaining("public DNS removal is not confirmed"), expect.stringContaining("DEVFN_FIXTURE_TOKEN is unset")] } } } });
      expect((await registry.read()).allocations).toEqual([]);
      expect(await run("tunnel", "status", "preview")).toMatchObject({ result: { tunnel: { hostnames: [], outstanding: [{ ownerId: "orphan-owner", detail: `${orphan}: public DNS removal is not confirmed` }] } } });
      expect(await run("tunnel", "unregister", "preview")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_TUNNEL_IN_USE" } } });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("registers ngrok bindings by endpoint kind and reports when their public URLs are known", async () => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "devfn-ngrok-cli-")));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-ngrok-state-"));
    try {
      const write = async (tunnel: Record<string, unknown>) => await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "fixture" }, ports: { web: {} },
        processes: { web: { adapter: "command", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"], ports: ["web"] } },
        profiles: { default: { processes: ["web"], proxy: true, tunnel } }, hostnames: { web: { target: "web" }, "session-id": { target: "web" } } }));
      await write({ binding: "share", routes: ["web", "session-id"] });
      const run = async (...args: string[]) => {
        let output = "";
        const code = await runCli([...args, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { output += text; }, stderr: () => undefined });
        return { code, result: JSON.parse(output) as Record<string, any> };
      };
      const invalid = { code: 1, result: { error: { code: "DEVFN_RUNTIME_INVALID" } } };
      expect(await run("tunnel", "register", "share", "--provider", "ngrok", "--authtoken-env", "NGROK_AUTHTOKEN", "--domain", "ngrok.example.test", "--nonproduction")).toMatchObject(invalid);
      expect(await run("tunnel", "register", "share", "--provider", "ngrok", "--authtoken-env", "NGROK_AUTHTOKEN", "--domain", "ngrok.example.test", "--api-key-env", "NGROK_API_KEY", "--credentials-file", "x", "--nonproduction")).toMatchObject(invalid);
      expect(await run("tunnel", "register", "eph", "--provider", "ngrok", "--authtoken-env", "NGROK_AUTHTOKEN", "--ephemeral", "--domain", "ngrok.example.test", "--nonproduction")).toMatchObject(invalid);
      expect(await run("tunnel", "register", "share", "--provider", "other", "--nonproduction")).toMatchObject(invalid);
      expect(await run("tunnel", "register", "share", "--provider", "ngrok", "--authtoken-env", "NGROK_AUTHTOKEN", "--domain", "ngrok.example.test", "--api-key-env", "NGROK_API_KEY", "--nonproduction"))
        .toMatchObject({ code: 0, result: { binding: { name: "share", provider: "ngrok", domain: "ngrok.example.test", ngrok: { endpoints: "reserved", authtokenEnv: "NGROK_AUTHTOKEN", apiKeyEnv: "NGROK_API_KEY" } } } });
      expect(await run("tunnel", "register", "eph", "--provider", "ngrok", "--authtoken-env", "NGROK_AUTHTOKEN", "--ephemeral", "--nonproduction"))
        .toMatchObject({ code: 0, result: { binding: { name: "eph", domain: "eph.ngrok.devfn.internal", ngrok: { endpoints: "ephemeral" } } } });
      // URL map keys are route names or hostnames, never secret field names, even when they read like one.
      expect((await run("tunnel", "urls")).result).toEqual({ ok: true, binding: "share", timing: "pre-start", urls: { web: expect.stringMatching(/^https:\/\/web-[a-z0-9-]+\.ngrok\.example\.test$/),
        "session-id": expect.stringMatching(/^https:\/\/session-id-[a-z0-9-]+\.ngrok\.example\.test$/) } });
      // An ephemeral binding must be selected explicitly; its URLs are reported as assigned after start, never guessed.
      await write({ binding: "eph", routes: ["web"] });
      expect(await run("tunnel", "urls")).toMatchObject({ code: 1, result: { error: { message: expect.stringContaining("tunnel.ephemeral: true") } } });
      await write({ binding: "eph", routes: ["web"], ephemeral: true });
      expect((await run("tunnel", "urls")).result).toEqual({ ok: true, binding: "eph", timing: "post-start", urls: {}, assignedAfterStart: ["web"] });
      expect(await run("up")).toMatchObject({ code: 1, result: { error: { code: "DEVFN_PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED" } } });
      expect((await run("tunnel", "status", "eph")).result.tunnel.capabilities).toMatchObject({ provider: "ngrok", urlTiming: "post-start", dns: "connector-only",
        gaps: expect.arrayContaining([expect.stringContaining("cannot satisfy pre-start references")]) });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("shows lifecycle URL map entries whose route names read like secret fields", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-url-keys-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-url-keys-state-"));
    await writeFile(path.join(cwd, "server.mjs"), "import { createServer } from 'node:http'; createServer((_request, response) => response.end('ready')).listen(Number(process.env.DEVFN_PORT_SESSION_ID), '127.0.0.1');\n");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "url-keys" }, ports: { "session-id": {} },
      processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["session-id"], health: { type: "http", port: "session-id", timeoutMs: 5000 } } },
      profiles: { default: { processes: ["web"] } } }));
    const invoke = async (command: string) => {
      let stdout = "";
      const code = await runCli([command, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(stdout) as Record<string, any> };
    };
    // A tunnel's public URLs need a running connector, which the core suites provide; here status reports fixture URLs for the same routes.
    const status = DevFnOrchestrator.prototype.status;
    const spy = vi.spyOn(DevFnOrchestrator.prototype, "status").mockImplementation(async function (this: DevFnOrchestrator, input) {
      return { ...await status.call(this, input), publicUrls: { "session-id": "https://assigned-1-0.ngrok-free.app", web: "https://assigned-1-1.ngrok-free.app" }, publicUrlsChanged: true, sessionToken: "fixture-secret" } as never;
    });
    try {
      const up = await invoke("up");
      expect(up.code, JSON.stringify(up.value)).toBe(0);
      expect(up.value.urls).toEqual({ "session-id": expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
      const result = await invoke("status");
      expect(result.value).toMatchObject({ state: "ready", urls: up.value.urls, publicUrlsChanged: true,
        publicUrls: { "session-id": "https://assigned-1-0.ngrok-free.app", web: "https://assigned-1-1.ngrok-free.app" } });
      // Only map keys are data: secret-named fields elsewhere stay redacted.
      expect(result.value.sessionToken).toBe("[REDACTED]");
    } finally {
      spy.mockRestore();
      await invoke("down").catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("shows resource plan provenance in up and restart JSON without secret values", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-resource-receipt-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-resource-receipt-state-"));
    await writeFile(path.join(cwd, "server.mjs"), "import { createServer } from 'node:http'; createServer((_request, response) => response.end('ready')).listen(Number(process.env.PORT), '127.0.0.1');\n");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "resource-receipt" }, ports: { web: { env: "PORT" } },
      processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], resources: ["auth-token", "login"],
        envAllowlist: ["AUTH_TOKEN_PASSWORD"], secretEnv: ["AUTH_TOKEN_PASSWORD"], health: { type: "http", port: "web", timeoutMs: 5000 } } },
      resources: {
        "auth-token": { kind: "cache", defaultTarget: "remote", targets: { remote: { url: "redis://cache.example.test:6379", secrets: { password: "AUTH_TOKEN_PASSWORD" } } } },
        login: { kind: "browser", cookies: ["session"] },
      },
      profiles: { default: { processes: ["web"] } } }));
    const secret = `cache-${Date.now()}-password`;
    const original = process.env.AUTH_TOKEN_PASSWORD;
    process.env.AUTH_TOKEN_PASSWORD = secret;
    const invoke = async (command: string) => {
      let stdout = "";
      const code = await runCli([command, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, stdout, value: JSON.parse(stdout) as Record<string, any> };
    };
    // A secret-named field outside the plan still goes through the shared redaction.
    const up = DevFnOrchestrator.prototype.up;
    const spy = vi.spyOn(DevFnOrchestrator.prototype, "up").mockImplementation(async function (this: DevFnOrchestrator, input) {
      return { ...await up.call(this, input), sessionToken: "fixture-secret" } as never;
    });
    try {
      for (const command of ["up", "restart"]) {
        const result = await invoke(command);
        expect(result.code, result.stdout).toBe(0);
        expect(result.stdout).not.toContain(secret);
        expect(result.value.sessionToken).toBe("[REDACTED]");
        const plan = result.value.resources;
        expect(plan.ownerToken).toMatch(/^o[0-9a-f]+$/);
        const cache = plan.resources["auth-token"];
        expect(cache).toMatchObject({ kind: "cache", consumers: ["web"], remote: { url: "redis://cache.example.test:6379" },
          target: { name: "remote", location: "remote", selectedBy: "defaultTarget", field: "resources.auth-token.defaultTarget" },
          secrets: [{ name: "password", env: "AUTH_TOKEN_PASSWORD", field: "resources.auth-token.targets.remote.secrets.password", present: true }] });
        expect(cache.values.DEVFN_RESOURCE_AUTH_TOKEN_URL).toEqual({ value: "redis://cache.example.test:6379", source: "manifest", field: "resources.auth-token.targets.remote.url" });
        expect(plan.resources.login.values.DEVFN_RESOURCE_LOGIN_COOKIE_SESSION).toEqual({ value: `login_${plan.ownerToken}_session`, source: "namespace", field: "resources.login" });
      }
    } finally {
      spy.mockRestore();
      if (original === undefined) delete process.env.AUTH_TOKEN_PASSWORD;
      else process.env.AUTH_TOKEN_PASSWORD = original;
      await invoke("down").catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("requires a separate confirmation for public exposure", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-public-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1,
      project: { id: "public-fixture" },
      processes: { tunnel: { adapter: "command", exposure: "public", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] } },
      profiles: { oauth: { processes: ["tunnel"] } },
      defaultProfile: "oauth",
    }), "utf8");
    let stdout = "";
    const code = await runCli(["up", "--profile", "oauth", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("DEVFN_PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED");
  });

  it("does not infer HTTP URLs from inactive profile nodes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-profile-url-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "server.mjs"), "import net from 'node:net'; const server = net.createServer(); server.listen(Number(process.env.PORT), '127.0.0.1');\n", "utf8");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1, project: { id: "profile-url" }, ports: { app: { range: [44600, 44700], env: "PORT" } },
      processes: {
        worker: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"], health: { type: "tcp", port: "app", timeoutMs: 5000 } },
        web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"], health: { type: "http", port: "app", timeoutMs: 5000 } },
      },
      profiles: { default: { processes: ["worker"] }, web: { processes: ["web"] } },
    }), "utf8");
    const invoke = async (args: string[]) => {
      let stdout = "";
      const code = await runCli([...args, "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(stdout) as Record<string, unknown> };
    };
    try {
      expect((await invoke(["up", "--trust"])).code).toBe(0);
      expect((await invoke(["url"])).value.urls).toEqual({});
    } finally { await invoke(["down"]).catch(() => undefined); }
  }, 15_000);

  it("does not infer an HTTP URL from a hostname when proxying is disabled", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-nonproxy-url-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "server.mjs"), "import net from 'node:net'; const server = net.createServer(); server.listen(Number(process.env.PORT), '127.0.0.1');\n", "utf8");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1, project: { id: "nonproxy-url" }, ports: { app: { range: [44810, 44900], env: "PORT" } },
      processes: { worker: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"], health: { type: "tcp", port: "app", timeoutMs: 5000 } } },
      profiles: { default: { processes: ["worker"], proxy: false } }, hostnames: { app: { target: "app", profiles: ["default"] } },
    }), "utf8");
    const invoke = async (args: string[]) => {
      let stdout = "";
      const code = await runCli([...args, "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(stdout) as Record<string, unknown> };
    };
    try {
      expect((await invoke(["up", "--trust"])).code).toBe(0);
      expect((await invoke(["url"])).value.urls).toEqual({});
    } finally { await invoke(["down"]).catch(() => undefined); }
  }, 15_000);

  it("matches exact-port diagnostics by protocol", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-doctor-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TCP test server did not receive a port.");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1, project: { id: "udp-doctor" }, ports: { udp: { preferred: address.port, exact: true, protocol: "udp" } },
      processes: { worker: { adapter: "command", command: [process.execPath, "-e", "process.exit(0)"], ports: ["udp"] } }, profiles: { default: { processes: ["worker"] } },
    }), "utf8");
    let stdout = "";
    try {
      expect(await runCli(["doctor", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined }), stdout).toBe(0);
      const diagnostics = JSON.parse(stdout).diagnostics as Array<{ code: string }>;
      expect(diagnostics.some((item) => item.code === "DEVFN_EXACT_PORT_OCCUPIED")).toBe(false);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("does not report the running instance's exact port as a doctor conflict", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-doctor-owned-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("TCP test server did not receive a port.");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await writeFile(path.join(cwd, "server.mjs"), "import net from 'node:net'; const server = net.createServer(); server.listen(Number(process.env.PORT), '127.0.0.1');\n", "utf8");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1, project: { id: "doctor-owned" }, ports: { app: { preferred: address.port, exact: true, env: "PORT" } },
      processes: { app: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"], health: { type: "tcp", port: "app", timeoutMs: 5000 } } },
      profiles: { default: { processes: ["app"] } },
    }), "utf8");
    const invoke = async (args: string[]) => {
      let stdout = "";
      const code = await runCli([...args, "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(stdout) as { diagnostics?: Array<{ code: string }> } };
    };
    try {
      expect((await invoke(["up", "--trust"])).code).toBe(0);
      const registry = JSON.parse(await readFile(path.join(stateDir, "registry.json"), "utf8")) as { allocations: Array<{ state: string; process?: { pid: number } }> };
      expect(registry.allocations[0], JSON.stringify(registry)).toMatchObject({ state: "active", process: { pid: expect.any(Number) } });
      const doctor = await invoke(["doctor"]);
      expect(doctor.code, JSON.stringify(doctor.value)).toBe(0);
      expect(doctor.value.diagnostics?.some((item) => item.code === "DEVFN_EXACT_PORT_OCCUPIED")).toBe(false);
      if (process.platform !== "win32") {
        await withListenerTools(async () => {
          const unavailable = await invoke(["doctor"]);
          expect(unavailable.code, JSON.stringify(unavailable.value)).toBe(0);
          expect(unavailable.value.diagnostics?.some((item) => item.code === "DEVFN_LISTENER_INSPECTION_UNAVAILABLE")).toBe(true);
        });
      }
    } finally { await invoke(["down"]).catch(() => undefined); }
  }, 15_000);

  it("fails closed when local TCP listener ownership cannot be inspected", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-listener-tools-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "server.mjs"), "import net from 'node:net'; net.createServer().listen(Number(process.env.PORT), '127.0.0.1');\n", "utf8");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1, project: { id: "listener-tools" }, ports: { app: { range: [45300, 45400], env: "PORT" } },
      processes: { app: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"], health: { type: "tcp", port: "app", timeoutMs: 5000 } } },
      profiles: { default: { processes: ["app"] } },
    }), "utf8");
    let stdout = "";
    await withListenerTools(async () => {
      expect(await runCli(["doctor", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(1);
      expect(JSON.parse(stdout).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DEVFN_LISTENER_INSPECTION_UNAVAILABLE", severity: "error" })]));
      stdout = "";
      expect(await runCli(["up", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(1);
      expect(JSON.parse(stdout).error.message).toContain("could not be inspected");
    });
  }, 15_000);

  it("preflights both listener protocols for portless local processes", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-portless-listener-tools-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1, project: { id: "portless-listener-tools" },
      processes: { app: { adapter: "command", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] } },
      profiles: { default: { processes: ["app"] } },
    }), "utf8");
    let stdout = "";
    await withListenerTools(async () => {
      expect(await runCli(["doctor", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(1);
      const diagnostics = JSON.parse(stdout).diagnostics.filter((item: { code: string }) => item.code === "DEVFN_LISTENER_INSPECTION_UNAVAILABLE");
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics.map((item: { message: string }) => item.message)).toEqual(expect.arrayContaining([expect.stringContaining("TCP"), expect.stringContaining("UDP")]));
    });
  }, 15_000);

  it("waits for an unprobed process to bind its declared port", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-slow-listener-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "server.mjs"), "import net from 'node:net'; setTimeout(() => net.createServer().listen(Number(process.env.PORT), '127.0.0.1'), 900);\n", "utf8");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1, project: { id: "slow-listener" }, ports: { app: { range: [45410, 45500], env: "PORT" } },
      processes: { app: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"] } },
      profiles: { default: { processes: ["app"] } },
    }), "utf8");
    const invoke = async (args: string[]) => {
      let stdout = "";
      const code = await runCli([...args, "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(stdout) as Record<string, unknown> };
    };
    try {
      const up = await invoke(["up", "--trust"]);
      expect(up.code, JSON.stringify(up.value)).toBe(0);
      expect(up.value.state).toBe("ready");
      const allocation = (up.value.allocations as Array<{ port: number }>)[0];
      expect(await isPortAvailable(allocation.port)).toBe(false);
    }
    finally { await invoke(["down"]).catch(() => undefined); }
  }, 15_000);

  it("reports an unrelated listener that replaces a recorded exact-port owner", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-doctor-replaced-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("TCP test server did not receive a port.");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const closeMarker = path.join(cwd, "close-listener");
    await writeFile(path.join(cwd, "server.mjs"), "import { existsSync } from 'node:fs'; import net from 'node:net'; const server = net.createServer(); server.listen(Number(process.env.PORT), '127.0.0.1'); setInterval(() => { if (existsSync(process.env.CLOSE_FILE)) server.close(); }, 25);\n", "utf8");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1, project: { id: "doctor-replaced" }, ports: { app: { preferred: address.port, exact: true, env: "PORT" } },
      processes: { app: { adapter: "command", command: [process.execPath, "server.mjs"], env: { CLOSE_FILE: closeMarker }, ports: ["app"], health: { type: "tcp", port: "app", timeoutMs: 5000 } } },
      profiles: { default: { processes: ["app"] } },
    }), "utf8");
    const invoke = async (args: string[]) => {
      let stdout = "";
      const code = await runCli([...args, "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(stdout) as { diagnostics?: Array<{ code: string }> } };
    };
    const replacement = createServer();
    try {
      expect((await invoke(["up", "--trust"])).code).toBe(0);
      await writeFile(closeMarker, "close\n");
      for (let attempt = 0; attempt < 100 && !await isPortAvailable(address.port); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await isPortAvailable(address.port)).toBe(true);
      await new Promise<void>((resolve, reject) => { replacement.once("error", reject); replacement.listen(address.port, "127.0.0.1", resolve); });
      const doctor = await invoke(["doctor"]);
      expect(doctor.code).toBe(1);
      expect(doctor.value.diagnostics?.some((item) => item.code === "DEVFN_EXACT_PORT_OCCUPIED"), JSON.stringify(doctor.value)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
      await invoke(["down"]).catch(() => undefined);
    }
  }, 15_000);

  it("does not execute an untrusted TypeScript manifest", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-trust-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    const marker = path.join(cwd, "executed.txt");
    await writeFile(path.join(cwd, "devfn.config.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export default { version: 1, project: { id: "unsafe" }, profiles: { default: {} } };\n`, "utf8");
    let stdout = "";
    const code = await runCli(["status", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("DEVFN_MANIFEST_UNTRUSTED");
    expect(JSON.parse(stdout).error.message).toContain("is not trusted");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    stdout = "";
    const trustedCode = await runCli(["status", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
    expect(trustedCode).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("DEVFN_CONFIG_INVALID");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires positive Docker ownership when an occupied container port cannot be inspected", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-doctor-docker-unknown-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    const probe = createServer();
    const occupied = createServer();
    try {
      await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
      const address = probe.address();
      if (!address || typeof address === "string") throw new Error("TCP probe did not receive a port.");
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
        version: 1, project: { id: "docker-ownership-fixture" }, ports: { api: { preferred: address.port, exact: true } },
        services: { api: { adapter: "compose", service: "api", ports: { api: 8080 } } },
        profiles: { default: { services: ["api"] } },
      }));
      const owner = (await resolveInstanceIdentity("docker-ownership-fixture", cwd)).instanceId;
      const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
      await registry.reserve({ projectId: "docker-ownership-fixture", instanceId: owner, invocationId: "fixture-invocation", profile: "default",
        requests: [{ name: "api", spec: { preferred: address.port, exact: true } }] });
      await registry.markActive("fixture-invocation", { api: { container: { id: "fixture-container" } } });
      await new Promise<void>((resolve, reject) => { occupied.once("error", reject); occupied.listen(address.port, "127.0.0.1", resolve); });
      await withListenerTools(async () => {
        let stdout = "";
        await runCli(["doctor", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
        const result = JSON.parse(stdout) as { diagnostics: Array<{ code: string; severity: string; message: string }> };
        expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
          code: "DEVFN_LISTENER_INSPECTION_UNAVAILABLE", severity: "error", message: expect.stringContaining("Docker listener ownership"),
        })]));
      });
    } finally {
      if (probe.listening) await new Promise<void>((resolve) => probe.close(() => resolve()));
      if (occupied.listening) await new Promise<void>((resolve) => occupied.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not load an untrusted JSON manifest", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-json-trust-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "unsafe-json" }, profiles: { default: {} } }), "utf8");
    let stdout = "";
    const code = await runCli(["status", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("DEVFN_MANIFEST_UNTRUSTED");
  });

  it("rejects unsupported ports actions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-ports-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ version: 1, project: { id: "ports" }, profiles: { default: {} } }), "utf8");
    let stdout = "";
    const code = await runCli(["ports", "wat", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined });
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("DEVFN_RUNTIME_INVALID");
  });

  it("rolls back a ready dependency when a later process fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "devfn-rollback-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-state-"));
    await writeFile(path.join(cwd, "server.mjs"), "import net from 'node:net'; const server = net.createServer(); server.listen(Number(process.env.PORT), '127.0.0.1');\n", "utf8");
    await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({
      version: 1,
      project: { id: "rollback" },
      ports: { app: { range: [44400, 44500], env: "PORT" } },
      processes: {
        app: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"], health: { type: "tcp", port: "app", timeoutMs: 5000 } },
        fail: { adapter: "command", command: [process.execPath, "-e", "process.exit(2)"], dependsOn: ["app"] },
      },
      profiles: { default: { processes: ["fail"] } },
    }), "utf8");
    let stdout = "";
    expect(await runCli(["up", "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("DEVFN_START_FAILED");
    const instance = (await readdir(path.join(cwd, ".devfn", "instances")))[0];
    const receipt = JSON.parse(await readFile(path.join(cwd, ".devfn", "instances", instance, "receipt.json"), "utf8")) as { state: string; cleanup: { stoppedProcesses: string[]; releasedPorts: boolean } };
    expect(receipt.state).toBe("failed");
    expect(receipt.cleanup.stoppedProcesses, JSON.stringify(receipt)).toContain("app");
    expect(receipt.cleanup.releasedPorts).toBe(true);
    stdout = "";
    expect(await runCli(["status", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed" });
  }, 15_000);
});
