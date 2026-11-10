import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { access, link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { composeProjectName } from "@devfn/compose";
import { trustProject, validateDevFnConfig, type DevFnConfig } from "@devfn/config";
import { FilePortRegistry, withFileLock } from "@devfn/ports";
import { CaddyProxyController, proxyListenerPorts, proxyOwnerStatus } from "@devfn/proxy";
import { describe, expect, it, vi } from "vitest";

import { assertEnvironmentOutputsAvailable, claimEnvironmentOutputs, makeStateDirectory, releaseEnvironmentOutputs, withInstanceLifecycleLock, within } from "../src/outputs.js";
import { newRuntimeId, recordRuntimeId } from "../src/runtime.js";
import { preflightTasks } from "../src/tasks.js";
import { createPlan, DevFnOrchestrator, domainAliases, readTaskJournal, recoverOrphanedProxyRoutes, resolveEndpointTemplates, resolveInstanceIdentity, resolveLocalHostname, runtimeDirectory, selectRuntime, taskInputRevision, taskScope } from "../src/index.js";

const execFileAsync = promisify(execFile);
// What a start does under its instance lifecycle lock before it writes in its state directory, as a start killed right after it leaves it.
const recordStateDirectory = async (config: DevFnConfig, root: string, identity: Awaited<ReturnType<typeof resolveInstanceIdentity>>, stateDir: string) =>
  await withInstanceLifecycleLock(root, identity.instanceId, async () => await makeStateDirectory(config, root, identity, stateDir, true));
// Lets a test act right after down releases a claim, as a sibling start in another process could.
const releases = vi.hoisted(() => ({ after: undefined as (() => Promise<void>) | undefined, fail: undefined as Error | undefined }));
const claimReads = vi.hoisted(() => ({ root: undefined as string | undefined, after: undefined as (() => Promise<void>) | undefined }));
vi.mock("../src/outputs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/outputs.js")>();
  return { ...actual, releaseEnvironmentOutputs: async (...args: Parameters<typeof actual.releaseEnvironmentOutputs>) => {
    // Lets a test fail one release, as an unwritable claim store would.
    const fail = releases.fail;
    releases.fail = undefined;
    if (fail) throw fail;
    await actual.releaseEnvironmentOutputs(...args);
    const after = releases.after;
    releases.after = undefined;
    await after?.();
  }, readClaims: async (...args: Parameters<typeof actual.readClaims>) => {
    // Lets a test publish a sibling right after a task-input revision read the claims, before its walk.
    // Only the test's own checkout consumes it, never a read from an earlier test's lingering work.
    const result = await actual.readClaims(...args);
    const after = args[0] === claimReads.root ? claimReads.after : undefined;
    if (after) claimReads.after = undefined;
    await after?.();
    return result;
  } };
});

// Lets a test act right before the task-input walk reads a file, as a concurrent writer could, or right after a start creates a directory.
const reads = vi.hoisted(() => ({ before: undefined as ((operation: "lstat" | "readFile" | "opendir", file: string) => Promise<void>) | undefined }));
const made = vi.hoisted(() => ({ after: undefined as ((directory: string) => Promise<void>) | undefined, fail: undefined as ((directory: string) => Error | undefined) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => { const failure = made.fail?.(String(args[0])); if (failure) throw failure; const created = await actual.mkdir(...args); await made.after?.(String(args[0])); return created; },
    lstat: async (...args: Parameters<typeof actual.lstat>) => { await reads.before?.("lstat", String(args[0])); return await actual.lstat(...args); },
    readFile: async (...args: Parameters<typeof actual.readFile>) => { await reads.before?.("readFile", String(args[0])); return await actual.readFile(...args); },
    opendir: async (...args: Parameters<typeof actual.opendir>) => { await reads.before?.("opendir", String(args[0])); return await actual.opendir(...args); } };
});

// Lets a test fail acquiring a lock, as a filesystem without hard links fails linking its owner record, or act right before acquiring one.
const lockFailures = vi.hoisted(() => ({ fail: undefined as ((lockPath: string) => Error | undefined) | undefined, before: undefined as ((lockPath: string) => Promise<void>) | undefined }));
vi.mock("@devfn/ports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devfn/ports")>();
  return { ...actual, withFileLock: async (...args: Parameters<typeof actual.withFileLock>) => {
    const failure = lockFailures.fail?.(args[0]);
    if (failure) throw failure;
    await lockFailures.before?.(args[0]);
    return await actual.withFileLock(...args);
  } };
});

// Lets a test act as soon as a stopped receipt's stable copy is written: at the first point writeReceipt yields after it, or once it returns.
const stops = vi.hoisted(() => ({ onStopped: undefined as ((copyAfterStable: boolean) => Promise<void>) | undefined }));
// Lets a test act once a start recorded its runtime identity, or each time a lifecycle command reads a receipt, also under its locks.
const lifecycle = vi.hoisted(() => ({ recorded: undefined as (() => Promise<void>) | undefined, read: undefined as (() => Promise<void>) | undefined, recording: undefined as (() => Promise<void>) | undefined }));
vi.mock("../src/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime.js")>();
  const once = async (name: "recorded") => { const hook = lifecycle[name]; lifecycle[name] = undefined; await hook?.(); };
  return { ...actual, recordRuntimeId: async (...args: Parameters<typeof actual.recordRuntimeId>) => { await lifecycle.recording?.(); const recorded = await actual.recordRuntimeId(...args); await once("recorded"); return recorded; },
    readReceipt: async (...args: Parameters<typeof actual.readReceipt>) => { const receipt = await actual.readReceipt(...args); await lifecycle.read?.(); return receipt; }, writeReceipt: async (receipt: Parameters<typeof actual.writeReceipt>[0], options: Parameters<typeof actual.writeReceipt>[1] = {}) => {
    const onStopped = stops.onStopped;
    if (!onStopped || receipt.state !== "stopped" || options.runtimeCopy !== undefined || options.stable === false) return await actual.writeReceipt(receipt, options);
    stops.onStopped = undefined;
    const stable = path.join(receipt.root, ".devfn", "receipts", `${receipt.instanceId}.json`);
    let ran = false;
    const said = async () => (JSON.parse(await readFile(stable, "utf8")) as { state: string }).state === "stopped";
    await actual.writeReceipt(receipt, { ...options, runtimeCopy: async (relative) => {
      if (await said()) { ran = true; await onStopped(true); }
      return path.join(receipt.runtimeDir, relative);
    } });
    if (!ran && await said()) await onStopped(false);
  } };
});

/** Whether a directory's filesystem folds case, observed by writing a probe there and reading it back in another case. */
async function foldsCaseHere(directory: string): Promise<boolean> {
  const probe = path.join(directory, `case-probe-${process.pid}`);
  await writeFile(probe, "");
  try { return await access(path.join(directory, `CASE-PROBE-${process.pid}`)).then(() => true, () => false); }
  finally { await rm(probe, { force: true }); }
}

async function repository(): Promise<{ parent: string; primary: string; second: string }> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-named-runtime-")));
  const primary = path.join(parent, "checkout");
  const second = path.join(parent, "second");
  await mkdir(primary);
  await execFileAsync("git", ["init", "-q", primary]);
  await execFileAsync("git", ["-C", primary, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "--allow-empty", "-m", "fixture"]);
  await execFileAsync("git", ["-C", primary, "worktree", "add", "-q", "--detach", second]);
  return { parent, primary, second };
}

