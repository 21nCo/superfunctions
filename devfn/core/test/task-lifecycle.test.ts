import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ComposeController } from "@devfn/compose";
import { validateDevFnConfig, type TaskSpec } from "@devfn/config";
import type { FilePortRegistry } from "@devfn/ports";
import { processBirthSignature, processExists, ProcessSupervisor, type ProcessRunResult, type RunProcessInput } from "@devfn/processes";
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

async function fixture(name: string, task: Partial<TaskSpec> = {}, behavior: Record<string, unknown> = {}, profileEnvironment?: Record<string, string>, selected = ["web"]) {
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
    profiles: { default: { processes: selected, ...(profileEnvironment ? { environment: profileEnvironment } : {}) } } });
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

  it("masks only secret-channel and credential values of a Compose task's sources, never service names or other fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-task-revision-compose-"));
    const config = validateDevFnConfig({ version: 1, project: { id: "revision-compose" },
      services: {
        auth: { adapter: "compose", service: "auth", envAllowlist: ["SEED_KEY"], secretEnv: ["SEED_KEY"], task: {} },
        "token-init": { adapter: "compose", service: "token-init", task: {} },
      }, profiles: { default: { services: ["auth", "token-init"] } } });
    const values = { key: "k-1", password: "p-1", token: "t-1", mode: "minimal", command: "migrate", image: "busybox:1", other: "a" };
    const source = (value: typeof values, comment = "") => [
      `services:${comment}`,
      "  auth:", `    image: ${value.image}`, "    environment:", `      SEED_KEY: ${value.key}`, `      DB_PASSWORD: ${value.password}`, `      SEED_MODE: ${value.mode}`,
      `    command: [sh, -c, '${value.command}']`,
      "  token-init:", `    image: ${value.image}`, "    environment:", `      - API_TOKEN=${value.token}`, `      - SEED_MODE=${value.mode}`,
      `    command: [sh, -c, '${value.command}']`,
      "  unrelated:", `    image: busybox`, `    command: [echo, '${value.other}']`, ""].join("\n");
    const revisions = async (value: typeof values, comment?: string) => {
      await writeFile(path.join(root, "compose.yaml"), source(value, comment));
      return [await taskInputRevision(config, root, { name: "auth", kind: "service" }, "default"),
        await taskInputRevision(config, root, { name: "token-init", kind: "service" }, "default")];
    };
    try {
      const base = await revisions(values);
      // Rotated literal credentials (map and list entries), formatting and other services are not a changed input.
      expect(await revisions({ ...values, key: "k-2", password: "p-2", token: "t-2", other: "b" }, " # rotated")).toEqual(base);
      // A service whose name looks like a credential is hashed like any other.
      for (const change of [{ mode: "full" }, { command: "migrate --all" }, { image: "busybox:2" }]) {
        const changed = await revisions({ ...values, ...change });
        expect(changed[0]).not.toBe(base[0]);
        expect(changed[1]).not.toBe(base[1]);
      }
      await writeFile(path.join(root, "compose.yaml"), "services: [unclosed\n");
      await expect(taskInputRevision(config, root, { name: "auth", kind: "service" }, "default")).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("follows a Compose task's included, extended and env files, masking their credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-task-revision-compose-sources-"));
    const config = validateDevFnConfig({ version: 1, project: { id: "revision-compose-sources" },
      services: { seed: { adapter: "compose", service: "seed", task: {} } }, profiles: { default: { services: ["seed"] } } });
    const files = { base: "migrate", included: "busybox:1", envFile: "minimal", envSecret: "s-1", dotenv: "1", dotenvSecret: "d-1" };
    const write = async (value: typeof files) => {
      await mkdir(path.join(root, "setup"), { recursive: true });
      await writeFile(path.join(root, "compose.yaml"), ["include: [setup/included.yaml]", "services: {}", ""].join("\n"));
      await writeFile(path.join(root, "setup", "included.yaml"), ["services:", "  seed:", "    extends: { file: base.yaml, service: base }",
        `    image: \${SEED_IMAGE:-${value.included}}`, "    env_file: [seed.env]", ""].join("\n"));
      await writeFile(path.join(root, "setup", "base.yaml"), ["services:", "  base:", `    command: [sh, -c, '${value.base}']`, ""].join("\n"));
      await writeFile(path.join(root, "setup", "seed.env"), `SEED_MODE=${value.envFile}\nSEED_PASSWORD=${value.envSecret}\n`);
      await writeFile(path.join(root, "setup", ".env"), `SEED_LEVEL=${value.dotenv}\nREGISTRY_TOKEN=${value.dotenvSecret}\n`);
      return await taskInputRevision(config, root, { name: "seed", kind: "service" }, "default");
    };
    try {
      const base = await write(files);
      expect(await write({ ...files, envSecret: "s-2", dotenvSecret: "d-2" })).toBe(base);
      for (const change of [{ base: "migrate --all" }, { included: "busybox:2" }, { envFile: "full" }, { dotenv: "2" }]) {
        expect(await write({ ...files, ...change })).not.toBe(base);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("tracks where a Compose task's definition resolves its relative paths, independent of the root's spelling and worktree", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-task-revision-provenance-")));
    const root = path.join(parent, "tree");
    const config = validateDevFnConfig({ version: 1, project: { id: "revision-provenance" },
      services: { seed: { adapter: "compose", service: "seed", task: { inputs: ["setup", "nested/setup"] } } }, profiles: { default: { services: ["seed"] } } });
    const seed = ["  seed:", "    image: busybox:1", "    volumes: [./setup:/setup]", "    env_file: [seed.env]", "    command: [sh, /setup/run.sh]", ""];
    const layout = async (files: Record<string, string>) => {
      await rm(root, { recursive: true, force: true });
      for (const directory of ["setup", "nested/setup", "lib"]) await mkdir(path.join(root, directory), { recursive: true });
      for (const directory of ["setup", "nested/setup"]) await writeFile(path.join(root, directory, "run.sh"), "echo seeded\n");
      for (const directory of [".", "nested", "lib"]) {
        await writeFile(path.join(root, directory, "seed.env"), "SEED_MODE=minimal\nSEED_PASSWORD=p-1\n");
        await writeFile(path.join(root, directory, ".env"), "SEED_LEVEL=1\n");
      }
      for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
    };
    const revision = async (at = root) => await taskInputRevision(config, at, { name: "seed", kind: "service" }, "default");
    try {
      await layout({ "compose.yaml": ["services:", ...seed].join("\n") });
      const base = await revision();
      // The identical definition in an included file binds nested/setup, not setup.
      await layout({ "compose.yaml": "include: [nested/compose.yaml]\nservices: {}\n", "nested/compose.yaml": ["services:", ...seed].join("\n") });
      const included = await revision();
      expect(included).not.toBe(base);
      // Only the include's project directory changes where its relative paths resolve.
      await layout({ "compose.yaml": "include: [{ path: nested/compose.yaml, project_directory: . }]\nservices: {}\n", "nested/compose.yaml": ["services:", ...seed].join("\n") });
      expect(await revision()).not.toBe(included);
      // An extended definition counts where its file is, too.
      const extended = ["services:", "  seed:", "    extends: { file: lib/base.yaml, service: base }", ""].join("\n");
      await layout({ "compose.yaml": extended, "lib/base.yaml": ["services:", "  base:", ...seed.slice(1)].join("\n") });
      const fromLib = await revision();
      await layout({ "compose.yaml": extended.replace("lib/base.yaml", "base.yaml"), "base.yaml": ["services:", "  base:", ...seed.slice(1)].join("\n") });
      expect(await revision()).not.toBe(fromLib);
      // One source agrees through a symlinked root and in another worktree.
      await layout({ "compose.yaml": "include: [nested/compose.yaml]\nservices: {}\n", "nested/compose.yaml": ["services:", ...seed].join("\n") });
      await symlink(root, path.join(parent, "alias"));
      await cp(root, path.join(parent, "other-worktree"), { recursive: true });
      expect(await revision(path.join(parent, "alias"))).toBe(included);
      expect(await revision(path.join(parent, "other-worktree"))).toBe(included);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("selects a Compose task's sources with the environment startup selects them with, never hashing an inherited value", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-task-revision-selected-")));
    const root = path.join(parent, "tree");
    const previous = process.env.TASK_TEST_SETUP_ROOT;
    const service = (name: string, command: string) => ["services:", `  ${name}:`, "    image: busybox:1", `    command: [sh, -c, '${command}']`, ""].join("\n");
    const write = async (files: Record<string, string>) => {
      for (const [file, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), content);
      }
    };
    const manifest = (seed: Record<string, unknown>, environment: Record<string, string> = {}) => validateDevFnConfig({ version: 1, project: { id: "revision-selected" },
      services: { seed: { adapter: "compose", service: "seed", task: {}, ...seed } }, profiles: { default: { services: ["seed"], environment } } });
    const revision = async (config: ReturnType<typeof manifest>, at = root, environment?: Record<string, string>) =>
      await taskInputRevision(config, at, { name: "seed", kind: "service" }, "default", undefined, environment);
    try {
      await write({ "compose.yaml": "include: [\"${SETUP_SOURCE}\"]\nservices: {}\n", "setup/a.yaml": service("seed", "migrate"), "setup/b.yaml": service("seed", "migrate") });
      // Selected by the profile environment, and by the manifest environment.
      for (const config of [manifest({}, { SETUP_SOURCE: "setup/a.yaml" }), manifest({ env: { SETUP_SOURCE: "setup/a.yaml" } })]) {
        const base = await revision(config);
        await write({ "setup/b.yaml": service("seed", "migrate --all") });
        expect(await revision(config)).toBe(base);
        await write({ "setup/a.yaml": service("seed", "migrate --all") });
        expect(await revision(config)).not.toBe(base);
        await write({ "setup/a.yaml": service("seed", "migrate"), "setup/b.yaml": service("seed", "migrate") });
      }
      // The resolved startup environment selects, here through a resolved manifest template.
      const templated = manifest({ env: { SETUP_SOURCE: "{{env.SETUP_FILE}}" } }, { SETUP_FILE: "setup/a.yaml" });
      const resolved = await revision(templated, root, { SETUP_FILE: "setup/a.yaml", SETUP_SOURCE: "setup/a.yaml" });
      await write({ "setup/a.yaml": service("seed", "migrate --all") });
      expect(await revision(templated, root, { SETUP_FILE: "setup/a.yaml", SETUP_SOURCE: "setup/a.yaml" })).not.toBe(resolved);
      await write({ "setup/a.yaml": service("seed", "migrate") });
      // An extends file and an env_file path chosen by the environment.
      await write({ "compose.yaml": ["services:", "  seed:", "    extends: { file: \"${SEED_BASE}\", service: base }", "    env_file: [\"${SEED_ENV}\"]", ""].join("\n"),
        "setup/base.yaml": service("base", "migrate"), "setup/seed.env": "SEED_MODE=minimal\nSEED_TOKEN=t-1\n" });
      const chosen = manifest({}, { SEED_BASE: "setup/base.yaml", SEED_ENV: "setup/seed.env" });
      const selected = await revision(chosen);
      await write({ "setup/seed.env": "SEED_MODE=minimal\nSEED_TOKEN=t-2\n" });
      expect(await revision(chosen)).toBe(selected);
      await write({ "setup/seed.env": "SEED_MODE=full\nSEED_TOKEN=t-2\n" });
      expect(await revision(chosen)).not.toBe(selected);
      await write({ "setup/base.yaml": service("base", "migrate --all") });
      const changedBase = await revision(chosen);
      expect(changedBase).not.toBe(selected);
      // An allowlisted host value selects the source; how the host spells the same file is not an input.
      await write({ "compose.yaml": "include: [\"${TASK_TEST_SETUP_ROOT}/setup/a.yaml\"]\nservices: {}\n" });
      await symlink(root, path.join(parent, "alias"));
      const inherited = manifest({ envAllowlist: ["TASK_TEST_SETUP_ROOT"] });
      process.env.TASK_TEST_SETUP_ROOT = root;
      const direct = await revision(inherited);
      process.env.TASK_TEST_SETUP_ROOT = path.join(parent, "alias");
      expect(await revision(inherited)).toBe(direct);
      await write({ "setup/a.yaml": service("seed", "migrate --all") });
      expect(await revision(inherited)).not.toBe(direct);
    } finally {
      if (previous === undefined) delete process.env.TASK_TEST_SETUP_ROOT; else process.env.TASK_TEST_SETUP_ROOT = previous;
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("masks credential build arguments of a Compose task like its credential environment entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-task-revision-build-args-"));
    const config = validateDevFnConfig({ version: 1, project: { id: "revision-build-args" },
      services: { seed: { adapter: "compose", service: "seed", task: {} } }, profiles: { default: { services: ["seed"] } } });
    const revision = async (args: string) => {
      await writeFile(path.join(root, "compose.yaml"), ["services:", "  seed:", "    build:", "      context: .", `      args: ${args}`, ""].join("\n"));
      return await taskInputRevision(config, root, { name: "seed", kind: "service" }, "default");
    };
    try {
      const map = await revision("{ NPM_TOKEN: n-1, SEED_MODE: minimal }");
      expect(await revision("{ NPM_TOKEN: n-2, SEED_MODE: minimal }")).toBe(map);
      expect(await revision("{ NPM_TOKEN: n-2, SEED_MODE: full }")).not.toBe(map);
      const list = await revision("[NPM_TOKEN=n-1, SEED_MODE=minimal]");
      expect(await revision("[NPM_TOKEN=n-2, SEED_MODE=minimal]")).toBe(list);
      expect(await revision("[NPM_TOKEN=n-2, SEED_MODE=full]")).not.toBe(list);
    } finally { await rm(root, { recursive: true, force: true }); }
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
      // An explicit rerun on a ready lifecycle names the replacement that runs it.
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, rerunTasks: ["migrate"] }))
        .rejects.toMatchObject({ code: "DEVFN_ALREADY_RUNNING", message: expect.stringContaining("devfn restart --rerun-task migrate") });
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

  it("reruns an unresolved idempotent run-once task only at a revision it already ran, never at a changed one", async () => {
    const env = await fixture("once-unresolved", { rerun: "once", idempotent: true });
    try {
      await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir });
      await env.orchestrator.down({ config: env.config, root: env.root, stateDir: env.stateDir });
      await env.reset({ exit: 9 });
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, rerunTasks: ["migrate"] })).rejects.toMatchObject({ code: "DEVFN_START_FAILED" });
      await env.reset({});
      // The unresolved attempt does not make a changed input revision run without --rerun-task.
      await writeFile(path.join(env.root, "migrations", "001.sql"), "create table two;\n");
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
      expect(await env.runs()).toHaveLength(2);
      // At the revision it already ran, it reruns to resolve that attempt.
      await writeFile(path.join(env.root, "migrations", "001.sql"), "create table one;\n");
      expect((await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).tasks)
        .toMatchObject([{ status: "succeeded", reason: "an attempt since the last success ended failed with unknown effects" }]);
      expect(await env.runs()).toHaveLength(3);
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
      // The locked start settles the unfinished attempt, records it interrupted and blocks before any lease, receipt or node.
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_RERUN_REQUIRED" });
      expect((await env.journal())?.attempts).toMatchObject([{ invocationId: "crashed", outcome: "interrupted", effects: "unknown", stopped: true }]);
      expect(await env.runs()).toHaveLength(0);
      expect(await readReceipt(env.config, env.root, env.identity.instanceId)).toBeNull();
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_RERUN_REQUIRED" });
    } finally { await env.cleanup(); }
  }, 60_000);

  it("stops what an earlier attempt left running before the task runs again, and blocks every start while that cannot be verified", async () => {
    const env = await fixture("leftover", { idempotent: true });
    // A process group an earlier attempt could not be verified to stop.
    const leftover = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
    const pid = leftover.pid!;
    const record = async (launcher: { pid: number; birthSignature?: string }) => {
      const { key } = taskScope(env.config, env.identity.instanceId, { name: "migrate", kind: "process" });
      await mkdir(path.join(env.stateDir, "tasks"), { recursive: true });
      await writeFile(path.join(env.stateDir, "tasks", `${key}.json`), JSON.stringify({ version: 1, task: "migrate", scope: "instance", attempts: [
        { invocationId: "unstopped", instanceId: "another", attempt: 1, inputRevision: "x", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
          outcome: "failed", exitCode: 1, effects: "unknown", stopped: false, launcher }] }));
    };
    try {
      // Without a verifiable identity DevFn never signals it, and even an explicit rerun blocks before any mutation.
      await record({ pid });
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, rerunTasks: ["migrate"] })).rejects.toMatchObject({ code: "DEVFN_TASK_RERUN_REQUIRED" });
      expect(alive(pid)).toBe(true);
      expect(await env.runs()).toHaveLength(0);
      expect(await readReceipt(env.config, env.root, env.identity.instanceId)).toBeNull();
      // With its recorded identity the leftover group is stopped first; the idempotent task then runs.
      await record({ pid, birthSignature: (await processBirthSignature(pid))! });
      const ready = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir });
      expect(ready.tasks).toMatchObject([{ status: "succeeded", reason: "an attempt since the last success ended failed with unknown effects" }]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(pid)).toBe(false);
      expect((await env.journal())?.attempts).toMatchObject([{ invocationId: "unstopped", outcome: "failed", stopped: true }, { outcome: "succeeded", stopped: true }]);
    } finally {
      leftover.kill("SIGKILL");
      await env.cleanup();
    }
  }, 60_000);

  it("decides again under the lifecycle lock, so a start waiting on a failing non-idempotent run never mutates", async () => {
    const env = await fixture("waiter", {}, { sleepMs: 1_500, exit: 4 });
    try {
      const first = env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir }).catch((error: unknown) => error);
      while (!await exists(path.join(env.root, "task.pid"))) await new Promise((resolve) => setTimeout(resolve, 20));
      // This start's early preflight sees only a running attempt; it then waits for the first start.
      const waiter = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir }).catch((error: unknown) => error);
      expect(await first).toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_TASK_FAILED" } });
      expect(waiter).toMatchObject({ code: "DEVFN_TASK_RERUN_REQUIRED" });
      // The receipt is still the first start's: the waiter reserved, recorded and started nothing.
      const receipt = await readReceipt(env.config, env.root, env.identity.instanceId);
      expect(receipt).toMatchObject({ state: "failed", tasks: [{ status: "failed", attempts: [{ invocationId: receipt!.invocationId, exitCode: 4 }] }] });
      expect(await env.runs()).toHaveLength(1);
    } finally { await env.cleanup(); }
  }, 90_000);

  it("keeps a ready lifecycle of only setup tasks ready, so a duplicate start runs nothing", async () => {
    const env = await fixture("task-only", { rerun: "always", idempotent: true }, {}, undefined, ["migrate"]);
    try {
      expect(await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir }))
        .toMatchObject({ state: "ready", processes: [], services: [], tasks: [{ status: "succeeded" }] });
      expect(await env.orchestrator.status({ config: env.config, root: env.root })).toMatchObject({ state: "ready" });
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).rejects.toMatchObject({ code: "DEVFN_ALREADY_RUNNING" });
      expect(await env.runs()).toHaveLength(1);
      // Only an explicit replacement runs the always task again.
      expect((await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir, replace: true })).tasks).toMatchObject([{ status: "succeeded", reason: "rerun always" }]);
      expect(await env.runs()).toHaveLength(2);
    } finally { await env.cleanup(); }
  }, 90_000);

  it("lets a start waiting on a failed first start rerun an unresolved idempotent task, as documented", async () => {
    const env = await fixture("waiter-idempotent", { idempotent: true }, { sleepMs: 1_500, exit: 4 });
    try {
      const first = env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir }).catch((error: unknown) => error);
      while (!await exists(path.join(env.root, "task.pid"))) await new Promise((resolve) => setTimeout(resolve, 20));
      // The first attempt already read its behavior; the waiter's attempt succeeds.
      await writeFile(path.join(env.root, "behavior.json"), "{}");
      const waiter = await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir });
      expect(await first).toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_TASK_FAILED" } });
      expect(waiter).toMatchObject({ state: "ready", tasks: [{ status: "succeeded", reason: "an attempt since the last success ended failed with unknown effects" }] });
      expect(await env.runs()).toHaveLength(2);
    } finally { await env.cleanup(); }
  }, 90_000);

  it("runs a never-succeeded run-once task at a changed revision, as on its first start", async () => {
    const env = await fixture("once-never", { rerun: "once", idempotent: true }, { exit: 9 });
    try {
      await expect(env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).rejects.toMatchObject({ code: "DEVFN_START_FAILED" });
      await env.reset({});
      await writeFile(path.join(env.root, "migrations", "001.sql"), "create table two;\n");
      expect((await env.orchestrator.up({ config: env.config, root: env.root, stateDir: env.stateDir })).tasks).toMatchObject([{ status: "succeeded" }]);
      expect((await env.runs()).map((run) => run.migrations)).toEqual(["create table one;", "create table two;"]);
    } finally { await env.cleanup(); }
  }, 90_000);

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

