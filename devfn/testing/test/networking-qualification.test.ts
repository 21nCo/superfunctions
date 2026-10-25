import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { validateDevFnConfig } from "@devfn/config";
import { createPlan, resolveEndpointTemplates, resolveLocalHostname } from "@devfn/core";
import { proxyListenerPorts, PUBLIC_ORIGIN_HEADER } from "@devfn/proxy";
import { relayPaths } from "@devfn/proxy/oauth-relay";
import { ephemeralOriginDomain, ngrokMarker, registerTunnelBinding, tunnelPaths, type TunnelBinding } from "@devfn/proxy/tunnel";
import { staleBuildOutputs } from "../src/networking/cli.js";
import { loopbackListening } from "../src/networking/prerequisites.js";
import {
  ANSWERS, approvedDomains, checkPrerequisites, composeFixture, DEFERRED_ROWS, DisposableInventory, domainFixture, ENDPOINT_INTERFACE, hostFixture, InventoryError, listenerPorts, liveDrivers, LiveHost,
  localDockerEndpoint, materialDigest, NETWORKING_MATRIX, networkingOutcomeGate, oauthFixture, ownerLabel, parseApproval, providerReadBack, receiptProblems, redactSecrets, runScenarios, selectScenarios, summarize, tunnelFixture,
  protectedChanges, type Answer, type CommandRunner, type NetworkingQualificationReceipt, type PrerequisiteResult, type ProbeEnvironment, type ProtectedSnapshot, type ResourceHandlers, type ScenarioContext, type ScenarioDriver, type ScenarioResult,
} from "../src/networking/index.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT = "/tmp/devfn-qualification-test";
const HEAD = "a".repeat(40);
const future = new Date(Date.now() + 86_400_000).toISOString();
const approval = {
  version: 1, nonproduction: true, approvedBy: "owner", expiresAt: future, domain: "dev.example.test",
  oauth: { provider: "google", clientIdEnv: "QUAL_GOOGLE_ID", clientSecretEnv: "QUAL_GOOGLE_SECRET", relayHost: "auth", redirectUri: "https://auth.dev.example.test:8443/oauth/callback" },
  cloudflare: { domain: "preview.example.test", accountId: "a".repeat(32), zoneId: "b".repeat(32), tunnelId: "00000000-0000-4000-8000-000000000000", credentialsFile: "/secure/tunnel.json", apiTokenEnv: "QUAL_CF_TOKEN" },
  ngrokEphemeral: { authtokenEnv: "QUAL_NGROK_AUTHTOKEN", apiKeyEnv: "QUAL_NGROK_API_KEY" },
};
/** The same approval with the redirect URI of the relay origin on a platform's HTTPS listener. */
const approvalFor = (platform: NodeJS.Platform) => {
  const { httpsPort } = listenerPorts(platform);
  return parseApproval({ ...approval, oauth: { ...approval.oauth, redirectUri: `https://auth.dev.example.test${httpsPort === 443 ? "" : `:${httpsPort}`}/oauth/callback` } });
};

const satisfied = (ids: Iterable<string>): PrerequisiteResult[] => [...ids].map((id) => ({ id, status: "satisfied", detail: "fixture" }) as PrerequisiteResult);
const allPrerequisites = satisfied(new Set(NETWORKING_MATRIX.flatMap((scenario) => scenario.prerequisites)));
const twoWorktrees = NETWORKING_MATRIX.find((scenario) => scenario.id === "host.two-worktrees")!;

/** Resources that exist until removed; read-back answers from that set. */
function fakeResources(options: { failRead?: string; keep?: string } = {}): ResourceHandlers & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    remove: async (entry) => { removed.push(entry.id); if (entry.id === options.keep) throw new Error("provider refused"); },
    present: async (entry) => {
      if (entry.id === options.failRead) throw new Error("provider unreadable");
      return entry.id === options.keep || !removed.includes(entry.id);
    },
  };
}

async function run(driver: ScenarioDriver | undefined, overrides: { platform?: NodeJS.Platform; prerequisites?: PrerequisiteResult[]; resources?: ResourceHandlers; snapshot?: () => Promise<ProtectedSnapshot> } = {}): Promise<ScenarioResult> {
  const inventory = new DisposableInventory({ runId: "abcdef123456", root: ROOT, domains: ["dev.example.test"] });
  const [result] = await runScenarios({ scenarios: [twoWorktrees], platform: overrides.platform ?? "linux", prerequisites: overrides.prerequisites ?? allPrerequisites,
    drivers: driver ? { [twoWorktrees.id]: driver } : {}, inventory, resources: overrides.resources ?? fakeResources(), snapshot: overrides.snapshot ?? (async () => ({ routes: ["operator@app.localhost"] })) });
  return result;
}

const complete: ScenarioDriver = async (context) => {
  context.inventory.record("fixture-repository", `${ROOT}/qabcdef12-pair`, context.scenario.id);
  context.observe("distinct-owners", true, "observed");
  context.observe("own-marker", true, "observed");
};

describe("networking qualification matrix", () => {
  it("covers every deferred live row with a driver, distinct assertions and existing fixture evidence", async () => {
    const ids = NETWORKING_MATRIX.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of [1, 2, 3, 4, 5] as const) expect(NETWORKING_MATRIX.some((scenario) => scenario.row === row), DEFERRED_ROWS[row]).toBe(true);
    const drivers = liveDrivers(new LiveHost({ root: ROOT, devfnCli: "/missing", env: {}, inventory: new DisposableInventory({ runId: "abcdef123456", root: ROOT, domains: [] }) }), undefined);
    expect(Object.keys(drivers).sort()).toEqual([...ids].sort());
    for (const scenario of NETWORKING_MATRIX) {
      expect(new Set(scenario.assertions.map((item) => item.id)).size, scenario.id).toBe(scenario.assertions.length);
      for (const file of scenario.fixtureEvidence) await expect(access(path.join(repository, file)), file).resolves.toBeUndefined();
    }
    // Every provider, domain and OAuth boundary needs explicit operator approval before it can run.
    for (const scenario of NETWORKING_MATRIX.filter((item) => item.prerequisites.some((id) => ["registered-domain", "google-oauth", "cloudflare", "ngrok-reserved", "ngrok-ephemeral"].includes(id)))) {
      expect(scenario.prerequisites, scenario.id).toContain("approval");
    }
  });

  it("selects scenarios by ID and row in matrix order and refuses unknown or empty selections", () => {
    expect(selectScenarios({ rows: [3] }).map((scenario) => scenario.id)).toEqual(["tunnel.cloudflare", "tunnel.ngrok-reserved", "tunnel.ngrok-ephemeral"]);
    expect(selectScenarios({ scenarios: ["interface.owner-endpoint", "host.two-worktrees"] }).map((scenario) => scenario.id)).toEqual(["host.two-worktrees", "interface.owner-endpoint"]);
    expect(() => selectScenarios({ scenarios: ["host.two-worktree"] })).toThrow(/Unknown qualification scenarios: host.two-worktree/);
    expect(() => selectScenarios({ rows: [6] })).toThrow(/Unknown matrix rows: 6/);
    expect(() => selectScenarios({ scenarios: ["host.two-worktrees"], rows: [2] })).toThrow(/names no qualification scenario/);
  });

  it("schema-validates every generic fixture manifest the live drivers start", () => {
    for (const config of [hostFixture(), hostFixture({ QUAL_REVISION: "2" }), composeFixture(), domainFixture("dev.example.test"), tunnelFixture("qabcdef12-cf", false),
      tunnelFixture("qabcdef12-nge", true), oauthFixture("dev.example.test", parseApproval(approval).oauth!)]) {
      expect(() => validateDevFnConfig(config)).not.toThrow();
    }
  });
});

