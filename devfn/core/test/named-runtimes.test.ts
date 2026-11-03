import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { access, chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { composeProjectName } from "@devfn/compose";
import { validateDevFnConfig, type DevFnConfig } from "@devfn/config";
import { withFileLock } from "@devfn/ports";
import { proxyListenerPorts, proxyOwnerStatus } from "@devfn/proxy";
import { describe, expect, it } from "vitest";

import { assertEnvironmentOutputsAvailable, claimEnvironmentOutputs } from "../src/outputs.js";
import { createPlan, DevFnOrchestrator, domainAliases, resolveEndpointTemplates, resolveInstanceIdentity, resolveLocalHostname, runtimeDirectory, selectRuntime, taskInputRevision } from "../src/index.js";

const execFileAsync = promisify(execFile);

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
