import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withFileLock } from "@devfn/ports";
import { processBirthSignature } from "@devfn/processes";
import { CaddyProxyController, proxyOwnerStatus, renderCaddyfile } from "../src/index.js";

// Fixtures that need the fixed Caddy admin port 127.0.0.1:2019 free share one
// machine-wide lock with other DevFn packages' fixtures that bind it.
const withCaddyAdminPort = async <T>(action: () => Promise<T>): Promise<T> =>
  await withFileLock(path.join(tmpdir(), "devfn-test-caddy-admin.lock"), action, { timeoutMs: 120_000 });

/**
 * A state directory owned by this live process, with a Caddy command stub
 * that accepts every command first on PATH and logs its subcommand for
 * caddyCalls(). cleanup() restores PATH and removes both directories.
 */
async function stubbedCaddyState(prefix: string): Promise<{ stateDir: string; cleanup: () => Promise<void>; caddyCalls: () => Promise<string[]> }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const toolsDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-tools-"));
  const originalPath = process.env.PATH;
  const birthSignature = await processBirthSignature(process.pid);
  if (!birthSignature) throw new Error("Test process has no birth signature.");
  await writeFile(path.join(stateDir, "proxy-owner.json"), JSON.stringify({ pid: process.pid, birthSignature }));
  const calls = path.join(toolsDir, "calls.log");
  await writeFile(path.join(toolsDir, "caddy"), `#!/bin/sh\necho "$1" >> '${calls}'\nexit 0\n`, { mode: 0o700 });
  process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
  return {
    stateDir,
    caddyCalls: async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean),
    cleanup: async () => {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      await rm(stateDir, { recursive: true, force: true });
      await rm(toolsDir, { recursive: true, force: true });
    },
  };
}

// A resolver that fails every lookup with ENOTFOUND, independent of the host's DNS.
const unresolvable = (async () => { throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); }) as never;