describe("tasks consuming targets shared across worktrees (real local processes)", () => {
  // Two worktrees of one project sharing a state directory, as on one machine.
  const worktrees = async (name: string, resources: Record<string, unknown>, consumed: string[], task: Partial<TaskSpec> = {}) => {
    const base = await mkdtemp(path.join(os.tmpdir(), `devfn-task-${name}-`));
    const stateDir = path.join(base, "state");
    const config = validateDevFnConfig({ version: 1, project: { id: `task-${name}` }, ports: { web: {} },
      processes: {
        migrate: { adapter: "command", command: [process.execPath, "task.mjs"], resources: consumed, task: { inputs: ["migrations"], ...task } },
        web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], dependsOn: ["migrate"], health: { type: "http", port: "web", timeoutMs: 10_000 } },
      },
      resources, profiles: { default: { processes: ["web"] } } });
    const roots: string[] = [];
    for (const worktree of ["a", "b"]) {
      const root = path.join(base, worktree);
      await mkdir(path.join(root, "migrations"), { recursive: true });
      await writeFile(path.join(root, "migrations", "001.sql"), "create table one;\n");
      await writeFile(path.join(root, "task.mjs"), taskScript);
      await writeFile(path.join(root, "server.mjs"), serverScript);
      await writeFile(path.join(root, "behavior.json"), JSON.stringify({ sleepMs: 1_000 }));
      // What a task did to a shared target is visible from every worktree.
      await writeFile(path.join(root, "migrated"), "1");
      roots.push(root);
    }
    const orchestrator = new DevFnOrchestrator();
    const runs = async () => (await Promise.all(roots.map(async (root) => (await readFile(path.join(root, "runs.log"), "utf8").catch(() => "")).split("\n").filter(Boolean)))).flat();
    const cleanup = async () => {
      for (const root of roots) await orchestrator.down({ config, root, stateDir }).catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    };
    return { config, roots, stateDir, orchestrator, runs, cleanup };
  };

  it("runs a non-idempotent task consuming a remote service once for every worktree, also for concurrent starts", async () => {
    const env = await worktrees("remote-service", { api: { kind: "service", defaultTarget: "remote", targets: { remote: { url: "https://api.example.test" } } } }, ["api"]);
    try {
      const started = await Promise.all(env.roots.map(async (root) => await env.orchestrator.up({ config: env.config, root, stateDir: env.stateDir })));
      expect(started.map((receipt) => receipt.state)).toEqual(["ready", "ready"]);
      expect(started.map((receipt) => receipt.tasks![0].status).sort()).toEqual(["skipped", "succeeded"]);
      expect(await env.runs()).toHaveLength(1);
      // A later start in either worktree decides from the same record.
      const restarted = await env.orchestrator.up({ config: env.config, root: env.roots[1], stateDir: env.stateDir, replace: true });
      expect(restarted.tasks).toMatchObject([{ status: "skipped", reason: "succeeded for this input revision" }]);
      expect(await env.runs()).toHaveLength(1);
    } finally { await env.cleanup(); }
  }, 90_000);

  it("rejects a task mixing shared and per-instance targets in every worktree before any mutation", async () => {
    const resources = {
      db: { kind: "database", defaultTarget: "remote", namespace: { level: "schema", database: "app", sharing: "shared" }, targets: { remote: { url: "postgres://db.example.test:5432" } } },
      cache: { kind: "cache", defaultTarget: "remote", targets: { remote: { url: "redis://cache.example.test:6379" } } },
    };
    for (const task of [{}, { idempotent: true }]) {
      const env = await worktrees("mixed", resources, ["db", "cache"], task);
      try {
        const outcomes = await Promise.all(env.roots.map(async (root) => await env.orchestrator.up({ config: env.config, root, stateDir: env.stateDir }).catch((error: unknown) => error)));
        for (const outcome of outcomes) {
          expect(outcome).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { task: "migrate", shared: ["db"], instance: ["cache"] } });
        }
        expect(await env.runs()).toHaveLength(0);
        expect(await exists(env.stateDir)).toBe(false);
      } finally { await env.cleanup(); }
    }
  }, 90_000);
});