describe("operator approval", () => {
  it("accepts named nonproduction resources and credential variable names only", () => {
    const parsed = parseApproval(approval);
    expect(parsed.oauth?.redirectUri).toBe("https://auth.dev.example.test:8443/oauth/callback");
    expect(parsed.ngrokEphemeral).toEqual({ authtokenEnv: "QUAL_NGROK_AUTHTOKEN", apiKeyEnv: "QUAL_NGROK_API_KEY" });
    expect(approvedDomains(parsed)).toEqual(["dev.example.test", "preview.example.test"]);
    expect(approvedDomains(undefined)).toEqual([]);
  });

  it.each([
    ["production", { ...approval, nonproduction: false }, /nonproduction must be true/],
    ["expired", { ...approval, expiresAt: new Date(Date.now() - 1000).toISOString() }, /expired/],
    ["a credential value", { ...approval, cloudflare: { ...approval.cloudflare, apiToken: "cf-secret-value" } }, /unsupported fields: apiToken/],
    ["a lowercase variable name", { ...approval, cloudflare: { ...approval.cloudflare, apiTokenEnv: "token value" } }, /apiTokenEnv is invalid/],
    ["a redirect off the relay host", { ...approval, oauth: { ...approval.oauth, redirectUri: "https://app.dev.example.test:8443/oauth/callback" } }, /relay host/],
    ["a redirect off the fixture callback path", { ...approval, oauth: { ...approval.oauth, redirectUri: "https://auth.dev.example.test:8443/callback" } }, /\/oauth\/callback/],
    ["ephemeral ngrok without an API key for read-back", { ...approval, ngrokEphemeral: { authtokenEnv: "QUAL_NGROK_AUTHTOKEN" } }, /ngrokEphemeral is missing apiKeyEnv/],
    ["OAuth without a domain", { ...approval, domain: undefined }, /requires approval.domain/],
    ["a relative credentials file", { ...approval, cloudflare: { ...approval.cloudflare, credentialsFile: "tunnel.json" } }, /absolute path/],
  ])("refuses %s", (_name, value, error) => {
    expect(() => parseApproval(JSON.parse(JSON.stringify(value)))).toThrow(error);
  });
});

describe("prerequisite probes", () => {
  /** Host tools answering like a Linux host whose Caddy holds cap_net_bind_service. */
  const tools = (answers: Record<string, string> = {}) => async (command: string, args: readonly string[]) => {
    const key = [command, ...args].join(" ");
    const known: Record<string, string> = { "cat /proc/sys/net/ipv4/ip_unprivileged_port_start": "1024", "id -u": "1000", "sh -c command -v caddy": "/usr/bin/caddy",
      "getcap /usr/bin/caddy": "/usr/bin/caddy cap_net_bind_service=ep", "ps -A -o pid=,pgid=": "  1   1\n 42  42", ...answers };
    if (command === "lsof") return { code: 0, stdout: `p${String(process.pid)}\nn/tmp\n` };
    return { code: 0, stdout: known[key] ?? "{\"ok\":true}" };
  };
  const environment = (overrides: Partial<ProbeEnvironment> = {}): ProbeEnvironment => ({
    platform: "linux", nodeVersion: "v22.12.0", env: { QUAL_GOOGLE_ID: "id", QUAL_GOOGLE_SECRET: "google-secret-value" }, devfnCli: "/devfn/cli.js", approval: approvalFor(overrides.platform ?? "linux"), browserOperator: true,
    run: tools(), resolve: async () => ["127.0.0.1"], listening: async () => false, exists: async () => true, ...overrides,
  });
  const status = async (id: Parameters<typeof checkPrerequisites>[1] extends Iterable<infer T> ? T : never, overrides: Partial<ProbeEnvironment> = {}) =>
    (await checkPrerequisites(environment(overrides), [id]))[0];

  it("fails closed on unqualified hosts, occupied proxy ports, failed probes and non-loopback DNS", async () => {
    expect(await status("supported-host", { platform: "win32" })).toMatchObject({ status: "missing", detail: expect.stringContaining("win32") });
    expect(await status("supported-host", { nodeVersion: "v20.18.0" })).toMatchObject({ status: "missing" });
    expect(await status("proxy-ports", { listening: async (port) => port === 2019 })).toMatchObject({ status: "missing", detail: expect.stringContaining("2019") });
    expect(await status("caddy", { run: async () => { throw new Error("spawn failed"); } })).toMatchObject({ status: "missing" });
    expect(await status("registered-domain", { resolve: async (name) => name === "dev.example.test" ? ["127.0.0.1"] : ["127.0.0.1", "203.0.113.9"] })).toMatchObject({ status: "missing", detail: expect.stringContaining("203.0.113.9") });
    expect(await status("registered-domain", { resolve: async () => { throw new Error("SERVFAIL"); } })).toMatchObject({ status: "missing" });
    expect(await status("devfn-cli", { exists: async () => { throw new Error("EACCES"); } })).toMatchObject({ status: "invalid", detail: expect.stringContaining("EACCES") });
    expect(await status("process-tools", { run: tools({ "ps -A -o pid=,pgid=": "" }) })).toMatchObject({ status: "missing" });
    expect(await status("process-tools")).toMatchObject({ status: "satisfied" });
  });

  it("derives the proxy and relay ports from the probed platform, and needs Linux Caddy allowed to bind 80 and 443", async () => {
    expect(listenerPorts(process.platform)).toEqual(proxyListenerPorts());
    expect(await status("proxy-ports", { platform: "darwin", listening: async (port) => port === 443 })).toMatchObject({ status: "satisfied", detail: "free: 2019, 8080, 8443, 8444" });
    expect(await status("proxy-ports", { platform: "linux", listening: async (port) => port === 443 })).toMatchObject({ status: "missing", detail: expect.stringContaining("443") });
    for (const platform of ["darwin", "linux"] as const) {
      expect(await status("google-oauth", { platform }), platform).toMatchObject({ status: "satisfied" });
      const other = approvalFor(platform === "darwin" ? "linux" : "darwin");
      expect(await status("google-oauth", { platform, approval: other }), platform).toMatchObject({ status: "missing", detail: expect.stringContaining("relay origin") });
    }
    expect(await status("caddy")).toMatchObject({ status: "satisfied" });
    expect(await status("caddy", { run: tools({ "getcap /usr/bin/caddy": "" }) })).toMatchObject({ status: "missing", detail: expect.stringContaining("80 and 443") });
    expect(await status("caddy", { run: tools({ "getcap /usr/bin/caddy": "", "cat /proc/sys/net/ipv4/ip_unprivileged_port_start": "80" }) })).toMatchObject({ status: "satisfied" });
    expect(await status("caddy", { platform: "darwin", approval: approvalFor("darwin"), run: tools({ "getcap /usr/bin/caddy": "" }) })).toMatchObject({ status: "satisfied" });
  });

  it("accepts Compose only against a local Docker engine socket", async () => {
    const context = (host: string) => tools({ "docker context inspect --format {{.Endpoints.docker.Host}}": host, "docker context inspect remote --format {{.Endpoints.docker.Host}}": "ssh://ci@build.example.test" });
    expect(await localDockerEndpoint({}, context("unix:///var/run/docker.sock"))).toBe("unix:///var/run/docker.sock");
    await expect(localDockerEndpoint({ DOCKER_CONTEXT: "remote" }, context("unix:///var/run/docker.sock"))).rejects.toThrow(/ssh:\/\/ci@build.example.test, not a local engine socket/);
    await expect(localDockerEndpoint({ DOCKER_HOST: "tcp://10.0.0.5:2376" }, context("unix:///var/run/docker.sock"))).rejects.toThrow(/tcp:\/\/10.0.0.5:2376/);
    await expect(localDockerEndpoint({}, async () => ({ code: 1, stdout: "" }))).rejects.toThrow(/unreadable/);
    expect(await status("docker-compose", { run: context("unix:///var/run/docker.sock") })).toMatchObject({ status: "satisfied", detail: expect.stringContaining("local engine") });
    expect(await status("docker-compose", { run: context("tcp://docker.example.test:2376") })).toMatchObject({ status: "missing", detail: expect.stringContaining("remote targets need their own approval") });
  });

  it("finds a listener bound to IPv6 loopback only", async (test) => {
    const server = net.createServer();
    const bound = await new Promise<boolean>((resolve) => { server.once("error", () => resolve(false)); server.listen(0, "::1", () => resolve(true)); });
    if (!bound) { test.skip(); return; }
    try { expect(await loopbackListening((server.address() as net.AddressInfo).port)).toBe(true); } finally { server.close(); }
  });

  it("names unset credential variables without reading values into results", async () => {
    const result = await status("google-oauth", { env: { QUAL_GOOGLE_ID: "id" } });
    expect(result).toMatchObject({ status: "missing", detail: "credential variables unset: QUAL_GOOGLE_SECRET" });
    const ready = await checkPrerequisites(environment(), ["google-oauth", "registered-domain", "browser-operator"]);
    expect(ready.map((item) => item.status)).toEqual(["satisfied", "satisfied", "satisfied"]);
    expect(JSON.stringify(ready)).not.toContain("google-secret-value");
    expect(await status("browser-operator", { browserOperator: false })).toMatchObject({ status: "missing" });
    expect(await status("cloudflare", { approval: undefined })).toMatchObject({ status: "missing" });
  });
});

