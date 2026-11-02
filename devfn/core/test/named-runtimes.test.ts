import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { validateDevFnConfig, type DevFnConfig } from "@devfn/config";
import { withFileLock } from "@devfn/ports";
import { proxyOwnerStatus } from "@devfn/proxy";
import { describe, expect, it } from "vitest";

import { createPlan, DevFnOrchestrator, domainAliases, resolveEndpointTemplates, resolveInstanceIdentity, resolveLocalHostname, selectRuntime, taskInputRevision } from "../src/index.js";

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
      // A file the token cannot produce is an ordinary input.
      await writeFile(path.join(root, "config", "app.re_view.env"), "A=3\n");
      expect(await revision()).not.toBe(before);
      await expect(taskInputRevision(validateDevFnConfig({ ...config, processes: { migrate: { ...config.processes!.migrate, task: { inputs: ["config/app.review.env"] } } } }),
        root, { name: "migrate", kind: "process" }, "default")).rejects.toThrow(/DevFn runtime state/);
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
      const request = http.get({ host: "127.0.0.1", port: 8080, path: "/", headers: { host: hostname } }, (response) => {
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
