import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { access, chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { composeProjectName } from "@devfn/compose";
import { validateDevFnConfig, type DevFnConfig } from "@devfn/config";
import { FilePortRegistry, withFileLock } from "@devfn/ports";
import { proxyListenerPorts, proxyOwnerStatus } from "@devfn/proxy";
import { describe, expect, it, vi } from "vitest";

import { assertEnvironmentOutputsAvailable, claimEnvironmentOutputs } from "../src/outputs.js";
import { createPlan, DevFnOrchestrator, domainAliases, resolveEndpointTemplates, resolveInstanceIdentity, resolveLocalHostname, runtimeDirectory, selectRuntime, taskInputRevision } from "../src/index.js";

const execFileAsync = promisify(execFile);
// Lets a test act right after down releases a claim, as a sibling start in another process could.
const releases = vi.hoisted(() => ({ after: undefined as (() => Promise<void>) | undefined }));
const claimReads = vi.hoisted(() => ({ root: undefined as string | undefined, after: undefined as (() => Promise<void>) | undefined }));
vi.mock("../src/outputs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/outputs.js")>();
  return { ...actual, releaseEnvironmentOutputs: async (...args: Parameters<typeof actual.releaseEnvironmentOutputs>) => {
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
const reads = vi.hoisted(() => ({ before: undefined as ((operation: "lstat" | "readFile", file: string) => Promise<void>) | undefined }));
const made = vi.hoisted(() => ({ after: undefined as ((directory: string) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => { const created = await actual.mkdir(...args); await made.after?.(String(args[0])); return created; },
    lstat: async (...args: Parameters<typeof actual.lstat>) => { await reads.before?.("lstat", String(args[0])); return await actual.lstat(...args); },
    readFile: async (...args: Parameters<typeof actual.readFile>) => { await reads.before?.("readFile", String(args[0])); return await actual.readFile(...args); } };
});

// Lets a test act as soon as a stopped receipt's stable copy is written: at the first point writeReceipt yields after it, or once it returns.
const stops = vi.hoisted(() => ({ onStopped: undefined as ((copyAfterStable: boolean) => Promise<void>) | undefined }));
vi.mock("../src/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime.js")>();
  return { ...actual, writeReceipt: async (receipt: Parameters<typeof actual.writeReceipt>[0], options: Parameters<typeof actual.writeReceipt>[1] = {}) => {
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
      await writeFile(path.join(claims, "0123456789ab.json"), "{}");
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
it.skipIf(process.getuid?.() === 0)("releases a stopped runtime's output claim on a retried down when the first release failed, keeping its history and other runtimes' claims", async () => {
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
    await chmod(claims, 0o555);
    const failed = await orchestrator.down({ config, root: primary, stateDir, runtime: "a" });
    await chmod(claims, 0o700);
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
    await chmod(claims, 0o700).catch(() => undefined);
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