/** A real DevFn process takes the locks as a lifecycle command does and is SIGKILLed holding them: no record is aged. A child leaves `children` once it exited, so cleanup never signals a PID it no longer owns. */
async function killLockHolder(children: Set<ChildProcess>, ...locks: string[]): Promise<void> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withFileLock } from "@devfn/ports";
    const locks = process.argv.slice(1);
    const hold = async (index) => index === locks.length ? await new Promise(() => setInterval(() => undefined, 1_000)) : await withFileLock(locks[index], async () => await hold(index + 1));
    await hold(0);`, ...locks], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "ignore" });
  children.add(child);
  const exited = new Promise((resolve) => child.once("exit", () => { children.delete(child); resolve(undefined); }));
  for (const lock of locks) await expect.poll(async () => await readFile(path.join(lock, "owner.json"), "utf8").then((text) => (JSON.parse(text) as { pid: number }).pid, () => 0), { timeout: 20_000 }).toBe(child.pid);
  child.kill("SIGKILL");
  await exited;
}

/** Kill only the children a test still owns and that still run. */
const killRunning = (children: Set<ChildProcess>) => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };

describe("named runtime identity", () => {
  it("keeps the default runtime's v0.1 identity and gives each named runtime and worktree its own owner", async () => {
    const { parent, primary, second } = await repository();
    try {
      const [base, explicit, review, preview, otherReview] = await Promise.all([
        resolveInstanceIdentity("fixture", primary), resolveInstanceIdentity("fixture", primary, "default"), resolveInstanceIdentity("fixture", primary, "review"),
        resolveInstanceIdentity("fixture", primary, "preview"), resolveInstanceIdentity("fixture", second, "review")]);
      const commonDir = await realpath(path.join(primary, ".git"));
      // Instance ID and label exactly as earlier releases derived them; selecting "default" is the same runtime.
      expect(base.instanceId).toBe(createHash("sha256").update(`${commonDir}\0${primary}\0fixture`).digest("hex").slice(0, 12));
      expect(base.readableWorktreeLabel).toBe(`checkout-${createHash("sha256").update(primary).digest("hex").slice(0, 20)}`);
      expect(explicit).toEqual(base);
      expect(Object.hasOwn(base, "runtime")).toBe(false);
      expect(review).toMatchObject({ runtime: "review", worktreePath: primary, repositoryIdentity: base.repositoryIdentity });
      expect(new Set([base, review, preview, otherReview].map((item) => item.instanceId)).size).toBe(4);
      expect(review.readableWorktreeLabel).toMatch(/^review-checkout-[0-9a-f]{20}$/);
      // Opaque owners keep .localhost routes and registered-domain aliases apart; only the default runtime of the primary worktree takes the canonical alias.
      expect(new Set([base, review, preview, otherReview].map((item) => resolveLocalHostname(undefined, "app", "fixture", item.instanceId))).size).toBe(4);
      // A fixed hostname is labelled per owner too, so no runtime routes the bare name.
      const fixed = [base, review, preview, otherReview].map((item) => resolveLocalHostname("app.localhost", "app", "fixture", item.instanceId));
      expect(new Set(fixed).size).toBe(4);
      expect(fixed).not.toContain("app.localhost");
      expect(domainAliases("app", "dev.example.test", base)).toContain("app.dev.example.test");
      const named = [review, preview, otherReview].map((item) => domainAliases("app", "dev.example.test", item));
      for (const aliases of named) expect(aliases).toHaveLength(1);
      expect(new Set([...domainAliases("app", "dev.example.test", base), ...named.flat()]).size).toBe(5);
      // A long runtime name still leaves a DNS-safe label with the digest intact.
      const long = await resolveInstanceIdentity("fixture", primary, "a".repeat(24));
      expect(domainAliases("app", "dev.example.test", long)[0].split(".")[0].length).toBeLessThanOrEqual(63);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("accepts only DNS-safe runtime names", () => {
    expect(selectRuntime()).toBe("default");
    for (const name of ["review", "pr-12", "a", "a".repeat(24)]) expect(selectRuntime(name)).toBe(name);
    for (const name of ["", "Review", "-a", "a-", "a_b", "a.b", "a/b", "a".repeat(25), "é"]) expect(() => selectRuntime(name)).toThrow(expect.objectContaining({ code: "DEVFN_RUNTIME_INVALID" }));
  });
});

describe("named runtime isolation", () => {
  it("gives an artifacts: runtime process its runtime directory and refuses to resolve one without it", () => {
    const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, processes: {
      app: { adapter: "command", command: ["node", "build.mjs", "--out", "{{env.DEVFN_ARTIFACT_DIR}}/dist"], artifacts: "runtime", env: { CACHE: "{{env.DEVFN_ARTIFACT_DIR}}/cache" } },
      plain: { adapter: "command", command: ["node", "serve.mjs"] } }, profiles: { default: { processes: ["app", "plain"] } } });
    const plan = createPlan(config);
    const resolved = resolveEndpointTemplates({ config, plan, ownerId: "owner", ports: {}, artifactDirectories: { app: "/runtime/one/artifacts/app" } });
    expect(resolved.nodes.app).toMatchObject({ command: ["node", "build.mjs", "--out", "/runtime/one/artifacts/app/dist"],
      environment: expect.objectContaining({ DEVFN_ARTIFACT_DIR: "/runtime/one/artifacts/app", CACHE: "/runtime/one/artifacts/app/cache" }) });
    expect(resolved.nodes.plain.environment).not.toHaveProperty("DEVFN_ARTIFACT_DIR");
    expect(() => resolveEndpointTemplates({ config, plan, ownerId: "owner", ports: {} })).toThrow(/processes\.app\.artifacts/);
    // A process that did not declare a runtime directory cannot reference one.
    const undeclared = validateDevFnConfig({ ...config, processes: { app: { adapter: "command", command: ["node", "{{env.DEVFN_ARTIFACT_DIR}}"] } }, profiles: { default: { processes: ["app"] } } });
    expect(() => resolveEndpointTemplates({ config: undeclared, plan: createPlan(undeclared), ownerId: "owner", ports: {}, artifactDirectories: { app: "/x" } })).toThrow(/missing reference DEVFN_ARTIFACT_DIR/);
  });

  it("records a task's artifacts choice and directory in its input revision, leaving an undeclared task's revision as it was", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-runtime-artifacts-")));
    try {
      const task = (artifacts?: string, runtimeDir?: string) => validateDevFnConfig({ version: 1, project: { id: "fixture" }, ...(runtimeDir ? { runtimeDir } : {}),
        processes: { build: { adapter: "command", command: ["node", "build.mjs"], task: {}, ...(artifacts ? { artifacts } : {}) } }, profiles: { default: { processes: ["build"] } } });
      const revision = async (config: DevFnConfig) => await taskInputRevision(config, root, { name: "build", kind: "process" }, "default");
      const revisions = await Promise.all([revision(task()), revision(task("shared")), revision(task("runtime")), revision(task("runtime", ".state"))]);
      expect(new Set(revisions).size).toBe(4);
      // The runtime directory reaches an undeclared task through nothing it reads, so its revision does not move with it.
      expect(await revision(task(undefined, ".state"))).toBe(revisions[0]);
      expect(await revision(task("runtime", ".devfn"))).toBe(revisions[2]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps every runtime's environment output out of a task's input revision", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-runtime-outputs-")));
    try {
      await mkdir(path.join(root, "config"));
      await writeFile(path.join(root, "config", "schema.sql"), "create table t();");
      const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, environmentOutputs: [{ path: "config/app.{runtime}.env" }],
        processes: { migrate: { adapter: "command", command: ["node", "migrate.mjs"], task: { inputs: ["config"] } } }, profiles: { default: { processes: ["migrate"] } } });
      const revision = async () => await taskInputRevision(config, root, { name: "migrate", kind: "process" }, "default");
      const before = await revision();
      await writeFile(path.join(root, "config", "app.default.env"), "A=1\n");
      await writeFile(path.join(root, "config", "app.review.env"), "A=2\n");
      expect(await revision()).toBe(before);
      // A staging file DevFn writes beside any runtime's output, mid-write or left by an interrupted write, is never read:
      // this one cannot be read at all, and the revision is unchanged.
      const staging = path.join(root, "config", ".app.review.env.00000000-0000-4000-8000-000000000000.devfn-tmp");
      await writeFile(staging, "DEVFN_INSTANCE_ID=partial\n", { mode: 0o000 });
      await writeFile(path.join(root, "config", ".app.other.env.11111111-1111-4111-8111-111111111111.devfn-tmp"), "A=4\n");
      expect(await revision()).toBe(before);
      await rm(staging);
      expect(await revision()).toBe(before);
      // The pattern is not a blanket exclusion: staging-shaped names of other files are inputs.
      await writeFile(path.join(root, "config", ".schema.sql.22222222-2222-4222-8222-222222222222.devfn-tmp"), "x");
      expect(await revision()).not.toBe(before);
      await rm(path.join(root, "config", ".schema.sql.22222222-2222-4222-8222-222222222222.devfn-tmp"));
      // A file the token cannot produce is an ordinary input.
      await writeFile(path.join(root, "config", "app.re_view.env"), "A=3\n");
      expect(await revision()).not.toBe(before);
      await expect(taskInputRevision(validateDevFnConfig({ ...config, processes: { migrate: { ...config.processes!.migrate, task: { inputs: ["config/app.review.env"] } } } }),
        root, { name: "migrate", kind: "process" }, "default")).rejects.toThrow(/DevFn runtime state/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the file a default runtime's {runtime} output links to out of a task's input revision, as for a literal output", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-runtime-output-link-")));
    try {
      await mkdir(path.join(root, "config"));
      await writeFile(path.join(root, "config", "schema.sql"), "create table t();");
      await writeFile(path.join(root, "config", "generated.env"), "PORT=1\n");
      // The default runtime writes through a symlink at its output name, so the linked file holds its generated values.
      await symlink(path.join("config", "generated.env"), path.join(root, ".env.default"));
      const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, environmentOutputs: [{ path: ".env.{runtime}" }],
        processes: { migrate: { adapter: "command", command: ["node", "migrate.mjs"], task: { inputs: ["config"] } } }, profiles: { default: { processes: ["migrate"] } } });
      const revision = async () => await taskInputRevision(config, root, { name: "migrate", kind: "process" }, "default");
      const before = await revision();
      await writeFile(path.join(root, "config", "generated.env"), "PORT=2\n");
      expect(await revision()).toBe(before);
      // Only that file is excluded: a neighbouring source edit is still an input change.
      await writeFile(path.join(root, "config", "schema.sql"), "create table u();");
      expect(await revision()).not.toBe(before);
      await expect(taskInputRevision(validateDevFnConfig({ ...config, processes: { migrate: { ...config.processes!.migrate, task: { inputs: ["config/generated.env"] } } } }),
        root, { name: "migrate", kind: "process" }, "default")).rejects.toThrow(/DevFn runtime state/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a named runtime's output out of a task's input revision under a case-only rename, but not a distinct file differing only in case", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-runtime-output-case-")));
    try {
      await writeFile(path.join(root, "schema.sql"), "create table t();");
      await writeFile(path.join(root, "case-probe"), "");
      const caseInsensitive = await access(path.join(root, "CASE-PROBE")).then(() => true, () => false);
      await rm(path.join(root, "case-probe"));
      const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, environmentOutputs: [{ path: ".env.{runtime}" }],
        processes: { migrate: { adapter: "command", command: ["node", "migrate.mjs"], task: { inputs: ["."] } } }, profiles: { default: { processes: ["migrate"] } } });
      const revision = async () => await taskInputRevision(config, root, { name: "migrate", kind: "process" }, "default");
      const staging = "..env.review.00000000-0000-4000-8000-000000000000.devfn-tmp";
      await writeFile(path.join(root, ".env.review"), "PORT=1\n");
      await writeFile(path.join(root, staging), "PORT=2\n");
      const before = await revision();
      if (caseInsensitive) {
        // The same files under another spelling: DevFn keeps writing them by its own.
        await rename(path.join(root, ".env.review"), path.join(root, ".ENV.review"));
        await rename(path.join(root, staging), path.join(root, staging.replace(".env.review", ".ENV.REVIEW")));
        expect(await revision()).toBe(before);
        await writeFile(path.join(root, ".env.review"), "PORT=3\n");
        expect(await revision()).toBe(before);
      } else {
        // Distinct files that differ only in case are the user's, so they stay inputs.
        await writeFile(path.join(root, ".ENV.review"), "A=1\n");
        const withVariant = await revision();
        expect(withVariant).not.toBe(before);
        await writeFile(path.join(root, staging.replace(".env.review", ".ENV.REVIEW")), "A=2\n");
        expect(await revision()).not.toBe(withVariant);
      }
      // Only those files are excluded: a neighbouring source edit is still an input change.
      const current = await revision();
      await writeFile(path.join(root, "schema.sql"), "create table u();");
      expect(await revision()).not.toBe(current);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps output-ownership state, its lock and the lock's retired directories out of a task's input revision", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-runtime-claims-")));
    try {
      await writeFile(path.join(root, "schema.sql"), "create table t();");
      const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, environmentOutputs: [{ path: ".env.{runtime}" }],
        processes: { migrate: { adapter: "command", command: ["node", "migrate.mjs"], task: { inputs: ["."] } } }, profiles: { default: { processes: ["migrate"] } } });
      const revision = async () => await taskInputRevision(config, root, { name: "migrate", kind: "process" }, "default");
      const before = await revision();
      const claims = path.join(root, ".devfn", "receipts", "outputs");
      // A held lock, one a killed holder left retired, a claim and its temporary file, and a staging file of an output.
      for (const lock of ["claims.lock", "claims.lock.released.0123456789abcdef"]) {
        await mkdir(path.join(claims, lock), { recursive: true });
        await writeFile(path.join(claims, lock, "owner.json"), JSON.stringify({ token: "x", pid: 999_999, createdAt: new Date().toISOString() }), { mode: 0o000 });
      }
      await writeFile(path.join(claims, "0123456789ab.json"), JSON.stringify({ version: 1, instanceId: "0123456789ab", runtime: "review", targets: [], written: [], pid: 999_999, createdAt: new Date().toISOString() }));
      await writeFile(path.join(claims, "0123456789ab.json.00000000-0000-4000-8000-000000000000.tmp"), "{");
      await writeFile(path.join(root, ".env.review"), "A=1\n");
      await writeFile(path.join(root, "..env.review.00000000-0000-4000-8000-000000000000.devfn-tmp"), "A=2\n");
      expect(await revision()).toBe(before);
      // State that appears and vanishes while siblings start and stop is never read, so a walk cannot fail on it.
      let churning = true;
      const churn = (async () => {
        for (let round = 0; churning; round += 1) {
          const retired = path.join(claims, `claims.lock.released.${round}`);
          await mkdir(retired, { recursive: true });
          await writeFile(path.join(retired, "owner.json"), "{}");
          await rm(retired, { recursive: true, force: true });
        }
      })();
      try { for (let walk = 0; walk < 20; walk += 1) expect(await revision()).toBe(before); }
      finally { churning = false; await churn; }
      // Other files under .devfn stay inputs, .devfn/outputs included: DevFn does not keep its state there.
      await mkdir(path.join(root, ".devfn", "outputs"), { recursive: true });
      await writeFile(path.join(root, ".devfn", "outputs", "notes.txt"), "user notes");
      const withOutputsNotes = await revision();
      expect(withOutputsNotes).not.toBe(before);
      await writeFile(path.join(root, ".devfn", "notes.txt"), "user notes");
      expect(await revision()).not.toBe(withOutputsNotes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

const SERVER = `import http from "node:http";
http.createServer((_request, response) => { response.writeHead(200); response.end(process.env.DEVFN_INSTANCE_ID); }).listen(Number(process.env.PORT), "127.0.0.1");
`;

async function stopFixtureProxy(stateDir: string): Promise<void> {
  const owner = await readFile(path.join(stateDir, "proxy-owner.json"), "utf8").then((text) => JSON.parse(text) as { pid: number; birthSignature?: string }, () => undefined);
  if (!owner || await proxyOwnerStatus(owner) !== "active") return;
  try { process.kill(owner.pid, "SIGTERM"); } catch { /* stopped */ }
  for (let attempt = 0; attempt < 40 && await proxyOwnerStatus(owner) === "active"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
}

it("never removes a declared output that has the shape of another output's staging file, but still removes a real leftover staging file", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const uuid = "00000000-0000-4000-8000-000000000000";
  const configWith = (paths: string[]) => validateDevFnConfig({ version: 1, project: { id: "staging-shape" }, ports: { web: { env: "PORT" } }, environmentOutputs: paths.map((item) => ({ path: item })),
    processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 10_000 } } },
    profiles: { default: { processes: ["web"] } } });
  const orchestrator = new DevFnOrchestrator();
  const started: Array<[DevFnConfig, string | undefined]> = [];
  const up = async (config: DevFnConfig, runtime?: string) => {
    started.push([config, runtime]);
    return await orchestrator.up({ config, root: primary, stateDir, ...(runtime ? { runtime } : {}) });
  };
  const read = async (name: string) => await readFile(path.join(primary, name), "utf8").catch(() => undefined);
  try {
    await writeFile(path.join(primary, "server.mjs"), SERVER);
    // A named runtime's pair and the v0.1 literal pair: a repeated up claims again before it is refused, and keeps the second output.
    for (const [paths, runtime, declared] of [[[".env.{runtime}", `..env.{runtime}.${uuid}.devfn-tmp`], "review", `..env.review.${uuid}.devfn-tmp`],
      [[".env", `..env.${uuid}.devfn-tmp`], undefined, `..env.${uuid}.devfn-tmp`]] as const) {
      const config = configWith([...paths]);
      await up(config, runtime);
      const content = await read(declared);
      expect(content).toContain("DEVFN_INSTANCE_ID=");
      await expect(up(config, runtime)).rejects.toMatchObject({ code: "DEVFN_ALREADY_RUNNING" });
      expect(await read(declared)).toBe(content);
    }
    // Runtime devfn-tmp's output is staging-shaped for runtime x's .env.x: x's start leaves it, while running and once stopped.
    const shared = configWith([".env.{runtime}", `..env.x.${uuid}.{runtime}`]);
    await up(shared, "devfn-tmp");
    const declared = await read(`..env.x.${uuid}.devfn-tmp`);
    expect(declared).toContain("DEVFN_INSTANCE_ID=");
    const leftover = "..env.x.11111111-1111-4111-8111-111111111111.devfn-tmp";
    await writeFile(path.join(primary, leftover), "PARTIAL=1\n");
    await up(shared, "x");
    expect(await read(`..env.x.${uuid}.devfn-tmp`)).toBe(declared);
    expect(await read(leftover)).toBeUndefined();
    await orchestrator.down({ config: shared, root: primary, stateDir, runtime: "devfn-tmp" });
    await orchestrator.down({ config: shared, root: primary, stateDir, runtime: "x" });
    await up(shared, "x");
    expect(await read(`..env.x.${uuid}.devfn-tmp`)).toBe(declared);
  } finally {
    for (const [config, runtime] of started) await orchestrator.down({ config, root: primary, stateDir, ...(runtime ? { runtime } : {}) }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("never removes a staging-shaped output that only a checkout receipt records, live or stopped, but still removes a real leftover staging file", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const uuid = "00000000-0000-4000-8000-000000000000";
  const configWith = (paths: string[]) => validateDevFnConfig({ version: 1, project: { id: "staging-receipt" }, ports: { web: { env: "PORT" } }, environmentOutputs: paths.map((item) => ({ path: item })),
    processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 10_000 } } },
    profiles: { default: { processes: ["web"] } } });
  const orchestrator = new DevFnOrchestrator();
  const legacy = configWith([".env", `..env.x.${uuid}.devfn-tmp`]);
  const named = configWith([".env.{runtime}"]);
  const declaredName = `..env.x.${uuid}.devfn-tmp`;
  const claims = path.join(primary, ".devfn", "receipts", "outputs");
  const read = async (name: string) => await readFile(path.join(primary, name), "utf8").catch(() => undefined);
  // An earlier release's receipt has no output claim: only the receipt records its outputs.
  const removeClaims = async (keep: readonly string[] = []) => {
    for (const name of await readdir(claims).catch(() => [] as string[])) if (name.endsWith(".json") && !keep.includes(name)) await rm(path.join(claims, name));
  };
  try {
    await writeFile(path.join(primary, "server.mjs"), SERVER);
    await orchestrator.up({ config: legacy, root: primary, stateDir });
    const declared = await read(declaredName);
    expect(declared).toContain("DEVFN_INSTANCE_ID=");
    await removeClaims();
    const leftover = "..env.x.11111111-1111-4111-8111-111111111111.devfn-tmp";
    await writeFile(path.join(primary, leftover), "PARTIAL=1\n");
    await orchestrator.up({ config: named, root: primary, stateDir, runtime: "x" });
    expect(await read(declaredName)).toBe(declared);
    expect(await read(leftover)).toBeUndefined();
    const xClaims = (await readdir(claims)).filter((name) => name.endsWith(".json"));
    await orchestrator.down({ config: named, root: primary, stateDir, runtime: "x" });
    await orchestrator.down({ config: legacy, root: primary, stateDir });
    // The default runtime's receipt is now stopped and, again, the only record of its outputs.
    await removeClaims(xClaims);
    await orchestrator.up({ config: named, root: primary, stateDir, runtime: "x" });
    expect(await read(declaredName)).toBe(declared);
  } finally {
    await orchestrator.down({ config: named, root: primary, stateDir, runtime: "x" }).catch(() => undefined);
    await orchestrator.down({ config: legacy, root: primary, stateDir }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

// Root writes through a read-only directory, so the failed release cannot be provoked there.
it("releases a stopped runtime's output claim on a retried down when the first release failed, keeping its history and other runtimes' claims", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const config = validateDevFnConfig({ version: 1, project: { id: "release-fixture" }, runtimeDir: "old-run", ports: { web: { env: "PORT" } }, environmentOutputs: [{ path: ".env.{runtime}" }],
    processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 10_000 } } },
    profiles: { default: { processes: ["web"] } } });
  const orchestrator = new DevFnOrchestrator();
  const claims = path.join(primary, ".devfn", "receipts", "outputs");
  const claimOf = async (instanceId: string) => JSON.parse(await readFile(path.join(claims, `${instanceId}.json`), "utf8")) as { targets: string[]; runtimeDirectory?: string; written: Array<{ target: string }> };
  try {
    await writeFile(path.join(primary, "server.mjs"), SERVER);
    // This process ran both starts, so it is their running claimant until it exits.
    const a = await orchestrator.up({ config, root: primary, stateDir, runtime: "a" });
    const c = await orchestrator.up({ config, root: primary, stateDir, runtime: "c" });
    const cClaim = await readFile(path.join(claims, `${c.instanceId}.json`), "utf8");
    // Runtime b, under another runtimeDir, would write its output in a's runtime directory.
    const b = await resolveInstanceIdentity("release-fixture", primary, "b");
    const sibling = validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), runtimeDir: "new-run", environmentOutputs: [{ path: path.join("old-run", "instances", a.instanceId, "b.env") }] });
    // The first down stops a but cannot write its claim: its receipt stays live (degraded) instead of saying stopped.
    releases.fail = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const failed = await orchestrator.down({ config, root: primary, stateDir, runtime: "a" });
    expect(failed.state).toBe("degraded");
    expect(failed.cleanup?.errors.join(" ")).toMatch(/not released.*run devfn down again/);
    expect((await claimOf(a.instanceId)).targets).toHaveLength(1);
    await expect(assertEnvironmentOutputsAvailable(sibling, primary, b)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("the runtime directory of runtime a") });
    // The retried down releases it; the files a wrote stay recorded as its own, and c's claim is untouched.
    expect((await orchestrator.down({ config, root: primary, stateDir, runtime: "a" })).state).toBe("stopped");
    const released = await claimOf(a.instanceId);
    expect(released.targets).toEqual([]);
    expect(released.runtimeDirectory).toBeUndefined();
    expect(released.written.map((item) => path.basename(item.target))).toEqual([".env.a"]);
    expect(await readFile(path.join(claims, `${c.instanceId}.json`), "utf8")).toBe(cClaim);
    await expect(orchestrator.down({ config, root: primary, stateDir, runtime: "a" })).rejects.toMatchObject({ code: "DEVFN_NOT_RUNNING" });
    // The sibling now takes the released location, while c still holds its own.
    await expect(assertEnvironmentOutputsAvailable(sibling, primary, b)).resolves.toBeUndefined();
    await (await claimEnvironmentOutputs(sibling, primary, b)).commit();
    await expect(assertEnvironmentOutputsAvailable(validateDevFnConfig({ ...JSON.parse(JSON.stringify(sibling)), environmentOutputs: [{ path: path.join("old-run", "instances", c.instanceId, "b.env") }] }), primary, b))
      .rejects.toMatchObject({ message: expect.stringContaining("the runtime directory of runtime c") });
  } finally {
    releases.fail = undefined;
    for (const runtime of ["a", "c"]) await orchestrator.down({ config, root: primary, stateDir, runtime }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("writes nothing into a stopped runtime's runtime directory once down released it, so a sibling can then write there", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const config = validateDevFnConfig({ version: 1, project: { id: "release-order" }, runtimeDir: "old-run", ports: { web: { env: "PORT" } }, environmentOutputs: [{ path: ".env.{runtime}" }],
    processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 10_000 } } },
    profiles: { default: { processes: ["web"] } } });
  const orchestrator = new DevFnOrchestrator();
  const snapshot = async (directory: string): Promise<Record<string, string>> => {
    const files: Record<string, string> = {};
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[path.relative(directory, path.join(entry.parentPath, entry.name))] = await readFile(path.join(entry.parentPath, entry.name), "utf8");
    }
    return files;
  };
  try {
    await writeFile(path.join(primary, "server.mjs"), SERVER);
    const a = await orchestrator.up({ config, root: primary, stateDir, runtime: "a" });
    const runtimeDir = path.join(primary, "old-run", "instances", a.instanceId);
    let atRelease: Record<string, string> | undefined;
    releases.after = async () => { atRelease = await snapshot(runtimeDir); };
    const stopped = await orchestrator.down({ config, root: primary, stateDir, runtime: "a" });
    expect(stopped.state).toBe("stopped");
    // Its receipt copy already said stopped when the claim was released, and nothing there changed afterwards.
    expect(JSON.parse(atRelease!["receipt.json"]!)).toMatchObject({ instanceId: a.instanceId, state: "stopped" });
    expect(await snapshot(runtimeDir)).toEqual(atRelease);
    // The default runtime, under another runtimeDir, may now write where a kept its receipt copy, and a stays stopped.
    const copy = path.join("old-run", "instances", a.instanceId, "receipt.json");
    const sibling = validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), runtimeDir: "new-run", environmentOutputs: [{ path: copy }] });
    const claim = await claimEnvironmentOutputs(sibling, primary, await resolveInstanceIdentity("release-order", primary));
    await claim.write(path.join(primary, copy), "SIBLING=1\n", 0o600);
    await claim.commit();
    expect((await orchestrator.status({ config, root: primary, runtime: "a" })).state).toBe("stopped");
    await expect(orchestrator.down({ config, root: primary, stateDir, runtime: "a" })).rejects.toMatchObject({ code: "DEVFN_NOT_RUNNING" });
    expect(await readFile(path.join(primary, copy), "utf8")).toBe("SIBLING=1\n");
  } finally {
    releases.after = undefined;
    await orchestrator.down({ config, root: primary, stateDir, runtime: "a" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("writes a stopped prior's receipt copy before its stable receipt, so a sibling that then takes its old runtime directory keeps its file", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const raw = { version: 1, project: { id: "stop-existing-order" }, runtimeDir: "old-run", ports: { web: { env: "PORT" } }, environmentOutputs: [{ path: ".env.{runtime}" }],
    processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 10_000 } } },
    profiles: { default: { processes: ["web"] } } };
  const config = validateDevFnConfig(raw);
  const moved = validateDevFnConfig({ ...JSON.parse(JSON.stringify(raw)), runtimeDir: "new-run" });
  const orchestrator = new DevFnOrchestrator();
  try {
    await writeFile(path.join(primary, "server.mjs"), SERVER);
    const a = await orchestrator.up({ config, root: primary, stateDir, runtime: "a" });
    const copy = path.join("old-run", "instances", a.instanceId, "receipt.json");
    // A down of a was interrupted; the next start of a, under another runtimeDir, completes that stop.
    await new FilePortRegistry(path.join(stateDir, "registry.json")).updateInvocation(a.invocationId, { state: "stopping" });
    let observed: { copyAfterStable: boolean; copyState: string } | undefined;
    stops.onStopped = async (copyAfterStable) => {
      observed = { copyAfterStable, copyState: (JSON.parse(await readFile(path.join(primary, copy), "utf8")) as { state: string }).state };
      // Nothing holds a's old runtime directory once its stable receipt says stopped: the default runtime takes its receipt copy's name.
      const sibling = validateDevFnConfig({ ...JSON.parse(JSON.stringify(raw)), runtimeDir: "third-run", environmentOutputs: [{ path: copy }] });
      const claim = await claimEnvironmentOutputs(sibling, primary, await resolveInstanceIdentity("stop-existing-order", primary));
      await claim.write(path.join(primary, copy), "SIBLING=1\n", 0o600);
      await claim.commit();
    };
    const restarted = await orchestrator.up({ config: moved, root: primary, stateDir, runtime: "a" });
    expect(restarted.state).toBe("ready");
    expect(observed).toEqual({ copyAfterStable: false, copyState: "stopped" });
    expect(await readFile(path.join(primary, copy), "utf8")).toBe("SIBLING=1\n");
  } finally {
    stops.onStopped = undefined;
    await orchestrator.down({ config: moved, root: primary, stateDir, runtime: "a" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("gives back a stopped prior invocation's outputs and runtime directory when the start that stopped it fails", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const raw = { version: 1, project: { id: "restore-fixture" }, runtimeDir: "old-run", ports: { web: { env: "PORT" } }, environmentOutputs: [{ path: ".env.{runtime}" }],
    processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 10_000 } } },
    profiles: { default: { processes: ["web"] } } };
  const config = validateDevFnConfig(raw);
  const orchestrator = new DevFnOrchestrator();
  const claims = path.join(primary, ".devfn", "receipts", "outputs");
  const claimOf = async (instanceId: string) => JSON.parse(await readFile(path.join(claims, `${instanceId}.json`), "utf8")) as { targets: string[]; runtimeDirectory?: string; written: Array<{ target: string }> };
  const blocker = net.createServer();
  try {
    await writeFile(path.join(primary, "server.mjs"), SERVER);
    const a = await orchestrator.up({ config, root: primary, stateDir, runtime: "a" });
    const c = await orchestrator.up({ config, root: primary, stateDir, runtime: "c" });
    const cClaim = await readFile(path.join(claims, `${c.instanceId}.json`), "utf8");
    const b = await resolveInstanceIdentity("restore-fixture", primary, "b");
    const sibling = validateDevFnConfig({ ...JSON.parse(JSON.stringify(raw)), runtimeDir: "new-run", environmentOutputs: [{ path: path.join("old-run", "instances", a.instanceId, "b.env") }] });
    await expect(assertEnvironmentOutputsAvailable(sibling, primary, b)).rejects.toMatchObject({ message: expect.stringContaining("the runtime directory of runtime a") });
    // A down of a was interrupted, and the next start of a, which completes that stop, fails on an occupied exact port before its receipt.
    await new FilePortRegistry(path.join(stateDir, "registry.json")).updateInvocation(a.invocationId, { state: "stopping" });
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const busy = (blocker.address() as net.AddressInfo).port;
    const failing = validateDevFnConfig({ ...JSON.parse(JSON.stringify(raw)), ports: { web: { env: "PORT", preferred: busy, exact: true } } });
    await expect(orchestrator.up({ config: failing, root: primary, stateDir, runtime: "a" })).rejects.toMatchObject({ code: "DEVFN_PORT_CONFLICT" });
    // a is stopped, so its claim holds nothing; the files it wrote stay its own, and c's claim is untouched.
    expect((await orchestrator.status({ config, root: primary, runtime: "a" })).state).toBe("stopped");
    const restored = await claimOf(a.instanceId);
    expect(restored.targets).toEqual([]);
    expect(restored.runtimeDirectory).toBeUndefined();
    expect(restored.written.map((item) => path.basename(item.target))).toEqual([".env.a"]);
    expect(await readFile(path.join(claims, `${c.instanceId}.json`), "utf8")).toBe(cClaim);
    await expect(assertEnvironmentOutputsAvailable(sibling, primary, b)).resolves.toBeUndefined();
  } finally {
    blocker.close();
    for (const runtime of ["a", "c"]) await orchestrator.down({ config, root: primary, stateDir, runtime }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("reruns an artifacts task whose runtime directory a symlink now redirects, and keeps its completion while the destination is unchanged", async () => {
  // Not resolved: on macOS the temporary directory is itself reached through a symlink.
  const root = await mkdtemp(path.join(os.tmpdir(), "devfn-artifact-destination-"));
  const stateDir = path.join(root, ".state");
  const build = `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