describe("Caddy route rendering", () => {
  it("renders explicit routes without a catch-all", () => {
    const output = renderCaddyfile([{ id: "a", instanceId: "i", hostname: "app-i.localhost", targetHost: "127.0.0.1", targetPort: 4100, tls: "off", updatedAt: "now" }]);
    expect(output).toContain("http://app-i.localhost {\n  reverse_proxy 127.0.0.1:4100\n}");
    expect(output).toContain("default_bind 127.0.0.1\n");
    expect(renderCaddyfile([], true)).toContain("default_bind 127.0.0.1 [::1]");
    expect(output).toContain("skip_install_trust");
    expect(output).toContain("http:// {\n  respond 404\n}");
    expect(output).not.toContain(":80 {");
    expect(output).not.toContain("* {");
    expect(output).not.toContain(":443 {");
  });

  it("brackets IPv6 loopback targets and rejects invalid route fields", () => {
    const output = renderCaddyfile([{ id: "a", instanceId: "i", hostname: "app-i.localhost", targetHost: "::1", targetPort: 4100, tls: "off", updatedAt: "now" }]);
    expect(output).toContain("reverse_proxy [::1]:4100");
    expect(() => renderCaddyfile([{ id: "a", instanceId: "i", hostname: "app.localhost\n:80", targetHost: "127.0.0.1", targetPort: 4100, tls: "off", updatedAt: "now" }])).toThrow(/concrete/);
  });

  it("rejects non-integer proxy ports", () => {
    expect(() => renderCaddyfile([{ id: "a", instanceId: "i", hostname: "app.localhost", targetHost: "127.0.0.1", targetPort: Number.NaN, tls: "off", updatedAt: "now" }])).toThrow(/integer/);
  });

  it("rejects route names that DNS treats as the same hostname", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-case-"));
    try {
      await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [
        { id: "first", instanceId: "owner", hostname: "api-owner.localhost", targetHost: "127.0.0.1", targetPort: 4100, tls: "off", updatedAt: "now" },
      ] }));
      await expect(new CaddyProxyController(stateDir).upsert([{ id: "second", instanceId: "OWNER", hostname: "API-OWNER.localhost", targetHost: "127.0.0.1", targetPort: 4101, tls: "off" }]))
        .rejects.toThrow(/already owned/);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("fails closed on corrupt persisted route state", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-"));
    await writeFile(path.join(stateDir, "proxy-routes.json"), "{not-json");
    await expect(new CaddyProxyController(stateDir).routes()).rejects.toMatchObject({ code: "DEVFN_PROXY_CONFIG_INVALID" });
  });

  it("reads mixed-case localhost routes through active and pending state while a sibling changes", async () => {
    const { stateDir, cleanup } = await stubbedCaddyState("devfn-proxy-case-state-");
    const retained = { id: "retained", instanceId: "first", hostname: "App.LOCALHOST", targetHost: "127.0.0.1",
      targetPort: 4101, tls: "off" as const, updatedAt: "now" };
    const sibling = { id: "sibling", instanceId: "second", hostname: "Other.localhost", targetHost: "127.0.0.1",
      targetPort: 4102, tls: "off" as const, updatedAt: "now" };
    try {
      await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [retained] }));
      const controller = new CaddyProxyController(stateDir);
      expect(await controller.routes()).toEqual([retained]);
      await expect(controller.upsert([{ ...sibling, id: "collision", hostname: "app.localhost" }]))
        .rejects.toMatchObject({ code: "DEVFN_PROXY_OWNERSHIP_CONFLICT" });
      await writeFile(path.join(stateDir, "proxy-routes.pending.json"), JSON.stringify({ version: 1, routes: [retained, sibling] }));
      expect(await controller.routes()).toEqual([retained, sibling]);
      await controller.upsert([sibling]);
      await controller.removeInstance("second");
      expect(await controller.routes()).toEqual([retained]);
      expect(JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8")).routes).toEqual([retained]);
    } finally { await cleanup(); }
  });

  it("removes another instance and recovers its removal when a retained domain loses DNS", async () => {
    const { stateDir, cleanup } = await stubbedCaddyState("devfn-proxy-domain-cleanup-");
    const retained = { id: "a", instanceId: "a", hostname: "a.invalid.test", targetHost: "127.0.0.1", targetPort: 4101,
      tls: "internal" as const, registeredDomain: "invalid.test", projectId: "fixture", repositoryIdentity: stateDir, updatedAt: "now" };
    const removed = { id: "b", instanceId: "b", hostname: "b.localhost", targetHost: "127.0.0.1", targetPort: 4102,
      tls: "off" as const, updatedAt: "now" };
    try {
      const controller = new CaddyProxyController(stateDir, unresolvable);
      await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [retained, removed] }));
      await controller.removeInstance("b");
      expect(await controller.routes()).toEqual([retained]);
      await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [retained, removed] }));
      await writeFile(path.join(stateDir, "proxy-routes.pending.json"), JSON.stringify({ version: 1, routes: [retained] }));
      expect(await controller.routes()).toEqual([retained]);
      await expect(controller.upsert([retained])).rejects.toMatchObject({ code: "DEVFN_DOMAIN_UNREGISTERED" });
      await controller.upsert([removed]);
      const committedBefore = await controller.routes();
      await writeFile(path.join(stateDir, "domains.json"), JSON.stringify({ version: 1, domains: [
        { domain: "invalid.test", projectId: "fixture", repositoryIdentity: stateDir, tls: "internal" },
      ] }));
      const failedActivation = { ...retained, id: "new-domain", instanceId: "new", hostname: "new.invalid.test" };
      await writeFile(path.join(stateDir, "proxy-routes.pending.json"), JSON.stringify({ version: 1, routes: [...committedBefore, failedActivation] }));
      expect(await controller.routes()).toEqual(committedBefore);
      expect(JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8"))).toEqual({ version: 1, routes: committedBefore });
      expect(await controller.routes()).toEqual(committedBefore);
      await controller.removeInstance("b");
      expect(await controller.routes()).toEqual([retained]);
      expect(JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8"))).toEqual({ version: 1, routes: [retained] });
      await expect(access(path.join(stateDir, "proxy-routes.pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(controller.upsert([failedActivation])).rejects.toMatchObject({ code: "DEVFN_DOMAIN_DNS_INVALID" });
      expect(await controller.routes()).toEqual([retained]);
    } finally { await cleanup(); }
  });

  it("releases the shared lock after a stalled domain lookup so a sibling can stop", async () => {
    const { stateDir, cleanup } = await stubbedCaddyState("devfn-proxy-dns-lock-");
    const sibling = { id: "sibling", instanceId: "sibling", hostname: "sibling.localhost", targetHost: "127.0.0.1", targetPort: 4101, tls: "off" as const };
    const stalled = { id: "stalled", instanceId: "stalled", hostname: "stalled.dev.example.test", targetHost: "127.0.0.1", targetPort: 4102,
      tls: "internal" as const, registeredDomain: "dev.example.test", projectId: "fixture", repositoryIdentity: stateDir };
    try {
      await writeFile(path.join(stateDir, "domains.json"), JSON.stringify({ version: 1, domains: [
        { domain: "dev.example.test", projectId: "fixture", repositoryIdentity: stateDir, tls: "internal" },
      ] }));
      let signalLookup!: () => void;
      const lookupStarted = new Promise<void>((resolve) => { signalLookup = resolve; });
      // Route activation holds the proxy lock through its bounded DNS
      // check; a lookup that never answers must end at that bound and
      // release the lock, or the sibling's cleanup never runs.
      const controller = new CaddyProxyController(stateDir, (async () => { signalLookup(); return await new Promise(() => {}); }) as never, 50);
      await controller.upsert([sibling]);
      const activation = controller.upsert([stalled]);
      await lookupStarted;
      const siblingRemoval = controller.removeInstance("sibling");
      await expect(activation).rejects.toMatchObject({ code: "DEVFN_DOMAIN_DNS_INVALID" });
      await expect(siblingRemoval).resolves.toBeUndefined();
      expect(await controller.routes()).toEqual([]);
    } finally { await cleanup(); }
  });

  it("an empty owner selection recovers pending state and removes only that owner's routes", async () => {
    const { stateDir, cleanup } = await stubbedCaddyState("devfn-proxy-empty-");
    const first = { id: "a", instanceId: "a", hostname: "a.localhost", targetHost: "127.0.0.1", targetPort: 4101, tls: "off" as const, updatedAt: "now" };
    const sibling = { id: "b", instanceId: "b", hostname: "b.localhost", targetHost: "127.0.0.1", targetPort: 4102, tls: "off" as const, updatedAt: "now" };
    try {
      await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [first] }));
      await writeFile(path.join(stateDir, "proxy-routes.pending.json"), JSON.stringify({ version: 1, routes: [first, sibling] }));
      const controller = new CaddyProxyController(stateDir);
      await expect(controller.upsert([], "a")).resolves.toEqual([]);
      expect(await controller.routes()).toEqual([sibling]);
      expect(JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8"))).toEqual({ version: 1, routes: [sibling] });
      await expect(access(path.join(stateDir, "proxy-routes.pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(controller.upsert([])).rejects.toMatchObject({ code: "DEVFN_PROXY_CONFIG_INVALID" });
    } finally { await cleanup(); }
  });

  it("drops a route whose service process is verified gone at the next transition that changes routes", async () => {
    const { stateDir, cleanup } = await stubbedCaddyState("devfn-proxy-service-");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 200)"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const deadSignature = await processBirthSignature(child.pid!);
    await exited;
    const route = (id: string, targetPort: number, serviceProcess?: { pid: number; birthSignature: string }) =>
      ({ id, instanceId: id, hostname: `${id}.localhost`, targetHost: "127.0.0.1", targetPort, tls: "off" as const, updatedAt: "now", ...(serviceProcess ? { serviceProcess } : {}) });
    const dead = route("dead", 4101, { pid: child.pid!, birthSignature: deadSignature ?? "gone" });
    const live = route("live", 4102, { pid: process.pid, birthSignature: (await processBirthSignature(process.pid))! });
    // A signature in no readable format cannot be judged, so its route stays.
    const unverifiable = route("unverifiable", 4103, { pid: process.pid, birthSignature: "unreadable" });
    const plain = route("plain", 4104);
    try {
      await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [dead, live, unverifiable, plain] }));
      const controller = new CaddyProxyController(stateDir);
      await controller.removeInstance("unrelated");
      expect(await controller.routes()).toEqual([dead, live, unverifiable, plain]);
      await controller.removeInstance("plain");
      expect(await controller.routes()).toEqual([live, unverifiable]);
      await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [dead, plain] }));
      await controller.upsert([{ id: "next", instanceId: "next", hostname: "next.localhost", targetHost: "127.0.0.1", targetPort: 4105, tls: "off" }]);
      expect((await controller.routes()).map((item) => item.id)).toEqual(["plain", "next"]);
      await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [{ ...plain, serviceProcess: { pid: 0, birthSignature: "x" } }] }));
      await expect(controller.routes()).rejects.toMatchObject({ code: "DEVFN_PROXY_CONFIG_INVALID" });
    } finally { await cleanup(); }
  });

  it("refuses a route update that route state reads would reject, before Caddy or any state changes", async () => {
    const { stateDir, cleanup, caddyCalls } = await stubbedCaddyState("devfn-proxy-write-check-");
    const statePath = path.join(stateDir, "proxy-routes.json");
    const route = (id: string, targetPort: number) => ({ id, instanceId: id, hostname: `${id}.localhost`, targetHost: "127.0.0.1" as const, targetPort, tls: "off" as const });
    try {
      const controller = new CaddyProxyController(stateDir);
      await controller.upsert([route("sibling", 4101)]);
      const committed = await readFile(statePath, "utf8");
      const calls = (await caddyCalls()).length;
      for (const serviceProcess of [{ pid: 0, birthSignature: "x" }, { pid: process.pid, birthSignature: "" }]) {
        await expect(controller.upsert([{ ...route("service", 4102), serviceProcess }])).rejects.toMatchObject({ code: "DEVFN_PROXY_CONFIG_INVALID" });
      }
      expect((await caddyCalls()).length).toBe(calls);
      expect(await readFile(statePath, "utf8")).toBe(committed);
      await expect(access(path.join(stateDir, "proxy-routes.pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
      // Every other owner's routes stay readable and removable.
      expect((await controller.routes()).map((item) => item.id)).toEqual(["sibling"]);
      await controller.removeInstance("sibling");
      expect(await controller.routes()).toEqual([]);
    } finally { await cleanup(); }
  });

  it.skipIf(process.platform === "win32")("keeps a service route while a process of its group outlives the leader", async () => {
    const { stateDir, cleanup } = await stubbedCaddyState("devfn-proxy-service-group-");
    // The leader starts a member of its own process group, prints its PID and exits.
    const leader = spawn(process.execPath, ["-e", `const member = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
process.stdout.write(String(member.pid), () => setTimeout(() => process.exit(0), 300));`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    leader.stdout.on("data", (chunk) => { output += String(chunk); });
    const exited = new Promise((resolve) => leader.once("exit", resolve));
    const birthSignature = (await processBirthSignature(leader.pid!))!;
    await exited;
    const member = Number(output);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const service = { id: "relay:callback", instanceId: "relay", hostname: "auth.localhost", targetHost: "127.0.0.1", targetPort: 4101, tls: "off" as const, updatedAt: "now",
      serviceProcess: { pid: leader.pid!, birthSignature } };
    const plain = (id: string, targetPort: number) => ({ id, instanceId: id, hostname: `${id}.localhost`, targetHost: "127.0.0.1", targetPort, tls: "off" as const, updatedAt: "now" });
    try {
      expect(alive(member)).toBe(true);
      await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [service, plain("a", 4102), plain("b", 4103)] }));
      const controller = new CaddyProxyController(stateDir);
      await controller.removeInstance("a");
      expect(await controller.routes()).toEqual([service, plain("b", 4103)]);
      // Once the whole group is gone, the next transition drops the route.
      process.kill(-leader.pid!, "SIGKILL");
      for (let attempt = 0; attempt < 100 && alive(member); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      await controller.removeInstance("b");
      expect(await controller.routes()).toEqual([]);
    } finally {
      try { process.kill(-leader.pid!, "SIGKILL"); } catch { /* stopped */ }
      await cleanup();
    }
  });

  it("never applies Caddy for a dead service route when the caller's routes do not change", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-routeless-"));
    const toolsDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-tools-"));
    const originalPath = process.env.PATH;
    const marker = path.join(toolsDir, "caddy-invoked");
    // No Caddy owner is recorded and this Caddy fails every command, as on a host without DevFn's Caddy.
    await writeFile(path.join(toolsDir, "caddy"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
    process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 200)"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const deadSignature = await processBirthSignature(child.pid!);
    await exited;
    const dead = { id: "relay:callback", instanceId: "relay", hostname: "auth.localhost", targetHost: "127.0.0.1", targetPort: 4101, tls: "off" as const, updatedAt: "now",
      serviceProcess: { pid: child.pid!, birthSignature: deadSignature ?? "gone" } };
    try {
      await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [dead] }));
      const controller = new CaddyProxyController(stateDir);
      // A route-less lifecycle's teardown and empty selection.
      await controller.removeInstance("routeless");
      await expect(controller.upsert([], "routeless")).resolves.toEqual([]);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await controller.routes()).toEqual([dead]);
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      await rm(stateDir, { recursive: true, force: true });
      await rm(toolsDir, { recursive: true, force: true });
    }
  });

  it("drops a dead service route when a rollback or a recovered activation journal changes routes", async () => {
    const { stateDir, cleanup } = await stubbedCaddyState("devfn-proxy-service-recovery-");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 200)"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const deadSignature = await processBirthSignature(child.pid!);
    await exited;
    const statePath = path.join(stateDir, "proxy-routes.json");
    const pendingPath = path.join(stateDir, "proxy-routes.pending.json");
    const dead = { id: "relay:callback", instanceId: "relay", hostname: "auth.localhost", targetHost: "127.0.0.1", targetPort: 4101, tls: "off" as const, updatedAt: "now",
      serviceProcess: { pid: child.pid!, birthSignature: deadSignature ?? "gone" } };
    const live = { id: "live:callback", instanceId: "live", hostname: "live.localhost", targetHost: "127.0.0.1", targetPort: 4102, tls: "off" as const, updatedAt: "now",
      serviceProcess: { pid: process.pid, birthSignature: (await processBirthSignature(process.pid))! } };
    const app = { id: "a", instanceId: "a", hostname: "a.localhost", targetHost: "127.0.0.1", targetPort: 4103, tls: "off" as const, updatedAt: "now" };
    const failed = { id: "new", instanceId: "new", hostname: "new.invalid.test", targetHost: "127.0.0.1", targetPort: 4104, tls: "internal" as const,
      registeredDomain: "invalid.test", projectId: "fixture", repositoryIdentity: stateDir, updatedAt: "now" };
    try {
      const controller = new CaddyProxyController(stateDir, unresolvable);
      // An activation rollback restores the instance's captured routes.
      await writeFile(statePath, JSON.stringify({ version: 1, routes: [dead, live, app] }));
      const snapshot = await controller.captureInstanceRoutes("a");
      await controller.restoreInstanceRoutes("a", snapshot);
      expect(await controller.routes()).toEqual([live, app]);
      // A crashed activation's journal is recovered without the dead route, and committed so.
      await writeFile(statePath, JSON.stringify({ version: 1, routes: [live] }));
      await writeFile(pendingPath, JSON.stringify({ version: 1, routes: [dead, live, app] }));
      expect(await controller.routes()).toEqual([live, app]);
      expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ version: 1, routes: [live, app] });
      await expect(access(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
      // A journal that can no longer activate rolls back to the committed routes, still without the dead one.
      await writeFile(statePath, JSON.stringify({ version: 1, routes: [dead, live, app] }));
      await writeFile(pendingPath, JSON.stringify({ version: 1, routes: [dead, live, app, failed] }));
      expect(await controller.routes()).toEqual([live, app]);
      expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ version: 1, routes: [live, app] });
      await expect(access(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await cleanup(); }
  });

  it("replays and commits a valid route activation journal", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-"));
    const pendingPath = path.join(stateDir, "proxy-routes.pending.json");
    const toolsDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-tools-"));
    const caddyLog = path.join(stateDir, "caddy.log");
    const route = { id: "a", instanceId: "i", hostname: "app-i.localhost", targetHost: "127.0.0.1", targetPort: 4100, tls: "off", updatedAt: "now" } as const;
    const birthSignature = await processBirthSignature(process.pid);
    if (!birthSignature) throw new Error("Test process has no birth signature.");
    await writeFile(pendingPath, `${JSON.stringify({ version: 1, routes: [route] })}\n`);
    await writeFile(path.join(stateDir, "proxy-owner.json"), `${JSON.stringify({ pid: process.pid, birthSignature })}\n`);
    await writeFile(path.join(toolsDir, "caddy"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$DEVFN_TEST_CADDY_LOG\"\nexit 0\n", { mode: 0o700 });
    const originalPath = process.env.PATH;
    const originalLog = process.env.DEVFN_TEST_CADDY_LOG;
    try {
      process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.DEVFN_TEST_CADDY_LOG = caddyLog;
      await expect(new CaddyProxyController(stateDir).routes()).resolves.toEqual([route]);
      expect(await readFile(caddyLog, "utf8")).toContain("reload --config");
      expect(JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8"))).toEqual({ version: 1, routes: [route] });
      await expect(access(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.DEVFN_TEST_CADDY_LOG; else process.env.DEVFN_TEST_CADDY_LOG = originalLog;
      await rm(stateDir, { recursive: true, force: true });
      await rm(toolsDir, { recursive: true, force: true });
    }
  });

  it("preserves a route activation journal when recovery reload fails", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-"));
    const pendingPath = path.join(stateDir, "proxy-routes.pending.json");
    const statePath = path.join(stateDir, "proxy-routes.json");
    const toolsDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-tools-"));
    const caddyLog = path.join(stateDir, "caddy.log");
    const previousRoute = { id: "old", instanceId: "i", hostname: "old-i.localhost", targetHost: "127.0.0.1", targetPort: 4099, tls: "off", updatedAt: "before" } as const;
    const route = { id: "a", instanceId: "i", hostname: "app-i.localhost", targetHost: "127.0.0.1", targetPort: 4100, tls: "off", updatedAt: "now" } as const;
    const birthSignature = await processBirthSignature(process.pid);
    if (!birthSignature) throw new Error("Test process has no birth signature.");
    await writeFile(statePath, `${JSON.stringify({ version: 1, routes: [previousRoute] })}\n`);
    await writeFile(pendingPath, `${JSON.stringify({ version: 1, routes: [route] })}\n`);
    await writeFile(path.join(stateDir, "proxy-owner.json"), `${JSON.stringify({ pid: process.pid, birthSignature })}\n`);
    await writeFile(path.join(toolsDir, "caddy"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$DEVFN_TEST_CADDY_LOG\"\nif [ \"$1\" = reload ]; then exit 1; fi\nexit 0\n", { mode: 0o700 });
    const originalPath = process.env.PATH;
    const originalLog = process.env.DEVFN_TEST_CADDY_LOG;
    try {
      process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.DEVFN_TEST_CADDY_LOG = caddyLog;
      await expect(new CaddyProxyController(stateDir).routes()).rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED" });
      expect(await readFile(caddyLog, "utf8")).toContain("reload --config");
      expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ version: 1, routes: [previousRoute] });
      expect(JSON.parse(await readFile(pendingPath, "utf8"))).toEqual({ version: 1, routes: [route] });
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.DEVFN_TEST_CADDY_LOG; else process.env.DEVFN_TEST_CADDY_LOG = originalLog;
      await rm(stateDir, { recursive: true, force: true });
      await rm(toolsDir, { recursive: true, force: true });
    }
  });

  it("keeps an activation whose reload outcome is uncertain as possibly live until a reload of the committed routes confirms Caddy", async () => {
    const { stateDir, cleanup } = await stubbedCaddyState("devfn-proxy-uncertain-");
    const toolsDir = (process.env.PATH ?? "").split(path.delimiter)[0];
    const live = path.join(toolsDir, "live.Caddyfile");
    const reloads = path.join(toolsDir, "reloads");
    const statePath = path.join(stateDir, "proxy-routes.json");
    const pendingPath = path.join(stateDir, "proxy-routes.pending.json");
    // Every reload loads its configuration; the command then fails, as on a timeout, until DEVFN_TEST_RELOAD_FAILURES reloads have failed.
    await writeFile(path.join(toolsDir, "caddy"), `#!/bin/sh\nif [ "$1" = reload ]; then\n  cp "$3" '${live}'\n  n=$(( $(cat '${reloads}' 2>/dev/null || echo 0) + 1 )); echo "$n" > '${reloads}'\n  [ "$n" -gt "$DEVFN_TEST_RELOAD_FAILURES" ] || exit 1\nfi\nexit 0\n`, { mode: 0o700 });
    const sibling = { id: "s", instanceId: "sibling", hostname: "sibling.localhost", targetHost: "127.0.0.1", targetPort: 4100, tls: "off", updatedAt: "before" } as const;
    const committed = `${JSON.stringify({ version: 1, routes: [sibling] })}\n`;
    await writeFile(statePath, committed);
    const added = { id: "a", instanceId: "i", hostname: "added.localhost", targetHost: "127.0.0.1", targetPort: 4101, tls: "off" } as const;
    const controller = new CaddyProxyController(stateDir);
    const originalFailures = process.env.DEVFN_TEST_RELOAD_FAILURES;
    try {
      // The candidate reached Caddy before its reload failed; a reload of the committed routes confirms it is gone.
      process.env.DEVFN_TEST_RELOAD_FAILURES = "1";
      await expect(controller.upsert([added])).rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED" });
      expect(await readFile(live, "utf8")).toContain("sibling.localhost");
      expect(await readFile(live, "utf8")).not.toContain("added.localhost");
      await expect(access(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await controller.hasInstanceRoutes("i")).toBe(false);
      // While no reload can be confirmed, the journal keeps the route possibly live, and no transition treats it as gone.
      await rm(reloads);
      process.env.DEVFN_TEST_RELOAD_FAILURES = "99";
      await expect(controller.upsert([added])).rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED", message: expect.stringContaining("possibly live") });
      expect(await controller.instanceRouteState("i")).toMatchObject({ committed: [], pending: [expect.objectContaining({ hostname: "added.localhost" })] });
      await expect(controller.removeInstance("i")).rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED" });
      expect(await controller.hasInstanceRoutes("i")).toBe(true);
      expect(await readFile(statePath, "utf8")).toBe(committed);
      // Once Caddy reloads, the uncertain activation is rolled back rather than replayed; sibling state is byte-identical.
      process.env.DEVFN_TEST_RELOAD_FAILURES = "0";
      await controller.removeInstance("i");
      expect(await readFile(live, "utf8")).toContain("sibling.localhost");
      expect(await readFile(live, "utf8")).not.toContain("added.localhost");
      expect(await readFile(statePath, "utf8")).toBe(committed);
      await expect(access(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await controller.routes()).toEqual([sibling]);
    } finally {
      if (originalFailures === undefined) delete process.env.DEVFN_TEST_RELOAD_FAILURES; else process.env.DEVFN_TEST_RELOAD_FAILURES = originalFailures;
      await cleanup();
    }
  });

  it("rolls an uncertain activation back without service routes verified gone, and commits only what Caddy confirmed", async () => {
    const { stateDir, cleanup } = await stubbedCaddyState("devfn-proxy-uncertain-dead-");
    const toolsDir = (process.env.PATH ?? "").split(path.delimiter)[0];
    const live = path.join(toolsDir, "live.Caddyfile");
    const reloads = path.join(toolsDir, "reloads");
    const statePath = path.join(stateDir, "proxy-routes.json");
    const pendingPath = path.join(stateDir, "proxy-routes.pending.json");
    const uncertainPath = path.join(stateDir, "proxy-routes.pending.uncertain");
    await writeFile(path.join(toolsDir, "caddy"), `#!/bin/sh\nif [ "$1" = reload ]; then\n  cp "$3" '${live}'\n  n=$(( $(cat '${reloads}' 2>/dev/null || echo 0) + 1 )); echo "$n" > '${reloads}'\n  [ "$n" -gt "$DEVFN_TEST_RELOAD_FAILURES" ] || exit 1\nfi\nexit 0\n`, { mode: 0o700 });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 200)"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const deadSignature = await processBirthSignature(child.pid!);
    await exited;
    const dead = { id: "relay:callback", instanceId: "relay", hostname: "auth.localhost", targetHost: "127.0.0.1", targetPort: 4101, tls: "off" as const, updatedAt: "now",
      serviceProcess: { pid: child.pid!, birthSignature: deadSignature ?? "gone" } };
    const sibling = { id: "s", instanceId: "sibling", hostname: "sibling.localhost", targetHost: "127.0.0.1", targetPort: 4100, tls: "off", updatedAt: "before" } as const;
    const committed = `${JSON.stringify({ version: 1, routes: [dead, sibling] })}\n`;
    const added = { id: "a", instanceId: "i", hostname: "added.localhost", targetHost: "127.0.0.1", targetPort: 4102, tls: "off" } as const;
    const controller = new CaddyProxyController(stateDir);
    const originalFailures = process.env.DEVFN_TEST_RELOAD_FAILURES;
    try {
      // The upsert drops the dead route and its reload fails; the immediate rollback must not bring that route back.
      await writeFile(statePath, committed);
      process.env.DEVFN_TEST_RELOAD_FAILURES = "1";
      await expect(controller.upsert([added])).rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED" });
      expect(await readFile(live, "utf8")).toContain("sibling.localhost");
      expect(await readFile(live, "utf8")).not.toContain("auth.localhost");
      expect(await readFile(live, "utf8")).not.toContain("added.localhost");
      expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ version: 1, routes: [sibling] });
      await expect(access(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(uncertainPath)).rejects.toMatchObject({ code: "ENOENT" });
      // While no reload is confirmed, the committed state is unchanged and the journal stays possibly live.
      await writeFile(statePath, committed);
      await rm(reloads);
      process.env.DEVFN_TEST_RELOAD_FAILURES = "99";
      await expect(controller.upsert([added])).rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED", message: expect.stringContaining("possibly live") });
      expect(await readFile(statePath, "utf8")).toBe(committed);
      expect(await controller.instanceRouteState("i")).toMatchObject({ pending: [expect.objectContaining({ hostname: "added.localhost" })] });
      await access(uncertainPath);
      // The marked journal's recovery also rolls back without the dead route, then commits what Caddy confirmed.
      process.env.DEVFN_TEST_RELOAD_FAILURES = "0";
      expect(await controller.routes()).toEqual([sibling]);
      expect(await readFile(live, "utf8")).toContain("sibling.localhost");
      expect(await readFile(live, "utf8")).not.toContain("auth.localhost");
      expect(await readFile(live, "utf8")).not.toContain("added.localhost");
      expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ version: 1, routes: [sibling] });
      await expect(access(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(uncertainPath)).rejects.toMatchObject({ code: "ENOENT" });
      // A crashed activation's journal recovered without the dead route is not rewritten before Caddy confirms it.
      const crashed = `${JSON.stringify({ version: 1, routes: [dead, sibling, { ...added, updatedAt: "now" }] })}\n`;
      await writeFile(statePath, committed);
      await writeFile(pendingPath, crashed);
      process.env.DEVFN_TEST_RELOAD_FAILURES = "99";
      await expect(controller.routes()).rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED" });
      expect(await readFile(pendingPath, "utf8")).toBe(crashed);
      expect(await readFile(statePath, "utf8")).toBe(committed);
      process.env.DEVFN_TEST_RELOAD_FAILURES = "0";
      expect(await controller.routes()).toEqual([sibling]);
      expect(await readFile(live, "utf8")).not.toContain("auth.localhost");
    } finally {
      if (originalFailures === undefined) delete process.env.DEVFN_TEST_RELOAD_FAILURES; else process.env.DEVFN_TEST_RELOAD_FAILURES = originalFailures;
      await cleanup();
    }
  });

  it("tears down a route-less owner without Caddy while another owner's uncertain journal cannot be rolled back", async () => {
    const { stateDir, cleanup, caddyCalls } = await stubbedCaddyState("devfn-proxy-uncertain-routeless-");
    const toolsDir = (process.env.PATH ?? "").split(path.delimiter)[0];
    // Caddy logs every command and fails every reload.
    await writeFile(path.join(toolsDir, "caddy"), `#!/bin/sh\necho "$1" >> '${path.join(toolsDir, "calls.log")}'\n[ "$1" != reload ]\n`, { mode: 0o700 });
    const statePath = path.join(stateDir, "proxy-routes.json");
    const pendingPath = path.join(stateDir, "proxy-routes.pending.json");
    const uncertainPath = path.join(stateDir, "proxy-routes.pending.uncertain");
    const sibling = { id: "s", instanceId: "sibling", hostname: "sibling.localhost", targetHost: "127.0.0.1", targetPort: 4100, tls: "off", updatedAt: "before" } as const;
    const added = { id: "a", instanceId: "i", hostname: "added.localhost", targetHost: "127.0.0.1", targetPort: 4101, tls: "off", updatedAt: "now" } as const;
    const committed = `${JSON.stringify({ version: 1, routes: [sibling] })}\n`;
    const journal = `${JSON.stringify({ version: 1, routes: [sibling, added] })}\n`;
    try {
      await writeFile(statePath, committed);
      await writeFile(pendingPath, journal);
      await writeFile(uncertainPath, "");
      const controller = new CaddyProxyController(stateDir);
      // A route-less lifecycle's teardown and empty selection change no routes.
      await controller.removeInstance("routeless");
      await expect(controller.upsert([], "routeless")).resolves.toEqual([]);
      expect(await caddyCalls()).toEqual([]);
      expect(await readFile(statePath, "utf8")).toBe(committed);
      expect(await readFile(pendingPath, "utf8")).toBe(journal);
      await access(uncertainPath);
      // An owner the journal names still waits for its rollback.
      await expect(controller.removeInstance("i")).rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED" });
      expect(await readFile(pendingPath, "utf8")).toBe(journal);
      await access(uncertainPath);
    } finally { await cleanup(); }
  });

  it("serializes route reads with an in-flight proxy activation", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-"));
    const toolsDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-tools-"));
    const reloadMarker = path.join(stateDir, "reload-started");
    const birthSignature = await processBirthSignature(process.pid);
    if (!birthSignature) throw new Error("Test process has no birth signature.");
    await writeFile(path.join(stateDir, "proxy-owner.json"), `${JSON.stringify({ pid: process.pid, birthSignature })}\n`);
    await writeFile(path.join(toolsDir, "caddy"), "#!/bin/sh\nif [ \"$1\" = reload ]; then : > \"$DEVFN_TEST_RELOAD_MARKER\"; sleep 0.2; fi\nexit 0\n", { mode: 0o700 });
    const originalPath = process.env.PATH;
    const originalMarker = process.env.DEVFN_TEST_RELOAD_MARKER;
    let update: Promise<unknown> | undefined;
    try {
      process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.DEVFN_TEST_RELOAD_MARKER = reloadMarker;
      const controller = new CaddyProxyController(stateDir);
      const route = { id: "a", instanceId: "i", hostname: "app-i.localhost", targetHost: "127.0.0.1", targetPort: 4100, tls: "off" as const };
      update = controller.upsert([route]);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await access(reloadMarker).then(() => true).catch(() => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expect(access(reloadMarker)).resolves.toBeUndefined();
      const [, routes] = await Promise.all([update, controller.routes()]);
      expect(routes).toEqual([expect.objectContaining(route)]);
    } finally {
      await update?.catch(() => undefined);
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalMarker === undefined) delete process.env.DEVFN_TEST_RELOAD_MARKER; else process.env.DEVFN_TEST_RELOAD_MARKER = originalMarker;
      await rm(stateDir, { recursive: true, force: true });
      await rm(toolsDir, { recursive: true, force: true });
    }
  });

  it("distinguishes dead proxy owners from live PID reuse", async () => {
    await expect(proxyOwnerStatus({ pid: 2_147_483_647, birthSignature: "missing" })).resolves.toBe("dead");
    await expect(proxyOwnerStatus({ pid: process.pid, birthSignature: `${(await processBirthSignature(process.pid))!.split(":")[0]}:different-process` })).resolves.toBe("identity-mismatch");
    await expect(proxyOwnerStatus({ pid: process.pid })).resolves.toBe("unverified");
  });

  it("clears a reused-PID owner on retry without signaling the unrelated process", async () => await withCaddyAdminPort(async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-reused-owner-"));
    const toolsDir = await mkdtemp(path.join(tmpdir(), "devfn-proxy-tools-"));
    const originalPath = process.env.PATH;
    const ownerPath = path.join(stateDir, "proxy-owner.json");
    try {
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid, birthSignature: `${(await processBirthSignature(process.pid))!.split(":")[0]}:reused-pid` }));
      await writeFile(path.join(toolsDir, "caddy"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
      await expect(new CaddyProxyController(stateDir).upsert([{
        id: "retry", instanceId: "retry", hostname: "retry.localhost", targetHost: "127.0.0.1", targetPort: 4100, tls: "off",
      }])).rejects.toMatchObject({ code: "DEVFN_PROXY_RELOAD_FAILED" });
      await expect(access(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await processBirthSignature(process.pid)).toBeTruthy();
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      await rm(stateDir, { recursive: true, force: true }); await rm(toolsDir, { recursive: true, force: true });
    }
  }), 150_000);
});
