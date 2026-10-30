import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ComposeController } from "@devfn/compose";
import { validateDevFnConfig, type TaskSpec } from "@devfn/config";
import type { FilePortRegistry } from "@devfn/ports";
import { processExists, ProcessSupervisor, type ProcessRunResult, type RunProcessInput } from "@devfn/processes";
import { describe, expect, it, vi } from "vitest";

import { createPlan, DevFnOrchestrator, planResources, readReceipt, readTaskJournal, resolveInstanceIdentity, taskInputRevision, taskScope, type TaskJournal } from "../src/index.js";
import { runTask, type RunTaskContext } from "../src/tasks.js";

const execFileAsync = promisify(execFile);
const exists = async (file: string) => await stat(file).then(() => true, () => false);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// An application-neutral setup task: it records each run, then follows
// behavior.json, which is deliberately not one of its inputs.
const taskScript = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const behavior = JSON.parse(readFileSync("behavior.json", "utf8"));
appendFileSync("runs.log", JSON.stringify({ pid: process.pid, migrations: readFileSync("migrations/001.sql", "utf8").trim(), token: process.env.SETUP_TOKEN ?? null }) + "\\n");
console.log("setup with " + (process.env.SETUP_TOKEN ?? "none"));
writeFileSync("task.pid", String(process.pid));
const remaining = behavior.failTimes ?? 0;
if (remaining > 0) { writeFileSync("behavior.json", JSON.stringify({ ...behavior, failTimes: remaining - 1 })); process.exit(7); }
await new Promise((resolve) => setTimeout(resolve, behavior.sleepMs ?? 0));
if (behavior.exit) process.exit(behavior.exit);
writeFileSync("migrated", "1");
`;

// The dependent refuses to serve without the task's marker, and leaves
// evidence that it started at all.
const serverScript = `import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
writeFileSync("web-started", String(Date.now()));
if (!existsSync("migrated")) process.exit(3);
const server = createServer((request, response) => { response.writeHead(200); response.end("ok"); });
server.listen(Number(process.env.DEVFN_PORT_WEB), "127.0.0.1");
`;

async function fixture(name: string, task: Partial<TaskSpec> = {}, behavior: Record<string, unknown> = {}, profileEnvironment?: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), `devfn-task-${name}-`));
  await mkdir(path.join(root, "migrations"));
  await writeFile(path.join(root, "migrations", "001.sql"), "create table one;\n");
  await writeFile(path.join(root, "task.mjs"), taskScript);
  await writeFile(path.join(root, "server.mjs"), serverScript);
  await writeFile(path.join(root, "behavior.json"), JSON.stringify(behavior));
  const config = validateDevFnConfig({ version: 1, project: { id: `task-${name}` }, ports: { web: {} },
    processes: {
      migrate: { adapter: "command", command: [process.execPath, "task.mjs"], envAllowlist: ["SETUP_TOKEN"], secretEnv: ["SETUP_TOKEN"],
        task: { inputs: ["migrations"], ...task } },
      web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], dependsOn: ["migrate"], health: { type: "http", port: "web", timeoutMs: 10_000 } },
    },
    profiles: { default: { processes: ["web"], ...(profileEnvironment ? { environment: profileEnvironment } : {}) } } });
  const stateDir = path.join(root, "state");
  const orchestrator = new DevFnOrchestrator();
  const identity = await resolveInstanceIdentity(config.project.id, root);
  const journal = async (): Promise<TaskJournal | undefined> => await readTaskJournal(stateDir, taskScope(config, identity.instanceId, { name: "migrate", kind: "process" }).key);
  const runs = async () => (await readFile(path.join(root, "runs.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; migrations: string; token: string | null });
  const reset = async (next: Record<string, unknown>) => {
    await writeFile(path.join(root, "behavior.json"), JSON.stringify(next));
    await rm(path.join(root, "web-started"), { force: true });
  };
  const cleanup = async () => {
    await orchestrator.down({ config, root, stateDir }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  };
  return { root, config, stateDir, orchestrator, identity, journal, runs, reset, cleanup };
}

describe("finite process runs", () => {
  it("runs a finite command only after its identity is recorded and stops its group on timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-run-"));
    const runtimeDir = path.join(root, "runtime");
    const supervisor = new ProcessSupervisor();
    const base = { root, runtimeDir, environment: { PATH: process.env.PATH ?? "" }, timeoutMs: 30_000 };
    try {
      // A failed recording keeps the gate closed: the command never runs.
      await expect(supervisor.run({ ...base, name: "unrecorded", command: [process.execPath, "-e", "require('fs').writeFileSync('ran', '1')"],
        onStarted: async () => { throw new Error("journal unavailable"); } })).rejects.toThrow("journal unavailable");
      expect(await exists(path.join(root, "ran"))).toBe(false);
      expect(await supervisor.run({ ...base, name: "exits", command: [process.execPath, "-e", "process.exit(6)"] })).toMatchObject({ outcome: "failed", exitCode: 6 });
      expect(await supervisor.run({ ...base, name: "succeeds", command: [process.execPath, "-e", "0"] })).toMatchObject({ outcome: "succeeded", exitCode: 0 });
      // A timeout stops the command and what it started in its group.
      const result = await supervisor.run({ ...base, name: "hangs", timeoutMs: 5_000, command: [process.execPath, "-e",
        "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); require('fs').writeFileSync('child.pid', String(c.pid)); setTimeout(() => {}, 60000)"] });
      expect(result).toMatchObject({ outcome: "timed-out", exitCode: null });
      expect(result.stopError).toBeUndefined();
      expect(processExists(Number(await readFile(path.join(root, "child.pid"), "utf8")))).toBe(false);
      expect(processExists(result.process.pid)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it("ends a run when its command exits although a descendant still holds its output, and stops that descendant", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-run-drain-"));
    try {
      const started = Date.now();
      const result = await new ProcessSupervisor().run({ name: "lingers", root, runtimeDir: path.join(root, "runtime"), environment: { PATH: process.env.PATH ?? "" }, timeoutMs: 20_000,
        command: [process.execPath, "-e", "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' }); require('fs').writeFileSync('child.pid', String(c.pid)); console.log('done'); process.exit(0)"] });
      expect(result).toMatchObject({ outcome: "succeeded", exitCode: 0 });
      expect(result.stopError).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(processExists(Number(await readFile(path.join(root, "child.pid"), "utf8")))).toBe(false);
      expect(await readFile(result.process.logPath, "utf8")).toContain("done");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("task input revisions", () => {
  const manifest = (mutate: (value: any) => void = () => undefined) => {
    const value: any = { version: 1, project: { id: "revision" }, ports: { api: {} },
      processes: {
        "api-server": { adapter: "command", command: ["node", "api.mjs"], ports: ["api"] },
        migrate: { adapter: "command", command: ["node", "migrate.mjs"], resources: ["api", "db", "events"], dependsOn: ["api-server"], task: {} },
      },
      resources: {
        api: { kind: "service", defaultTarget: "local", targets: { local: { node: "api-server", port: "api", scheme: "http" } } },
        db: { kind: "database", defaultTarget: "remote", namespace: { level: "schema", database: "app" }, targets: { remote: { url: "postgres://db.example.test:5432" } } },
        events: { kind: "broker", defaultTarget: "remote", topics: ["orders"], consumerGroup: "workers", targets: { remote: { url: "kafka://broker.example.test:9092" } } },
      },
      profiles: { default: { processes: ["migrate"], environment: { SEED_MODE: "minimal" } } } };
    mutate(value);
    return validateDevFnConfig(value);
  };
  const revision = async (config: ReturnType<typeof manifest>, port = 4100) => {
    const plan = createPlan(config);
    const resources = planResources({ config, plan, ownerId: "owner-a", runtimeId: "a".repeat(32), ports: { api: port }, platform: "linux" });
    return await taskInputRevision(config, os.tmpdir(), { name: "migrate", kind: "process" }, plan.profile, resources);
  };

  it("covers the profile environment and the resource values a task receives, but not leased ports", async () => {
    const base = await revision(manifest());
    expect(await revision(manifest(), 4200)).toBe(base);
    for (const change of [
      (value: any) => { value.profiles.default.environment.SEED_MODE = "full"; },
      (value: any) => { value.resources.db.namespace.database = "reports"; },
      (value: any) => { value.resources.events.topics = ["orders", "refunds"]; },
      (value: any) => { value.resources.events.consumerGroup = "importers"; },
    ]) expect(await revision(manifest(change))).not.toBe(base);
  });
});

describe("finite setup tasks gate dependents (real local processes)", () => {
  it("starts the dependent only after the task succeeds and keeps a ready lifecycle ready after the task exited", async () => {
    const env = await fixture("success");
    try {
      const receipt = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir });
      expect(receipt.state).toBe("ready");
      // The task process is gone, and its exit 0 never reads as a crashed daemon.
      expect(receipt.processes.map((item) => item.name)).toEqual(["web"]);
      expect(receipt.startedNodes).toEqual([{ name: "web", kind: "process" }]);
      expect(receipt.tasks).toMatchObject([{ name: "migrate", status: "succeeded", reason: "no recorded success", rerun: "on-change", idempotent: false,
        attempts: [{ attempt: 1, outcome: "succeeded", exitCode: 0, effects: "applied" }] }]);
      expect(await env.orchestrator.status({ config: env.config, root: env.root })).toMatchObject({ ok: true, state: "ready",
        tasks: [{ name: "migrate", status: "succeeded", attempts: 1 }] });
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).rejects.toMatchObject({ code: "DEVFN_ALREADY_RUNNING" });
      expect(await env.runs()).toHaveLength(1);
    } finally { await env.cleanup(); }
  }, 60_000);

  it("blocks dependents on a nonzero exit, then refuses to rerun a non-idempotent task until explicitly asked", async () => {
    const env = await fixture("failure", {}, { exit: 4 });
    try {
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir }))
        .rejects.toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_TASK_FAILED" } });
      expect(await exists(path.join(env.root, "web-started"))).toBe(false);
      const failed = await readReceipt(env.config, env.root, env.identity.instanceId);
      expect(failed).toMatchObject({ state: "failed", processes: [], tasks: [{ name: "migrate", status: "failed",
        attempts: [{ outcome: "failed", exitCode: 4, effects: "unknown" }] }] });
      // Rollback stopped nothing of the task and claims nothing about its effects.
      expect(failed?.error?.message).toMatch(/effects are unknown and were not reverted/);
      expect(failed?.cleanup?.stoppedProcesses).toEqual([]);
      // The next start fails before any mutation: no run, no new receipt.
      await env.reset({});
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_RERUN_REQUIRED" });
      expect(await env.runs()).toHaveLength(1);
      expect((await readReceipt(env.config, env.root, env.identity.instanceId))?.invocationId).toBe(failed!.invocationId);
      // An explicit rerun runs it and records both attempts.
      const ready = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, rerunTasks: ["migrate"] });
      expect(ready.tasks).toMatchObject([{ status: "succeeded", reason: "rerun requested" }]);
      expect((await env.journal())?.attempts.map((attempt) => [attempt.outcome, attempt.effects])).toEqual([["failed", "unknown"], ["succeeded", "applied"]]);
    } finally { await env.cleanup(); }
  }, 90_000);

  it("stops a timed-out task with its process group and never starts dependents", async () => {
    const env = await fixture("timeout", { timeoutMs: 1_500 }, { sleepMs: 60_000 });
    try {
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir }))
        .rejects.toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_TASK_TIMEOUT" } });
      const pid = Number(await readFile(path.join(env.root, "task.pid"), "utf8"));
      expect(alive(pid)).toBe(false);
      expect(await exists(path.join(env.root, "web-started"))).toBe(false);
      expect((await env.journal())?.attempts).toMatchObject([{ outcome: "timed-out", effects: "unknown", exitCode: null }]);
    } finally { await env.cleanup(); }
  }, 60_000);

  it("cancels a running task, stops it and rolls back the start without starting dependents", async () => {
    const env = await fixture("cancel", {}, { sleepMs: 60_000 });
    const controller = new AbortController();
    try {
      const started = env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, signal: controller.signal });
      const observed = started.catch((error: unknown) => error);
      while (!await exists(path.join(env.root, "task.pid"))) await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      expect(await observed).toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_CANCELLED" } });
      expect(alive(Number(await readFile(path.join(env.root, "task.pid"), "utf8")))).toBe(false);
      expect(await exists(path.join(env.root, "web-started"))).toBe(false);
      expect(await readReceipt(env.config, env.root, env.identity.instanceId)).toMatchObject({ state: "failed", tasks: [{ status: "cancelled",
        attempts: [{ outcome: "cancelled", effects: "unknown" }] }] });
    } finally { await env.cleanup(); }
  }, 60_000);

  it("skips a task whose input revision succeeded, reruns it when an input changes, and retries an idempotent task", async () => {
    const env = await fixture("rerun", { idempotent: true, retries: 1 }, { failTimes: 1 });
    try {
      const first = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir });
      expect(first.tasks).toMatchObject([{ status: "succeeded", attempts: [{ attempt: 1, outcome: "failed", exitCode: 7 }, { attempt: 2, outcome: "succeeded" }] }]);
      // A restart replaces the daemons; the task's revision already succeeded.
      const restarted = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, replace: true });
      expect(restarted.tasks).toMatchObject([{ status: "skipped", reason: "succeeded for this input revision", attempts: [] }]);
      expect(await env.runs()).toHaveLength(2);
      // A changed input makes the ready lifecycle stale; the replacement reruns the task first.
      await writeFile(path.join(env.root, "migrations", "001.sql"), "create table two;\n");
      expect(await env.orchestrator.status({ config: env.config, root: env.root })).toMatchObject({ ok: false, state: "degraded" });
      const changed = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir });
      expect(changed.tasks).toMatchObject([{ status: "succeeded", reason: "input revision changed" }]);
      expect((await env.runs()).at(-1)?.migrations).toBe("create table two;");
    } finally { await env.cleanup(); }
  }, 90_000);

  it("reruns an on-change task and blocks a run-once task when the selected profile environment changes", async () => {
    for (const rerun of ["on-change", "once"] as const) {
      const env = await fixture(`profile-${rerun}`, { rerun }, {}, { SEED_MODE: "minimal" });
      try {
        await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir });
        const changed = validateDevFnConfig({ ...env.config, profiles: { default: { ...env.config.profiles.default, environment: { SEED_MODE: "full" } } } });
        if (rerun === "once") {
          await expect(env.orchestrator.up({ config: changed, root: env.root, stateDir: env.stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
          expect(await env.runs()).toHaveLength(1);
        } else {
          expect((await env.orchestrator.up({ config: changed, root: env.root, stateDir: env.stateDir })).tasks).toMatchObject([{ status: "succeeded", reason: "input revision changed" }]);
          expect(await env.runs()).toHaveLength(2);
        }
      } finally { await env.cleanup(); }
    }
  }, 120_000);

  it("never lets a recorded success mask a later attempt of unknown effect", async () => {
    const env = await fixture("masked", { idempotent: true });
    try {
      await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir });
      await env.orchestrator.down({ config: env.config, root: env.root, stateDir: env.stateDir });
      await env.reset({ exit: 9 });
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, rerunTasks: ["migrate"] }))
        .rejects.toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_TASK_FAILED" } });
      await env.reset({});
      // The success is for this revision, but the failed attempt after it may have partly applied: the idempotent task runs again.
      const next = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir });
      expect(next.tasks).toMatchObject([{ status: "succeeded", reason: "an attempt since the last success ended failed with unknown effects" }]);
      expect(await env.runs()).toHaveLength(3);
      expect((await env.journal())?.attempts.map((attempt) => attempt.outcome)).toEqual(["succeeded", "failed", "succeeded"]);
    } finally { await env.cleanup(); }
  }, 90_000);

  it("refuses a changed input for a run-once task before any mutation", async () => {
    const env = await fixture("once", { rerun: "once" });
    try {
      const first = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir });
      await writeFile(path.join(env.root, "migrations", "001.sql"), "create table two;\n");
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
      // The ready lifecycle was not touched.
      expect(await readReceipt(env.config, env.root, env.identity.instanceId)).toMatchObject({ state: "ready", invocationId: first.invocationId });
      expect(await env.runs()).toHaveLength(1);
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, rerunTasks: ["web"] })).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      const rerun = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, rerunTasks: ["migrate"] });
      expect(rerun.tasks).toMatchObject([{ status: "succeeded", reason: "rerun requested" }]);
    } finally { await env.cleanup(); }
  }, 90_000);

  it("records an interrupted attempt as of unknown effect and never as reverted", async () => {
    const env = await fixture("interrupted");
    try {
      const { key } = taskScope(env.config, env.identity.instanceId, { name: "migrate", kind: "process" });
      const exited = await execFileAsync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
      await mkdir(path.join(env.stateDir, "tasks"), { recursive: true });
      await writeFile(path.join(env.stateDir, "tasks", `${key}.json`), JSON.stringify({ version: 1, task: "migrate", scope: "instance", attempts: [
        { invocationId: "crashed", instanceId: env.identity.instanceId, attempt: 1, inputRevision: "x", startedAt: new Date().toISOString(), outcome: "running", effects: "unknown",
          launcher: { pid: Number(exited.stdout) } }] }));
      // The preflight leaves an unfinished attempt to the locked start, which records it interrupted and blocks.
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir }))
        .rejects.toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_TASK_RERUN_REQUIRED" } });
      expect((await env.journal())?.attempts).toMatchObject([{ invocationId: "crashed", outcome: "interrupted", effects: "unknown" }]);
      expect(await env.runs()).toHaveLength(0);
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_RERUN_REQUIRED" });
    } finally { await env.cleanup(); }
  }, 60_000);

  it("runs a task once for duplicate concurrent starts and keeps secrets out of logs, receipts and journals", async () => {
    const env = await fixture("concurrent", {}, { sleepMs: 1_000 });
    const previous = process.env.SETUP_TOKEN;
    process.env.SETUP_TOKEN = "setup-secret-value-123";
    try {
      const outcomes = await Promise.allSettled([1, 2].map(async () => await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })));
      expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((item): item is PromiseRejectedResult => item.status === "rejected");
      expect(["DEVFN_ALREADY_RUNNING", "DEVFN_REGISTRY_LOCK_TIMEOUT"]).toContain((rejected?.reason as { code?: string }).code);
      expect(await env.runs()).toHaveLength(1);
      expect((await env.runs())[0].token).toBe("setup-secret-value-123");
      const receipt = await readReceipt(env.config, env.root, env.identity.instanceId);
      const log = await readFile(receipt!.tasks![0].logPath!, "utf8");
      expect(log).toContain("setup with [REDACTED]");
      const logs = await env.orchestrator.logs({ config: env.config, root: env.root, name: "migrate" });
      for (const text of [log, logs.migrate, JSON.stringify(receipt), JSON.stringify(await env.journal())]) expect(text).not.toContain("setup-secret-value-123");
      // A rotated secret is not a changed input revision.
      process.env.SETUP_TOKEN = "rotated-secret-value-456";
      const restarted = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, replace: true });
      expect(restarted.tasks).toMatchObject([{ status: "skipped" }]);
    } finally {
      if (previous === undefined) delete process.env.SETUP_TOKEN; else process.env.SETUP_TOKEN = previous;
      await env.cleanup();
    }
  }, 90_000);
});

describe("task attempt boundaries (stub launchers)", () => {
  async function context(name: string, overrides: Partial<RunTaskContext> & Pick<RunTaskContext, "node">) {
    const root = await mkdtemp(path.join(os.tmpdir(), `devfn-task-stub-${name}-`));
    await writeFile(path.join(root, "compose.yaml"), "services: {}\n");
    const config = validateDevFnConfig({ version: 1, project: { id: `stub-${name}` },
      processes: { migrate: { adapter: "command", command: [process.execPath, "-e", "0"], task: { idempotent: true, retries: 2 } } },
      services: {
        seed: { adapter: "compose", service: "seed", envAllowlist: ["SEED_TOKEN"], secretEnv: ["SEED_TOKEN"], task: { idempotent: true, retries: 2 } },
        plain: { adapter: "compose", service: "plain", task: {} },
      },
      profiles: { default: { processes: ["migrate"], services: ["seed", "plain"] } } });
    const registry = { recordOwners: vi.fn(async () => undefined), beginLaunch: vi.fn(async () => undefined) };
    const stateDir = path.join(root, "state");
    const value: RunTaskContext = { config, root, stateDir, runtimeDir: path.join(root, "runtime"), instanceId: "instance", invocationId: "invocation", profile: "default",
      environment: { PATH: process.env.PATH ?? "" }, generated: {}, rerunRequested: false, registry: registry as unknown as FilePortRegistry, record: async () => undefined, ...overrides };
    const journal = async () => await readTaskJournal(stateDir, taskScope(config, "instance", overrides.node).key);
    return { root, value, registry, journal };
  }
  const compose = (command: string[], stopLaunch: () => Promise<void> = async () => undefined) => ({
    prepareTask: async (input: { name: string }) => ({ command, environment: { PATH: process.env.PATH ?? "" },
      launch: { name: input.name, projectName: "stub", composeService: input.name, preExisting: false, existingContainerIds: [], runningContainerIds: [] } }),
    stopLaunch: vi.fn(stopLaunch),
  }) as unknown as ComposeController;
  // Fails each attempt after recording its launcher; the first result may report what it could not stop.
  const failing = (result: Partial<ProcessRunResult>) => {
    const runs: RunProcessInput[] = [];
    const supervisor = { run: async (input: RunProcessInput): Promise<ProcessRunResult> => {
      runs.push(input);
      const managed = { name: input.name, pid: 2 ** 22 + 7, command: input.command, cwd: input.root, logPath: path.join(input.root, "stub.log"), startedAt: new Date().toISOString() };
      await input.onStarted?.(managed);
      return { outcome: "failed", exitCode: 1, signal: null, process: managed, ...result };
    } } as unknown as ProcessSupervisor;
    return { runs, supervisor };
  };

  it("never retries a native attempt whose process group could not be verified stopped", async () => {
    const stub = failing({ stopError: "process group 4194311 is still alive" });
    const env = await context("native", { node: { name: "migrate", kind: "process" }, supervisor: stub.supervisor });
    try {
      await expect(runTask(env.value)).rejects.toMatchObject({ code: "DEVFN_TASK_FAILED", message: expect.stringContaining("still alive") });
      expect(stub.runs).toHaveLength(1);
      expect((await env.journal())?.attempts).toMatchObject([{ outcome: "failed", effects: "unknown", error: expect.stringContaining("still alive") }]);
    } finally { await rm(env.root, { recursive: true, force: true }); }
  });

  it("never retries a Compose attempt whose container could not be removed and keeps its launch journaled", async () => {
    const stub = failing({});
    const controller = compose(["docker", "compose", "run"], async () => { throw new Error("one-off container still running"); });
    const env = await context("compose", { node: { name: "seed", kind: "service" }, supervisor: stub.supervisor, compose: controller });
    try {
      await expect(runTask(env.value)).rejects.toMatchObject({ code: "DEVFN_TASK_FAILED", message: expect.stringContaining("still running") });
      expect(stub.runs).toHaveLength(1);
      expect(env.registry.beginLaunch).toHaveBeenCalledTimes(1);
      // Resolving the launch would let teardown forget the container.
      expect(env.registry.recordOwners).not.toHaveBeenCalled();
    } finally { await rm(env.root, { recursive: true, force: true }); }
  });

  it("keeps no output of a Compose task with secret channels, whose values Compose may load where redaction cannot see them", async () => {
    // The value is not in the environment DevFn passes, as with one Compose read from an env file.
    const print = (text: string) => [process.execPath, "-e", `console.log(${JSON.stringify(text)})`];
    const secret = await context("secret", { node: { name: "seed", kind: "service" }, compose: compose(print("seeded with compose-only-secret-987")) });
    const plain = await context("plain", { node: { name: "plain", kind: "service" }, compose: compose(print("seeded plainly")) });
    try {
      const receipt = await runTask(secret.value);
      expect(receipt).toMatchObject({ status: "succeeded" });
      const log = await readFile(receipt.logPath!, "utf8");
      expect(log).not.toContain("compose-only-secret-987");
      expect(log).toContain("not kept");
      expect(await readFile((await runTask(plain.value)).logPath!, "utf8")).toContain("seeded plainly");
    } finally {
      await rm(secret.root, { recursive: true, force: true });
      await rm(plain.root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("finite setup tasks (real Compose)", () => {
  it.skipIf(process.env.DEVFN_REAL_COMPOSE !== "1")("gates a dependent on a one-off Compose task and blocks it on failure, timeout and cancellation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-task-compose-"));
    const stateDir = path.join(root, "state");
    const orchestrator = new DevFnOrchestrator();
    const config = (seed: { exit?: number; sleep?: number; timeoutMs?: number } = {}) => validateDevFnConfig({ version: 1, project: { id: "task-compose" },
      services: {
        seed: { adapter: "compose", service: "seed", env: { SEED_EXIT: String(seed.exit ?? 0), SEED_SLEEP: String(seed.sleep ?? 0) },
          task: { idempotent: true, ...(seed.timeoutMs ? { timeoutMs: seed.timeoutMs } : {}) } },
        "vault-seed": { adapter: "compose", service: "vault-seed", envAllowlist: ["SEED_TOKEN"], secretEnv: ["SEED_TOKEN"], task: {} },
        api: { adapter: "compose", service: "api", dependsOn: ["seed"], health: { type: "command", command: ["sh", "-c", "exit 0"], timeoutMs: 5_000 } },
        "vault-api": { adapter: "compose", service: "api", dependsOn: ["vault-seed"], health: { type: "command", command: ["sh", "-c", "exit 0"], timeoutMs: 5_000 } },
      },
      profiles: { default: { services: ["api"] }, vault: { services: ["vault-api"] } } });
    let project: string | undefined;
    const oneOffs = async () => project ? (await execFileAsync("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.oneoff=True"])).stdout.trim() : "";
    const services = async () => (await readReceipt(config(), root, (await resolveInstanceIdentity("task-compose", root)).instanceId))?.services ?? [];
    try {
      await writeFile(path.join(root, "compose.yaml"), [
        "services:",
        "  seed:",
        "    image: busybox",
        "    command: [sh, -c, 'echo seeded; sleep ${SEED_SLEEP:-0}; exit ${SEED_EXIT:-0}']",
        "  vault-seed:",
        "    image: busybox",
        "    environment: [SEED_TOKEN]",
        "    command: [sh, -c, 'echo token=$$SEED_TOKEN']",
        "  api:",
        "    image: busybox",
        "    command: [sleep, '3600']",
        "",
      ].join("\n"));
      // Compose reads this value itself; DevFn's environment never holds it.
      await writeFile(path.join(root, ".env"), "SEED_TOKEN=compose-dotenv-secret-555\n");
      const ready = await orchestrator.up({ config: config(), root, stateDir });
      project = ready.services[0].projectName;
      expect(ready.tasks).toMatchObject([{ name: "seed", kind: "service", status: "succeeded", attempts: [{ exitCode: 0, effects: "applied" }] }]);
      expect(ready.services.map((item) => item.name)).toEqual(["api"]);
      expect(await readFile(ready.tasks![0].logPath!, "utf8")).toContain("seeded");
      // No one-off container is left behind.
      expect(await oneOffs()).toBe("");
      await orchestrator.down({ config: config(), root, stateDir });

      await expect(orchestrator.up({ config: config({ exit: 5 }), root, stateDir })).rejects.toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_TASK_FAILED" } });
      expect(await readReceipt(config(), root, ready.instanceId)).toMatchObject({ state: "failed", services: [], tasks: [{ status: "failed", attempts: [{ exitCode: 5 }] }] });

      // A timeout stops the run and removes the one-off container it left.
      await expect(orchestrator.up({ config: config({ sleep: 60, timeoutMs: 4_000 }), root, stateDir })).rejects.toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_TASK_TIMEOUT" } });
      expect(await services()).toEqual([]);
      expect(await oneOffs()).toBe("");

      // So does a cancellation while the container runs.
      const controller = new AbortController();
      const cancelled = orchestrator.up({ config: config({ sleep: 60 }), root, stateDir, signal: controller.signal }).catch((error: unknown) => error);
      while (!await oneOffs()) await new Promise((resolve) => setTimeout(resolve, 200));
      controller.abort();
      expect(await cancelled).toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_CANCELLED" } });
      expect(await services()).toEqual([]);
      expect(await oneOffs()).toBe("");

      // A task with secret channels keeps none of its output, so a value Compose loaded never reaches its log.
      const vault = await orchestrator.up({ config: config(), root, stateDir, profile: "vault" });
      expect(vault.tasks).toMatchObject([{ name: "vault-seed", status: "succeeded" }]);
      const log = await readFile(vault.tasks![0].logPath!, "utf8");
      expect(log).not.toContain("compose-dotenv-secret-555");
      expect(log).toContain("not kept");
      expect(JSON.stringify(await orchestrator.logs({ config: config(), root, name: "vault-seed" }))).not.toContain("compose-dotenv-secret-555");
    } finally {
      await orchestrator.down({ config: config(), root, stateDir }).catch(() => undefined);
      if (project) await execFileAsync("docker", ["network", "rm", `${project}_default`]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