describe("scenario runner", () => {
  it("never runs a driver on an unqualified host or with an unmet prerequisite", async () => {
    let calls = 0;
    const driver: ScenarioDriver = async () => { calls += 1; };
    expect(await run(driver, { platform: "win32" })).toMatchObject({ status: "unsupported", observations: [], resources: [] });
    const blocked = await run(driver, { prerequisites: allPrerequisites.map((item) => item.id === "caddy" ? { ...item, status: "missing", detail: "caddy is unavailable" } : item) });
    expect(blocked).toMatchObject({ status: "blocked", reason: expect.stringMatching(/^EXTERNAL_ACCEPTANCE_GATE: DEV-17 needs caddy \(caddy is unavailable\)/) });
    expect(await run(undefined)).toMatchObject({ status: "blocked", reason: expect.stringContaining("No live driver") });
    expect(calls).toBe(0);
  });

  it("passes only with every planned assertion observed, resources read back absent and protected state unchanged", async () => {
    const resources = fakeResources();
    const passed = await run(complete, { resources });
    expect(passed).toMatchObject({ status: "passed", protectedChanges: [] });
    expect(passed.resources).toEqual([expect.objectContaining({ kind: "fixture-repository", cleanup: expect.objectContaining({ absent: true }) })]);
    expect(resources.removed).toEqual([`${ROOT}/qabcdef12-pair`]);

    expect(await run(async (context) => { context.observe("distinct-owners", true, "observed"); })).toMatchObject({ status: "failed", reason: "not observed: own-marker" });
    expect(await run(async (context) => { await complete(context); context.observe("own-marker", false, "other marker"); })).toMatchObject({ status: "failed", reason: "failed: own-marker" });
    expect((await run(async (context) => { await complete(context); context.observe("fabricated", true, "unplanned"); })).reason).toMatch(/has no planned assertion fabricated/);
  });

  it("cleans up after a failing driver and holds resources whose removal or read-back fails", async () => {
    const thrown = await run(async (context) => { await complete(context); throw new Error("edge unreachable"); });
    expect(thrown).toMatchObject({ status: "failed", reason: "driver: edge unreachable" });
    expect(thrown.resources[0].cleanup?.absent).toBe(true);
    const kept = await run(complete, { resources: fakeResources({ keep: `${ROOT}/qabcdef12-pair` }) });
    expect(kept).toMatchObject({ status: "failed", reason: expect.stringContaining("not confirmed absent: fixture-repository") });
    expect(kept.resources[0].cleanup?.detail).toBe("removal failed: provider refused; still present on read-back");
    const unreadable = await run(complete, { resources: fakeResources({ failRead: `${ROOT}/qabcdef12-pair` }) });
    expect(unreadable.resources[0].cleanup).toMatchObject({ absent: false, detail: "read-back failed: provider unreadable" });
  });

  it("on interrupt cleans up only after the running driver returned, so a resource it created late is read back, and starts nothing more", async () => {
    const interrupt = new AbortController();
    const events: string[] = [];
    const late = `${ROOT}/qabcdef12-late`;
    const existing = new Set<string>();
    const driver: ScenarioDriver = async (context) => {
      interrupt.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      // An in-flight start finished after the interrupt; it can no longer be removed, as a connector outside DevFn's reach.
      context.inventory.record("fixture-repository", late, context.scenario.id);
      existing.add(late);
      events.push("created");
      throw new Error("the run was interrupted");
    };
    const inventory = new DisposableInventory({ runId: "abcdef123456", root: ROOT, domains: [] });
    const scenarios = selectScenarios({ scenarios: ["host.two-worktrees", "host.route-isolation"] });
    const results = await runScenarios({ scenarios, platform: "linux", prerequisites: allPrerequisites, drivers: { "host.two-worktrees": driver, "host.route-isolation": async () => { events.push("second driver"); } },
      inventory, signal: interrupt.signal, snapshot: async () => ({}),
      resources: { remove: async () => { events.push("remove"); }, present: async (entry) => { events.push("read"); return existing.has(entry.id) ? "checkout exists" : false; } } });
    expect(events).toEqual(["created", "remove", "read"]);
    expect(results[0]).toMatchObject({ status: "failed", reason: expect.stringContaining(`not confirmed absent: fixture-repository ${late}`) });
    expect(results[1]).toMatchObject({ status: "blocked", reason: "The run was interrupted before this scenario started." });
  });

  it("fails on any protected change and refuses to start without a protected read", async () => {
    let reads = 0;
    const changed = await run(complete, { snapshot: async () => ({ routes: reads++ === 0 ? ["operator@app.localhost"] : [] }) });
    expect(changed).toMatchObject({ status: "failed", protectedChanges: ["routes: removed operator@app.localhost"] });
    let ran = false;
    const unreadable = await run(async () => { ran = true; }, { snapshot: async () => { throw new Error("EACCES"); } });
    expect(unreadable).toMatchObject({ status: "failed", reason: expect.stringContaining("protected inventory unreadable before start: EACCES") });
    expect(ran).toBe(false);
  });
});