describe("task attempt boundaries (stub launchers)", () => {
  async function context(name: string, overrides: Partial<RunTaskContext> & Pick<RunTaskContext, "node">) {
    const root = await mkdtemp(path.join(os.tmpdir(), `devfn-task-stub-${name}-`));
    await writeFile(path.join(root, "compose.yaml"), "services:\n  seed: { image: busybox }\n  plain: { image: busybox }\n");
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
    prepareTask: async (input: { name: string; instanceId: string }) => ({ command, environment: { PATH: process.env.PATH ?? "" },
      launch: { name: input.name, projectName: `stub-${input.instanceId}`, composeService: input.name, preExisting: false, existingContainerIds: [], runningContainerIds: [] } }),
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

  it("settles another worktree's unverified Compose attempt of a shared scope through its journaled launch before any new attempt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-task-shared-"));
    await writeFile(path.join(root, "compose.yaml"), "services:\n  seed: { image: busybox }\n  plain: { image: busybox }\n");
    const config = validateDevFnConfig({ version: 1, project: { id: "stub-shared" },
      services: { seed: { adapter: "compose", service: "seed", resources: ["db"], task: { idempotent: true } } },
      resources: { db: { kind: "database", defaultTarget: "remote", namespace: { level: "schema", database: "app", sharing: "shared" }, targets: { remote: { url: "postgres://db.example.test:5432" } } } },
      profiles: { default: { services: ["seed"] } } });
    const node = { name: "seed", kind: "service" as const };
    const stateDir = path.join(root, "state");
    const worktree = (instanceId: string, supervisor: ProcessSupervisor, controller: ComposeController, rerunRequested = false): RunTaskContext => {
      const resources = planResources({ config, plan: createPlan(config), ownerId: instanceId, runtimeId: "a".repeat(32), ports: {}, platform: "linux" });
      // Each worktree's registry is its own; none of them knows another's launch.
      const registry = { recordOwners: vi.fn(async () => undefined), beginLaunch: vi.fn(async () => undefined) } as unknown as FilePortRegistry;
      return { config, root, stateDir, runtimeDir: path.join(root, instanceId), instanceId, invocationId: `${instanceId}-invocation`, node, profile: "default",
        environment: { PATH: process.env.PATH ?? "" }, generated: {}, resources, rerunRequested, registry, supervisor, compose: controller, record: async () => undefined };
    };
    const scope = (instanceId: string) => taskScope(config, instanceId, node, planResources({ config, plan: createPlan(config), ownerId: instanceId, runtimeId: "a".repeat(32), ports: {}, platform: "linux" }));
    const order: string[] = [];
    const succeeding = { run: async (input: RunProcessInput): Promise<ProcessRunResult> => {
      order.push("run");
      const managed = { name: input.name, pid: 2 ** 22 + 9, command: input.command, cwd: input.root, logPath: path.join(input.root, "ok.log"), startedAt: new Date().toISOString() };
      await input.onStarted?.(managed);
      return { outcome: "succeeded", exitCode: 0, signal: null, process: managed };
    } } as unknown as ProcessSupervisor;
    try {
      expect(scope("worktree-a")).toEqual(scope("worktree-b"));
      expect(scope("worktree-a").scope).toBe("shared");
      // Worktree A's attempt ends with a one-off container it could not remove.
      await expect(runTask(worktree("worktree-a", failing({}).supervisor, compose(["docker"], async () => { throw new Error("container still running"); }))))
        .rejects.toMatchObject({ code: "DEVFN_TASK_FAILED" });
      expect((await readTaskJournal(stateDir, scope("worktree-a").key))?.attempts).toMatchObject([{ stopped: false, compose: { projectName: "stub-worktree-a", composeService: "seed" } }]);
      // Worktree B cannot remove it either: nothing runs, also on an explicit rerun.
      const blocked = compose(["docker"], async () => { order.push("stop"); throw new Error("container still running"); });
      await expect(runTask(worktree("worktree-b", succeeding, blocked, true))).rejects.toMatchObject({ code: "DEVFN_TASK_RERUN_REQUIRED" });
      expect(order).toEqual(["stop"]);
      // Once it can, it stops A's leftovers through A's journaled launch, then runs.
      const settles = compose(["docker"], async () => { order.push("stop"); });
      expect(await runTask(worktree("worktree-b", succeeding, settles))).toMatchObject({ status: "succeeded" });
      expect(order).toEqual(["stop", "stop", "run"]);
      expect(settles.stopLaunch).toHaveBeenCalledWith(expect.objectContaining({ name: "seed", projectName: "stub-worktree-a", launcher: { pid: 2 ** 22 + 7 } }));
      expect((await readTaskJournal(stateDir, scope("worktree-a").key))?.attempts.map((attempt) => [attempt.instanceId, attempt.outcome, attempt.stopped]))
        .toEqual([["worktree-a", "failed", true], ["worktree-b", "succeeded", true]]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("never lets attempts that never started evict an unresolved one from the journal", async () => {
    for (const node of [{ name: "migrate", kind: "process" as const }, { name: "plain", kind: "service" as const }]) {
      const gateClosed = { recordOwners: vi.fn(async () => { throw new Error("registry unavailable"); }), beginLaunch: vi.fn(async () => { throw new Error("registry unavailable"); }) };
      const env = await context(`evict-${node.name}`, { node, supervisor: failing({}).supervisor, compose: compose(["docker"]), registry: gateClosed as unknown as FilePortRegistry, rerunRequested: true });
      try {
        // A success at this revision, then an attempt of unknown effect.
        const revision = await taskInputRevision(env.value.config, env.root, node, "default");
        const attempt = { instanceId: "instance", attempt: 1, inputRevision: revision, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), launcher: { pid: 2 ** 22 + 7 }, stopped: true };
        await mkdir(path.join(env.value.stateDir, "tasks"), { recursive: true });
        await writeFile(path.join(env.value.stateDir, "tasks", `${taskScope(env.value.config, "instance", node).key}.json`), JSON.stringify({ version: 1, task: node.name, scope: "instance",
          lastSuccess: { inputRevision: revision, invocationId: "ok", instanceId: "instance", completedAt: attempt.endedAt },
          attempts: [{ ...attempt, invocationId: "ok", outcome: "succeeded", effects: "applied" }, { ...attempt, invocationId: "partial", outcome: "failed", exitCode: 1, effects: "unknown" }] }));
        // More explicit reruns than the journal keeps fail before their launch gate opens.
        for (let index = 0; index < 21; index += 1) await expect(runTask({ ...env.value, invocationId: `closed-${index}` })).rejects.toThrow("registry unavailable");
        const kept = (await env.journal())!.attempts;
        expect(kept.filter((item) => item.effects === "none")).toHaveLength(20);
        expect(kept.map((item) => item.invocationId).slice(0, 2)).toEqual(["ok", "partial"]);
        // The unresolved attempt still decides the next start.
        const next = runTask({ ...env.value, command: [process.execPath, "-e", "0"], rerunRequested: false, registry: env.registry as unknown as FilePortRegistry, supervisor: new ProcessSupervisor(), compose: compose([process.execPath, "-e", "0"]) });
        if (node.name === "plain") await expect(next).rejects.toMatchObject({ code: "DEVFN_TASK_RERUN_REQUIRED", details: { attempt: { invocationId: "partial" } } });
        else expect(await next).toMatchObject({ status: "succeeded", reason: "an attempt since the last success ended failed with unknown effects" });
      } finally { await rm(env.root, { recursive: true, force: true }); }
    }
  }, 60_000);

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
  it.skipIf(process.env.DEVFN_REAL_COMPOSE !== "1")("starts a Compose task whose source the profile environment selects, and reruns it when the selected file changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-task-compose-selected-"));
    const stateDir = path.join(root, "state");
    const orchestrator = new DevFnOrchestrator();
    const config = validateDevFnConfig({ version: 1, project: { id: "task-compose-selected" },
      services: { seed: { adapter: "compose", service: "seed", task: { idempotent: true } } },
      profiles: { default: { services: ["seed"], environment: { SETUP_SOURCE: "setup/compose.yaml" } } } });
    const seed = (message: string) => ["services:", "  seed:", "    image: busybox", `    command: [sh, -c, 'echo ${message}']`, ""].join("\n");
    try {
      await mkdir(path.join(root, "setup"));
      await writeFile(path.join(root, "compose.yaml"), "include: [\"${SETUP_SOURCE}\"]\nservices: {}\n");
      await writeFile(path.join(root, "setup", "compose.yaml"), seed("seeded-one"));
      const first = await orchestrator.up({ config, root, stateDir });
      expect(first.tasks).toMatchObject([{ name: "seed", status: "succeeded" }]);
      expect(await readFile(first.tasks![0].logPath!, "utf8")).toContain("seeded-one");
      await writeFile(path.join(root, "setup", "compose.yaml"), seed("seeded-two"));
      const second = await orchestrator.up({ config, root, stateDir });
      expect(second.tasks).toMatchObject([{ name: "seed", status: "succeeded" }]);
      expect(second.tasks![0].inputRevision).not.toBe(first.tasks![0].inputRevision);
      expect(await readFile(second.tasks![0].logPath!, "utf8")).toContain("seeded-two");
      await orchestrator.down({ config, root, stateDir });
    } finally {
      await orchestrator.down({ config, root, stateDir }).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

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
      profiles: { default: { services: ["api"] }, vault: { services: ["vault-api"] }, setup: { services: ["seed"] } } });
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

      // A ready lifecycle of only a completed task stays ready: a duplicate start runs nothing.
      expect(await orchestrator.up({ config: config(), root, stateDir, profile: "setup" })).toMatchObject({ state: "ready", services: [], tasks: [{ name: "seed", status: "skipped" }] });
      await expect(orchestrator.up({ config: config(), root, stateDir, profile: "setup" })).rejects.toMatchObject({ code: "DEVFN_ALREADY_RUNNING" });
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

      // A killed `docker compose run` leaves its one-off container to dockerd. Only the task journal knows it, as
      // for another worktree sharing the scope: the next start removes it before the task runs again.
      const { instanceId } = await resolveInstanceIdentity("task-compose", root);
      const prepare = async (attempt: string) => await new ComposeController().prepareTask({ name: "seed", spec: config({ sleep: 60 }).services!.seed, root, runtimeDir: path.join(root, `${attempt}-runtime`), instanceId, environment: {}, attempt });
      const orphanRun = async (attempt: string) => {
        const prepared = await prepare(attempt);
        const child = spawn(prepared.command[0], prepared.command.slice(1), { cwd: root, env: prepared.environment, detached: true, stdio: "ignore" });
        const launcher = { pid: child.pid!, birthSignature: (await processBirthSignature(child.pid!))! };
        const labeled = async () => (await execFileAsync("docker", ["ps", "-aq", "--filter", `label=devfn.task-attempt=${attempt}`])).stdout.trim();
        while (!await labeled()) await new Promise((resolve) => setTimeout(resolve, 200));
        return { prepared, launcher, labeled };
      };
      const { prepared, launcher } = await orphanRun("killed.1");
      process.kill(-launcher.pid, "SIGKILL");
      while (alive(launcher.pid)) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await oneOffs()).not.toBe("");
      // Another attempt's one-off container of the same project and service (as from another scope) is not this attempt's.
      const other = await orphanRun("other.1");
      const { key } = taskScope(config(), instanceId, { name: "seed", kind: "service" });
      const { name: _name, ...launch } = prepared.launch;
      await writeFile(path.join(stateDir, "tasks", `${key}.json`), JSON.stringify({ version: 1, task: "seed", scope: "instance", attempts: [
        { invocationId: "killed", instanceId, attempt: 1, inputRevision: "x", startedAt: new Date().toISOString(), outcome: "running", effects: "unknown", launcher, compose: launch }] }));
      const recovered = await orchestrator.up({ config: config(), root, stateDir });
      expect(recovered.tasks).toMatchObject([{ status: "succeeded", reason: "an attempt since the last success ended interrupted with unknown effects" }]);
      expect(await other.labeled()).not.toBe("");
      process.kill(-other.launcher.pid, "SIGKILL");
      await new ComposeController().stopLaunch({ ...other.prepared.launch, launcher: other.launcher });
      expect(await oneOffs()).toBe("");
      expect((await readTaskJournal(stateDir, key))?.attempts[0]).toMatchObject({ invocationId: "killed", outcome: "interrupted", stopped: true });
      await orchestrator.down({ config: config(), root, stateDir });

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
  }, 600_000);
});