appendFileSync("runs.log", process.env.DEVFN_ARTIFACT_DIR + "\\n");
mkdirSync(process.env.DEVFN_ARTIFACT_DIR, { recursive: true });
writeFileSync(process.env.DEVFN_ARTIFACT_DIR + "/out", "built");
`;
  const configOf = (rerun: "on-change" | "once") => validateDevFnConfig({ version: 1, project: { id: "artifact-destination" }, runtimeDir: "run",
    processes: { build: { adapter: "command", command: [process.execPath, "build.mjs"], artifacts: "runtime", task: { rerun } } },
    profiles: { default: { processes: ["build"] } } });
  const orchestrator = new DevFnOrchestrator();
  const runs = async () => (await readFile(path.join(root, "runs.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const cycle = async (config: DevFnConfig, rerunTasks?: string[]) => {
    await orchestrator.up({ config, root, stateDir, ...(rerunTasks ? { rerunTasks } : {}) });
    await orchestrator.down({ config, root, stateDir });
  };
  try {
    await writeFile(path.join(root, "build.mjs"), build);
    await mkdir(path.join(root, "first"));
    await mkdir(path.join(root, "second"));
    await symlink("first", path.join(root, "run"));
    const onChange = configOf("on-change");
    const node = { name: "build", kind: "process" as const };
    // The first start creates the runtime directory; the second sees the same destination and keeps the completion.
    await cycle(onChange);
    await cycle(onChange);
    expect(await runs()).toBe(1);
    const toFirst = await taskInputRevision(onChange, root, node, "default");
    expect(toFirst).toBe(await taskInputRevision(onChange, await realpath(root), node, "default"));
    await rm(path.join(root, "run"));
    await symlink("second", path.join(root, "run"));
    expect(await taskInputRevision(onChange, root, node, "default")).not.toBe(toFirst);
    // The redirected destination has none of its artifacts: an on-change task runs again there.
    await cycle(onChange);
    expect(await runs()).toBe(2);
    await rm(path.join(root, "run"));
    await symlink("first", path.join(root, "run"));
    // A once task blocks instead, until it is rerun explicitly.
    const once = configOf("once");
    await expect(orchestrator.up({ config: once, root, stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
    expect(await runs()).toBe(2);
    await cycle(once, ["build"]);
    expect(await runs()).toBe(3);
    await cycle(once);
    expect(await runs()).toBe(3);
  } finally {
    await orchestrator.down({ config: configOf("once"), root, stateDir }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("reruns an artifacts task whose instance or artifact directory a symlink below runtimeDir now redirects, and keeps its completion while it is unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devfn-artifact-instance-"));
  const stateDir = path.join(root, ".state");
  const configOf = (rerun: "on-change" | "once") => validateDevFnConfig({ version: 1, project: { id: "artifact-instance" }, runtimeDir: "run",
    processes: { build: { adapter: "command", command: [process.execPath, "-e", "require('node:fs').appendFileSync('runs.log', 'run\\n')"], artifacts: "runtime", task: { rerun } } },
    profiles: { default: { processes: ["build"] } } });
  const orchestrator = new DevFnOrchestrator();
  const runs = async () => (await readFile(path.join(root, "runs.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const cycle = async (config: DevFnConfig, rerunTasks?: string[]) => {
    const started = await orchestrator.up({ config, root, stateDir, ...(rerunTasks ? { rerunTasks } : {}) });
    await orchestrator.down({ config, root, stateDir });
    return started.instanceId;
  };
  const redirect = async (relative: string, to: string) => {
    await mkdir(path.join(root, to), { recursive: true });
    await rm(path.join(root, relative), { recursive: true, force: true });
    await symlink(path.join(root, to), path.join(root, relative));
  };
  const onChange = configOf("on-change");
  const node = { name: "build", kind: "process" as const };
  try {
    // The first start creates the instance's artifact directory; an unchanged destination keeps the completion.
    const instanceId = await cycle(onChange);
    await cycle(onChange);
    expect(await runs()).toBe(1);
    const created = await taskInputRevision(onChange, root, node, "default", undefined, undefined, stateDir, instanceId);
    expect(created).toBe(await taskInputRevision(onChange, await realpath(root), node, "default", undefined, undefined, stateDir, instanceId));
    // run/instances now reaches an empty directory: an on-change task runs again.
    await redirect(path.join("run", "instances"), "elsewhere");
    expect(await taskInputRevision(onChange, root, node, "default", undefined, undefined, stateDir, instanceId)).not.toBe(created);
    await cycle(onChange);
    await cycle(onChange);
    expect(await runs()).toBe(2);
    // So does a link at the instance's own directory, and at its artifact directory.
    await redirect(path.join("run", "instances", instanceId), "third");
    await cycle(onChange);
    expect(await runs()).toBe(3);
    // (A link out of the runtime directory is refused at the start; one inside it is followed.)
    await redirect(path.join("run", "instances", instanceId, "artifacts", "build"), path.join("third", "moved"));
    await cycle(onChange);
    expect(await runs()).toBe(4);
    // A once task blocks instead, until it is rerun explicitly.
    await redirect(path.join("run", "instances", instanceId), "fifth");
    const once = configOf("once");
    await expect(orchestrator.up({ config: once, root, stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
    expect(await runs()).toBe(4);
    await cycle(once, ["build"]);
    await cycle(once);
    expect(await runs()).toBe(5);
  } finally {
    await orchestrator.down({ config: configOf("once"), root, stateDir }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(process.env.DEVFN_REAL_PROXY !== "1")("routes two named runtimes of one checkout through the real proxy and removes only the stopped one's routes", async () => await withFileLock(
  path.join(os.tmpdir(), "devfn-test-caddy-admin.lock"), async () => {
    const { parent, primary } = await repository();
    const stateDir = path.join(parent, "state");
    const config = validateDevFnConfig({ version: 1, project: { id: "routes-fixture" }, ports: { web: { env: "PORT" } },
      processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 10_000 } } },
      profiles: { default: { processes: ["web"], proxy: true } }, hostnames: { web: { target: "web" } } });
    const orchestrator = new DevFnOrchestrator();
    const routes = async () => (JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8")) as { routes: Array<{ instanceId: string; hostname: string }> }).routes;
    const viaProxy = async (hostname: string) => await new Promise<string>((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: proxyListenerPorts().httpPort, path: "/", headers: { host: hostname } }, (response) => {
        let body = "";
        response.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; }).on("end", () => resolve(body));
      });
      request.once("error", reject);
    });
    try {
      await writeFile(path.join(primary, "server.mjs"), SERVER);
      const [one, two] = await Promise.all(["one", "two"].map(async (runtime) => await orchestrator.up({ config, root: primary, stateDir, runtime })));
      expect(one.routes[0].hostname).not.toBe(two.routes[0].hostname);
      expect(await viaProxy(one.routes[0].hostname)).toBe(one.instanceId);
      expect(await viaProxy(two.routes[0].hostname)).toBe(two.instanceId);
      await orchestrator.down({ config, root: primary, stateDir, runtime: "one" });
      expect((await routes()).map((route) => route.instanceId)).toEqual([two.instanceId]);
      expect(await viaProxy(two.routes[0].hostname)).toBe(two.instanceId);
      expect(await orchestrator.status({ config, root: primary, runtime: "two" })).toMatchObject({ ok: true, state: "ready" });
    } finally {
      for (const runtime of ["one", "two"]) await orchestrator.down({ config, root: primary, stateDir, runtime }).catch(() => undefined);
      await stopFixtureProxy(stateDir);
      await rm(parent, { recursive: true, force: true });
    }
  }, { timeoutMs: 120_000 }), 150_000);

it.skipIf(process.env.DEVFN_REAL_COMPOSE !== "1")("runs one Compose service per named runtime in separate Compose projects and stops only the selected one", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const config: DevFnConfig = validateDevFnConfig({ version: 1, project: { id: "compose-runtimes" },
    services: { api: { adapter: "compose", service: "api", health: { type: "command", command: ["sh", "-c", "exit 0"], timeoutMs: 5000 } } },
    profiles: { default: { services: ["api"] } } });
  const orchestrator = new DevFnOrchestrator();
  const running = async (id: string) => await execFileAsync("docker", ["inspect", "--format", "{{.State.Running}}", id]).then(({ stdout }) => stdout.trim(), () => "absent");
  const projects: string[] = [];
  try {
    await writeFile(path.join(primary, "compose.yaml"), "services:\n  api:\n    image: busybox\n    command: [sleep, '3600']\n");
    const [one, two] = await Promise.all(["one", "two"].map(async (runtime) => await orchestrator.up({ config, root: primary, stateDir, runtime })));
    projects.push(one.services[0].projectName, two.services[0].projectName);
    expect(one.services[0].projectName).not.toBe(two.services[0].projectName);
    expect(await running(one.services[0].containerIds[0])).toBe("true");
    expect(await running(two.services[0].containerIds[0])).toBe("true");
    await orchestrator.down({ config, root: primary, stateDir, runtime: "one" });
    expect(await running(one.services[0].containerIds[0])).not.toBe("true");
    expect(await running(two.services[0].containerIds[0])).toBe("true");
    expect(await orchestrator.status({ config, root: primary, runtime: "two" })).toMatchObject({ ok: true, state: "ready" });
  } finally {
    for (const runtime of ["one", "two"]) await orchestrator.down({ config, root: primary, stateDir, runtime }).catch(() => undefined);
    for (const project of projects) await execFileAsync("docker", ["network", "rm", `${project}_default`]).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 180_000);

it.skipIf(process.env.DEVFN_REAL_COMPOSE !== "1")("never lets a Compose task write its log through a link to another runtime's logs, on its first attempt or a retry", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const config: DevFnConfig = validateDevFnConfig({ version: 1, project: { id: "compose-task-logs" },
    services: { seed: { adapter: "compose", service: "seed", task: { idempotent: true, retries: 1 } } }, profiles: { default: { services: ["seed"] } } });
  const orchestrator = new DevFnOrchestrator();
  const instance = async (runtime: string) => runtimeDirectory(config, primary, (await resolveInstanceIdentity("compose-task-logs", primary, runtime)).instanceId);
  try {
    // An attempt sources plant.sh when it exists, which can fail it after linking its own logs elsewhere.
    await writeFile(path.join(primary, "compose.yaml"), "services:\n  seed:\n    image: busybox\n    volumes: ['./:/m']\n    command: [sh, -c, 'if [ -f /m/plant.sh ]; then . /m/plant.sh; fi; echo seeded']\n");
    const a = await orchestrator.up({ config, root: primary, stateDir, runtime: "a" });
    const aLog = path.join(a.runtimeDir, "logs", "seed.log");
    await writeFile(aLog, "runtime a's log\n");
    // Runtime b's logs directory is a link to a's before it starts.
    await mkdir(await instance("b"), { recursive: true, mode: 0o700 });
    await symlink(path.join(a.runtimeDir, "logs"), path.join(await instance("b"), "logs"));
    await expect(orchestrator.up({ config, root: primary, stateDir, runtime: "b" })).rejects.toMatchObject({ details: { causeCode: "DEVFN_RUNTIME_INVALID" } });
    expect(await readFile(aLog, "utf8")).toBe("runtime a's log\n");
    // Runtime c's first attempt links its logs to a's and fails; the retry is refused before it writes.
    const cLogs = path.relative(primary, path.join(await instance("c"), "logs"));
    await writeFile(path.join(primary, "plant.sh"), `rm /m/plant.sh; rm -rf '/m/${cLogs}'; ln -s '${path.join(a.runtimeDir, "logs")}' '/m/${cLogs}'; exit 7\n`);
    await expect(orchestrator.up({ config, root: primary, stateDir, runtime: "c" })).rejects.toMatchObject({ details: { causeCode: "DEVFN_RUNTIME_INVALID" } });
    expect(await readFile(aLog, "utf8")).toBe("runtime a's log\n");
  } finally {
    for (const runtime of ["a", "b", "c"]) {
      await orchestrator.down({ config, root: primary, stateDir, runtime }).catch(() => undefined);
      const { instanceId } = await resolveInstanceIdentity("compose-task-logs", primary, runtime);
      await execFileAsync("docker", ["network", "rm", `${composeProjectName("devfn", instanceId)}_default`]).catch(() => undefined);
    }
    await rm(parent, { recursive: true, force: true });
  }
}, 180_000);

it.skipIf(process.env.DEVFN_REAL_COMPOSE !== "1")("never rewrites another runtime's Compose override through a link inside its own runtime directory, for a service or a task", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const config: DevFnConfig = validateDevFnConfig({ version: 1, project: { id: "compose-overrides" },
    services: { api: { adapter: "compose", service: "api", health: { type: "command", command: ["sh", "-c", "exit 0"], timeoutMs: 5000 } }, seed: { adapter: "compose", service: "seed", task: {} } },
    profiles: { default: { services: ["api", "seed"] } } });
  const orchestrator = new DevFnOrchestrator();
  try {
    await writeFile(path.join(primary, "compose.yaml"), "services:\n  api:\n    image: busybox\n    command: [sleep, '3600']\n  seed:\n    image: busybox\n    command: [sh, -c, 'echo seeded']\n");
    const a = await orchestrator.up({ config, root: primary, stateDir, runtime: "a" });
    const b = await resolveInstanceIdentity("compose-overrides", primary, "b");
    const bDir = runtimeDirectory(config, primary, b.instanceId);
    await mkdir(path.join(bDir, "compose"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(bDir, "kept"), { recursive: true, mode: 0o700 });
    const before: Record<string, string> = {};
    for (const name of ["api", "seed"]) {
      // b's override is a link to a file of b's own directory, which is a hard link to a's override.
      const aOverride = path.join(a.runtimeDir, "compose", `${name}.override.yaml`);
      before[name] = await readFile(aOverride, "utf8");
      await link(aOverride, path.join(bDir, "kept", `${name}.yaml`));
      await symlink(path.join("..", "kept", `${name}.yaml`), path.join(bDir, "compose", `${name}.override.yaml`));
    }
    expect((await orchestrator.up({ config, root: primary, stateDir, runtime: "b" })).state).toBe("ready");
    for (const name of ["api", "seed"]) {
      expect(await readFile(path.join(a.runtimeDir, "compose", `${name}.override.yaml`), "utf8")).toBe(before[name]);
      expect(await readFile(path.join(bDir, "compose", `${name}.override.yaml`), "utf8")).toContain(b.instanceId);
    }
  } finally {
    for (const runtime of ["a", "b"]) {
      await orchestrator.down({ config, root: primary, stateDir, runtime }).catch(() => undefined);
      const { instanceId } = await resolveInstanceIdentity("compose-overrides", primary, runtime);
      await execFileAsync("docker", ["network", "rm", `${composeProjectName("devfn", instanceId)}_default`]).catch(() => undefined);
    }
    await rm(parent, { recursive: true, force: true });
  }
}, 180_000);

it("keeps a task's completion while a sibling runtime stops under an earlier runtimeDir or environment outputs its receipt records, and reruns it for a real input change", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const log = path.join(parent, "runs.log");
  const configOf = (runtimeDir: string, output: string) => validateDevFnConfig({ version: 1, project: { id: "sibling-task" }, runtimeDir, environmentOutputs: [{ path: output }],
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n")`], task: { rerun: "on-change", inputs: ["."] } } },
    profiles: { default: { processes: ["seed"], environment: { APP: "1" } } } });
  const orchestrator = new DevFnOrchestrator();
  const runs = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const current = configOf("new-run", ".out.{runtime}");
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const cycle = async (config: DevFnConfig, runtime: string) => {
      await orchestrator.up({ config, root: primary, stateDir, runtime });
      await orchestrator.down({ config, root: primary, stateDir, runtime });
    };
    await cycle(current, "d");
    // Siblings start under an earlier runtimeDir (a), output (c) or both (b): d's on-change task keeps its completion while each runs, after it stops and when it starts again.
    for (const [runtime, earlier] of [["a", configOf("old-run", ".out.{runtime}")], ["b", configOf("old-run", ".env.{runtime}")], ["c", configOf("new-run", ".env.{runtime}")]] as const) {
      await orchestrator.up({ config: earlier, root: primary, stateDir, runtime });
      await cycle(current, "d");
      await orchestrator.down({ config: current, root: primary, stateDir, runtime });
      await cycle(current, "d");
      await cycle(earlier, runtime);
      await cycle(current, "d");
    }
    expect(await readdir(primary)).toEqual(expect.arrayContaining([".env.b", ".env.c", ".out.a"]));
    // Each sibling's task ran once in its own instance, d's once.
    expect(await runs()).toBe(4);
    // A real input change still reruns it.
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    await cycle(current, "d");
    expect(await runs()).toBe(5);
  } finally {
    for (const runtime of ["a", "b", "c", "d"]) await orchestrator.down({ config: current, root: primary, stateDir, runtime }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 240_000);

it("keeps a once task's completion when its own runtime moves to another runtimeDir, also from an earlier release's claimless receipt, and still refuses a real input change before stopping anything", async () => {
  for (const [runtime, claimless] of [[undefined, false], ["r", false], [undefined, true]] as const) {
    const { parent, primary } = await repository();
    const stateDir = path.join(parent, "state");
    const log = path.join(parent, "runs.log");
    const configOf = (runtimeDir: string, wait: number) => validateDevFnConfig({ version: 1, project: { id: "relocate-task" }, runtimeDir,
      processes: {
        seed: { adapter: "command", command: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n")`], task: { rerun: "once", inputs: ["."] } },
        web: { adapter: "command", command: [process.execPath, "-e", `setTimeout(() => {}, ${wait})`], dependsOn: ["seed"] } },
      profiles: { default: { processes: ["seed", "web"] } } });
    const orchestrator = new DevFnOrchestrator();
    const runs = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    const options = (config: DevFnConfig) => ({ config, root: primary, stateDir, ...(runtime ? { runtime } : {}) });
    const web = async (config: DevFnConfig) => (await orchestrator.status(options(config))).processes.find((item) => item.name === "web")?.state;
    try {
      await writeFile(path.join(primary, "schema.sql"), "create table t();");
      await orchestrator.up(options(configOf("old-run", 60_000)));
      // An earlier release's receipt has no output claim.
      if (claimless) for (const name of await readdir(path.join(primary, ".devfn", "receipts", "outputs"))) if (name.endsWith(".json")) await rm(path.join(primary, ".devfn", "receipts", "outputs", name));
      // A ready lifecycle replaced under a new runtimeDir (and a changed web command) keeps the completion and runs web.
      await orchestrator.up(options(configOf("new-run", 60_001)));
      expect(await web(configOf("new-run", 60_001))).toBe("running");
      expect(await runs()).toBe(1);
      // So does a later start after down, reading the moved runtime's earlier directory as its own state.
      await orchestrator.down(options(configOf("new-run", 60_001)));
      await orchestrator.up(options(configOf("new-run", 60_002)));
      expect(await runs()).toBe(1);
      // A real input change is still refused, before the ready lifecycle is stopped.
      await writeFile(path.join(primary, "schema.sql"), "create table u();");
      await expect(orchestrator.up(options(configOf("new-run", 60_003)))).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
      expect(await web(configOf("new-run", 60_002))).toBe("running");
      expect(await runs()).toBe(1);
    } finally {
      for (const runtimeDir of ["old-run", "new-run"]) await orchestrator.down(options(configOf(runtimeDir, 60_000))).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  }
}, 240_000);

it("keeps a task's input revision when a sibling runtime publishes its claim and files after the revision read the claims, before its walk", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const configOf = (runtimeDir: string, output: string, processes: string[]) => validateDevFnConfig({ version: 1, project: { id: "sibling-window" }, runtimeDir, environmentOutputs: [{ path: output }],
    processes: {
      seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } },
      web: { adapter: "command", command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"] } },
    profiles: { default: { processes } } });
  const orchestrator = new DevFnOrchestrator();
  const current = configOf("new-run", ".out.{runtime}", ["seed"]);
  const sibling = configOf("old-run", ".env.{runtime}", ["web"]);
  const revision = async () => await taskInputRevision(current, primary, { name: "seed", kind: "process" }, "default", undefined, undefined, stateDir);
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const before = await revision();
    // Sibling b starts under an earlier runtimeDir and another output between the claims read and the walk.
    claimReads.root = primary;
    claimReads.after = async () => { await orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "b" }); };
    const during = await revision();
    expect(claimReads.after).toBeUndefined();
    expect(await readdir(primary)).toEqual(expect.arrayContaining([".env.b", "old-run"]));
    expect(during).toBe(before);
    expect(await revision()).toBe(before);
    // A real input change still changes it.
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    expect(await revision()).not.toBe(before);
  } finally {
    claimReads.after = undefined; claimReads.root = undefined;
    await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "b" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("keeps a task's input revision when a sibling's file, attributed only by a claim published after the first claims read, vanishes mid-walk, and names an unattributed source file that vanishes", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const configOf = (runtimeDir: string, output: string, processes: string[]) => validateDevFnConfig({ version: 1, project: { id: "sibling-vanish" }, runtimeDir, environmentOutputs: [{ path: output }],
    processes: {
      seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } },
      web: { adapter: "command", command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"] } },
    profiles: { default: { processes } } });
  const orchestrator = new DevFnOrchestrator();
  const current = configOf("new-run", ".out.{runtime}", ["seed"]);
  const sibling = (operation: string) => configOf(`old-${operation}`, ".env.{runtime}", ["web"]);
  const revision = async () => await taskInputRevision(current, primary, { name: "seed", kind: "process" }, "default", undefined, undefined, stateDir);
  // Runs once, right before the walk's `operation` on `file`.
  const once = (operation: "lstat" | "readFile", file: () => string | undefined, action: (file: string) => Promise<void>) => {
    reads.before = async (called, target) => { const wanted = file(); if (called === operation && wanted !== undefined && target === wanted) { reads.before = undefined; await action(target); } };
  };
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const before = await revision();
    for (const operation of ["lstat", "readFile"] as const) {
      let temp: string | undefined;
      // Sibling b starts under an earlier runtimeDir after the first claims read; its next atomic receipt write's temporary file is enumerated, then renamed onto receipt.json before the walk reads it.
      claimReads.root = primary;
      claimReads.after = async () => {
        await orchestrator.up({ config: sibling(operation), root: primary, stateDir, runtime: "b" });
        const instances = path.join(primary, `old-${operation}`, "instances");
        const [id] = await readdir(instances);
        const file = path.join(await realpath(path.join(instances, id!)), "receipt.json.tmp");
        await writeFile(file, await readFile(path.join(instances, id!, "receipt.json")));
        temp = file;
        once(operation, () => temp, async (from) => { temp = undefined; await rename(from, path.join(path.dirname(from), "receipt.json")); });
      };
      expect(await revision()).toBe(before);
      expect(claimReads.after).toBeUndefined();
      expect(temp).toBeUndefined();
      expect(await revision()).toBe(before);
      await orchestrator.down({ config: sibling(operation), root: primary, stateDir, runtime: "b" });
    }
    // An unattributed source file that vanishes mid-walk is a real input change: it is named, not taken for a missing input root.
    for (const operation of ["lstat", "readFile"] as const) {
      await writeFile(path.join(primary, "notes.txt"), "draft");
      once(operation, () => path.join(primary, "notes.txt"), async (file) => { await rm(file); });
      await expect(revision()).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: "processes.seed.task.inputs[0] entry notes.txt vanished while DevFn read it." });
      expect(reads.before).toBeUndefined();
    }
    expect(await revision()).toBe(before);
    // A real input change still changes it.
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    expect(await revision()).not.toBe(before);
  } finally {
    claimReads.after = undefined; claimReads.root = undefined; reads.before = undefined;
    for (const operation of ["lstat", "readFile"]) await orchestrator.down({ config: sibling(operation), root: primary, stateDir, runtime: "b" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("keeps once and on-change tasks' input revisions while a sibling's start creates its runtime directory, and while its refused start removes it under a walk", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const configOf = (runtimeDir: string, output: string) => validateDevFnConfig({ version: 1, project: { id: "sibling-directories" }, runtimeDir, environmentOutputs: [{ path: output }],
    processes: {
      seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } },
      init: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "once", inputs: ["."] } } },
    profiles: { default: { processes: ["seed", "init"] } } });
  const current = configOf("new-run", ".out.{runtime}");
  const revisions = async () => {
    const result: string[] = [];
    for (const name of ["seed", "init"]) result.push(await taskInputRevision(current, primary, { name, kind: "process" }, "default", undefined, undefined, stateDir));
    return result;
  };
  const b = await resolveInstanceIdentity("sibling-directories", primary, "b");
  const created = path.join(primary, "old-run", "instances", b.instanceId);
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const before = await revisions();
    // Sibling b's start creates its runtime directory, and the parents it lacks, under an earlier runtimeDir; both revisions are read right then, before it binds that directory.
    let during: string[] | undefined;
    made.after = async (directory) => { if (directory === created) { made.after = undefined; during = await revisions(); } };
    const started = await claimEnvironmentOutputs(configOf("old-run", ".env.{runtime}"), primary, b, stateDir);
    expect(made.after).toBeUndefined();
    expect(during).toEqual(before);
    expect(await revisions()).toEqual(before);
    // Its start is refused and removes what it created after a walk listed old-run, before the walk visits old-run/instances: nothing vanished is named and the revision is unchanged.
    reads.before = async (operation, target) => { if (operation === "lstat" && target === path.join(primary, "old-run", "instances")) { reads.before = undefined; await started.restore(); } };
    expect(await revisions()).toEqual(before);
    expect(reads.before).toBeUndefined();
    await expect(access(path.join(primary, "old-run"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(primary, ".devfn", "receipts", "outputs", `${b.instanceId}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    // A real input change still changes both.
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    const after = await revisions();
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  } finally {
    made.after = undefined; reads.before = undefined;
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("gives an input directory the same marker with or without a sibling's output in it, so an on-change task does not rerun for the sibling", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const log = path.join(parent, "runs.log");
  const configOf = (output: string) => validateDevFnConfig({ version: 1, project: { id: "marker-task" }, runtimeDir: "new-run", environmentOutputs: [{ path: output }],
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n")`], task: { rerun: "on-change", inputs: ["."] } } },
    profiles: { default: { processes: ["seed"] } } });
  const orchestrator = new DevFnOrchestrator();
  const runs = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const current = configOf(".out.{runtime}");
  const sibling = configOf("config/.env.{runtime}");
  const revision = async () => await taskInputRevision(current, primary, { name: "seed", kind: "process" }, "default", undefined, undefined, stateDir);
  const cycle = async () => { await orchestrator.up({ config: current, root: primary, stateDir, runtime: "d" }); await orchestrator.down({ config: current, root: primary, stateDir, runtime: "d" }); };
  try {
    await mkdir(path.join(primary, "config"));
    await writeFile(path.join(primary, "config", "app.yml"), "a: 1\n");
    await cycle();
    const before = await revision();
    expect(await runs()).toBe(1);
    // Sibling c writes its output into config/, beside the repository's own file.
    await orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "c" });
    expect(await readdir(path.join(primary, "config"))).toEqual(expect.arrayContaining([".env.c", "app.yml"]));
    expect(await revision()).toBe(before);
    await cycle();
    expect(await runs()).toBe(2);
    await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "c" });
    expect(await revision()).toBe(before);
    await cycle();
    expect(await runs()).toBe(2);
    // A real change in that directory still reruns it.
    await writeFile(path.join(primary, "config", "app.yml"), "a: 2\n");
    expect(await revision()).not.toBe(before);
    await cycle();
    expect(await runs()).toBe(3);
  } finally {
    for (const runtime of ["c", "d"]) await orchestrator.down({ config: runtime === "c" ? sibling : current, root: primary, stateDir, runtime }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 240_000);

it("never removes a staging-shaped output that only a replaced claimless receipt recorded, now kept in its claim's history", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const declaredName = "..env.x.00000000-0000-4000-8000-000000000000.devfn-tmp";
  const configWith = (paths: string[]) => validateDevFnConfig({ version: 1, project: { id: "staging-history" }, ports: { web: { env: "PORT" } }, environmentOutputs: paths.map((item) => ({ path: item })),
    processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 10_000 } } },
    profiles: { default: { processes: ["web"] } } });
  const orchestrator = new DevFnOrchestrator();
  const claims = path.join(primary, ".devfn", "receipts", "outputs");
  try {
    await writeFile(path.join(primary, "server.mjs"), SERVER);
    await orchestrator.up({ config: configWith([".env", declaredName]), root: primary, stateDir });
    const declared = await readFile(path.join(primary, declaredName), "utf8");
    // An earlier release's receipt has no claim; the next start replaces that receipt, so only the new claim's history records the output.
    for (const name of await readdir(claims)) if (name.endsWith(".json")) await rm(path.join(claims, name));
    await orchestrator.down({ config: configWith([".env"]), root: primary, stateDir });
    await orchestrator.up({ config: configWith([".env"]), root: primary, stateDir });
    await orchestrator.up({ config: configWith([".env.{runtime}"]), root: primary, stateDir, runtime: "x" });
    expect(await readFile(path.join(primary, declaredName), "utf8")).toBe(declared);
  } finally {
    for (const runtime of [undefined, "x"]) await orchestrator.down({ config: configWith([".env"]), root: primary, stateDir, ...(runtime ? { runtime } : {}) }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("releases an output a runtime wrote, stopped and then dropped from its config: a direct input naming it is accepted, and once its content changes a walk hashes it, so edits rerun an on-change task", async () => {
  for (const runtime of [undefined, "r"]) {
    const { parent, primary } = await repository();
    const stateDir = path.join(parent, "state");
    const log = path.join(parent, "runs.log");
    const output = runtime ? "config/app.{runtime}.json" : "config/app.json", file = runtime ? "config/app.r.json" : "config/app.json";
    const configOf = (inputs: string[], outputs: string[]) => validateDevFnConfig({ version: 1, project: { id: "dropped-output" }, environmentOutputs: outputs.map((item) => ({ path: item })),
      processes: { seed: { adapter: "command", command: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n")`], task: { rerun: "on-change", inputs } } },
      profiles: { default: { processes: ["seed"] } } });
    const orchestrator = new DevFnOrchestrator();
    const runs = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    const direct = configOf([file], []), directory = configOf(["config"], []);
    const cycle = async (config: DevFnConfig) => { await orchestrator.up({ config, root: primary, stateDir, ...(runtime ? { runtime } : {}) }); await orchestrator.down({ config, root: primary, stateDir, ...(runtime ? { runtime } : {}) }); };
    const revision = async (config: DevFnConfig) => await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default", undefined, undefined, stateDir, (await resolveInstanceIdentity("dropped-output", primary, runtime)).instanceId);
    try {
      await writeFile(path.join(primary, "schema.sql"), "create table t();");
      await mkdir(path.join(primary, "config"));
      await writeFile(path.join(primary, "config", "other.yml"), "a: 1\n");
      await cycle(configOf(["schema.sql"], [output]));
      const written = await readFile(path.join(primary, file), "utf8");
      expect(await runs()).toBe(1);
      // Still holding what DevFn wrote, the dropped output is accepted as a direct input and only a walk leaves it out.
      await cycle(direct);
      expect(await runs()).toBe(2);
      const unchanged = await revision(directory);
      await rm(path.join(primary, file));
      expect(await revision(directory)).toBe(unchanged);
      // Once the user's own file is there, it is an input like any other.
      await writeFile(path.join(primary, file), written);
      const before = await revision(direct);
      await writeFile(path.join(primary, file), "{\"user\":1}\n");
      expect(await revision(direct)).not.toBe(before);
      await cycle(direct);
      expect(await runs()).toBe(3);
      await cycle(directory);
      expect(await runs()).toBe(4);
      await writeFile(path.join(primary, file), "{\"user\":2}\n");
      await cycle(directory);
      expect(await runs()).toBe(5);
      await cycle(directory);
      expect(await runs()).toBe(5);
    } finally {
      await orchestrator.down({ config: directory, root: primary, stateDir, ...(runtime ? { runtime } : {}) }).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  }
}, 240_000);

it("keeps an empty input directory's marker when a sibling's output lands in it, for once and on-change tasks, and a directory DevFn creates for a sibling's output transparent", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const log = path.join(parent, "runs.log");
  const command = [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n")`];
  const configOf = (outputs: string[], logged: boolean) => validateDevFnConfig({ version: 1, project: { id: "empty-marker" }, runtimeDir: "new-run", environmentOutputs: outputs.map((item) => ({ path: item })),
    processes: {
      seed: { adapter: "command", command: logged ? command : [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["config"] } },
      init: { adapter: "command", command: logged ? command : [process.execPath, "-e", "0"], task: { rerun: "once", inputs: ["."] } } },
    profiles: { default: { processes: ["seed", "init"] } } });
  const orchestrator = new DevFnOrchestrator();
  const runs = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const current = configOf([".out.{runtime}"], true), sibling = configOf(["config/app.{runtime}.env", "gen/app.{runtime}.env"], false);
  const revisions = async () => await Promise.all(["seed", "init"].map(async (name) => await taskInputRevision(current, primary, { name, kind: "process" }, "default", undefined, undefined, stateDir)));
  const cycle = async () => { await orchestrator.up({ config: current, root: primary, stateDir, runtime: "d" }); await orchestrator.down({ config: current, root: primary, stateDir, runtime: "d" }); };
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    await mkdir(path.join(primary, "config"));
    await cycle();
    expect(await runs()).toBe(2);
    const before = await revisions();
    // Sibling c writes into the repository's own empty config/ and into gen/, which DevFn creates for it.
    await orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "c" });
    expect(await readdir(path.join(primary, "config"))).toEqual(["app.c.env"]);
    expect(await readdir(path.join(primary, "gen"))).toEqual(["app.c.env"]);
    expect(await revisions()).toEqual(before);
    await cycle();
    expect(await runs()).toBe(2);
    await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "c" });
    expect(await revisions()).toEqual(before);
    // A real change in config/ still changes both.
    await writeFile(path.join(primary, "config", "app.yml"), "a: 1\n");
    const after = await revisions();
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  } finally {
    for (const runtime of ["c", "d"]) await orchestrator.down({ config: runtime === "c" ? sibling : current, root: primary, stateDir, runtime }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 240_000);

it("repeats a task-input walk that listed a directory a sibling published, created and withdrew between its attribution reads", async () => {
  const { parent, primary } = await repository();
  const stateDir = path.join(parent, "state");
  const configOf = (runtimeDir: string, output: string) => validateDevFnConfig({ version: 1, project: { id: "aba" }, runtimeDir, environmentOutputs: [{ path: output }],
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } },
    profiles: { default: { processes: ["seed"] } } });
  const current = configOf("new-run", ".out.{runtime}");
  const revision = async () => await taskInputRevision(current, primary, { name: "seed", kind: "process" }, "default", undefined, undefined, stateDir);
  const b = await resolveInstanceIdentity("aba", primary, "b");
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const control = await revision();
    // After the first claims read, sibling b publishes its claim and creates old-run/instances/<b>; the walk lists old-run, and before it reads schema.sql b's refused start removes them and withdraws its claim, so both reads agree.
    let started: { restore: () => Promise<void> } | undefined;
    claimReads.root = primary;
    claimReads.after = async () => { started = await claimEnvironmentOutputs(configOf("old-run", ".env.{runtime}"), primary, b, stateDir); };
    reads.before = async (operation, target) => { if (operation === "lstat" && target === path.join(primary, "schema.sql") && started) { reads.before = undefined; await started.restore(); } };
    expect(await revision()).toBe(control);
    expect(claimReads.after).toBeUndefined();
    expect(reads.before).toBeUndefined();
    await expect(access(path.join(primary, "old-run"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    expect(await revision()).not.toBe(control);
  } finally {
    claimReads.after = undefined; claimReads.root = undefined; reads.before = undefined;
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("refuses an output in a sibling runtime's state directory inside the checkout while its claimant runs or its receipt is live, before any lease or write, and frees it once that runtime is down", async () => {
  const { parent, primary } = await repository();
  const [stateA, stateB] = [path.join(primary, "state-a"), path.join(primary, "state-b")];
  const base = { version: 1, project: { id: "sibling-state" }, ports: { web: { env: "PORT" } },
    processes: { web: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["web"], health: { type: "http", port: "web", timeoutMs: 10_000 } } },
    profiles: { default: { processes: ["web"] } } };
  const a = validateDevFnConfig(base as never);
  const intruder = validateDevFnConfig({ ...base, environmentOutputs: [{ path: "state-a/registry.json" }] } as never);
  const orchestrator = new DevFnOrchestrator();
  const defaultIdentity = await resolveInstanceIdentity("sibling-state", primary);
  try {
    await writeFile(path.join(primary, "server.mjs"), SERVER);
    // A claim records its state directory before any lease there: a sibling's output is refused while that claimant runs.
    await mkdir(stateA);
    const starting = await claimEnvironmentOutputs(a, primary, await resolveInstanceIdentity("sibling-state", primary, "a"), stateA);
    await expect(assertEnvironmentOutputsAvailable(intruder, primary, defaultIdentity, stateB))
      .rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("the state directory of runtime a") });
    await starting.restore();
    await assertEnvironmentOutputsAvailable(intruder, primary, defaultIdentity, stateB);

    const upA = await orchestrator.up({ config: a, root: primary, stateDir: stateA, runtime: "a" });
    const registry = path.join(stateA, "registry.json");
    const before = await readFile(registry);
    await expect(orchestrator.up({ config: intruder, root: primary, stateDir: stateB }))
      .rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining(`the state directory of runtime a (instance ${upA.instanceId})`) });
    expect(await readFile(registry)).toEqual(before);
    expect((await orchestrator.down({ config: a, root: primary, stateDir: stateA, runtime: "a" })).state).toBe("stopped");
    // A stopped runtime holds no state directory, as it holds no runtime directory.
    await assertEnvironmentOutputsAvailable(intruder, primary, defaultIdentity, stateB);
  } finally {
    for (const [runtime, stateDir] of [["a", stateA], [undefined, stateB]] as const) await orchestrator.down({ config: a, root: primary, stateDir, ...(runtime ? { runtime } : {}) }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("serializes one instance's starts and stops across state directories: a start elsewhere waits instead of taking over an in-flight claim a sibling could then receive, and a later move still works", async () => {
  const { parent, primary } = await repository();
  const [s1, s2, s3] = [path.join(parent, "s1"), path.join(parent, "s2"), path.join(parent, "s3")];
  const base = { version: 1, project: { id: "instance-lock" }, processes: {}, profiles: { default: { processes: [] } } };
  const literal = validateDevFnConfig({ ...base, environmentOutputs: [{ path: ".b" }] } as never);
  const other = validateDevFnConfig({ ...base, environmentOutputs: [{ path: ".other" }] } as never);
  const template = validateDevFnConfig({ ...base, environmentOutputs: [{ path: ".{runtime}" }] } as never);
  const orchestrator = new DevFnOrchestrator();
  const identity = await resolveInstanceIdentity("instance-lock", primary);
  const claimFile = path.join(primary, ".devfn", "receipts", "outputs", `${identity.instanceId}.json`);
  const claimOf = async () => JSON.parse(await readFile(claimFile, "utf8").catch(() => "{}")) as { targets?: string[]; stateDir?: string };
  const code = (error: { code?: string }) => error.code ?? String(error);
  let second: Promise<string> | undefined;
  let observed: Record<string, unknown> | undefined;
  try {
    await mkdir(s3);
    // Once the default runtime's start in s1 holds .b and is about to write it, the same runtime starts in s2.
    made.after = async (directory) => {
      if (second || directory !== primary || !(await claimOf()).targets?.some((item) => path.basename(item) === ".b")) return;
      made.after = undefined;
      second = orchestrator.up({ config: other, root: primary, stateDir: s2 }).then(() => "ok", code);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const claim = await claimOf();
      const named = await claimEnvironmentOutputs(template, primary, await resolveInstanceIdentity("instance-lock", primary, "b"), s3)
        .then(async (held) => { await held.restore(); return "ok"; }, code);
      observed = { targets: claim.targets?.map((item) => path.basename(item)), stateDir: claim.stateDir, named };
    };
    expect((await orchestrator.up({ config: literal, root: primary, stateDir: s1 })).state).toBe("ready");
    // The start in s2 never took over the claim while the one in s1 ran, so runtime b could not take .b.
    expect(observed).toEqual({ targets: [".b"], stateDir: await realpath(s1), named: "DEVFN_RUNTIME_INVALID" });
    // It then ran, and was refused for the runtime s1 still runs; the claim is still s1's.
    expect(await second).toBe("DEVFN_RUNTIME_INVALID");
    expect(await claimOf()).toMatchObject({ targets: [expect.stringMatching(/\.b$/)], stateDir: await realpath(s1) });
    expect(await readFile(path.join(primary, ".b"), "utf8")).toContain("DEVFN_INSTANCE_ID");
    // Stopped in s1, the runtime starts and stops in s2.
    expect((await orchestrator.down({ config: literal, root: primary, stateDir: s1 })).state).toBe("stopped");
    expect((await orchestrator.up({ config: literal, root: primary, stateDir: s2 })).state).toBe("ready");
    expect((await orchestrator.down({ config: literal, root: primary, stateDir: s2 })).state).toBe("stopped");
    expect((await claimOf()).targets).toEqual([]);
  } finally {
    made.after = undefined;
    await second;
    for (const stateDir of [s1, s2]) await orchestrator.down({ config: literal, root: primary, stateDir }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("releases a stopped claim under the claims lock, so it never rewrites the claim while a claim is checked or published", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "locked-release" }, environmentOutputs: [{ path: ".env" }], processes: {}, profiles: { default: { processes: [] } } } as never);
  const identity = await resolveInstanceIdentity("locked-release", primary);
  const claimFile = path.join(primary, ".devfn", "receipts", "outputs", `${identity.instanceId}.json`);
  try {
    const claim = await claimEnvironmentOutputs(config, primary, identity);
    await claim.write(path.join(primary, ".env"), "A=1\n", 0o600);
    await claim.commit();
    const held = await readFile(claimFile, "utf8");
    let release: Promise<void> | undefined;
    await withFileLock(path.join(primary, ".devfn", "receipts", "outputs", "claims.lock"), async () => {
      release = releaseEnvironmentOutputs(primary, identity.instanceId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await readFile(claimFile, "utf8")).toBe(held);
    });
    await release;
    expect(JSON.parse(await readFile(claimFile, "utf8"))).toMatchObject({ targets: [], written: [expect.objectContaining({ target: expect.stringMatching(/\.env$/) })] });
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 60_000);

it("refuses a task-input revision when the claims cannot be read, rather than hashing a sibling's output its claim attributes", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "claims-read" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const sibling = validateDevFnConfig({ version: 1, project: { id: "claims-read" }, environmentOutputs: [{ path: ".sibling.{runtime}" }], processes: {}, profiles: { default: { processes: [] } } } as never);
  const revision = async () => await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default");
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const before = await revision();
    // Runtime b holds .sibling.b only through its claim.
    const claim = await claimEnvironmentOutputs(sibling, primary, await resolveInstanceIdentity("claims-read", primary, "b"));
    await claim.write(path.join(primary, ".sibling.b"), "B=1\n", 0o600);
    await claim.commit();
    expect(await revision()).toBe(before);
    claimReads.root = primary;
    claimReads.after = async () => { throw Object.assign(new Error("injected claims read failure"), { code: "EIO" }); };
    await expect(revision()).rejects.toMatchObject({ code: "EIO" });
    expect(await revision()).toBe(before);
  } finally {
    claimReads.after = undefined; claimReads.root = undefined;
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("recovers either lifecycle lock of a killed start or stop within the lock timeout, in its own and another state directory, while a live holder still excludes", async () => {
  const { parent, primary } = await repository();
  const [s1, s2] = [path.join(parent, "s1"), path.join(parent, "s2")];
  const config = validateDevFnConfig({ version: 1, project: { id: "dead-lock" }, environmentOutputs: [{ path: ".b" }], processes: {}, profiles: { default: { processes: [] } } } as never);
  const orchestrator = new DevFnOrchestrator();
  const identity = await resolveInstanceIdentity("dead-lock", primary);
  const outputs = path.join(primary, ".devfn", "receipts", "outputs");
  const instanceLock = path.join(outputs, `lifecycle-${identity.instanceId}.lock`);
  const children = new Set<ChildProcess>();
  // A real DevFn process takes the locks as up and down do, and is killed while holding them: no record is aged.
  const killHolder = async (...locks: string[]) => await killLockHolder(children, ...locks);
  const timed = async <T>(action: () => Promise<T>) => { const started = Date.now(); const value = await action(); return { value, ms: Date.now() - started }; };
  try {
    for (const directory of [outputs, s1, s2]) await mkdir(directory, { recursive: true });
    const lockIn = async (stateDir: string) => path.join(await realpath(stateDir), `lifecycle-${identity.instanceId}.lock`);
    // A start killed in s1 holds the instance lock and s1's: a start in s2 takes over the instance lock at once.
    await killHolder(instanceLock, await lockIn(s1));
    const moved = await timed(async () => await orchestrator.up({ config, root: primary, stateDir: s2 }));
    expect(moved.value.state).toBe("ready");
    expect(moved.ms).toBeLessThan(20_000);
    expect((await orchestrator.down({ config, root: primary, stateDir: s2 })).state).toBe("stopped");
    // A start in s1 then takes over s1's lock too.
    const same = await timed(async () => await orchestrator.up({ config, root: primary, stateDir: s1 }));
    expect(same.value.state).toBe("ready");
    expect(same.ms).toBeLessThan(20_000);
    // A stop killed in s1 leaves both locks too; the next stop takes both over.
    await killHolder(instanceLock, await lockIn(s1));
    const stopped = await timed(async () => await orchestrator.down({ config, root: primary, stateDir: s1 }));
    expect(stopped.value.state).toBe("stopped");
    expect(stopped.ms).toBeLessThan(20_000);
    // A live holder is never taken over, however long past the stale window it holds the lock.
    let waiting: Promise<string> | undefined;
    await withFileLock(instanceLock, async () => {
      waiting = orchestrator.up({ config, root: primary, stateDir: s2 }).then((receipt) => receipt.state, (error: { code?: string }) => error.code ?? String(error));
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      expect(await Promise.race([waiting, Promise.resolve("pending")])).toBe("pending");
      expect(JSON.parse(await readFile(path.join(outputs, `${identity.instanceId}.json`), "utf8"))).toMatchObject({ targets: [] });
    });
    expect(await waiting).toBe("ready");
  } finally {
    killRunning(children);
    for (const stateDir of [s1, s2]) await orchestrator.down({ config, root: primary, stateDir }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 180_000);

it("recovers a killed lifecycle's orphaned proxy routes once its lock is past the lifecycle stale window, and skips an instance whose live command holds it", async () => {
  const stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-gc-lock-")));
  const lock = path.join(stateDir, "lifecycle-gone-owner.lock");
  const children = new Set<ChildProcess>();
  // Route removal itself is the proxy's concern; this checks which instances gc may recover.
  const removed = vi.spyOn(CaddyProxyController.prototype, "removeInstance").mockResolvedValue();
  try {
    await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [{ id: "gone-owner:web", instanceId: "gone-owner", hostname: "gone.localhost", targetHost: "127.0.0.1", targetPort: 41003, tls: "off", updatedAt: new Date().toISOString() }] }));
    // A live command holds the lock past the stale window: gc skips its instance.
    await withFileLock(lock, async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect(await recoverOrphanedProxyRoutes(stateDir)).toEqual([]);
    });
    expect(removed).not.toHaveBeenCalled();
    // A command killed holding it: gc takes it over once past the same stale window up and down use, not five minutes later.
    await killLockHolder(children, lock);
    const createdAt = Date.parse((JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as { createdAt: string }).createdAt);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, createdAt + 5_500 - Date.now())));
    expect(await recoverOrphanedProxyRoutes(stateDir)).toEqual(["gone-owner"]);
    expect(removed).toHaveBeenCalledWith("gone-owner");
  } finally {
    removed.mockRestore();
    killRunning(children);
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60_000);

it("keeps a task's input revision while a sibling runtime's state directory inside the checkout changes, whether a live receipt, a claim alone or a stopped receipt records it, but never hides the checkout behind a state directory containing it", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "sibling-state-input" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const sibling = validateDevFnConfig({ version: 1, project: { id: "sibling-state-input" }, environmentOutputs: [{ path: ".sibling.{runtime}" }], processes: {}, profiles: { default: { processes: [] } } } as never);
  const orchestrator = new DevFnOrchestrator();
  const revision = async () => await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default");
  const [live, claimed, stopped] = ["review-state", "claim-state", "stopped-state"].map((name) => path.join(primary, name));
  const touch = async (stateDir: string) => await writeFile(path.join(stateDir, "registry.json"), JSON.stringify({ version: 1, invocations: [], touched: Date.now() }));
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    // Runtime b runs with its state directory inside the checkout.
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: live, runtime: "b" })).state).toBe("ready");
    const before = await revision();
    await touch(live);
    expect(await revision()).toBe(before);
    // Runtime c only claimed, with its own state directory there.
    await mkdir(claimed);
    const claim = await claimEnvironmentOutputs(sibling, primary, await resolveInstanceIdentity("sibling-state-input", primary, "c"), claimed);
    await claim.commit();
    const withClaim = await revision();
    await touch(claimed);
    expect(await revision()).toBe(withClaim);
    // Runtime d stopped and its claim is gone: its stopped receipt still records the state directory.
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: stopped, runtime: "d" })).state).toBe("ready");
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir: stopped, runtime: "d" })).state).toBe("stopped");
    await rm(path.join(primary, ".devfn", "receipts", "outputs", `${(await resolveInstanceIdentity("sibling-state-input", primary, "d")).instanceId}.json`));
    const withStopped = await revision();
    await touch(stopped);
    expect(await revision()).toBe(withStopped);
    // A state directory equal to the checkout is recorded too, yet a source edit still changes the revision.
    const rooted = await claimEnvironmentOutputs(sibling, primary, await resolveInstanceIdentity("sibling-state-input", primary, "e"), primary);
    await rooted.commit();
    const withRoot = await revision();
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    expect(await revision()).not.toBe(withRoot);
    // A claim store that cannot be read still refuses the revision.
    claimReads.root = primary;
    claimReads.after = async () => { throw Object.assign(new Error("injected claims read failure"), { code: "EIO" }); };
    await expect(revision()).rejects.toMatchObject({ code: "EIO" });
  } finally {
    claimReads.after = undefined; claimReads.root = undefined;
    await orchestrator.down({ config: sibling, root: primary, stateDir: live, runtime: "b" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("keeps a task's input revision while DevFn creates and uses a sibling's nested state directory inside the checkout, recorded before it is created, but not once a directory it made holds anything else, nor for a directory that existed before", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "nested-state-input" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const sibling = validateDevFnConfig({ version: 1, project: { id: "nested-state-input" }, processes: {}, profiles: { default: { processes: [] } } });
  const orchestrator = new DevFnOrchestrator();
  const revision = async () => await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default");
  const [nested, deeper, kept] = [["cache", "review-state"], ["x", "y", "state"], ["kept", "state"]].map((parts) => path.join(primary, ...parts));
  // A registry rewrite that the sibling's own later stop still reads.
  const touch = async (stateDir: string) => await writeFile(path.join(stateDir, "registry.json"), `${await readFile(path.join(stateDir, "registry.json"), "utf8")}\n`);
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const before = await revision();
    // The directories a start creates for its state directory are DevFn's from the moment they exist.
    const atCreation: string[] = [];
    made.after = async (directory) => { if (path.resolve(directory) === nested) { made.after = undefined; atCreation.push(await revision()); } };
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: nested, runtime: "b" })).state).toBe("ready");
    expect(atCreation).toEqual([before]);
    expect(await revision()).toBe(before);
    await touch(nested);
    expect(await revision()).toBe(before);
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: deeper, runtime: "c" })).state).toBe("ready");
    await touch(deeper);
    expect(await revision()).toBe(before);
    // Stopped, their receipts still record the state directories.
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir: nested, runtime: "b" })).state).toBe("stopped");
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir: deeper, runtime: "c" })).state).toBe("stopped");
    await touch(nested);
    expect(await revision()).toBe(before);
    // A stop with a state directory that never existed refuses, and what it created is DevFn's too.
    await expect(orchestrator.down({ config: sibling, root: primary, stateDir: path.join(primary, "gone", "state"), runtime: "d" })).rejects.toMatchObject({ code: "DEVFN_NOT_RUNNING" });
    expect(await revision()).toBe(before);
    // A user's file in a directory DevFn made is an input.
    await writeFile(path.join(primary, "cache", "user.txt"), "mine");
    expect(await revision()).not.toBe(before);
    await rm(path.join(primary, "cache", "user.txt"));
    expect(await revision()).toBe(before);
    // A directory that existed before the start is never DevFn's, so it stays an input once it holds a state directory.
    await mkdir(path.dirname(kept));
    const withKept = await revision();
    expect(withKept).not.toBe(before);
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: kept, runtime: "e" })).state).toBe("ready");
    expect(await revision()).toBe(withKept);
    await writeFile(path.join(path.dirname(kept), "user.txt"), "mine");
    expect(await revision()).not.toBe(withKept);
  } finally {
    made.after = undefined;
    for (const [stateDir, runtime] of [[nested, "b"], [deeper, "c"], [kept, "e"]] as const) await orchestrator.down({ config: sibling, root: primary, stateDir, runtime }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("keeps a task's input revision when a start into a new nested state directory inside the checkout fails after DevFn wrote there, and keeps an earlier release's provenance when a later start or stop records a claim", async () => {
  const { parent, primary } = await repository();
  const seed = (rerun: "on-change" | "once") => validateDevFnConfig({ version: 1, project: { id: "failed-state-input" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun, inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const idle = [process.execPath, "-e", "setInterval(() => undefined, 1_000)"];
  const withResources = validateDevFnConfig({ version: 1, project: { id: "failed-state-input" }, ports: { r: {} },
    processes: { redis: { adapter: "command", command: idle, ports: ["r"] }, worker: { adapter: "command", command: idle, resources: ["cache"] } },
    resources: { cache: { kind: "cache", defaultTarget: "local", targets: { local: { node: "redis", port: "r", scheme: "redis" } } } }, profiles: { default: { processes: ["worker", "redis"] } } } as never);
  const plain = validateDevFnConfig({ version: 1, project: { id: "failed-state-input" }, ports: { r: {} }, processes: { app: { adapter: "command", command: idle, ports: ["r"] } }, profiles: { default: { processes: ["app"] } } } as never);
  const legacy = validateDevFnConfig({ version: 1, project: { id: "failed-state-input" }, runtimeDir: "old-run", processes: {}, profiles: { default: { processes: [] } } } as never);
  const orchestrator = new DevFnOrchestrator();
  const revision = async () => await taskInputRevision(seed("on-change"), primary, { name: "seed", kind: "process" }, "default");
  const outside = (name: string) => path.join(parent, name);
  const reserve = FilePortRegistry.prototype.reserve;
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const before = await revision();
    // A first start whose port reservation fails leaves runtime-id and registry.json in the state directory it created: DevFn's, while written and after.
    for (const [config, runtime, state] of [[withResources, "b", ["cache", "state"]], [plain, "c", ["cache2", "state"]]] as const) {
      const stateDir = path.join(primary, ...state), atWrite: string[] = [];
      const spy = vi.spyOn(FilePortRegistry.prototype, "reserve").mockImplementation(async function (this: FilePortRegistry, ...args: Parameters<FilePortRegistry["reserve"]>) {
        await reserve.apply(this, args);
        atWrite.push(await revision());
        throw new Error("stopped at port reservation");
      });
      try { await expect(orchestrator.up({ config, root: primary, stateDir, runtime })).rejects.toThrow("stopped at port reservation"); } finally { spy.mockRestore(); }
      expect((await readdir(stateDir)).filter((name) => !name.endsWith(".lock"))).toEqual(expect.arrayContaining(runtime === "b" ? ["registry.json", "runtime-id"] : ["registry.json"]));
      expect(atWrite).toEqual([before]);
      expect(await revision()).toBe(before);
    }
    // Runtime d left a claimless stopped receipt, as an earlier release did, with its runtime directory in old-run.
    const d = await resolveInstanceIdentity("failed-state-input", primary, "d");
    expect((await orchestrator.up({ config: legacy, root: primary, stateDir: outside("d-state"), runtime: "d" })).state).toBe("ready");
    expect((await orchestrator.down({ config: legacy, root: primary, stateDir: outside("d-state"), runtime: "d" })).state).toBe("stopped");
    await rm(path.join(primary, ".devfn", "receipts", "outputs", `${d.instanceId}.json`));
    // A run-once task of the default runtime completes with that receipt in place.
    expect((await orchestrator.up({ config: seed("once"), root: primary, stateDir: outside("a-state") })).state).toBe("ready");
    expect((await orchestrator.down({ config: seed("once"), root: primary, stateDir: outside("a-state") })).state).toBe("stopped");
    const legacyBefore = await revision();
    // A stop of d with a new state directory records a claim, which keeps the earlier release's provenance.
    await expect(orchestrator.down({ config: legacy, root: primary, stateDir: path.join(primary, "fresh", "state"), runtime: "d" })).rejects.toMatchObject({ code: "DEVFN_NOT_RUNNING" });
    expect(await revision()).toBe(legacyBefore);
    expect((await orchestrator.up({ config: seed("once"), root: primary, stateDir: outside("a-state") })).state).toBe("ready");
    expect((await orchestrator.down({ config: seed("once"), root: primary, stateDir: outside("a-state") })).state).toBe("stopped");
    // So does a start of a claimless instance with a new state directory.
    const e = await resolveInstanceIdentity("failed-state-input", primary, "e");
    expect((await orchestrator.up({ config: legacy, root: primary, stateDir: outside("e-state"), runtime: "e" })).state).toBe("ready");
    expect((await orchestrator.down({ config: legacy, root: primary, stateDir: outside("e-state"), runtime: "e" })).state).toBe("stopped");
    await rm(path.join(primary, ".devfn", "receipts", "outputs", `${e.instanceId}.json`));
    const withE = await revision();
    expect((await orchestrator.up({ config: legacy, root: primary, stateDir: path.join(primary, "later", "state"), runtime: "e" })).state).toBe("ready");
    expect(await revision()).toBe(withE);
    expect((await orchestrator.down({ config: legacy, root: primary, stateDir: path.join(primary, "later", "state"), runtime: "e" })).state).toBe("stopped");
    expect(await revision()).toBe(withE);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 180_000);

it("refuses a start or stop that would create state directories when its own claim cannot be read, leaving the claim as it was and creating nothing", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "malformed-own-claim" }, processes: {}, profiles: { default: { processes: [] } } });
  const orchestrator = new DevFnOrchestrator();
  try {
    const { instanceId } = await resolveInstanceIdentity("malformed-own-claim", primary, "b");
    const claimFile = path.join(primary, ".devfn", "receipts", "outputs", `${instanceId}.json`);
    const malformed = `{"version":1,"instanceId":"${instanceId}","targets":["/owned/thing"],"truncated":`;
    await mkdir(path.dirname(claimFile), { recursive: true });
    await writeFile(claimFile, malformed);
    // A stop of a runtime that is not running is refused before it reads any claim.
    for (const [command, code] of [[() => orchestrator.down({ config, root: primary, stateDir: path.join(primary, "fresh", "state"), runtime: "b" }), "DEVFN_NOT_RUNNING"], [() => orchestrator.up({ config, root: primary, stateDir: path.join(primary, "fresh", "state"), runtime: "b" }), "DEVFN_RUNTIME_INVALID"]] as const) {
      await expect(command()).rejects.toMatchObject({ code });
      expect(await readFile(claimFile, "utf8")).toBe(malformed);
      await expect(access(path.join(primary, "fresh"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("refuses a start whose state path is a checkout file or lies below one before recording anything, and restores the claim when creating its state directory fails", async () => {
  const { parent, primary } = await repository();
  const seed = (inputs: string[]) => validateDevFnConfig({ version: 1, project: { id: "file-state-input" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs } } }, profiles: { default: { processes: ["seed"] } } });
  const sibling = validateDevFnConfig({ version: 1, project: { id: "file-state-input" }, processes: {}, profiles: { default: { processes: [] } } });
  const orchestrator = new DevFnOrchestrator();
  const revision = async (inputs = ["."]) => await taskInputRevision(seed(inputs), primary, { name: "seed", kind: "process" }, "default");
  const { instanceId } = await resolveInstanceIdentity("file-state-input", primary, "b");
  const claimFile = path.join(primary, ".devfn", "receipts", "outputs", `${instanceId}.json`);
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const before = await revision();
    for (const stateDir of [path.join(primary, "schema.sql"), path.join(primary, "schema.sql", "state")]) {
      await expect(orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "b" })).rejects.toMatchObject({ code: "ENOTDIR" });
      await expect(access(claimFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await revision()).toBe(before);
    }
    // The file is still an input, directly and below the checkout.
    const direct = await revision(["schema.sql"]);
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    expect(await revision()).not.toBe(before);
    expect(await revision(["schema.sql"])).not.toBe(direct);
    // A creation that fails once the claim recorded it leaves the claim as it was, or none.
    const blocked = path.join(primary, "blocked", "state");
    const changed = await revision();
    made.fail = (directory) => path.resolve(directory) === blocked ? Object.assign(new Error("injected mkdir failure"), { code: "EACCES" }) : undefined;
    await expect(orchestrator.up({ config: sibling, root: primary, stateDir: blocked, runtime: "b" })).rejects.toThrow("injected mkdir failure");
    await expect(access(claimFile)).rejects.toMatchObject({ code: "ENOENT" });
    made.fail = undefined;
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: path.join(parent, "b-state"), runtime: "b" })).state).toBe("ready");
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir: path.join(parent, "b-state"), runtime: "b" })).state).toBe("stopped");
    const claimed = await readFile(claimFile, "utf8"), withClaim = await revision();
    made.fail = (directory) => path.resolve(directory) === blocked ? Object.assign(new Error("injected mkdir failure"), { code: "EACCES" }) : undefined;
    await expect(orchestrator.up({ config: sibling, root: primary, stateDir: blocked, runtime: "b" })).rejects.toThrow("injected mkdir failure");
    expect(await readFile(claimFile, "utf8")).toBe(claimed);
    expect(await revision()).toBe(withClaim);
    expect(withClaim).toBe(changed);
    // A recursive creation that fails after it created a parent keeps that parent's provenance, with or without an earlier claim, and holds nothing.
    const claimOf = async () => JSON.parse(await readFile(claimFile, "utf8")) as { made?: string[]; recorded?: string[] };
    const partly = (leaf: string) => { made.fail = (directory) => { if (path.resolve(directory) !== leaf) return undefined; mkdirSync(path.dirname(leaf)); return Object.assign(new Error("injected partial mkdir failure"), { code: "ENOSPC" }); }; };
    const previous = await claimOf();
    partly(path.join(primary, "partial", "state"));
    await expect(orchestrator.up({ config: sibling, root: primary, stateDir: path.join(primary, "partial", "state"), runtime: "b" })).rejects.toThrow("injected partial mkdir failure");
    expect(await revision()).toBe(withClaim);
    expect((await claimOf()).recorded).toEqual(previous.recorded);
    expect((await claimOf()).made).toEqual([...previous.made ?? [], path.join(primary, "partial")]);
    const fresh = await resolveInstanceIdentity("file-state-input", primary, "c");
    partly(path.join(primary, "partial-c", "state"));
    await expect(orchestrator.up({ config: sibling, root: primary, stateDir: path.join(primary, "partial-c", "state"), runtime: "c" })).rejects.toThrow("injected partial mkdir failure");
    expect(await revision()).toBe(withClaim);
    expect(JSON.parse(await readFile(path.join(path.dirname(claimFile), `${fresh.instanceId}.json`), "utf8"))).toMatchObject({ recorded: [], made: [path.join(primary, "partial-c")] });
    made.fail = undefined;
    // A start refused for an existing source directory as its state directory records nothing: it stays an input.
    await mkdir(path.join(primary, "src"));
    await writeFile(path.join(primary, "src", "app.sql"), "select 1;");
    const withSrc = await revision();
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: path.join(parent, "b-state"), runtime: "b" })).state).toBe("ready");
    await expect(orchestrator.up({ config: sibling, root: primary, stateDir: path.join(primary, "src"), runtime: "b" })).rejects.toBeDefined();
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir: path.join(parent, "b-state"), runtime: "b" })).state).toBe("stopped");
    expect(await revision()).toBe(withSrc);
    const directSrc = await revision(["src/app.sql"]);
    await writeFile(path.join(primary, "src", "app.sql"), "select 2;");
    expect(await revision()).not.toBe(withSrc);
    expect(await revision(["src/app.sql"])).not.toBe(directSrc);
  } finally {
    made.fail = undefined;
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("keeps refusing outputs a live claimless receipt may own after a refused start of it recorded only state-directory provenance", async () => {
  const { parent, primary } = await repository();
  const plain = validateDevFnConfig({ version: 1, project: { id: "hollow-claim" }, processes: {}, profiles: { default: { processes: [] } } });
  const writer = validateDevFnConfig({ version: 1, project: { id: "hollow-claim" }, environmentOutputs: [{ path: ".written.{runtime}" }], processes: {}, profiles: { default: { processes: [] } } } as never);
  const orchestrator = new DevFnOrchestrator();
  const outside = path.join(parent, "d-state");
  try {
    // Runtime d runs with a receipt that records no outputs and no claim, as an earlier release left it.
    const d = await resolveInstanceIdentity("hollow-claim", primary, "d");
    expect((await orchestrator.up({ config: plain, root: primary, stateDir: outside, runtime: "d" })).state).toBe("ready");
    await rm(path.join(primary, ".devfn", "receipts", "outputs", `${d.instanceId}.json`));
    const receiptFile = path.join(primary, ".devfn", "receipts", `${d.instanceId}.json`);
    const { environmentOutputs: _recorded, ...legacy } = JSON.parse(await readFile(receiptFile, "utf8")) as Record<string, unknown>;
    await writeFile(receiptFile, JSON.stringify(legacy, null, 2));
    const e = await resolveInstanceIdentity("hollow-claim", primary, "e");
    await expect(assertEnvironmentOutputsAvailable(writer, primary, e)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
    // A start of d into a new state directory inside the checkout while it runs elsewhere is refused before it records or creates anything.
    await expect(orchestrator.up({ config: plain, root: primary, stateDir: path.join(primary, "new", "state"), runtime: "d" })).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
    await expect(access(path.join(primary, "new"))).rejects.toMatchObject({ code: "ENOENT" });
    // One killed right after it recorded that state directory leaves a claim of provenance alone.
    await recordStateDirectory(plain, primary, d, path.join(primary, "new", "state"));
    await access(path.join(primary, ".devfn", "receipts", "outputs", `${d.instanceId}.json`));
    await expect(assertEnvironmentOutputsAvailable(writer, primary, e)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
  } finally {
    await orchestrator.down({ config: plain, root: primary, stateDir: outside, runtime: "d" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("keeps a task's input revision through every DevFn write of a failed, retried and stopped sibling in an existing state directory inside the checkout, holding only DevFn's entries there", async () => {
  const { parent, primary } = await repository();
  const config = (inputs: string[]) => validateDevFnConfig({ version: 1, project: { id: "existing-state-input" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs } } }, profiles: { default: { processes: ["seed"] } } });
  const idle = [process.execPath, "-e", "setInterval(() => undefined, 1_000)"];
  const listen = [process.execPath, "-e", "require('node:net').createServer().listen(Number(process.env.PORT), '127.0.0.1')"];
  const sibling = validateDevFnConfig({ version: 1, project: { id: "existing-state-input" }, ports: { r: { env: "PORT" } },
    processes: { redis: { adapter: "command", command: listen, ports: ["r"] }, worker: { adapter: "command", command: idle, resources: ["cache"] } },
    resources: { cache: { kind: "cache", defaultTarget: "local", targets: { local: { node: "redis", port: "r", scheme: "redis" } } } }, profiles: { default: { processes: ["worker", "redis"] } } } as never);
  const orchestrator = new DevFnOrchestrator();
  const revision = async () => await taskInputRevision(config(["."]), primary, { name: "seed", kind: "process" }, "default");
  const reserve = FilePortRegistry.prototype.reserve;
  const states: Array<[string, string]> = [];
  try {
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    for (const [variant, runtime] of [["existing", "b"], ["after-a-refused-down", "c"]] as const) {
      const stateDir = path.join(primary, `${variant}-cache`, "state");
      states.push([stateDir, runtime]);
      if (variant === "existing") {
        await mkdir(stateDir, { recursive: true });
        await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
      }
      const before = await revision();
      const seen: string[] = [];
      const sample = async () => { seen.push(await revision()); };
      if (variant === "after-a-refused-down") {
        // A stop of a runtime that is not running creates and records nothing.
        await expect(orchestrator.down({ config: sibling, root: primary, stateDir, runtime })).rejects.toMatchObject({ code: "DEVFN_NOT_RUNNING" });
        await expect(access(path.dirname(stateDir))).rejects.toMatchObject({ code: "ENOENT" });
      }
      // A first start that fails at port reservation, after runtime-id, its locks and registry.json were written.
      lifecycle.recorded = sample;
      const failing = vi.spyOn(FilePortRegistry.prototype, "reserve").mockImplementation(async function (this: FilePortRegistry, ...args: Parameters<FilePortRegistry["reserve"]>) {
        await reserve.apply(this, args);
        await sample();
        throw new Error("stopped at port reservation");
      });
      try { await expect(orchestrator.up({ config: sibling, root: primary, stateDir, runtime })).rejects.toThrow("stopped at port reservation"); } finally { failing.mockRestore(); }
      expect(await readdir(stateDir)).toEqual(expect.arrayContaining(["registry.json", "runtime-id"]));
      expect(await revision()).toBe(before);
      // Retried, it starts; stopped, and stopped again, it keeps every DevFn write out.
      const retried = vi.spyOn(FilePortRegistry.prototype, "reserve").mockImplementation(async function (this: FilePortRegistry, ...args: Parameters<FilePortRegistry["reserve"]>) {
        const reserved = await reserve.apply(this, args);
        await sample();
        return reserved;
      });
      try { expect((await orchestrator.up({ config: sibling, root: primary, stateDir, runtime })).state).toBe("ready"); } finally { retried.mockRestore(); }
      expect(await revision()).toBe(before);
      lifecycle.read = sample;
      expect((await orchestrator.down({ config: sibling, root: primary, stateDir, runtime })).state).toBe("stopped");
      await expect(orchestrator.down({ config: sibling, root: primary, stateDir, runtime })).rejects.toMatchObject({ code: "DEVFN_NOT_RUNNING" });
      lifecycle.read = undefined;
      expect(seen.length).toBeGreaterThanOrEqual(6);
      expect([...new Set(seen)]).toEqual([before]);
      expect(await revision()).toBe(before);
      // So do the other writers' files there: trust state, Caddy's candidate and preflight configurations, also renamed away during a walk.
      await mkdir(path.join(stateDir, "trust.lock"));
      await writeFile(path.join(stateDir, "trust.lock", "a.ticket"), "{}");
      for (const name of ["trust.json", "trust.json.1.a.tmp", "Caddyfile.candidate", `Caddyfile.preflight.${process.pid}.a`]) await writeFile(path.join(stateDir, name), "generated");
      // The candidate is renamed once the walk lists the state directory, after the listing's names are read.
      const candidate = path.join(stateDir, "Caddyfile.candidate");
      let renamed = false;
      reads.before = async (operation, file) => {
        if (operation !== "opendir" || file !== stateDir || renamed) return;
        renamed = true;
        await rename(candidate, path.join(stateDir, "Caddyfile"));
      };
      expect(await revision()).toBe(before);
      reads.before = undefined;
      // Only an existing state directory is walked; one the start created is held whole.
      expect(renamed).toBe(variant === "existing");
      // Only DevFn's entries of an existing one are held: a user's directory that only resembles a DevFn name stays an input. One the start created is held whole.
      if (variant !== "existing") continue;
      await mkdir(path.join(stateDir, "proxy"));
      await writeFile(path.join(stateDir, "proxy", "schema.sql"), "-- mine");
      expect(await revision()).not.toBe(before);
      await rm(path.join(stateDir, "proxy"), { recursive: true });
      expect(await revision()).toBe(before);
      // Where this directory's filesystem folds case, DevFn's task journals land in an existing directory of any spelling.
      if (await foldsCaseHere(stateDir)) {
        await mkdir(path.join(stateDir, "Tasks"));
        await writeFile(path.join(stateDir, "tasks", "journal.json"), "{}");
        expect(await revision()).toBe(before);
        await rm(path.join(stateDir, "Tasks"), { recursive: true });
      }
      // A user's file in it is an input, and a DevFn file there is no input.
      await writeFile(path.join(stateDir, "notes.sql"), "-- changed");
      expect(await revision()).not.toBe(before);
      await expect(taskInputRevision(config([path.relative(primary, path.join(stateDir, "registry.json"))]), primary, { name: "seed", kind: "process" }, "default")).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      await rm(path.join(stateDir, "notes.sql"));
      expect(await revision()).not.toBe(before);
    }
  } finally {
    lifecycle.recorded = undefined; lifecycle.read = undefined; reads.before = undefined;
    for (const [stateDir, runtime] of states) await orchestrator.down({ config: sibling, root: primary, stateDir, runtime }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 180_000);

it("keeps a task's input revision when a start into an existing state directory inside the checkout is killed after recording its runtime identity, and a later start and stop succeed, also in one --trust created", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "killed-state-input" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const sibling = validateDevFnConfig({ version: 1, project: { id: "killed-state-input" }, processes: {}, profiles: { default: { processes: [] } } });
  const orchestrator = new DevFnOrchestrator();
  const revision = async () => await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default");
  const stateDir = path.join(primary, "cache", "state");
  try {
    await mkdir(stateDir, { recursive: true });
    const before = await revision();
    // What a start killed before its claim binds leaves on disk: the state directory's record, then runtime-id, and no cleanup.
    await recordStateDirectory(sibling, primary, await resolveInstanceIdentity("killed-state-input", primary, "b"), stateDir);
    await recordRuntimeId(stateDir, newRuntimeId());
    expect(await revision()).toBe(before);
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "b" })).state).toBe("ready");
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "b" })).state).toBe("stopped");
    expect(await revision()).toBe(before);
    // A state directory `--trust` created holds only DevFn's entries when a start first records it, so it is DevFn's, also after trust is refreshed.
    const trusted = path.join(primary, ".state");
    await writeFile(path.join(parent, "devfn.json"), "{}");
    await trustProject(primary, path.join(parent, "devfn.json"), trusted);
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: trusted, runtime: "c" })).state).toBe("ready");
    expect(await revision()).toBe(before);
    await trustProject(primary, path.join(parent, "devfn.json"), trusted);
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir: trusted, runtime: "c" })).state).toBe("stopped");
    expect(await revision()).toBe(before);
    // Moved to a state directory elsewhere, it still holds what it left in this one.
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: path.join(parent, "elsewhere"), runtime: "b" })).state).toBe("ready");
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir: path.join(parent, "elsewhere"), runtime: "b" })).state).toBe("stopped");
    expect(await revision()).toBe(before);
    // Two runtimes sharing an existing empty state directory, also with a refused stop of a third and trust refreshed there, keep its marker.
    const common = path.join(primary, "common");
    await mkdir(common);
    const withCommon = await revision();
    // Runtime d recorded it and was killed before writing there; e's --trust then writes only trust state into it before e starts.
    await recordStateDirectory(sibling, primary, await resolveInstanceIdentity("killed-state-input", primary, "d"), common);
    await expect(orchestrator.down({ config: sibling, root: primary, stateDir: common, runtime: "e" })).rejects.toMatchObject({ code: "DEVFN_NOT_RUNNING" });
    await trustProject(primary, path.join(parent, "devfn.json"), common);
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: common, runtime: "e" })).state).toBe("ready");
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: common, runtime: "d" })).state).toBe("ready");
    for (const runtime of ["d", "e"]) expect((await orchestrator.down({ config: sibling, root: primary, stateDir: common, runtime })).state).toBe("stopped");
    expect(await revision()).toBe(withCommon);
    // A refused stop naming a source directory records nothing there, so a user's file named like DevFn's stays an input.
    await mkdir(path.join(primary, "src", "tasks"), { recursive: true });
    await writeFile(path.join(primary, "src", "tasks", "seed.sql"), "select 1;");
    await expect(orchestrator.down({ config: sibling, root: primary, stateDir: path.join(primary, "src"), runtime: "f" })).rejects.toMatchObject({ code: "DEVFN_NOT_RUNNING" });
    const withSrc = await revision();
    await writeFile(path.join(primary, "src", "tasks", "seed.sql"), "select 2;");
    expect(await revision()).not.toBe(withSrc);
    // Nor does a start or stop naming it while the runtime runs with another state directory.
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: path.join(parent, "f-state"), runtime: "f" })).state).toBe("ready");
    for (const command of [() => orchestrator.up({ config: sibling, root: primary, stateDir: path.join(primary, "src"), runtime: "f" }), () => orchestrator.down({ config: sibling, root: primary, stateDir: path.join(primary, "src"), runtime: "f" })]) {
      await expect(command()).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
    }
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir: path.join(parent, "f-state"), runtime: "f" })).state).toBe("stopped");
    const afterMismatch = await revision();
    await writeFile(path.join(primary, "src", "tasks", "seed.sql"), "select 3;");
    expect(await revision()).not.toBe(afterMismatch);
    // A start refused after it recorded an existing directory but before it wrote there takes that record back, also from a claim it had before.
    await mkdir(path.join(primary, "src2", "tasks"), { recursive: true });
    await writeFile(path.join(primary, "src2", "tasks", "seed.sql"), "select 1;");
    const withSrc2 = await revision();
    // Its start's claim of outputs fails creating its runtime directory, before it writes in src2.
    const fDirectory = path.resolve(runtimeDirectory(sibling, primary, (await resolveInstanceIdentity("killed-state-input", primary, "f")).instanceId));
    made.fail = (directory) => path.resolve(directory) === fDirectory ? Object.assign(new Error("injected runtime directory failure"), { code: "EACCES" }) : undefined;
    await expect(orchestrator.up({ config: sibling, root: primary, stateDir: path.join(primary, "src2"), runtime: "f" })).rejects.toThrow("injected runtime directory failure");
    made.fail = undefined;
    expect(await revision()).toBe(withSrc2);
    await writeFile(path.join(primary, "src2", "tasks", "seed.sql"), "select 2;");
    expect(await revision()).not.toBe(withSrc2);
  } finally {
    made.fail = undefined;
    await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "b" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("makes a stop wait for a start of its runtime in flight, then stop what it started, rather than report it not running", async () => {
  const { parent, primary } = await repository();
  const listen = [process.execPath, "-e", "require('node:net').createServer().listen(Number(process.env.PORT), '127.0.0.1')"];
  const config = validateDevFnConfig({ version: 1, project: { id: "racing-stop" }, ports: { r: { env: "PORT" } },
    processes: { app: { adapter: "command", command: listen, ports: ["r"] } }, profiles: { default: { processes: ["app"] } } } as never);
  const orchestrator = new DevFnOrchestrator();
  const stateDir = path.join(parent, "state");
  const reserve = FilePortRegistry.prototype.reserve;
  let stopping: Promise<{ state: string }> | undefined;
  const spy = vi.spyOn(FilePortRegistry.prototype, "reserve").mockImplementation(async function (this: FilePortRegistry, ...args: Parameters<FilePortRegistry["reserve"]>) {
    // The start holds its lifecycle lock and has written no receipt yet.
    stopping ??= orchestrator.down({ config, root: primary, stateDir, runtime: "b" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return await reserve.apply(this, args);
  });
  try {
    expect((await orchestrator.up({ config, root: primary, stateDir, runtime: "b" })).state).toBe("ready");
    spy.mockRestore();
    expect((await stopping!).state).toBe("stopped");
  } finally {
    spy.mockRestore();
    await stopping?.catch(() => undefined);
    await orchestrator.down({ config, root: primary, stateDir, runtime: "b" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("keeps a task's input revision when two starts of one runtime race into an existing state directory inside the checkout and the first, refused after recording it, withdraws its record", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "racing-state-input" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const listen = [process.execPath, "-e", "require('node:net').createServer().listen(Number(process.env.PORT), '127.0.0.1')"];
  const sibling = validateDevFnConfig({ version: 1, project: { id: "racing-state-input" }, ports: { r: { env: "PORT" } },
    processes: { redis: { adapter: "command", command: listen, ports: ["r"] }, worker: { adapter: "command", command: [process.execPath, "-e", "setInterval(() => undefined, 1_000)"], resources: ["cache"] } },
    resources: { cache: { kind: "cache", defaultTarget: "local", targets: { local: { node: "redis", port: "r", scheme: "redis" } } } }, profiles: { default: { processes: ["worker", "redis"] } } } as never);
  const orchestrator = new DevFnOrchestrator();
  const revision = async () => await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default");
  const stateDir = path.join(primary, "cache", "state");
  const claims = path.join(".devfn", "receipts", "outputs");
  const start = new AsyncLocalStorage<"a" | "b">();
  const { instanceId } = await resolveInstanceIdentity("racing-state-input", primary, "b");
  const events: string[] = [];
  // A step the interleaving needs that never comes fails the test, rather than letting it go on without that interleaving.
  const until = async (event: string, ms = 20_000) => {
    for (const deadline = Date.now() + ms; !events.includes(event);) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${event}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const claim = path.join(primary, claims, `${instanceId}.json`);
  const recorded = async () => await readFile(claim, "utf8").then((text) => (JSON.parse(text) as { shared?: string[] }).shared?.includes(stateDir) ?? false, () => false);
  let recordedAtWrite: boolean | undefined;
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    const before = await revision();
    // b asks for the instance lock once a recorded the state directory; a later request, made only where a start takes it step by step,
    // waits for a to end. a, at its next lifecycle lock after recording, goes on once b asked and had a chance to record the directory too,
    // which the instance lock a holds must exclude.
    let chance = false;
    lockFailures.before = async (lockPath) => {
      if (path.basename(lockPath) !== `lifecycle-${instanceId}.lock`) return;
      if (start.getStore() === "b" && path.dirname(lockPath).endsWith(claims)) {
        if (events.includes("b recorded")) return await until("a ended");
        await until("a recorded");
        events.push("b waits");
      }
      if (start.getStore() !== "a" || !events.includes("a recorded") || chance) return;
      chance = true;
      await until("b waits");
      for (const deadline = Date.now() + 3_000; !events.includes("b recorded") && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    made.after = async (directory) => { if (directory === stateDir) events.push(`${start.getStore()} recorded`); };
    // a is refused right before it would record the runtime identity, so it changed no DevFn entry there; b's identity is the first write sampled.
    lifecycle.recording = async () => {
      events.push(`${start.getStore()} writes`);
      if (start.getStore() === "a") throw new Error("a refused before writing");
      recordedAtWrite = await recorded();
    };
    const samples: string[] = [];
    lifecycle.recorded = async () => { samples.push(await revision()); };
    const a = start.run("a", async () => await orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "b" })).finally(() => { events.push("a ended"); });
    const b = start.run("b", async () => await orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "b" }));
    await expect(a).rejects.toThrow("a refused before writing");
    expect((await b).state).toBe("ready");
    // b waited at the lock while a held its record, and recorded the state directory again only after a was refused and withdrew under that lock.
    expect(events.filter((event, index) => event !== "a ended" && events.indexOf(event) === index)).toEqual(["a recorded", "b waits", "a writes", "b recorded", "b writes"]);
    expect(recordedAtWrite).toBe(true);
    expect(samples).toEqual([before]);
    expect(await revision()).toBe(before);
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "b" })).state).toBe("stopped");
    expect(await revision()).toBe(before);
  } finally {
    made.after = undefined; lockFailures.before = undefined; lifecycle.recording = undefined; lifecycle.recorded = undefined;
    await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "b" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it.each([["domains.json"], [path.join("tasks", "seed.json")]])("keeps the record of an existing state directory inside the checkout when a refused start changed DevFn's %s there, also keeping its size and modification times", async (entry) => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "changed-state-entry" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const sibling = validateDevFnConfig({ version: 1, project: { id: "changed-state-entry" }, processes: {}, profiles: { default: { processes: [] } } });
  const orchestrator = new DevFnOrchestrator();
  const revision = async () => await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default");
  const stateDir = path.join(primary, "kept", "state");
  const domains = path.join(stateDir, entry);
  try {
    await mkdir(path.dirname(domains), { recursive: true });
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    await writeFile(domains, "{\"a\":1}");
    for (const item of [domains, path.dirname(domains)]) await utimes(item, 1_000, 1_000);
    // The start rewrites DevFn's entry there in place, then is refused creating its runtime directory.
    const runtimeDir = path.resolve(runtimeDirectory(sibling, primary, (await resolveInstanceIdentity("changed-state-entry", primary, "b")).instanceId));
    made.fail = (directory) => {
      if (path.resolve(directory) !== runtimeDir) return undefined;
      writeFileSync(domains, "{\"a\":2}");
      for (const item of [domains, path.dirname(domains)]) utimesSync(item, 1_000, 1_000);
      return Object.assign(new Error("injected runtime directory failure"), { code: "EACCES" });
    };
    await expect(orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "b" })).rejects.toThrow("injected runtime directory failure");
    made.fail = undefined;
    // DevFn's entry stays held; a user's file there stays an input.
    const after = await revision();
    await writeFile(domains, "{\"rewritten\":true}");
    expect(await revision()).toBe(after);
    await writeFile(path.join(stateDir, "notes.sql"), "-- changed");
    expect(await revision()).not.toBe(after);
  } finally {
    made.fail = undefined;
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("decides DevFn's entry names in an existing state directory by that directory's own filesystem, so a user's file there differing only in case is an input where the filesystem keeps case apart", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "cased-state-entry" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const sibling = validateDevFnConfig({ version: 1, project: { id: "cased-state-entry" }, processes: {}, profiles: { default: { processes: [] } } });
  const orchestrator = new DevFnOrchestrator();
  const revision = async () => await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default");
  const stateDir = path.join(primary, "cased", "state");
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "b" })).state).toBe("ready");
    const folds = await foldsCaseHere(stateDir);
    for (const name of ["Domains.JSON", "TASKS"]) {
      await writeFile(path.join(stateDir, name), "one");
      const before = await revision();
      await writeFile(path.join(stateDir, name), "two");
      // Folding, the name is DevFn's own entry in another spelling; kept apart, it is the user's.
      if (folds) expect(await revision()).toBe(before);
      else expect(await revision()).not.toBe(before);
      await rm(path.join(stateDir, name));
    }
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "b" })).state).toBe("stopped");
  } finally {
    await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "b" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

// Opt in on macOS with DEVFN_CASE_MOUNTS=1: it attaches a small case-sensitive disk image as the state directory and detaches it.
it.skipIf(process.platform !== "darwin" || process.env.DEVFN_CASE_MOUNTS !== "1")("decides DevFn's entry spellings inside a state directory mounted with another case policy than the checkout holding it", async () => {
  const { parent, primary } = await repository();
  const sibling = validateDevFnConfig({ version: 1, project: { id: "case-mount" }, processes: {}, profiles: { default: { processes: [] } } });
  const config = validateDevFnConfig({ version: 1, project: { id: "case-mount" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const orchestrator = new DevFnOrchestrator();
  const revision = async () => await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default");
  const stateDir = path.join(primary, "cs");
  let mounted = false;
  try {
    // The checkout folds case (the default macOS volume) and its state directory, a mounted volume, keeps case apart.
    expect(await foldsCaseHere(primary)).toBe(true);
    await execFileAsync("hdiutil", ["create", "-quiet", "-size", "64m", "-type", "SPARSE", "-fs", "Case-sensitive APFS", "-volname", "devfn-case", path.join(parent, "cs.sparseimage")]);
    await mkdir(stateDir);
    await execFileAsync("hdiutil", ["attach", "-quiet", "-nobrowse", "-mountpoint", stateDir, path.join(parent, "cs.sparseimage")]);
    mounted = true;
    expect(await foldsCaseHere(stateDir)).toBe(false);
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "b" })).state).toBe("ready");
    // A user's file there differing from DevFn's name only in case is an input; DevFn's own spelling is not.
    await writeFile(path.join(stateDir, "Domains.JSON"), "one");
    await writeFile(path.join(stateDir, "domains.json"), "one");
    const before = await revision();
    await writeFile(path.join(stateDir, "domains.json"), "two");
    expect(await revision()).toBe(before);
    await writeFile(path.join(stateDir, "Domains.JSON"), "two");
    expect(await revision()).not.toBe(before);
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "b" })).state).toBe("stopped");
  } finally {
    await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "b" }).catch(() => undefined);
    if (mounted) await execFileAsync("hdiutil", ["detach", "-quiet", "-force", stateDir]).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("gives every caller the same task-input revision over a state directory inside the checkout, whichever state directory it uses itself", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "caller-state-input" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const sibling = validateDevFnConfig({ version: 1, project: { id: "caller-state-input" }, processes: {}, profiles: { default: { processes: [] } } });
  const orchestrator = new DevFnOrchestrator();
  const existing = path.join(primary, "state-a"), created = path.join(primary, "made", "state");
  const b = await resolveInstanceIdentity("caller-state-input", primary, "b"), c = await resolveInstanceIdentity("caller-state-input", primary, "c");
  // The runtime using the state directory, and a sibling using one outside the checkout.
  const both = async (stateDir: string) => await Promise.all([[stateDir, b.instanceId], [path.join(parent, "elsewhere"), c.instanceId]].map(async ([own, instanceId]) =>
    await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default", undefined, undefined, own, instanceId)));
  try {
    await mkdir(existing);
    await writeFile(path.join(existing, "notes.sql"), "-- mine");
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: existing, runtime: "b" })).state).toBe("ready");
    const [own, other] = await both(existing);
    expect(own).toBe(other);
    // A task journal there is DevFn's for both; a user's file there is an input for both.
    await mkdir(path.join(existing, "tasks"), { recursive: true });
    await writeFile(path.join(existing, "tasks", "journal.json"), "{}");
    expect(await both(existing)).toEqual([own, other]);
    await writeFile(path.join(existing, "notes.sql"), "-- changed");
    const [ownChanged, otherChanged] = await both(existing);
    expect(ownChanged).not.toBe(own);
    expect(ownChanged).toBe(otherChanged);
    expect((await orchestrator.down({ config: sibling, root: primary, stateDir: existing, runtime: "b" })).state).toBe("stopped");
    expect(await both(existing)).toEqual([ownChanged, otherChanged]);
    // One the start made is held whole for both.
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir: created, runtime: "b" })).state).toBe("ready");
    const [ownMade, otherMade] = await both(created);
    expect(ownMade).toBe(otherMade);
    await writeFile(path.join(created, "notes.sql"), "-- mine");
    expect(await both(created)).toEqual([ownMade, otherMade]);
  } finally {
    await orchestrator.down({ config: sibling, root: primary, stateDir: created, runtime: "b" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it.each([["empty"], ["populated"]])("keeps once and on-change completions an earlier release recorded while it held an existing state directory inside the checkout (%s) whole, rebinding them so a later change there counts, and still acts on a source edit", async (kind) => {
  const { parent, primary } = await repository();
  const logs = { once: path.join(parent, "once.log"), change: path.join(parent, "change.log") };
  const append = (log: string) => [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n")`];
  const config = validateDevFnConfig({ version: 1, project: { id: "earlier-journal" },
    processes: { once: { adapter: "command", command: append(logs.once), task: { rerun: "once", inputs: ["."] } }, change: { adapter: "command", command: append(logs.change), task: { rerun: "on-change", inputs: ["."] } } },
    profiles: { default: { processes: ["once"] }, change: { processes: ["change"] } } });
  const profileOf = { once: "default", change: "change" } as const;
  const orchestrator = new DevFnOrchestrator();
  const stateDir = path.join(primary, "cache", "state");
  const { instanceId } = await resolveInstanceIdentity("earlier-journal", primary);
  const runs = async (name: "once" | "change") => (await readFile(logs[name], "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const revision = async (name: "once" | "change") => await taskInputRevision(config, primary, { name, kind: "process" }, profileOf[name], undefined, undefined, stateDir, instanceId);
  const journal = (name: "once" | "change") => path.join(stateDir, "tasks", `${taskScope(config, instanceId, { name, kind: "process" }).key}.json`);
  const start = async (name: "once" | "change") => {
    const profile = profileOf[name];
    try { return (await orchestrator.up({ config, root: primary, stateDir, profile })).state; }
    finally { await orchestrator.down({ config, root: primary, stateDir, profile }).catch(() => undefined); }
  };
  try {
    await mkdir(path.join(stateDir, "tasks"), { recursive: true });
    if (kind === "populated") await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    // An earlier release held this state directory whole: the revision it recorded is what DevFn gives before it records the directory.
    const earlier: Record<string, string> = {};
    for (const name of ["once", "change"] as const) {
      earlier[name] = await revision(name);
      const success = { invocationId: "earlier", instanceId, completedAt: new Date(0).toISOString() };
      await writeFile(journal(name), JSON.stringify({ version: 1, task: name, scope: "instance", lastSuccess: { inputRevision: earlier[name], ...success },
        attempts: [{ ...success, attempt: 1, inputRevision: earlier[name], startedAt: success.completedAt, endedAt: success.completedAt, outcome: "succeeded", effects: "applied", stopped: true }] }));
    }
    // Neither reruns or refuses, and each completion is rebound to the revision that now holds only DevFn's entries there.
    for (const name of ["once", "change"] as const) {
      expect(await start(name)).toBe("ready");
      const current = await revision(name);
      expect(current).not.toBe(earlier[name]);
      expect((await readTaskJournal(stateDir, path.basename(journal(name), ".json")))?.lastSuccess).toMatchObject({ inputRevision: current, stateEntries: true });
      expect(await start(name)).toBe("ready");
    }
    expect([await runs("once"), await runs("change")]).toEqual([0, 0]);
    // A user's file there is an input once rebound.
    await writeFile(path.join(stateDir, "notes.sql"), "-- changed");
    await expect(orchestrator.up({ config, root: primary, stateDir, profile: "default" })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
    expect(await start("change")).toBe("ready");
    expect([await runs("once"), await runs("change")]).toEqual([0, 1]);
    // So is a source edit.
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    await expect(orchestrator.up({ config, root: primary, stateDir, profile: "default" })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
    expect(await start("change")).toBe("ready");
    expect([await runs("once"), await runs("change")]).toEqual([0, 2]);
  } finally {
    for (const profile of ["default", "change"]) await orchestrator.down({ config, root: primary, stateDir, profile }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("keeps a ready lifecycle an earlier release started, whose task completion held its existing state directory inside the checkout whole, as ready and running", async () => {
  const { parent, primary } = await repository();
  const log = path.join(parent, "runs.log");
  const config = validateDevFnConfig({ version: 1, project: { id: "earlier-ready" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n")`], task: { rerun: "once", inputs: ["."] } },
      web: { adapter: "command", command: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"], dependsOn: ["seed"] } },
    profiles: { default: { processes: ["seed", "web"] } } });
  const orchestrator = new DevFnOrchestrator();
  const stateDir = path.join(primary, "cache", "state");
  const { instanceId } = await resolveInstanceIdentity("earlier-ready", primary);
  const receiptFile = path.join(primary, ".devfn", "receipts", `${instanceId}.json`);
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    const earlier = await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default", undefined, undefined, stateDir, instanceId);
    expect((await orchestrator.up({ config, root: primary, stateDir })).state).toBe("ready");
    // The earlier release's receipt and journal recorded the revision that held the state directory whole.
    const receipt = JSON.parse(await readFile(receiptFile, "utf8")) as { tasks: Array<{ inputRevision: string; lastSuccess?: { inputRevision: string; stateEntries?: true } }> };
    expect(receipt.tasks[0].inputRevision).not.toBe(earlier);
    receipt.tasks[0].inputRevision = earlier;
    receipt.tasks[0].lastSuccess = { ...receipt.tasks[0].lastSuccess!, inputRevision: earlier, stateEntries: undefined };
    await writeFile(receiptFile, JSON.stringify(receipt));
    const key = taskScope(config, instanceId, { name: "seed", kind: "process" }).key, journal = path.join(stateDir, "tasks", `${key}.json`);
    const recorded = JSON.parse(await readFile(journal, "utf8")) as { lastSuccess: { inputRevision: string; stateEntries?: true } };
    recorded.lastSuccess = { ...recorded.lastSuccess, inputRevision: earlier, stateEntries: undefined };
    await writeFile(journal, JSON.stringify(recorded));
    expect((await orchestrator.status({ config, root: primary })).state).toBe("ready");
    await expect(orchestrator.up({ config, root: primary, stateDir })).rejects.toMatchObject({ code: "DEVFN_ALREADY_RUNNING" });
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
  } finally {
    await orchestrator.down({ config, root: primary, stateDir }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

/** Two tasks, a once and an on-change one appending to a log each, reading inputs and selected by their own profile. */
function twoTasks(parent: string, id: string, inputs: string[]) {
  const logs = { once: path.join(parent, "once.log"), change: path.join(parent, "change.log") };
  const append = (log: string) => [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n")`];
  const config = validateDevFnConfig({ version: 1, project: { id },
    processes: { once: { adapter: "command", command: append(logs.once), task: { rerun: "once", inputs } }, change: { adapter: "command", command: append(logs.change), task: { rerun: "on-change", inputs } } },
    profiles: { default: { processes: ["once"] }, change: { processes: ["change"] }, none: { processes: [] } } });
  const runs = async (name: "once" | "change") => (await readFile(logs[name], "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { config, runs, profileOf: { once: "default", change: "change" } as const };
}

it("never takes a completion this release recorded for an earlier release's where holding the caller's existing state directory whole gives the same revision, and marks an earlier one that matches as it is", async () => {
  const { parent, primary } = await repository();
  const { config, runs, profileOf } = twoTasks(parent, "same-rule", ["."]);
  const orchestrator = new DevFnOrchestrator();
  // DevFn's own runtime directory as the state directory: its marker is the config's state either way, so both rules agree while it holds only DevFn's entries.
  const stateDir = path.join(primary, ".devfn");
  const { instanceId } = await resolveInstanceIdentity("same-rule", primary);
  const revision = async (name: "once" | "change") => await taskInputRevision(config, primary, { name, kind: "process" }, profileOf[name], undefined, undefined, stateDir, instanceId);
  const key = (name: "once" | "change") => taskScope(config, instanceId, { name, kind: "process" }).key;
  const start = async (name: "once" | "change") => {
    try { return (await orchestrator.up({ config, root: primary, stateDir, profile: profileOf[name] })).state; }
    finally { await orchestrator.down({ config, root: primary, stateDir, profile: profileOf[name] }).catch(() => undefined); }
  };
  try {
    await mkdir(path.join(stateDir, "tasks"), { recursive: true });
    const earlier = await revision("once");
    const success = { invocationId: "earlier", instanceId, completedAt: new Date(0).toISOString() };
    await writeFile(path.join(stateDir, "tasks", `${key("once")}.json`), JSON.stringify({ version: 1, task: "once", scope: "instance", lastSuccess: { inputRevision: earlier, ...success },
      attempts: [{ ...success, attempt: 1, inputRevision: earlier, startedAt: success.completedAt, endedAt: success.completedAt, outcome: "succeeded", effects: "applied", stopped: true }] }));
    // The earlier release's completion matches as it is and is marked; the on-change task's first run is this release's.
    expect(await start("once")).toBe("ready");
    expect(await revision("once")).toBe(earlier);
    expect((await readTaskJournal(stateDir, key("once")))?.lastSuccess).toMatchObject({ inputRevision: earlier, stateEntries: true });
    expect(await start("change")).toBe("ready");
    expect((await readTaskJournal(stateDir, key("change")))?.lastSuccess?.stateEntries).toBe(true);
    expect([await runs("once"), await runs("change")]).toEqual([0, 1]);
    // A user's file there then changes both, though holding the directory whole still gives the recorded revision.
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    expect(await taskInputRevision(config, primary, { name: "once", kind: "process" }, "default", undefined, undefined, stateDir, instanceId, earlier)).toBe(earlier);
    await expect(orchestrator.up({ config, root: primary, stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
    expect(await start("change")).toBe("ready");
    expect([await runs("once"), await runs("change")]).toEqual([0, 2]);
  } finally {
    for (const profile of ["default", "change"]) await orchestrator.down({ config, root: primary, stateDir, profile }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("decides a task reading a user's file in its own existing state directory inside the checkout by the current rule, also against an earlier release's completion that rule never gave", async () => {
  const { parent, primary } = await repository();
  const { config, runs, profileOf } = twoTasks(parent, "own-state-input", ["state/notes.sql"]);
  const orchestrator = new DevFnOrchestrator();
  const stateDir = path.join(primary, "state");
  const { instanceId } = await resolveInstanceIdentity("own-state-input", primary);
  const start = async (name: "once" | "change") => {
    try { return (await orchestrator.up({ config, root: primary, stateDir, profile: profileOf[name] })).state; }
    finally { await orchestrator.down({ config, root: primary, stateDir, profile: profileOf[name] }).catch(() => undefined); }
  };
  try {
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    // A start without tasks records the existing state directory, so its user's file is an input from then on.
    expect((await orchestrator.up({ config, root: primary, stateDir, profile: "none" })).state).toBe("ready");
    await orchestrator.down({ config, root: primary, stateDir, profile: "none" });
    expect(await start("once")).toBe("ready");
    expect(await start("change")).toBe("ready");
    await writeFile(path.join(stateDir, "notes.sql"), "-- changed");
    await expect(orchestrator.up({ config, root: primary, stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
    expect(await start("change")).toBe("ready");
    expect([await runs("once"), await runs("change")]).toEqual([1, 2]);
    // An earlier release's completion: holding the directory whole refuses this input, so it matches nothing and the task runs.
    const journal = path.join(stateDir, "tasks", `${taskScope(config, instanceId, { name: "change", kind: "process" }).key}.json`);
    const recorded = JSON.parse(await readFile(journal, "utf8")) as { lastSuccess: { inputRevision: string; stateEntries?: true } };
    recorded.lastSuccess = { ...recorded.lastSuccess, inputRevision: "0".repeat(64), stateEntries: undefined };
    await writeFile(journal, JSON.stringify(recorded));
    expect(await start("change")).toBe("ready");
    expect(await runs("change")).toBe(3);
  } finally {
    for (const profile of ["default", "change", "none"]) await orchestrator.down({ config, root: primary, stateDir, profile }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

it("accepts a completed revision only where the earlier rule, holding the caller's existing state directory inside the checkout whole, gives it", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "earlier-rule" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const sibling = validateDevFnConfig({ version: 1, project: { id: "earlier-rule" }, processes: {}, profiles: { default: { processes: [] } } });
  const orchestrator = new DevFnOrchestrator();
  const stateDir = path.join(primary, "state");
  const { instanceId } = await resolveInstanceIdentity("earlier-rule", primary, "b");
  const revision = async (completed?: string) => await taskInputRevision(config, primary, { name: "seed", kind: "process" }, "default", undefined, undefined, stateDir, instanceId, completed);
  try {
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    const earlier = await revision();
    expect((await orchestrator.up({ config: sibling, root: primary, stateDir, runtime: "b" })).state).toBe("ready");
    const current = await revision();
    expect(current).not.toBe(earlier);
    expect(await revision(earlier)).toBe(earlier);
    expect(await revision(current)).toBe(current);
    expect(await revision("0".repeat(64))).toBe(current);
    // A change outside the state directory changes both rules' revisions; one inside it only the current rule's.
    await writeFile(path.join(stateDir, "notes.sql"), "-- changed");
    expect(await revision(earlier)).toBe(earlier);
    expect(await revision()).not.toBe(current);
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    expect(await revision(earlier)).not.toBe(earlier);
  } finally {
    await orchestrator.down({ config: sibling, root: primary, stateDir, runtime: "b" }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("decides an unlocked preflight from the one journal snapshot it read, while a concurrent start binds an earlier release's completion before the inputs are walked", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "snapshot-race" },
    processes: { once: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "once", inputs: ["."] } } }, profiles: { default: { processes: ["once"] } } });
  const node = { name: "once", kind: "process" as const };
  const stateDir = path.join(primary, "cache", "state");
  const identity = await resolveInstanceIdentity("snapshot-race", primary);
  const file = path.join(stateDir, "tasks", `${taskScope(config, identity.instanceId, node).key}.json`);
  const success = { invocationId: "earlier", instanceId: identity.instanceId, completedAt: new Date(0).toISOString() };
  const journal = (revision: string, marked: boolean) => JSON.stringify({ version: 1, task: "once", scope: "instance", lastSuccess: { inputRevision: revision, ...success, ...(marked ? { stateEntries: true } : {}) },
    attempts: [{ ...success, attempt: 1, inputRevision: revision, startedAt: success.completedAt, endedAt: success.completedAt, outcome: "succeeded", effects: "applied", stopped: true }] });
  try {
    await mkdir(path.join(stateDir, "tasks"), { recursive: true });
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const earlier = await taskInputRevision(config, primary, node, "default", undefined, undefined, stateDir, identity.instanceId);
    await recordStateDirectory(config, primary, identity, stateDir);
    const current = await taskInputRevision(config, primary, node, "default", undefined, undefined, stateDir, identity.instanceId);
    expect(current).not.toBe(earlier);
    await writeFile(file, journal(earlier, false));
    // Right after the preflight read the earlier release's journal, a concurrent start's task binds it to the current revision.
    const events: string[] = [];
    reads.before = async (operation, target) => {
      if (operation === "readFile" && target === file && !events.includes("read")) { events.push("read"); return; }
      if (events.includes("read") && !events.includes("bound")) { events.push("bound"); writeFileSync(file, journal(current, true)); }
    };
    await preflightTasks({ config, plan: createPlan(config, "default"), root: primary, stateDir, instanceId: identity.instanceId });
    expect(events).toEqual(["read", "bound"]);
    // A once task whose input really changed still refuses, from a bound or an earlier journal alike.
    reads.before = undefined;
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    for (const recorded of [journal(current, true), journal(earlier, false)]) {
      await writeFile(file, recorded);
      await expect(preflightTasks({ config, plan: createPlan(config, "default"), root: primary, stateDir, instanceId: identity.instanceId })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
    }
  } finally {
    reads.before = undefined;
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("reruns an idempotent once task whose unresolved attempt an earlier release recorded where it held its existing state directory whole, and refuses it once its inputs changed since", async () => {
  const { parent, primary } = await repository();
  const log = path.join(parent, "runs.log");
  const config = validateDevFnConfig({ version: 1, project: { id: "earlier-attempt" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n")`], task: { rerun: "once", idempotent: true, inputs: ["."] } } },
    profiles: { default: { processes: ["seed"] } } });
  const node = { name: "seed", kind: "process" as const };
  const orchestrator = new DevFnOrchestrator();
  const stateDir = path.join(primary, "cache", "state");
  const { instanceId } = await resolveInstanceIdentity("earlier-attempt", primary);
  const key = taskScope(config, instanceId, node).key;
  const revision = async () => await taskInputRevision(config, primary, node, "default", undefined, undefined, stateDir, instanceId);
  const runs = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  try {
    await mkdir(path.join(stateDir, "tasks"), { recursive: true });
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    // The earlier release succeeded for one source, then an attempt for an edited one ended with unknown effects.
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const succeeded = await revision();
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    const attempted = await revision();
    const at = new Date(0).toISOString();
    await writeFile(path.join(stateDir, "tasks", `${key}.json`), JSON.stringify({ version: 1, task: "seed", scope: "instance",
      lastSuccess: { inputRevision: succeeded, invocationId: "earlier", instanceId, completedAt: at },
      attempts: [{ invocationId: "earlier", instanceId, attempt: 1, inputRevision: succeeded, startedAt: at, endedAt: at, outcome: "succeeded", effects: "applied", stopped: true },
        { invocationId: "failed", instanceId, attempt: 1, inputRevision: attempted, startedAt: at, endedAt: at, outcome: "failed", exitCode: 1, effects: "unknown", stopped: true }] }));
    // Edited again since that attempt, it is refused as the earlier release refused it.
    await writeFile(path.join(primary, "schema.sql"), "create table v();");
    await expect(orchestrator.up({ config, root: primary, stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
    expect(await runs()).toBe(0);
    // At that attempt's inputs it reruns, and its success is this release's.
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    expect((await orchestrator.up({ config, root: primary, stateDir })).state).toBe("ready");
    expect(await runs()).toBe(1);
    expect((await readTaskJournal(stateDir, key))?.lastSuccess).toMatchObject({ inputRevision: await revision(), stateEntries: true });
  } finally {
    await orchestrator.down({ config, root: primary, stateDir }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("keeps the revision of an attempt this release recorded beside an earlier release's unmatched success, so an idempotent once task changed since it failed still needs an explicit rerun", async () => {
  const { parent, primary } = await repository();
  const log = path.join(parent, "runs.log"), failing = path.join(parent, "fail");
  const command = `const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(log)}, "x\\n"); process.exit(fs.existsSync(${JSON.stringify(failing)}) ? 1 : 0);`;
  const config = validateDevFnConfig({ version: 1, project: { id: "mixed-journal" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", command], task: { rerun: "once", idempotent: true, inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const node = { name: "seed", kind: "process" as const };
  const orchestrator = new DevFnOrchestrator();
  // DevFn's own runtime directory as the state directory: both rules agree while it holds only DevFn's entries.
  const stateDir = path.join(primary, ".devfn");
  const { instanceId } = await resolveInstanceIdentity("mixed-journal", primary);
  const key = taskScope(config, instanceId, node).key;
  const runs = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  try {
    await mkdir(path.join(stateDir, "tasks"), { recursive: true });
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const at = new Date(0).toISOString(), succeeded = await taskInputRevision(config, primary, node, "default", undefined, undefined, stateDir, instanceId);
    await writeFile(path.join(stateDir, "tasks", `${key}.json`), JSON.stringify({ version: 1, task: "seed", scope: "instance",
      lastSuccess: { inputRevision: succeeded, invocationId: "earlier", instanceId, completedAt: at },
      attempts: [{ invocationId: "earlier", instanceId, attempt: 1, inputRevision: succeeded, startedAt: at, endedAt: at, outcome: "succeeded", effects: "applied", stopped: true }] }));
    // An explicit rerun for an edited source fails; the earlier release's success matches neither rule and stays unmarked.
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    await writeFile(failing, "");
    await expect(orchestrator.up({ config, root: primary, stateDir, rerunTasks: ["seed"] })).rejects.toMatchObject({ code: "DEVFN_START_FAILED", details: { causeCode: "DEVFN_TASK_FAILED" } });
    await orchestrator.down({ config, root: primary, stateDir }).catch(() => undefined);
    const journal = await readTaskJournal(stateDir, key);
    expect(journal?.lastSuccess).toMatchObject({ inputRevision: succeeded });
    expect(journal?.lastSuccess?.stateEntries).toBeUndefined();
    expect(journal?.attempts.at(-1)).toMatchObject({ outcome: "failed", effects: "unknown", stateEntries: true });
    // A user's file there then changes the current revision only: that attempt's inputs are gone, so the task is not run again without an explicit rerun.
    await rm(failing);
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    await expect(orchestrator.up({ config, root: primary, stateDir })).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
    expect(await runs()).toBe(1);
    // Explicitly rerun, it succeeds for this release.
    expect((await orchestrator.up({ config, root: primary, stateDir, rerunTasks: ["seed"] })).state).toBe("ready");
    expect(await runs()).toBe(2);
  } finally {
    await orchestrator.down({ config, root: primary, stateDir }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("marks an earlier release's attempt once it is bound where both rules agree, so a later change in the state directory refuses its idempotent once task", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "bound-attempt" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "once", idempotent: true, inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const node = { name: "seed", kind: "process" as const };
  // DevFn's own runtime directory as the state directory: both rules agree while it holds only DevFn's entries.
  const stateDir = path.join(primary, ".devfn");
  const identity = await resolveInstanceIdentity("bound-attempt", primary);
  const key = taskScope(config, identity.instanceId, node).key, file = path.join(stateDir, "tasks", `${key}.json`);
  const revision = async () => await taskInputRevision(config, primary, node, "default", undefined, undefined, stateDir, identity.instanceId);
  const preflight = async () => await preflightTasks({ config, plan: createPlan(config, "default"), root: primary, stateDir, instanceId: identity.instanceId });
  try {
    await mkdir(path.join(stateDir, "tasks"), { recursive: true });
    await recordStateDirectory(config, primary, identity, stateDir);
    // The earlier release succeeded for one source, then an attempt for an edited one ended with unknown effects.
    await writeFile(path.join(primary, "schema.sql"), "create table t();");
    const succeeded = await revision();
    await writeFile(path.join(primary, "schema.sql"), "create table u();");
    const attempted = await revision();
    const at = new Date(0).toISOString();
    await writeFile(file, JSON.stringify({ version: 1, task: "seed", scope: "instance", lastSuccess: { inputRevision: succeeded, invocationId: "earlier", instanceId: identity.instanceId, completedAt: at },
      attempts: [{ invocationId: "failed", instanceId: identity.instanceId, attempt: 1, inputRevision: attempted, startedAt: at, endedAt: at, outcome: "failed", exitCode: 1, effects: "unknown", stopped: true }] }));
    // A start binds the journal under the scope lock and persists it, then stops before recording an attempt.
    const journal = await readTaskJournal(stateDir, key);
    expect(await taskInputRevision(config, primary, node, "default", undefined, undefined, stateDir, identity.instanceId, journal)).toBe(attempted);
    expect(journal?.attempts.at(-1)).toMatchObject({ inputRevision: attempted, stateEntries: true });
    expect(journal?.lastSuccess?.stateEntries).toBeUndefined();
    await writeFile(file, JSON.stringify(journal));
    await preflight();
    // A user's file there changes the current revision only; the bound attempt is not bound again, so the task needs an explicit rerun.
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    await expect(preflight()).rejects.toMatchObject({ code: "DEVFN_TASK_INPUT_CHANGED" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("walks a task's inputs once per revision check while an earlier release's completion matches neither rule", async () => {
  const { parent, primary } = await repository();
  const config = validateDevFnConfig({ version: 1, project: { id: "one-walk" },
    processes: { seed: { adapter: "command", command: [process.execPath, "-e", "0"], task: { rerun: "on-change", inputs: ["."] } } }, profiles: { default: { processes: ["seed"] } } });
  const node = { name: "seed", kind: "process" as const };
  const stateDir = path.join(primary, "state");
  const identity = await resolveInstanceIdentity("one-walk", primary);
  const root = await realpath(primary);
  const walks = { count: 0 };
  try {
    await mkdir(path.join(stateDir, "tasks"), { recursive: true });
    await writeFile(path.join(stateDir, "notes.sql"), "-- mine");
    await recordStateDirectory(config, primary, identity, stateDir);
    const at = new Date(0).toISOString(), mismatched = "0".repeat(64);
    await writeFile(path.join(stateDir, "tasks", `${taskScope(config, identity.instanceId, node).key}.json`), JSON.stringify({ version: 1, task: "seed", scope: "instance",
      lastSuccess: { inputRevision: mismatched, invocationId: "earlier", instanceId: identity.instanceId, completedAt: at },
      attempts: [{ invocationId: "earlier", instanceId: identity.instanceId, attempt: 1, inputRevision: mismatched, startedAt: at, endedAt: at, outcome: "succeeded", effects: "applied", stopped: true }] }));
    reads.before = async (operation, target) => { if (operation === "opendir" && target === root) walks.count += 1; };
    for (let check = 1; check <= 3; check += 1) {
      await taskInputRevision(config, primary, node, "default", undefined, undefined, stateDir, identity.instanceId, mismatched);
      await preflightTasks({ config, plan: createPlan(config, "default"), root: primary, stateDir, instanceId: identity.instanceId });
      expect(walks.count).toBe(2 * check);
    }
  } finally {
    reads.before = undefined;
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("refuses a state directory whose filesystem cannot link its lifecycle lock's owner record with the --state-dir remedy, before recording a runtime identity", async () => {
  const { parent, primary } = await repository();
  const listen = [process.execPath, "-e", "require('node:net').createServer().listen(Number(process.env.PORT), '127.0.0.1')"];
  const config = validateDevFnConfig({ version: 1, project: { id: "unlinked-state" }, ports: { r: { env: "PORT" } },
    processes: { redis: { adapter: "command", command: listen, ports: ["r"] }, worker: { adapter: "command", command: [process.execPath, "-e", "setInterval(() => undefined, 1_000)"], resources: ["cache"] } },
    resources: { cache: { kind: "cache", defaultTarget: "local", targets: { local: { node: "redis", port: "r", scheme: "redis" } } } }, profiles: { default: { processes: ["worker", "redis"] } } } as never);
  const orchestrator = new DevFnOrchestrator();
  const stateDir = path.join(parent, "unlinked");
  try {
    for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]) {
      lockFailures.fail = (lockPath) => path.dirname(lockPath) === stateDir && path.basename(lockPath).startsWith("lifecycle-") ? Object.assign(new Error(`link ${lockPath}`), { code }) : undefined;
      await expect(orchestrator.up({ config, root: primary, stateDir, runtime: "b" })).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining(`does not support hard links (${code})`) });
      await expect(orchestrator.up({ config, root: primary, stateDir, runtime: "b" })).rejects.toThrow("--state-dir");
      await expect(access(path.join(stateDir, "runtime-id"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    // Any other failure acquiring it is reported as it is.
    lockFailures.fail = (lockPath) => path.dirname(lockPath) === stateDir ? Object.assign(new Error("lock store failed"), { code: "EIO" }) : undefined;
    await expect(orchestrator.up({ config, root: primary, stateDir, runtime: "b" })).rejects.toMatchObject({ code: "EIO" });
  } finally {
    lockFailures.fail = undefined;
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

it("treats every path below a filesystem root as inside it", () => {
  const root = path.parse(process.cwd()).root;
  expect(within(path.join(root, "checkout", "state"), root)).toBe(true);
  expect(within(root, root)).toBe(true);
  expect(within(path.join(root, "checkout-other"), path.join(root, "checkout"))).toBe(false);
  expect(within(path.join(root, "checkout", "state"), path.join(root, "checkout"))).toBe(true);
});