describe("build provenance", () => {
  it("refuses a checkout whose entry points are fresh but an implementation module's output is stale or missing", async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-provenance-")));
    try {
      const file = async (name: string, at: number) => { await mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await writeFile(path.join(dir, name), "export {};\n"); await utimes(path.join(dir, name), at, at); };
      for (const name of ["devfn/cli/src/index.ts", "devfn/core/src/index.ts", "devfn/core/src/orchestrator.ts", "devfn/proxy/src/tunnel/service.ts", "devfn/core/src/types.d.ts"]) await file(name, 2_000);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["add", "."], { cwd: dir });
      for (const name of ["devfn/cli/dist/index.js", "devfn/core/dist/index.js", "devfn/core/dist/orchestrator.js", "devfn/proxy/dist/tunnel/service.js"]) await file(name, 3_000);
      expect(await staleBuildOutputs(dir)).toEqual([]);
      await file("devfn/core/dist/orchestrator.js", 1_000);
      await rm(path.join(dir, "devfn/proxy/dist/tunnel/service.js"));
      expect(await staleBuildOutputs(dir)).toEqual(["devfn/core/dist/orchestrator.js", "devfn/proxy/dist/tunnel/service.js"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("disposable inventory", () => {
  const inventory = () => new DisposableInventory({ runId: "abcdef123456", root: ROOT, domains: ["dev.example.test"] });

  it("refuses resources outside the run root, approved domains or run prefix", () => {
    const ledger = inventory();
    expect(() => ledger.record("runtime", "/tmp/devfn-qualification-test-other/app", "s")).toThrow(InventoryError);
    expect(() => ledger.record("fixture-repository", ROOT, "s")).toThrow(/outside the run root/);
    expect(() => ledger.record("registered-domain", "example.test", "s")).toThrow(/not an approved domain/);
    expect(() => ledger.record("tunnel-binding", "preview", "s")).toThrow(/not named for this run/);
    expect(() => ledger.record("public-hostname", "web-main-0123.dev.example.test", "s")).toThrow(/not a run-owned name/);
    expect(() => ledger.record("public-hostname", "web-qabcdef12-pair-0123.example.test", "s")).toThrow(/not a run-owned name/);
    expect(ledger.record("public-hostname", "web-qabcdef12-pair-0123.dev.example.test", "s").kind).toBe("public-hostname");
    expect(ledger.record("public-hostname", "web-qabcdef12-pair-0123.qabcdef12-nge.ngrok.devfn.internal", "s").kind).toBe("public-hostname");
    expect(() => ledger.record("public-hostname", "web-qabcdef12-pair-0123.dev.example.test", "s")).toThrow(/already recorded/);
  });

  it("persists every record and read-back to its ledger before returning", async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-ledger-")));
    try {
      const ledger = new DisposableInventory({ runId: "abcdef123456", root: dir, domains: ["dev.example.test"], ledger: path.join(dir, "inventory.json") });
      const read = async () => JSON.parse(await readFile(path.join(dir, "inventory.json"), "utf8")) as { entries: Array<Record<string, any>> };
      ledger.record("run-processes", dir, "run");
      expect(() => ledger.record("run-processes", `${dir}/x`, "run")).toThrow(/not the run root/);
      ledger.record("public-hostname", "web-qabcdef12-a-0123.dev.example.test", "s", { cwd: `${dir}/a`, binding: "qabcdef12-cf" });
      expect((await read()).entries.map((entry) => entry.kind)).toEqual(["run-processes", "public-hostname"]);
      expect((await read()).entries[1].context).toEqual({ cwd: `${dir}/a`, binding: "qabcdef12-cf" });
      await ledger.cleanup({ remove: async () => undefined, present: async (entry) => entry.kind === "run-processes" ? "processes in the run root: 4242" : false });
      expect((await read()).entries.map((entry) => entry.cleanup)).toEqual([
        expect.objectContaining({ absent: false, detail: "still present on read-back: processes in the run root: 4242" }), expect.objectContaining({ absent: true }),
      ]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("removes newest first and reads every resource back", async () => {
    const ledger = inventory();
    ledger.record("fixture-repository", `${ROOT}/repo`, "s");
    ledger.record("runtime", `${ROOT}/repo`, "s");
    ledger.record("registered-domain", "dev.example.test", "other");
    const resources = fakeResources();
    await ledger.cleanup(resources, "s");
    expect(resources.removed).toEqual([`${ROOT}/repo`, `${ROOT}/repo`]);
    expect(ledger.list().map((entry) => [entry.kind, entry.cleanup?.absent])).toEqual([["fixture-repository", true], ["runtime", true], ["registered-domain", undefined]]);
    expect(ledger.allAbsent("s")).toBe(true);
    expect(ledger.allAbsent()).toBe(false);
  });
});

describe("qualification receipts", () => {
  const passed = (id: string): ScenarioResult => {
    const scenario = NETWORKING_MATRIX.find((item) => item.id === id)!;
    return { id, row: scenario.row, status: "passed", protectedChanges: [], resources: [{ kind: "runtime", id: `${ROOT}/a`, scenario: id, createdAt: "t", cleanup: { absent: true, detail: "absent on read-back", checkedAt: "t" } }],
      observations: scenario.assertions.map((item) => ({ assertion: item.id, ok: true, detail: "observed", observedAt: "t" })) };
  };
  const absent = { absent: true, detail: "absent on read-back", checkedAt: "t" };
  const receipt = (platform: string, scenarios = NETWORKING_MATRIX.map((item) => passed(item.id))): NetworkingQualificationReceipt => ({
    contract: "devfn.networking-qualification/v1", check: "networking-qualification-contract", target: "DEV-17", head: HEAD, runId: "abcdef123456",
    provenance: { head: HEAD, checkout: "/src", clean: true, builtAfterSources: true, devfnCli: "/src/devfn/cli/dist/index.js" },
    host: { platform, arch: "x64", release: "1", node: "v22.12.0" }, startedAt: "t", finishedAt: "t", prerequisites: [], scenarios,
    runResources: [{ kind: "run-processes", id: ROOT, scenario: "run", createdAt: "t", cleanup: absent }, { kind: "proxy", id: `${ROOT}/state`, scenario: "run", createdAt: "t", cleanup: absent }],
    interface: ENDPOINT_INTERFACE, limitations: [], summary: summarize(scenarios),
  });

  it("rejects passed scenarios lacking evidence, cleanup or a qualified platform", () => {
    expect(receiptProblems(receipt("linux"))).toEqual([]);
    const unobserved = { ...passed("host.two-worktrees"), observations: [] };
    const leaked = { ...passed("host.internal-tls"), resources: [{ ...passed("host.internal-tls").resources[0], cleanup: { absent: false, detail: "still present", checkedAt: "t" } }] };
    const failedObservation = { ...passed("recovery.crash"), observations: [...passed("recovery.crash").observations, { assertion: "crash-detected", ok: false, detail: "x", observedAt: "t" }] };
    expect(receiptProblems(receipt("linux", [unobserved, leaked, failedObservation]))).toEqual([
      "host.two-worktrees: passed without observing distinct-owners", "host.two-worktrees: passed without observing own-marker",
      "host.internal-tls: passed with a resource not read back absent", "recovery.crash: passed with failed crash-detected",
    ]);
    expect(receiptProblems(receipt("win32", [passed("host.two-worktrees")]))).toEqual(["host.two-worktrees: passed on unqualified platform win32"]);
    expect(receiptProblems({ ...receipt("linux"), summary: { passed: 0, failed: 0, blocked: 0, unsupported: 0 } })).toEqual(["summary does not match scenarios"]);
  });

  it("rejects receipts not bound to a clean built head or whose run-level cleanup is unconfirmed", () => {
    const valid = receipt("linux");
    expect(receiptProblems({ ...valid, provenance: { ...valid.provenance, head: "b".repeat(40) } })).toEqual(["not run from a clean checkout built at its head"]);
    expect(receiptProblems({ ...valid, provenance: { ...valid.provenance, clean: false } })).toEqual(["not run from a clean checkout built at its head"]);
    expect(receiptProblems({ ...valid, provenance: undefined as never })).toEqual(["not run from a clean checkout built at its head"]);
    const caddy = { ...valid.runResources[1], cleanup: { absent: false, detail: "still present on read-back: the run's Caddy still runs or 2019 is held", checkedAt: "t" } };
    expect(receiptProblems({ ...valid, runResources: [valid.runResources[0], caddy] })).toEqual([`run-level proxy ${ROOT}/state not read back absent`]);
    expect(receiptProblems({ ...valid, runResources: [] })).toEqual(["run-level cleanup was not recorded"]);
    expect(networkingOutcomeGate([{ ...valid, runResources: [valid.runResources[0], caddy] }, receipt("darwin")], HEAD).ready).toBe(false);
  });

  it("opens the DEV-2 outcome only when every scenario passed on macOS and Linux at the head", () => {
    expect(networkingOutcomeGate([receipt("linux"), receipt("darwin")], HEAD)).toEqual({ ready: true, missing: [] });
    const linuxOnly = networkingOutcomeGate([receipt("linux"), receipt("win32")], HEAD);
    expect(linuxOnly.ready).toBe(false);
    expect(linuxOnly.missing).toHaveLength(NETWORKING_MATRIX.length);
    expect(networkingOutcomeGate([receipt("linux"), receipt("darwin")], "b".repeat(40)).ready).toBe(false);
    const blocked = receipt("darwin", NETWORKING_MATRIX.map((item) => item.id === "tunnel.cloudflare" ? { ...passed(item.id), status: "blocked" as const, observations: [], resources: [] } : passed(item.id)));
    expect(networkingOutcomeGate([receipt("linux"), blocked], HEAD)).toEqual({ ready: false, missing: ["darwin: tunnel.cloudflare"] });
  });

  it("redacts credential values anywhere in a receipt", () => {
    expect(redactSecrets({ detail: ["token cf-secret-value seen", { nested: "cf-secret-value" }], short: "abc" }, ["cf-secret-value", "abc"]))
      .toEqual({ detail: ["token [redacted] seen", { nested: "[redacted]" }], short: "abc" });
  });
});

describe("live host cleanup handlers", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ""; });

  /** A live host whose devfn, lsof and ps answer from fixtures; calls are recorded in order. */
  async function fixtureHost(answers: { devfn: Record<string, unknown>; lsof?: (root: string) => string; ps?: string; docker?: (args: readonly string[]) => { code: number; stdout: string } },
    providers?: ProviderReadBackFixture, env: NodeJS.ProcessEnv = {}) {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-livehost-")));
    const calls: string[] = [];
    const options: Array<Parameters<CommandRunner>[2]> = [];
    const run: CommandRunner = async (command, args, given) => {
      options.push(given);
      if (command === process.execPath) {
        const name = args.slice(1, args.indexOf("--json")).join(" ");
        calls.push(`devfn ${name}`);
        // An exact command, or the longest answered command it starts with.
        const answer = answers.devfn[name] ?? Object.entries(answers.devfn).filter(([key]) => name.startsWith(`${key} `)).sort(([a], [b]) => b.length - a.length)[0]?.[1];
        if (typeof answer === "function") return await (answer as (signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>)(given?.signal);
        return answer === undefined ? { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "UNEXPECTED" } }), stderr: "" } : { code: 0, stdout: JSON.stringify(answer), stderr: "" };
      }
      calls.push(command === "docker" ? `docker ${args.slice(0, 2).join(" ")}` : command);
      if (command === "docker") return { stderr: "", ...(answers.docker?.(args) ?? { code: 0, stdout: "" }) };
      return { code: 0, stdout: command === "lsof" ? answers.lsof?.(dir) ?? "p1\nn/\n" : command === "ps" ? answers.ps ?? "" : "", stderr: "" };
    };
    const inventory = new DisposableInventory({ runId: "abcdef123456", root: dir, domains: ["dev.example.test"] });
    const host = new LiveHost({ root: dir, devfnCli: "/devfn/cli.js", env, inventory, run, providers: providers ?? (async () => { throw new Error("no provider in this fixture"); }), docker: "unix:///var/run/docker.sock" });
    await mkdir(host.stateDir, { recursive: true });
    return { host, inventory, calls, options };
  }
  type ProviderReadBackFixture = (binding: TunnelBinding, hostname: string, url: string | undefined) => Promise<string[]>;
  const stopped = { status: { state: "stopped", instanceId: "i1" }, ports: { allocations: [] }, down: { ok: true } };

  it("reads a runtime back after devfn down and before any reaping, leaving shared process groups to their own resources", async () => {
    // The run's Caddy (group 900) inherited the checkout as its working directory; 4242 is a fixture process that outlived devfn down; 77 runs in a sibling checkout.
    const { host, inventory, calls } = await fixtureHost({ devfn: stopped, ps: "4242 4242\n4343 900\n77 77\n",
      lsof: (root) => `p4242\nn${root}/qabcdef12-app\np4343\nn${root}/qabcdef12-app/sub\np77\nn${root}/qabcdef12-app-b\n` });
    const runtime = path.join(dir, "qabcdef12-app");
    await writeFile(path.join(host.stateDir, "proxy-owner.json"), JSON.stringify({ pid: 900 }));
    inventory.record("runtime", runtime, "s");
    await inventory.cleanup(host.handlers(), "s");
    expect(inventory.list("s")[0].cleanup).toMatchObject({ absent: false, detail: "still present on read-back: processes: 4242" });
    // Removal is devfn down alone; the read-back saw the survivor and nothing was reaped (one lsof listing, no second pass).
    // Every check runs: without a readable manifest the Compose resources of the owner are listed too.
    expect(calls).toEqual(["devfn down", "devfn status", "devfn ports", "lsof", "ps", "docker ps -a", "docker network ls"]);
  });

  it("reports a removed working directory and the Compose containers and networks an owner left on the pinned engine", async () => {
    const owner = ownerLabel("i1");
    const listings: Record<string, string> = { ps: `qualification-echo-1\tdevfn-p-0123456789ab-${owner}\nother-1\tdevfn-p-0123456789ab-o-ffffffffffffffffffff\n`, network: `devfn-p-0123456789ab-${owner}_default\tdevfn-p-0123456789ab-${owner}\n` };
    let docker = (args: readonly string[]) => ({ code: 0, stdout: listings[args[0]] ?? "" });
    const { host, inventory, options } = await fixtureHost({ devfn: stopped, docker: (args) => docker(args), lsof: (root) => `p4242\nn${root}/qabcdef12-gone (deleted)\n` }, undefined, { DOCKER_CONTEXT: "remote", HOME: "/home/operator" });
    expect(await host.processesIn(path.join(dir, "qabcdef12-gone"), new Set())).toEqual([4242]);
    const runtime = path.join(dir, "qabcdef12-compose");
    await mkdir(runtime);
    await writeFile(path.join(runtime, "devfn.config.json"), JSON.stringify(composeFixture()));
    inventory.record("runtime", runtime, "s");
    await inventory.cleanup(host.handlers(), "s");
    expect(inventory.list("s")[0].cleanup?.detail).toBe(`still present on read-back: Compose resources: container qualification-echo-1, network devfn-p-0123456789ab-${owner}_default`);
    // Every docker command uses the pinned local engine, never the operator's context.
    const dockerEnv = options.filter((item) => item?.env?.DOCKER_HOST !== undefined).map((item) => item!.env!);
    expect(dockerEnv.length).toBeGreaterThan(0);
    for (const env of dockerEnv) expect(env).toMatchObject({ DOCKER_HOST: "unix:///var/run/docker.sock", HOME: "/home/operator" });
    expect(dockerEnv.some((env) => "DOCKER_CONTEXT" in env)).toBe(false);
    // Leftovers are removed only after the read-back recorded them, containers before networks.
    const removed: string[] = [];
    docker = (args) => { if (args[0] === "rm" || args[1] === "rm") removed.push(args.join(" ")); return { code: 0, stdout: listings[args[0]] ?? "" }; };
    await host.reapCompose();
    expect(removed).toEqual(["rm -f qualification-echo-1", `network rm devfn-p-0123456789ab-${owner}_default`]);
    // An unreadable engine is never absence.
    docker = () => ({ code: 1, stdout: "" });
    await inventory.cleanup(host.handlers(), "s");
    expect(inventory.list("s")[0].cleanup?.detail).toBe("read-back failed: docker could not list containers on the pinned engine");
  });

  it("runs every DevFn command in the run environment and, once aborted, kills in-flight commands and refuses creation but not cleanup", async () => {
    let inFlight: AbortSignal | undefined;
    const up = async (signal?: AbortSignal) => { inFlight = signal; await new Promise((resolve) => signal?.addEventListener("abort", resolve)); return { code: -1, stdout: "", stderr: "killed" }; };
    const { host, calls, options } = await fixtureHost({ devfn: { ...stopped, up } }, undefined, { XDG_DATA_HOME: "/home/operator/.local/share" });
    const runtime = path.join(dir, "qabcdef12-crash");
    // The crash scenario's own kill and the run's abort both reach the in-flight start.
    const kill = new AbortController();
    const killed = host.up("s", runtime, [], kill.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    kill.abort();
    expect(await killed).toMatchObject({ json: { error: { code: "UNPARSEABLE" } } });
    expect(options.at(-1)?.env).toMatchObject({ XDG_DATA_HOME: path.join(dir, "xdg", "data"), XDG_CONFIG_HOME: path.join(dir, "xdg", "config"), XDG_STATE_HOME: path.join(dir, "xdg", "state") });
    const pending = host.up("s", path.join(dir, "qabcdef12-other"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    host.abort();
    await pending;
    expect(inFlight?.aborted).toBe(true);
    await expect(host.up("s", runtime)).rejects.toThrow(/interrupted; devfn up is refused/);
    await expect(host.repository("s", "late", hostFixture())).rejects.toThrow(/refused/);
    await expect(host.must(runtime, ["tunnel", "register", "qabcdef12-cf"])).rejects.toThrow(/refused/);
    expect((await host.devfn(runtime, ["down"])).code).toBe(0);
    expect(calls.filter((call) => call.startsWith("devfn"))).toEqual(["devfn up", "devfn up", "devfn down"]);
  });

  it("reports surviving fixture processes and routes the owner still holds in the run proxy state", async () => {
    const { host, inventory } = await fixtureHost({ devfn: stopped });
    const runtime = path.join(dir, "qabcdef12-app");
    await mkdir(runtime);
    await writeFile(path.join(runtime, "seen-web.json"), JSON.stringify({ pid: process.pid, env: {} }));
    inventory.record("runtime", runtime, "s");
    await inventory.cleanup(host.handlers(), "s");
    expect(inventory.list("s")[0].cleanup?.detail).toBe(`still present on read-back: fixture processes: ${process.pid}`);
    await rm(path.join(runtime, "seen-web.json"));
    await writeFile(path.join(host.stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [
      { id: "i1-web", instanceId: "i1", hostname: "web-o-1.localhost", targetHost: "127.0.0.1", targetPort: 41000, tls: "off", updatedAt: "t" },
      { id: "other-web", instanceId: "other", hostname: "web-o-2.localhost", targetHost: "127.0.0.1", targetPort: 41001, tls: "off", updatedAt: "t" }] }));
    await inventory.cleanup(host.handlers(), "s");
    expect(inventory.list("s")[0].cleanup?.detail).toBe("still present on read-back: routes: web-o-1.localhost");
  });

  it("snapshots operator records by material fields, so a same-name route, domain or binding change is a protected change", async () => {
    const operator = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-operator-")));
    try {
      const { host } = await fixtureHost({ devfn: {} }, undefined, { XDG_STATE_HOME: operator });
      host.trustAnchors = async () => ["anchor"];
      const state = path.join(operator, "devfn");
      await mkdir(state, { recursive: true });
      const route = { id: "op-web", instanceId: "op", hostname: "web-o-1.localhost", targetHost: "127.0.0.1", targetPort: 41000, tls: "internal", updatedAt: "t1" };
      const domain = { domain: "operator.example.test", projectId: "op", repositoryIdentity: "/op", tls: "internal" };
      const write = async (changes: { route?: object; domain?: object } = {}) => {
        await writeFile(path.join(state, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [{ ...route, ...changes.route }] }));
        await writeFile(path.join(state, "domains.json"), JSON.stringify({ version: 1, domains: [{ ...domain, ...changes.domain }] }));
      };
      await write();
      await registerTunnelBinding(state, { name: "operator-ngr", provider: "ngrok", domain: ephemeralOriginDomain("operator-ngr"), projectId: "op", repositoryIdentity: "/op", nonproduction: true,
        ngrok: { endpoints: "ephemeral", authtokenEnv: "OP_NGROK_AUTHTOKEN", apiKeyEnv: "OP_NGROK_API_KEY" } });
      const before = await host.snapshot();
      // A rewrite that changes only DevFn's own timestamp is not material.
      await write({ route: { updatedAt: "t2" } });
      expect(protectedChanges(before, await host.snapshot())).toEqual([]);
      await write({ route: { targetPort: 42000 } });
      expect(protectedChanges(before, await host.snapshot())).toEqual([`routes: removed op-web@web-o-1.localhost ${materialDigest(route)}`,
        `routes: added op-web@web-o-1.localhost ${materialDigest({ ...route, targetPort: 42000 })}`]);
      await write({ domain: { tls: "certificate", certificateFile: "/op/cert.pem", keyFile: "/op/key.pem" } });
      expect((await host.snapshot().then((after) => protectedChanges(before, after))).filter((change) => change.startsWith("domains:"))).toHaveLength(2);
      await write();
      const registry = JSON.parse(await readFile(path.join(state, "tunnels.json"), "utf8")) as { bindings: Array<{ ngrok: Record<string, string> }> };
      registry.bindings[0].ngrok.authtokenEnv = "OTHER_NGROK_AUTHTOKEN";
      await writeFile(path.join(state, "tunnels.json"), JSON.stringify(registry));
      const after = await host.snapshot();
      expect(protectedChanges(before, after).map((change) => change.split(" ").slice(0, 3).join(" "))).toEqual(["tunnelBindings: removed operator-ngr", "tunnelBindings: added operator-ngr"]);
      // Bindings hold credential variable names only; a snapshot never holds a credential value.
      expect(JSON.stringify(after)).not.toContain("OTHER_NGROK_AUTHTOKEN");
    } finally { await rm(operator, { recursive: true, force: true }); }
  });

  /** A process that stands in for a relay or connector that outlived its removal. */
  async function survivor() {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const exited = once(child, "exit");
    return { pid: child.pid!, stop: async () => { child.kill("SIGKILL"); await exited; } };
  }

  it("keeps a checkout that still runs processes for its read-back and reaps nothing before it", async () => {
    const { host, inventory, calls } = await fixtureHost({ devfn: stopped, lsof: (root) => `p4242\nn${root}/qabcdef12-app/sub\n` });
    const checkout = path.join(dir, "qabcdef12-app");
    await mkdir(checkout);
    inventory.record("fixture-repository", checkout, "s");
    await inventory.cleanup(host.handlers(), "s");
    expect(inventory.list("s")[0].cleanup).toMatchObject({ absent: false,
      detail: "removal failed: processes 4242 still run in the checkout, so it is kept; still present on read-back: checkout exists; processes: 4242" });
    await expect(access(checkout)).resolves.toBeUndefined();
    // One listing before removal and one for the read-back: nothing was signalled, which would list again.
    expect(calls).toEqual(["lsof", "lsof"]);
  });

  it("fails a tunnel binding whose connector outlives unregister or whose provider still holds a marked name", async () => {
    const connector = await survivor();
    let held: string[] = [];
    const { host, inventory } = await fixtureHost({ devfn: { "tunnel unregister qabcdef12-nge": async () => {
      await writeFile(path.join(host.stateDir, "tunnels.json"), JSON.stringify({ version: 1, bindings: [] }));
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    } } }, async (_binding, hostname) => hostname === undefined ? held : []);
    try {
      const binding = await registerTunnelBinding(host.stateDir, { name: "qabcdef12-nge", provider: "ngrok", domain: ephemeralOriginDomain("qabcdef12-nge"), projectId: "qualification",
        repositoryIdentity: dir, nonproduction: true, ngrok: { endpoints: "ephemeral", authtokenEnv: "QUAL_NGROK_AUTHTOKEN", apiKeyEnv: "QUAL_NGROK_API_KEY" } });
      const state = tunnelPaths(host.stateDir, binding.name).state;
      await mkdir(path.dirname(state), { recursive: true });
      await writeFile(state, JSON.stringify({ version: 1, binding: binding.name, hostnames: [], retired: [], residue: [],
        connector: { pid: connector.pid, birthSignature: "fixture", startedAt: new Date().toISOString(), configDigest: "0".repeat(64), metricsPort: 4040, hostnames: [] } }));
      inventory.record("tunnel-binding", binding.name, "s", { cwd: dir });
      await inventory.cleanup(host.handlers(), "s");
      // The connector dropped out of the run state with the binding, yet the read-back still knows its process.
      expect(inventory.list("s")[0].cleanup?.detail).toBe(`still present on read-back: connector processes: ${connector.pid}`);
      await connector.stop();
      held = ["abc123.ngrok-free.app"];
      await inventory.cleanup(host.handlers(), "s");
      expect(inventory.list("s")[0].cleanup?.detail).toBe("still present on read-back: held by ngrok: abc123.ngrok-free.app");
      held = [];
      await inventory.cleanup(host.handlers(), "s");
      expect(inventory.list("s")[0].cleanup?.absent).toBe(true);
    } finally { await connector.stop().catch(() => undefined); }
  });

  it("fails an OAuth relay whose process outlives oauth-relay stop", async () => {
    const relay = await survivor();
    const { host, inventory } = await fixtureHost({ devfn: { "oauth-relay stop": { ok: true }, "oauth-relay status": { relay: { running: false, routeActive: false } } } });
    try {
      const { service } = relayPaths(host.stateDir);
      await mkdir(path.dirname(service), { recursive: true });
      await writeFile(service, JSON.stringify({ version: 1, pid: relay.pid, birthSignature: "fixture", startedAt: new Date().toISOString(), port: 8443, origin: "https://auth.dev.example.test:8443",
        hostname: "auth.dev.example.test", domain: "dev.example.test", projectId: "qualification", repositoryIdentity: dir, invocationId: "i1" }));
      const entry = inventory.record("oauth-relay", "dev.example.test", "s", { cwd: dir });
      expect(entry.kind).toBe("oauth-relay");
      await inventory.cleanup(host.handlers(), "s");
      // status alone reports the relay stopped; the process recorded before stop still runs.
      expect(inventory.list("s")[0].cleanup?.detail).toBe(`still present on read-back: relay processes: ${relay.pid}`);
      await relay.stop();
      await inventory.cleanup(host.handlers(), "s");
      expect(inventory.list("s")[0].cleanup?.absent).toBe(true);
    } finally { await relay.stop().catch(() => undefined); }
  });

  it("records an ngrok-ephemeral public name before up, so a publish that then fails is still read back at the provider", async () => {
    let published = false;
    const fail = { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "DEVFN_TUNNEL_PROVIDER_FAILED" } }), stderr: "" };
    const { host, inventory, calls } = await fixtureHost({ devfn: {
      status: stopped.status, down: stopped.down, ports: stopped.ports, "tunnel urls": { ok: true, timing: "post-start", urls: {}, assignedAfterStart: ["web"] },
      "tunnel register": async () => {
        await registerTunnelBinding(host.stateDir, { name: "qabcdef12-nge", provider: "ngrok", domain: ephemeralOriginDomain("qabcdef12-nge"), projectId: "qualification",
          repositoryIdentity: dir, nonproduction: true, ngrok: { endpoints: "ephemeral", authtokenEnv: "QUAL_NGROK_AUTHTOKEN", apiKeyEnv: "QUAL_NGROK_API_KEY" } });
        return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      },
      // The provider assigned and served an endpoint, then the start failed.
      "up --allow-public": async () => { published = true; return fail; },
      "tunnel status": { tunnel: { hostnames: [], outstanding: [] } }, "tunnel unregister": { ok: true },
    } }, async (binding) => published && binding.name === "qabcdef12-nge" ? ["abc123.ngrok-free.app"] : []);
    const scenario = NETWORKING_MATRIX.find((item) => item.id === "tunnel.ngrok-ephemeral")!;
    const context: ScenarioContext = { scenario, inventory, observe: () => undefined, expect: () => undefined };
    await expect(liveDrivers(host, parseApproval(approval))[scenario.id](context)).rejects.toThrow(/devfn up in qabcdef12-public failed/);
    expect(calls.filter((call) => call.startsWith("devfn up"))).toEqual(["devfn up --allow-public"]);
    const recorded = inventory.list(scenario.id).map((entry) => `${entry.kind} ${entry.id.replace(dir, "<root>")}`);
    expect(recorded).toEqual(["fixture-repository <root>/qabcdef12-public", "tunnel-binding qabcdef12-nge",
      expect.stringMatching(/^public-hostname web-qabcdef12-public-[a-f0-9]{20}\.qabcdef12-nge\.ngrok\.devfn\.internal$/), "runtime <root>/qabcdef12-public"]);
    await inventory.cleanup(host.handlers(), scenario.id);
    const name = inventory.list(scenario.id).find((entry) => entry.kind === "public-hostname")!;
    expect(name.cleanup).toMatchObject({ absent: false, detail: "still present on read-back: held by ngrok: abc123.ngrok-free.app" });
  });

  it("reads a public name back through the provider and never treats an unreadable provider as absence", async () => {
    const held = new Set(["held"]);
    let provider: ProviderReadBackFixture = async () => held.has("held") ? ["web-qabcdef12-public.ngrok-free.app"] : [];
    const { host, inventory } = await fixtureHost({ devfn: { "tunnel status qabcdef12-nge": { tunnel: { hostnames: [], outstanding: [] } } } }, async (...args) => await provider(...args));
    const binding = await registerTunnelBinding(host.stateDir, { name: "qabcdef12-nge", provider: "ngrok", domain: ephemeralOriginDomain("qabcdef12-nge"), projectId: "qualification",
      repositoryIdentity: dir, nonproduction: true, ngrok: { endpoints: "ephemeral", authtokenEnv: "QUAL_NGROK_AUTHTOKEN", apiKeyEnv: "QUAL_NGROK_API_KEY" } });
    const name = `web-qabcdef12-public-0123.${binding.domain}`;
    // The URL refuses connections: a failed request alone is never evidence of absence.
    const entry = inventory.record("public-hostname", name, "s", { cwd: dir, binding: binding.name, url: "http://127.0.0.1:9/" });
    const handlers = host.handlers();
    expect(await handlers.present(entry)).toBe("held by ngrok: web-qabcdef12-public.ngrok-free.app");
    provider = async () => { throw new Error("ngrok GET /endpoints answered HTTP 503"); };
    await expect(handlers.present(entry)).rejects.toThrow(/503/);
    await inventory.cleanup({ remove: async () => undefined, present: handlers.present }, "s");
    expect(inventory.list("s")[0].cleanup).toMatchObject({ absent: false, detail: "read-back failed: ngrok GET /endpoints answered HTTP 503" });
    held.clear();
    provider = async () => held.has("held") ? ["web-qabcdef12-public.ngrok-free.app"] : [];
    expect(await handlers.present(entry)).toBe(false);
  });

  it("finds a run's ngrok endpoints by marker or name and fails closed on unreadable pages or a missing API key", async () => {
    const binding = { name: "qabcdef12-ngr", provider: "ngrok", domain: "ngrok.example.test", projectId: "qualification", repositoryIdentity: "/r", nonproduction: true,
      ngrok: { endpoints: "reserved", authtokenEnv: "QUAL_NGROK_AUTHTOKEN", apiKeyEnv: "QUAL_NGROK_API_KEY", registrationId: "c".repeat(32) } } as TunnelBinding;
    const pages = (endpoints: unknown[], tunnels: unknown[] = [], status = 200): typeof fetch => (async (url: string | URL | Request) => {
      const list = String(url).includes("/endpoints") ? { endpoints } : { tunnels };
      return new Response(JSON.stringify({ ...list, next_page_uri: null }), { status });
    }) as typeof fetch;
    const env = { QUAL_NGROK_API_KEY: "key" };
    expect(await providerReadBack(env, pages([{ url: "https://other.ngrok.example.test", metadata: ngrokMarker(binding) }]))(binding, "web-q.ngrok.example.test", undefined)).toEqual(["other.ngrok.example.test"]);
    expect(await providerReadBack(env, pages([], [{ public_url: "https://web-q.ngrok.example.test", metadata: "foreign" }]))(binding, "web-q.ngrok.example.test", undefined)).toEqual(["web-q.ngrok.example.test"]);
    expect(await providerReadBack(env, pages([{ url: "https://other.ngrok.example.test", metadata: "foreign" }]))(binding, "web-q.ngrok.example.test", undefined)).toEqual([]);
    await expect(providerReadBack(env, pages([], [], 503))(binding, "web-q.ngrok.example.test", undefined)).rejects.toThrow(/HTTP 503/);
    await expect(providerReadBack({}, pages([]))(binding, "web-q.ngrok.example.test", undefined)).rejects.toThrow(/no readable API key/);
  });
});

describe("answer predicates", () => {
  const answer = (status: number, body = "", headers: Record<string, string> = {}): Answer => {
    let json: Record<string, any> | undefined;
    try { json = JSON.parse(body) as Record<string, any>; } catch { json = undefined; }
    return { status, body, headers, ...(json ? { json } : {}) };
  };
  const header = PUBLIC_ORIGIN_HEADER.toLowerCase();
  const fixture = answer(200, JSON.stringify({ marker: "qabcdef12-public", name: "private" }));
  const failures: Record<string, Answer | undefined> = {
    "transport error": undefined, "500": answer(500, "DEVFN_OAUTH_RELAY_FAILED\n"), "503": answer(503, "DEVFN_OAUTH_RELAY_UNAVAILABLE\n"), "502": answer(502),
    "fixture 404": answer(404, JSON.stringify({ marker: "qabcdef12-public" })), "fixture 200": fixture, "421": answer(421), "403 deny": answer(403, "", { [header]: "deny" }),
    "403 unmarked": answer(403), "404 fallback": answer(404, "", { [header]: "fallback" }), "404 proxy": answer(404), "301": answer(301, "", { location: "https://app-x.localhost:8443/" }),
    "308": answer(308, "", { location: "https://app-x.localhost:8443/" }), "403 replayed": answer(403, "DEVFN_OAUTH_RELAY_REJECTED: replayed\n"), "403 unknown-state": answer(403, "DEVFN_OAUTH_RELAY_REJECTED: unknown-state\n"),
    "421 wrong-origin": answer(421, "DEVFN_OAUTH_RELAY_REJECTED: wrong-origin\n"),
  };
  const accepted = (predicate: (item?: Answer) => boolean) => Object.entries(failures).filter(([, item]) => predicate(item)).map(([name]) => name);

  it("accept only the shipped component's own answer for each claim", () => {
    expect(accepted(ANSWERS.originDenied)).toEqual(["403 deny"]);
    expect(accepted(ANSWERS.forgedHostRefused)).toEqual(["421"]);
    expect(accepted(ANSWERS.originFallback)).toEqual(["404 fallback"]);
    expect(accepted(ANSWERS.relayReplayRejected)).toEqual(["403 replayed"]);
    // The local proxy's empty 404; the marked origin fallback is a public-origin answer, not a local one.
    expect(accepted(ANSWERS.proxyNotFound)).toEqual(["404 fallback", "404 proxy"]);
    expect(accepted((item) => ANSWERS.httpsRedirect(item, "app-x.localhost"))).toEqual(["308"]);
    expect(ANSWERS.httpsRedirect(failures["308"], "app-y.localhost")).toBe(false);
  });

  it("accept for a mismatched Host only the provider edge's own refusal, never a 5xx or an answer the DevFn origin could give", () => {
    const edge = { server: "cloudflare", "cf-ray": "8f0000000000-LAX" };
    const answers: Record<string, Answer | undefined> = { ...failures,
      "cloudflare 1001": answer(530, "error code: 1001", edge), "cloudflare 1003": answer(403, "error code: 1003\n", edge),
      "cloudflare 1033 (a tunnel matched)": answer(530, "error code: 1033", edge), "cloudflare forwarded 502": answer(502, "error code: 502", edge),
      "cloudflare forwarded origin 421": answer(421, "", edge), "cloudflare forwarded origin deny": answer(403, "", { ...edge, [header]: "deny" }),
      "cloudflare 1001 without edge headers": answer(530, "error code: 1001"),
      "ngrok 3200": answer(404, "", { "ngrok-error-code": "ERR_NGROK_3200" }), "ngrok 8012": answer(502, "", { "ngrok-error-code": "ERR_NGROK_8012" }),
      "ngrok forwarded origin deny": answer(403, "", { "ngrok-error-code": "ERR_NGROK_3200", [header]: "deny" }),
    };
    const edgeAccepted = (provider: TunnelBinding["provider"]) => Object.entries(answers).filter(([, item]) => ANSWERS.edgeUnrouted(item, provider)).map(([name]) => name);
    expect(edgeAccepted("cloudflare")).toEqual(["cloudflare 1001", "cloudflare 1003"]);
    expect(edgeAccepted("ngrok")).toEqual(["ngrok 3200"]);
  });

  it("require a provider read-back holding nothing for the private route and only the selected public host", () => {
    expect(ANSWERS.providerWithheld([], "web-q.preview.example.test", "private-q.preview.example.test")).toBe(true);
    expect(ANSWERS.providerWithheld(["web-q.ngrok-free.app"], "web-q.ngrok-free.app", "private-q.ngrok.devfn.internal")).toBe(true);
    expect(ANSWERS.providerWithheld(["private-q.preview.example.test"], "web-q.preview.example.test", "private-q.preview.example.test")).toBe(false);
    expect(ANSWERS.providerWithheld(["web-q.ngrok-free.app", "other.ngrok-free.app"], "web-q.ngrok-free.app", "private-q.ngrok.devfn.internal")).toBe(false);
  });

  it("route the private fixture over internal TLS so the public origin holds its certificate and must deny it", () => {
    const config = validateDevFnConfig(tunnelFixture("qabcdef12-cf", false));
    expect(config.hostnames?.private).toMatchObject({ tls: "internal" });
  });
});

describe("opaque-owner endpoint interface", () => {
  it("matches the @devfn/core resolver outputs and its owner label", () => {
    const config = validateDevFnConfig(hostFixture());
    const resolution = resolveEndpointTemplates({ config, plan: createPlan(config), ownerId: "owner/with spaces", ports: { web: 41000, api: 41001 } });
    expect(Object.keys(resolution).sort()).toEqual(["ownerId", ...ENDPOINT_INTERFACE.outputs].sort());
    const hostname = resolveLocalHostname(undefined, "web", "qualification", "owner/with spaces");
    expect(ownerLabel("owner/with spaces")).toMatch(/^o-[a-f0-9]{20}$/);
    expect(hostname).toBe(`web-${ownerLabel("owner/with spaces")}.localhost`);
    expect(hostname).not.toContain("owner");
    expect(ENDPOINT_INTERFACE.owner).toContain("o-<20 hex sha256 digest>");
  });
});
