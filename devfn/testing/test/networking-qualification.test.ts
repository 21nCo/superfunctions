import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, statSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isCredentialKey, processBirthSignature, validateDevFnConfig } from "@devfn/config";
import { createPlan, resolveEndpointTemplates, resolveLocalHostname } from "@devfn/core";
import { proxyListenerPorts, PUBLIC_ORIGIN_HEADER } from "@devfn/proxy";
import { relayPaths } from "@devfn/proxy/oauth-relay";
import { ephemeralOriginDomain, ngrokMarker, readTunnelBindings, registerTunnelBinding, tunnelPaths, type TunnelBinding } from "@devfn/proxy/tunnel";
import { executeRun, main, staleBuildOutputs, writeReceipt, type QualificationRun } from "../src/networking/cli.js";
import { loopbackListening } from "../src/networking/prerequisites.js";
import {
  ANSWERS, approvedDomains, checkPrerequisites, cloudflareConnectors, cloudflaredConnectorId, detach, dnsAbsent, RECOVERED, resolverDifferences, restartConnector, RUNTIME_ONLY_KEYS, composeFixture, DEFERRED_ROWS, DisposableInventory, domainFixture, ENDPOINT_INTERFACE, failureInjection, FIXTURE_SERVER, hostFixture, INTERRUPTED, LIFECYCLE_COMMAND_TIMEOUT_MS, interruptStart, InventoryError, listenerPorts, liveDrivers, LiveHost,
  failedWith, ownedStatus, SHIPPED_ERRORS, localDockerEndpoint, materialDigest, NETWORKING_MATRIX, networkingOutcomeGate, oauthFixture, ownerLabel, parseApproval, providerHeld, providerReadBack, receiptProblems, redactSecrets, rolledBackReadySibling, runExitCode, runScenarios, selectScenarios, summarize, trustDirectoryAnchors, tunnelFixture,
  protectedChanges, type Answer, type CommandRunner, type PublicOutcome, type NetworkingQualificationReceipt, type PrerequisiteResult, type ProbeEnvironment, type ProtectedSnapshot, type ResourceHandlers, type ScenarioContext, type ScenarioDriver, type ScenarioResult,
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

  it("starts the OAuth fixture with an approved client ID variable whose name DevFn classifies as a credential", () => {
    const clientIdEnv = "QUAL_GOOGLE_AUTH_CLIENT_ID";
    expect(isCredentialKey(clientIdEnv)).toBe(true);
    const oauth = parseApproval({ ...approval, oauth: { ...approval.oauth, clientIdEnv } }).oauth!;
    expect(() => validateDevFnConfig(oauthFixture("dev.example.test", oauth))).not.toThrow();
  });
});

describe("owned status and shipped errors", () => {
  const answer = (code: number, json: Record<string, unknown>) => ({ code, json });
  it("reads a status only as exit 0 with a lifecycle state and the asked owner's instance ID", () => {
    expect(ownedStatus(answer(0, { ok: false, state: "degraded", instanceId: "i1" }), "i1")).toMatchObject({ state: "degraded" });
    expect(ownedStatus(answer(0, { ok: true, state: "stopped", instanceId: "i1" }), "i1")).toMatchObject({ state: "stopped" });
    for (const unreadable of [answer(-1, { ok: false, error: { code: "UNPARSEABLE" } }), answer(1, { ok: false, error: { code: "DEVFN_CONFIG_INVALID" } }),
      answer(0, { ok: true, state: "ready", instanceId: "other" }), answer(0, { ok: true, state: "paused", instanceId: "i1" }), answer(0, { ok: true, instanceId: "i1" }), answer(1, { ok: false, state: "failed", instanceId: "i1" })]) {
      expect(ownedStatus(unreadable, "i1")).toBeUndefined();
    }
  });

  it("takes a provoked failure only from DevFn's own report of an allowed code", () => {
    expect(failedWith(answer(1, { ok: false, error: { code: "DEVFN_START_FAILED" } }), SHIPPED_ERRORS.startupFailure)).toBe(true);
    expect(failedWith(answer(1, { ok: false, error: { code: "DEVFN_ALREADY_RUNNING" } }), SHIPPED_ERRORS.concurrentStart)).toBe(true);
    for (const other of [answer(1, { ok: false, error: { code: "UNPARSEABLE" } }), answer(-1, { ok: false, error: { code: "DEVFN_START_FAILED" } }),
      answer(0, { ok: false, error: { code: "DEVFN_START_FAILED" } }), answer(1, { ok: false, error: { code: "DEVFN_ALREADY_RUNNING" } })]) {
      expect(failedWith(other, SHIPPED_ERRORS.startupFailure)).toBe(false);
    }
    expect(failedWith(undefined, SHIPPED_ERRORS.concurrentStart)).toBe(false);
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
  /**
   * The Cloudflare API for the approved tunnel: GET cfd_tunnel/{id}/connections
   * answers these clients, and GET cfd_tunnel/{id} this status, with its
   * deprecated connections field always empty, as Cloudflare documents it will be.
   */
  const tunnelApi = (clients: unknown[] | undefined, tunnelStatus = "inactive", status = 200): typeof fetch => async (input, init) => {
    const base = `https://api.cloudflare.com/client/v4/accounts/${approval.cloudflare.accountId}/cfd_tunnel/${approval.cloudflare.tunnelId}`;
    expect([base, `${base}/connections`]).toContain(String(input));
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cf-token-value");
    if (status !== 200) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status });
    return new Response(JSON.stringify({ success: true, result: String(input) === base ? { id: approval.cloudflare.tunnelId, status: tunnelStatus, connections: [] } : clients }), { status });
  };
  const environment = (overrides: Partial<ProbeEnvironment> = {}): ProbeEnvironment => ({
    platform: "linux", nodeVersion: "v22.12.0", env: { QUAL_GOOGLE_ID: "id", QUAL_GOOGLE_SECRET: "google-secret-value", QUAL_CF_TOKEN: "cf-token-value" }, fetch: tunnelApi([]), devfnCli: "/devfn/cli.js", approval: approvalFor(overrides.platform ?? "linux"), browserOperator: true,
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
    // Docker lets DOCKER_HOST override an explicitly named context, so both set never pins either one, local or remote.
    for (const named of ["remote", "default"]) {
      await expect(localDockerEndpoint({ DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: named }, context("unix:///var/run/docker.sock"))).rejects.toThrow(/both DOCKER_HOST and DOCKER_CONTEXT/);
      expect(await status("docker-compose", { run: context("unix:///var/run/docker.sock"), env: { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: named } })).toMatchObject({ status: "missing", detail: expect.stringContaining("both DOCKER_HOST and DOCKER_CONTEXT") });
    }
    expect(await status("docker-compose", { run: context("unix:///var/run/docker.sock") })).toMatchObject({ status: "satisfied", detail: expect.stringContaining("local engine") });
    expect(await status("docker-compose", { run: context("tcp://docker.example.test:2376") })).toMatchObject({ status: "missing", detail: expect.stringContaining("remote targets need their own approval") });
  });

  it("needs an approved Cloudflare tunnel no connector holds, read with the approved token, and fails closed when unreadable", async () => {
    // The documented /connections answer: one client (connector) holding two connections, and one that has none left.
    const held = [{ id: "operator-connector", conns: [{ colo_name: "ams01" }, { colo_name: "fra02" }], version: "2026.9.0" }, { id: "gone-connector", conns: [] }];
    expect(await status("cloudflare")).toMatchObject({ status: "satisfied", detail: expect.stringContaining("no connected connector") });
    expect(await status("cloudflare", { fetch: tunnelApi([{ id: "gone-connector", conns: [] }]) })).toMatchObject({ status: "satisfied" });
    expect(await status("cloudflare", { fetch: tunnelApi(held, "healthy") })).toMatchObject({ status: "missing", detail: expect.stringContaining("1 connected connector(s); an approved tunnel serves one run at a time") });
    // A healthy or degraded tunnel listing no connected client contradicts itself (the deprecated field reads empty): never free.
    for (const contradictory of ["healthy", "degraded"]) {
      expect(await status("cloudflare", { fetch: tunnelApi([], contradictory) })).toMatchObject({ status: "missing", detail: expect.stringContaining(`reports the tunnel ${contradictory} but lists no connected connector`) });
    }
    for (const unreadable of [tunnelApi([], "inactive", 403), tunnelApi(undefined), tunnelApi([{ conns: [] }]), tunnelApi([], "unknown"), (async () => { throw new Error("ENOTFOUND api.cloudflare.com"); }) as typeof fetch]) {
      expect(await status("cloudflare", { fetch: unreadable })).toMatchObject({ status: "missing", detail: expect.stringContaining("connections are unreadable") });
    }
    expect(await cloudflareConnectors(approval.cloudflare, { QUAL_CF_TOKEN: "cf-token-value" }, tunnelApi(held, "healthy"))).toEqual(["operator-connector"]);
    await expect(cloudflareConnectors(approval.cloudflare, {}, tunnelApi([]))).rejects.toThrow(/QUAL_CF_TOKEN is unset/);
    expect(JSON.stringify(await status("cloudflare", { fetch: tunnelApi(held) }))).not.toContain("cf-token-value");
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

  it("replaces the ledger atomically, so a failed write leaves the previous complete ledger", async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-ledger-")));
    try {
      const file = path.join(dir, "inventory.json");
      const ledger = new DisposableInventory({ runId: "abcdef123456", root: dir, domains: ["dev.example.test"], ledger: file });
      ledger.record("run-processes", dir, "run");
      ledger.record("fixture-repository", `${dir}/qabcdef12-a`, "s");
      // The next write cannot create its temporary file: the record fails and the ledger keeps every earlier entry.
      await mkdir(`${file}.${process.pid}.tmp`);
      expect(() => ledger.record("fixture-repository", `${dir}/qabcdef12-b`, "s")).toThrow();
      const kept = JSON.parse(await readFile(file, "utf8")) as { entries: Array<{ id: string }> };
      expect(kept.entries.map((entry) => entry.id)).toEqual([dir, `${dir}/qabcdef12-a`]);
      await rm(`${file}.${process.pid}.tmp`, { recursive: true });
      ledger.record("fixture-repository", `${dir}/qabcdef12-c`, "s");
      expect((JSON.parse(await readFile(file, "utf8")) as { entries: unknown[] }).entries).toHaveLength(4);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps removing and reading back every resource when a ledger write fails during cleanup", async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-ledger-")));
    try {
      const file = path.join(dir, "inventory.json");
      const ledger = new DisposableInventory({ runId: "abcdef123456", root: dir, domains: [], ledger: file });
      ledger.record("fixture-repository", `${dir}/qabcdef12-a`, "s");
      ledger.record("fixture-repository", `${dir}/qabcdef12-b`, "s");
      await mkdir(`${file}.${process.pid}.tmp`);
      const resources = fakeResources();
      await ledger.cleanup(resources);
      expect(resources.removed).toEqual([`${dir}/qabcdef12-b`, `${dir}/qabcdef12-a`]);
      expect(ledger.allAbsent()).toBe(true);
      expect(ledger.ledgerFailures).toHaveLength(2);
      expect(ledger.ledgerFailures[0]).toContain(`${file} not written`);
      // The last complete ledger stays readable.
      expect((JSON.parse(await readFile(file, "utf8")) as { entries: Array<{ cleanup?: unknown }> }).entries.map((entry) => entry.cleanup)).toEqual([undefined, undefined]);
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
    host: { platform, arch: "x64", release: "1", node: "v22.12.0" }, startedAt: "t", finishedAt: "t", prerequisites: allPrerequisites, scenarios,
    runResources: [{ kind: "run-processes", id: ROOT, scenario: "run", createdAt: "t", cleanup: absent }, { kind: "proxy", id: `${ROOT}/state`, scenario: "run", createdAt: "t", cleanup: absent }],
    interface: ENDPOINT_INTERFACE, limitations: [], runErrors: [], summary: summarize(scenarios),
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

  it("rejects a passed scenario whose matrix prerequisites the receipt does not record as satisfied exactly once", () => {
    const valid = receipt("linux", [passed("tunnel.cloudflare")]);
    const without = (id: string) => valid.prerequisites.filter((item) => item.id !== id);
    const cloudflare = valid.prerequisites.find((item) => item.id === "cloudflare")!;
    expect(receiptProblems({ ...valid, prerequisites: without("cloudflare") })).toEqual(["tunnel.cloudflare: passed without one satisfied cloudflare prerequisite"]);
    expect(receiptProblems({ ...valid, prerequisites: [...without("caddy"), { id: "caddy", status: "missing", detail: "caddy is unavailable" }] }))
      .toEqual(["tunnel.cloudflare: passed without one satisfied caddy prerequisite"]);
    expect(receiptProblems({ ...valid, prerequisites: [...valid.prerequisites, { ...cloudflare, status: "invalid" }] })).toEqual(["tunnel.cloudflare: passed without one satisfied cloudflare prerequisite"]);
    expect(receiptProblems({ ...valid, prerequisites: undefined as never })).toHaveLength(NETWORKING_MATRIX.find((item) => item.id === "tunnel.cloudflare")!.prerequisites.length);
    // A blocked scenario claims nothing, so its unmet prerequisite is not a problem.
    expect(receiptProblems({ ...receipt("linux", [{ ...passed("tunnel.cloudflare"), status: "blocked", observations: [], resources: [] }]), prerequisites: without("cloudflare") })).toEqual([]);
    const missing = { ...receipt("darwin"), prerequisites: without("approval") };
    expect(networkingOutcomeGate([receipt("linux"), missing], HEAD).ready).toBe(false);
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

  it("rejects a receipt recording a run error or none, while informational limitations still pass", () => {
    const informational = { ...receipt("darwin"), limitations: ["cloudflare: no ephemeral URLs"] };
    expect(receiptProblems(informational)).toEqual([]);
    expect(runExitCode(informational, receiptProblems(informational), true, 0)).toBe(0);
    const failedRun = { ...receipt("darwin"), runErrors: ["unhandled rejection during the run: probe aborted"] };
    expect(receiptProblems(failedRun)).toEqual(["run error: unhandled rejection during the run: probe aborted"]);
    expect(networkingOutcomeGate([receipt("linux"), failedRun], HEAD).ready).toBe(false);
    expect(runExitCode(failedRun, receiptProblems(failedRun), true, 1)).toBe(1);
    const unrecorded = { ...receipt("darwin"), runErrors: undefined as never };
    expect(receiptProblems(unrecorded)).toEqual(["run errors were not recorded"]);
    expect(networkingOutcomeGate([receipt("linux"), unrecorded], HEAD).ready).toBe(false);
    // The exit code applies the same check, and a run error seen after the receipt was written still fails it.
    expect(runExitCode(unrecorded, receiptProblems(unrecorded), true, 0)).toBe(1);
    expect(runExitCode(receipt("darwin"), [], true, 1)).toBe(1);
    expect(runExitCode(receipt("darwin"), [], false, 0)).toBe(1);
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

describe("run execution", () => {
  const scenario = twoWorktrees;
  async function setup(driver?: ScenarioDriver, resources: ResourceHandlers = fakeResources()) {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-run-")));
    const ledger = path.join(dir, "root", "inventory.json");
    driver ??= recordTwo(path.dirname(ledger));
    await mkdir(path.dirname(ledger));
    const inventory = new DisposableInventory({ runId: "abcdef123456", root: path.dirname(ledger), domains: [], ledger });
    inventory.record("run-processes", path.dirname(ledger), "run");
    inventory.record("proxy", `${path.dirname(ledger)}/state`, "run");
    const strays: string[] = [];
    const calls: string[] = [];
    const run: QualificationRun = { out: path.join(dir, "receipt.json"), strays,
      options: { scenarios: [scenario], platform: "darwin", prerequisites: allPrerequisites, drivers: { [scenario.id]: driver }, inventory, resources, snapshot: async () => ({}) },
      receipt: (results, runErrors) => ({ contract: "devfn.networking-qualification/v1", check: "networking-qualification-contract", target: "DEV-17", head: HEAD, runId: "abcdef123456",
        provenance: { head: HEAD, checkout: "/src", clean: true, builtAfterSources: true, devfnCli: "/src/devfn/cli/dist/index.js" }, host: { platform: "darwin", arch: "arm64", release: "1", node: "v22.12.0" },
        startedAt: "t", finishedAt: "t", prerequisites: allPrerequisites, scenarios: results, runResources: inventory.list("run"), interface: ENDPOINT_INTERFACE, limitations: [], runErrors, summary: summarize(results) }),
      reap: async () => { calls.push("reap"); }, removeRoot: async () => { calls.push("remove root"); } };
    const read = async () => JSON.parse(await readFile(run.out, "utf8")) as NetworkingQualificationReceipt;
    return { dir, ledger, inventory, strays, calls, run, read };
  }
  const recordTwo = (root: string): ScenarioDriver => async (context) => {
    context.inventory.record("fixture-repository", `${root}/qabcdef12-a`, context.scenario.id);
    context.inventory.record("fixture-repository", `${root}/qabcdef12-b`, context.scenario.id);
    for (const item of context.scenario.assertions) context.observe(item.id, true, "observed");
  };
  let dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.map(async (dir) => await rm(dir, { recursive: true, force: true }))); dirs = []; });

  it("writes a 0600 receipt and exits 0 only for a clean, error-free run", async () => {
    const context = await setup();
    dirs.push(context.dir);
    const outcome = await executeRun(context.run);
    expect(outcome.code).toBe(0);
    expect(receiptProblems(await context.read())).toEqual([]);
    expect(statSync(context.run.out).mode & 0o777).toBe(0o600);
    expect(context.calls).toEqual(["remove root"]);
  });

  it("rewrites the persisted receipt with run errors that arrive during its write or the root removal", async () => {
    const context = await setup();
    dirs.push(context.dir);
    context.run.write = async (file, receipt) => { if (!context.strays.length) context.strays.push("during write"); await writeReceipt(file, receipt); };
    context.run.removeRoot = async () => { setImmediate(() => context.strays.push("after root removal")); throw new Error("EBUSY"); };
    const outcome = await executeRun(context.run);
    const persisted = await context.read();
    expect(persisted.runErrors).toEqual(["run root removal failed: EBUSY", "unhandled rejection during the run: during write", "unhandled rejection during the run: after root removal"]);
    expect(receiptProblems(persisted)).toEqual(persisted.runErrors.map((item) => `run error: ${item}`));
    expect(networkingOutcomeGate([{ ...persisted, host: { ...persisted.host, platform: "linux" }, runErrors: [] }, persisted], HEAD).ready).toBe(false);
    expect(outcome.code).toBe(1);
  });

  it("withdraws a receipt that cannot record a later run error", async () => {
    const context = await setup();
    dirs.push(context.dir);
    let writes = 0;
    context.run.write = async (file, receipt) => { writes += 1; if (writes > 1) throw new Error("ENOSPC"); context.strays.push("late"); await writeReceipt(file, receipt); };
    await expect(executeRun(context.run)).rejects.toThrow(/withdrawn.*ENOSPC/);
    await expect(access(context.run.out)).rejects.toThrow();
  });

  it("removes and reads back every resource, attempts run-level cleanup and fails when the ledger cannot be written", async () => {
    let ledgerPath = "";
    const resources = fakeResources();
    const context = await setup(async (inner) => { await recordTwo(path.dirname(ledgerPath))(inner); await mkdir(`${ledgerPath}.${process.pid}.tmp`); }, resources);
    dirs.push(context.dir);
    ledgerPath = context.ledger;
    const outcome = await executeRun(context.run);
    const root = path.dirname(context.ledger);
    expect(resources.removed).toEqual([`${root}/qabcdef12-b`, `${root}/qabcdef12-a`, `${root}/state`, root]);
    expect(context.inventory.allAbsent()).toBe(true);
    const persisted = await context.read();
    expect(persisted.runErrors.length).toBe(4);
    expect(persisted.runErrors.every((item) => item.startsWith("inventory ledger: "))).toBe(true);
    expect(receiptProblems(persisted).length).toBe(4);
    expect(outcome.code).toBe(1);
  });

  it("still cleans up and reaps when the receipt cannot be written", async () => {
    const resources = fakeResources();
    const context = await setup(undefined, resources);
    dirs.push(context.dir);
    // The run-level Caddy is never read back absent, so after the failed write the run retries its cleanup, then reaps.
    let reads = 0;
    resources.present = async (entry) => { if (entry.kind !== "proxy") return false; reads += 1; return "Caddy still runs"; };
    context.run.write = async () => { throw new Error("EACCES"); };
    await expect(executeRun(context.run)).rejects.toThrow("EACCES");
    expect(reads).toBe(2);
    expect(context.calls).toEqual(["reap"]);
  });

  it("writes no receipt for an interrupted run and removes its root only after confirmed cleanup", async () => {
    const interrupt = new AbortController();
    let root = "";
    const context = await setup(async (inner) => { await recordTwo(root)(inner); interrupt.abort("SIGINT"); });
    root = path.dirname(context.ledger);
    dirs.push(context.dir);
    context.run.options = { ...context.run.options, signal: interrupt.signal };
    const outcome = await executeRun(context.run);
    expect(outcome).toEqual({ code: 130, clean: true, runErrors: [] });
    await expect(access(context.run.out)).rejects.toThrow();
    expect(context.calls).toEqual(["remove root"]);
  });

  it("removes a passing receipt left at the output path before the run, so an interrupted or unwritable rerun cannot leave it", async () => {
    for (const failure of ["interrupt", "write"] as const) {
      const interrupt = new AbortController();
      const context = await setup(async (inner) => { await recordTwo(path.dirname(context.ledger))(inner); if (failure === "interrupt") interrupt.abort("SIGINT"); });
      dirs.push(context.dir);
      context.run.options = { ...context.run.options, signal: interrupt.signal };
      await writeReceipt(context.run.out, context.run.receipt([], []));
      if (failure === "write") {
        context.run.write = async () => { throw new Error("EACCES"); };
        await expect(executeRun(context.run)).rejects.toThrow("EACCES");
      } else expect((await executeRun(context.run)).code).toBe(130);
      await expect(access(context.run.out)).rejects.toThrow();
    }
    // A receipt path that cannot be cleared starts nothing.
    const context = await setup(async () => { throw new Error("never runs"); });
    dirs.push(context.dir);
    await mkdir(context.run.out);
    await expect(executeRun(context.run)).rejects.toThrow();
    expect(context.inventory.list()).toHaveLength(2);
  });

  it("withdraws a receipt at --out once run validates its arguments, before any preflight can fail, and gate never touches it", async () => {
    const context = await setup();
    dirs.push(context.dir);
    const seed = async () => await writeReceipt(context.run.out, context.run.receipt([], []));
    const foreign = path.join(context.dir, "cli.js");
    await writeFile(foreign, "");
    // Scenario selection, provenance after the host prerequisite probes, and a DevFn CLI outside the harness checkout: real preflight failures of the CLI.
    for (const [args, failure] of [[["--scenario", "no.such-scenario"], /Unknown qualification scenarios/], [["--scenario", "host.native-prestart"], /is not the checkout HEAD/],
      [["--scenario", "host.native-prestart", "--devfn", foreign], /is not inside the harness checkout/]] as const) {
      await seed();
      await expect(main(["run", ...args, "--head", "0".repeat(40), "--out", context.run.out])).rejects.toThrow(failure);
      await expect(access(context.run.out)).rejects.toThrow();
    }
    // Invalid arguments start no run attempt, so the receipt stays.
    await seed();
    for (const args of [["--head", "abc", "--out", context.run.out], ["--head", "0".repeat(40)]]) await expect(main(["run", ...args])).rejects.toThrow(/run needs --head/);
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try { expect(await main(["gate", "--head", HEAD, context.run.out])).toBe(1); } finally { written.mockRestore(); }
    expect((await context.read()).head).toBe(HEAD);
    // A receipt path that cannot be cleared starts nothing.
    await rm(context.run.out);
    await mkdir(context.run.out);
    await expect(main(["run", "--scenario", "no.such-scenario", "--head", "0".repeat(40), "--out", context.run.out])).rejects.toThrow(/cannot be withdrawn, so the run does not start/);
  }, 60_000);

  it("withdraws the receipt when the interrupt arrives while it is written or finalized", async () => {
    for (const late of ["write", "root removal"] as const) {
      const interrupt = new AbortController();
      const context = await setup();
      dirs.push(context.dir);
      context.run.options = { ...context.run.options, signal: interrupt.signal };
      if (late === "write") context.run.write = async (file, receipt) => { await writeReceipt(file, receipt); interrupt.abort("SIGTERM"); };
      else context.run.removeRoot = async () => { context.calls.push("remove root"); interrupt.abort("SIGINT"); };
      const outcome = await executeRun(context.run);
      expect(outcome).toMatchObject({ code: 130, clean: true, runErrors: [] });
      expect(outcome.receipt).toBeUndefined();
      await expect(access(context.run.out)).rejects.toThrow();
      expect(context.calls).toEqual(["remove root"]);
    }
  });
});

describe("live host cleanup handlers", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ""; });

  /** A live host whose devfn, lsof and ps answer from fixtures; calls are recorded in order. */
  async function fixtureHost(answers: { devfn: Record<string, unknown>; lsof?: (root: string) => string; ps?: string; docker?: (args: readonly string[]) => { code: number; stdout: string } },
    providers?: ProviderReadBackFixture, env: NodeJS.ProcessEnv = {}, extra: Partial<ConstructorParameters<typeof LiveHost>[0]> = {}) {
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
        if (typeof answer === "function") return await (answer as (signal?: AbortSignal, cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>)(given?.signal, given?.cwd);
        return answer === undefined ? { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "UNEXPECTED" } }), stderr: "" } : { code: 0, stdout: JSON.stringify(answer), stderr: "" };
      }
      calls.push(command === "docker" ? `docker ${args.slice(0, 2).join(" ")}` : command);
      if (command === "docker") return { stderr: "", ...(answers.docker?.(args) ?? { code: 0, stdout: "" }) };
      return { code: 0, stdout: command === "lsof" ? answers.lsof?.(dir) ?? "p1\nn/\n" : command === "ps" ? answers.ps ?? "" : "", stderr: "" };
    };
    const inventory = new DisposableInventory({ runId: "abcdef123456", root: dir, domains: ["dev.example.test"] });
    const host = new LiveHost({ root: dir, devfnCli: "/devfn/cli.js", env, inventory, run, providers: providers ?? (async () => { throw new Error("no provider in this fixture"); }), docker: "unix:///var/run/docker.sock",
      owner: async () => "i1", ...extra });
    await mkdir(host.stateDir, { recursive: true });
    return { host, inventory, calls, options };
  }
  type ProviderReadBackFixture = (binding: TunnelBinding, hostname: string, url: string | undefined) => Promise<string[]>;
  const stopped = { status: { state: "stopped", instanceId: "i1" }, ports: { allocations: [] }, down: { ok: true } };

  it("reads a runtime back after devfn down and before any reaping, leaving shared process groups to their own resources", async () => {
    // The run's Caddy (a live group leader) inherited the checkout as its working directory; 4242 is a fixture process that outlived devfn down; 77 runs in a sibling checkout.
    const caddy = await survivor();
    try {
      const { host, inventory, calls } = await fixtureHost({ devfn: stopped, ps: `4242 4242\n4343 ${caddy.pid}\n77 77\n`,
        lsof: (root) => `p4242\nn${root}/qabcdef12-app\np4343\nn${root}/qabcdef12-app/sub\np77\nn${root}/qabcdef12-app-b\n` });
      const runtime = path.join(dir, "qabcdef12-app");
      const birthSignature = (await processBirthSignature(caddy.pid))!;
      await writeFile(path.join(host.stateDir, "proxy-owner.json"), JSON.stringify({ pid: caddy.pid, birthSignature, startedAt: new Date().toISOString() }));
      inventory.record("runtime", runtime, "s");
      await inventory.cleanup(host.handlers(), "s");
      expect(inventory.list("s")[0].cleanup).toMatchObject({ absent: false, detail: "still present on read-back: processes: 4242" });
      // Removal is devfn down, plus the owner's leftover Compose networks; the read-back saw the survivor and nothing was reaped (one lsof listing, no second pass).
      // Every check runs: without a readable manifest the Compose resources of the owner are listed too.
      expect(calls).toEqual(["devfn down", "devfn status", "docker ps -a", "docker network ls", "devfn status", "devfn ports", "lsof", "ps", "docker ps -a", "docker network ls"]);
      // A record whose PID no longer carries its birth identity (reused, or without one) is no shared leader, so its group is read back.
      for (const owner of [{ pid: caddy.pid, birthSignature: foreignSignature(birthSignature), startedAt: new Date().toISOString() }, { pid: caddy.pid }]) {
        await writeFile(path.join(host.stateDir, "proxy-owner.json"), JSON.stringify(owner));
        expect(await host.sharedLeaders()).toEqual(new Set());
        await inventory.cleanup(host.handlers(), "s");
        expect(inventory.list("s")[0].cleanup?.detail).toBe("still present on read-back: processes: 4242, 4343");
      }
    } finally { await caddy.stop(); }
  });

  it("confirms no process absence from an lsof listing it did not complete", async () => {
    let lsof = { code: -1, stdout: "p1\nn/\n" };
    const { host, inventory } = await fixtureHost({ devfn: stopped }, undefined, {}, { run: async (command) => command === "lsof" ? { ...lsof, stderr: "" } : { code: 0, stdout: "", stderr: "" } });
    const runs = dir;
    inventory.record("run-processes", runs, "s");
    // Killed, timed out or overflowing (-1) with partial output, another status, or a cut last line: unreadable, never absent.
    for (const listing of [{ code: -1, stdout: "p1\nn/\n" }, { code: 2, stdout: "p1\nn/\n" }, { code: 0, stdout: "p1\nn/" }, { code: 1, stdout: "" }]) {
      lsof = listing;
      await expect(host.processesIn(runs, new Set())).rejects.toThrow(/lsof could not list every process working directory/);
      await inventory.cleanup(host.handlers(), "s");
      expect(inventory.list("s")[0].cleanup).toMatchObject({ absent: false, detail: expect.stringMatching(/^read-back failed: lsof could not list/) });
    }
    // Exit 1 for a process the run cannot inspect still completes the listing.
    lsof = { code: 1, stdout: `p1\nn/\np4242\nn${runs}/x\n` };
    expect(await host.processesIn(runs, new Set())).toEqual([4242]);
    lsof = { code: 0, stdout: "p1\nn/\n" };
    await inventory.cleanup(host.handlers(), "s");
    expect(inventory.list("s")[0].cleanup?.absent).toBe(true);
  });

  /** A loopback server answering each request with how(response); its sockets are destroyed on close. */
  async function probeServer(how: (response: http.ServerResponse) => void) {
    const sockets = new Set<net.Socket>();
    const server = http.createServer((_request, response) => how(response));
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as net.AddressInfo).port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
  }
  /** Headers and part of a Content-Length body, then the connection is cut. */
  const truncated = (response: http.ServerResponse) => { response.writeHead(200, { "content-type": "application/json", "content-length": "64" }); response.write("{\"marker\":"); setTimeout(() => response.socket?.destroy(), 20); };
  const settlesWithin = async <T>(promise: Promise<T>, ms: number) => await Promise.race([promise.then((value) => ({ value }), (error: Error) => ({ error })), new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))]);

  it("settles every HTTP probe: a cut response, the overall deadline and an interrupt reject it, and a complete answer resolves", async () => {
    const { host } = await fixtureHost({ devfn: stopped });
    const cut = await probeServer(truncated);
    const trickle = await probeServer((response) => { response.writeHead(200, { "content-length": "1000" }); const timer = setInterval(() => response.write("x"), 20); response.once("close", () => clearInterval(timer)); });
    const hold = await probeServer((response) => { response.writeHead(200, { "content-length": "10" }); response.write("x"); });
    const whole = await probeServer((response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ marker: "qabcdef12-app" })); });
    try {
      expect(await host.request("http://app.localhost/", { port: whole.port })).toMatchObject({ status: 200, json: { marker: "qabcdef12-app" } });
      expect(await settlesWithin(host.request("http://app.localhost/", { port: cut.port }), 2_000)).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/before its response was complete|aborted/) }) });
      // A socket that keeps sending never idles out; the overall deadline still ends the probe.
      expect(await settlesWithin(host.request("http://app.localhost/", { port: trickle.port, deadlineMs: 300 }), 2_000)).toMatchObject({ error: expect.objectContaining({ message: "http://app.localhost/ passed its deadline" }) });
      // A cloudflared metrics answer cut short is no connector ID.
      expect(await settlesWithin(cloudflaredConnectorId(cut.port), 2_000)).toEqual({ value: undefined });
      // An interrupt rejects a probe in flight and refuses new ones; a cleanup read-back still runs.
      const inFlight = host.request("http://app.localhost/", { port: hold.port });
      await new Promise((resolve) => setTimeout(resolve, 50));
      host.abort();
      expect(await settlesWithin(inFlight, 1_000)).toMatchObject({ error: expect.objectContaining({ message: "http://app.localhost/ was interrupted" }) });
      await expect(host.request("http://app.localhost/", { port: whole.port })).rejects.toThrow(/interrupted; requesting http:\/\/app.localhost\/ is refused/);
      expect(await host.request("http://app.localhost/", { port: whole.port, afterAbort: true })).toMatchObject({ status: 200 });
    } finally { for (const server of [cut, trickle, hold, whole]) await server.close(); }
  });

  it("rejects a probe Node.js refuses to build at once and leaves no deadline armed", async () => {
    const { host } = await fixtureHost({ devfn: stopped });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    process.on("uncaughtException", onUncaught);
    try {
      await expect(host.request("http://app.localhost/", { port: 70_000, deadlineMs: 100 })).rejects.toMatchObject({ code: "ERR_SOCKET_BAD_PORT" });
      await expect(host.request("http://app.localhost/", { port: 1, host: "bad\nhost", deadlineMs: 100 })).rejects.toMatchObject({ code: "ERR_INVALID_CHAR" });
      // Past both deadlines nothing fires.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(uncaught).toEqual([]);
    } finally { process.off("uncaughtException", onUncaught); }
  });

  it("returns from a driver whose probe is cut short and cleans up every resource it recorded", async () => {
    const cut = await probeServer(truncated);
    const gone = await survivor();
    await gone.stop();
    try {
      // The native journey starts its fixture and probes the URL the process saw; the answer is cut after its headers.
      const { host, inventory } = await fixtureHost({ devfn: { ...stopped, url: { ok: true, urls: { web: "https://web-o-1.localhost:8443/" } },
        up: async (_signal?: AbortSignal, cwd?: string) => {
          await writeFile(path.join(cwd!, "seen-web.json"), JSON.stringify({ pid: gone.pid, env: { DEVFN_URL_WEB: `http://127.0.0.1:${cut.port}`, DEVFN_PORT_WEB: String(cut.port), DEVFN_INSTANCE_ID: "i1" } }));
          return { code: 0, stdout: JSON.stringify({ ok: true, state: "ready", instanceId: "i1", allocations: [{ instanceId: "i1", port: cut.port }] }), stderr: "" };
        } } });
      const scenario = NETWORKING_MATRIX.find((item) => item.id === "host.native-prestart")!;
      const outcome = await settlesWithin(runScenarios({ scenarios: [scenario], platform: "linux", prerequisites: allPrerequisites, drivers: { [scenario.id]: liveDrivers(host, parseApproval(approval))[scenario.id] },
        inventory, resources: host.handlers(), snapshot: async () => ({ routes: [] }) }), 10_000);
      expect(outcome).toMatchObject({ value: [{ status: "failed", reason: expect.stringMatching(/^driver: .*(before its response was complete|aborted)/) }] });
      const resources = inventory.list(scenario.id);
      expect(resources.map((entry) => entry.kind)).toEqual(["fixture-repository", "runtime"]);
      expect(resources.every((entry) => entry.cleanup?.absent === true)).toBe(true);
    } finally { await cut.close(); }
  });

  it("reads only an absent checkout as having no surviving fixtures, and keeps any other unreadable checkout", async (test) => {
    if (process.getuid?.() === 0) test.skip();
    const { host, inventory } = await fixtureHost({ devfn: stopped });
    expect(await host.survivingFixtures(path.join(dir, "qabcdef12-gone"))).toEqual([]);
    const runtime = path.join(dir, "qabcdef12-app");
    await mkdir(runtime);
    await chmod(runtime, 0o000);
    try {
      await expect(host.survivingFixtures(runtime)).rejects.toThrow(/EACCES/);
      inventory.record("runtime", runtime, "s");
      await inventory.cleanup(host.handlers(), "s");
      expect(inventory.list("s")[0].cleanup).toMatchObject({ absent: false, detail: expect.stringContaining("read-back failed: EACCES") });
    } finally { await chmod(runtime, 0o700); }
    const file = path.join(dir, "qabcdef12-file");
    await writeFile(file, "");
    await expect(host.survivingFixtures(file)).rejects.toThrow(/ENOTDIR/);
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

  it("removes the network devfn down leaves for a Compose owner during cleanup, records the leak and reads it back absent", async () => {
    const owner = ownerLabel("i1");
    const ours = `devfn-p-0123456789ab-${owner}_default`;
    const networks = new Set([`${ours}\tdevfn-p-0123456789ab-${owner}`, "operator_default\tdevfn-p-0123456789ab-o-ffffffffffffffffffff"]);
    const removed: string[] = [];
    const docker = (args: readonly string[]) => {
      if (args[1] === "rm") { removed.push(args.join(" ")); for (const line of networks) if (line.startsWith(`${args[2]}\t`)) networks.delete(line); }
      return { code: 0, stdout: args[0] === "network" && args[1] === "ls" ? [...networks].join("\n") : "" };
    };
    const { host, inventory } = await fixtureHost({ devfn: stopped, docker });
    const runtime = path.join(dir, "qabcdef12-compose");
    await mkdir(runtime);
    await writeFile(path.join(runtime, "devfn.config.json"), JSON.stringify(composeFixture()));
    inventory.record("runtime", runtime, "s");
    await inventory.cleanup(host.handlers(), "s");
    expect(inventory.list("s")[0].cleanup).toMatchObject({ absent: true });
    expect(removed).toEqual([`network rm ${ours}`]);
    expect([...networks]).toEqual(["operator_default\tdevfn-p-0123456789ab-o-ffffffffffffffffffff"]);
    expect([...host.limitations]).toEqual([expect.stringContaining(`devfn down left Compose network ${ours}`)]);
  });

  it("reads every check of a runtime DevFn reports degraded with ok false, then reaps the Compose resources it listed", async () => {
    const owner = ownerLabel("i1");
    const listings: Record<string, string> = { ps: `qualification-echo-1\tdevfn-p-0123456789ab-${owner}\n`, network: `devfn-p-0123456789ab-${owner}_default\tdevfn-p-0123456789ab-${owner}\n` };
    const removed: string[] = [];
    const docker = (args: readonly string[]) => { if (args[0] === "rm" || args[1] === "rm") removed.push(args.join(" ")); return { code: 0, stdout: listings[args[0]] ?? "" }; };
    // devfn down left cleanup errors: status answers degraded with ok false and exit 0, the leases stay, and a fixture process still runs.
    const { host, inventory } = await fixtureHost({ devfn: { ...stopped, status: { ok: false, state: "degraded", instanceId: "i1" }, ports: { allocations: [{ instanceId: "i1", port: 4799 }, { instanceId: "i2", port: 4800 }] } },
      docker });
    const runtime = path.join(dir, "qabcdef12-compose");
    await mkdir(runtime);
    await writeFile(path.join(runtime, "devfn.config.json"), JSON.stringify(composeFixture()));
    await writeFile(path.join(runtime, "seen-api.json"), JSON.stringify({ pid: process.pid, env: {} }));
    inventory.record("runtime", runtime, "s");
    await inventory.cleanup(host.handlers(), "s");
    expect(inventory.list("s")[0].cleanup?.detail).toBe(`still present on read-back: state degraded; fixture processes: ${process.pid}; leases: 4799; Compose resources: container qualification-echo-1, network devfn-p-0123456789ab-${owner}_default`);
    await host.reapCompose();
    expect(removed).toEqual(["rm -f qualification-echo-1", `network rm devfn-p-0123456789ab-${owner}_default`]);
  });

  it("treats a runtime status that names no owner, or another owner, as unreadable, never absent", async () => {
    for (const status of [{ ok: false, error: { code: "DEVFN_CONFIG_INVALID" } }, { ok: true, state: "stopped", instanceId: "other" }]) {
      const { host, inventory } = await fixtureHost({ devfn: { ...stopped, status } });
      const runtime = path.join(dir, "qabcdef12-app");
      inventory.record("runtime", runtime, "s");
      await inventory.cleanup(host.handlers(), "s");
      expect(inventory.list("s")[0].cleanup).toMatchObject({ absent: false, detail: "read-back failed: devfn status gave no readable answer for the runtime's owner" });
      await rm(dir, { recursive: true, force: true });
    }
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

  it("gives up and restart a timeout above every fixture's summed health budget plus an image pull, and other commands the default", async () => {
    const { host, options } = await fixtureHost({ devfn: { ...stopped, up: { ok: true }, restart: { ok: true } } });
    const runtime = path.join(dir, "qabcdef12-compose");
    await host.up("s", runtime);
    await host.must(runtime, ["restart"]);
    await host.devfn(runtime, ["status"]);
    expect(options.map((given) => given?.timeoutMs)).toEqual([LIFECYCLE_COMMAND_TIMEOUT_MS, LIFECYCLE_COMMAND_TIMEOUT_MS, undefined]);
    // DevFn starts nodes in plan order, so the worst case waits on every health budget in turn.
    const budget = (config: Record<string, any>) => Object.values({ ...config.services, ...config.processes } as Record<string, { health?: { timeoutMs?: number } }>)
      .reduce((sum, node) => sum + (node.health?.timeoutMs ?? 0), 0);
    const imagePull = 300_000;
    for (const config of [hostFixture(), composeFixture(), domainFixture("dev.example.test"), tunnelFixture("qabcdef12-cf", false), oauthFixture("dev.example.test", parseApproval(approval).oauth!)]) {
      expect(budget(config) + imagePull).toBeLessThan(LIFECYCLE_COMMAND_TIMEOUT_MS);
    }
    // The Compose fixture alone outlasts the 180 s every other command gets.
    expect(budget(composeFixture())).toBeGreaterThan(180_000);
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

  it("never confirms a relay absent whose record was unreadable before stop, nor a checkout whose path cannot be read", async (test) => {
    if (process.getuid?.() === 0) test.skip();
    const { host, inventory, calls } = await fixtureHost({ devfn: { "oauth-relay stop": { ok: true }, "oauth-relay status": { relay: { running: false, routeActive: false } } } });
    const { service } = relayPaths(host.stateDir);
    await mkdir(path.dirname(service), { recursive: true });
    await writeFile(service, "{ not a relay record");
    inventory.record("oauth-relay", "dev.example.test", "s", { cwd: dir });
    await inventory.cleanup(host.handlers(), "s");
    // Stop still ran, but the processes it had to end are unknown, so status alone confirms nothing.
    expect(calls).toContain("devfn oauth-relay stop");
    expect(inventory.list("s")[0].cleanup).toMatchObject({ absent: false, detail: expect.stringContaining("still present on read-back: the relay record was unreadable before stop") });
    const parent = path.join(dir, "locked");
    await mkdir(path.join(parent, "qabcdef12-app"), { recursive: true });
    await chmod(parent, 0o000);
    try {
      const checkout = path.join(parent, "qabcdef12-app");
      inventory.record("fixture-repository", checkout, "t");
      await inventory.cleanup({ ...host.handlers(), remove: async () => undefined }, "t");
      expect(inventory.list("t")[0].cleanup).toMatchObject({ absent: false, detail: expect.stringContaining("read-back failed: EACCES") });
    } finally { await chmod(parent, 0o700); }
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

  /** Record connector as the binding's running connector, and retired ones, in the run's tunnel state, as DevFn does. */
  /** A well-formed birth signature, in own's format, of a process that started at the epoch: never a live test process. */
  const foreignSignature = (own: string) => own.startsWith("linux:") ? "linux:1" : "darwin-utc:Thu Jan  1 00:00:00 1970";
  type FixtureConnector = { pid: number; metricsPort: number; birthSignature?: string };
  /** Each record carries the process's own birth identity unless the fixture gives one. */
  async function recordConnectors(stateDir: string, name: string, connector: FixtureConnector | undefined, retired: FixtureConnector[] = []) {
    const record = async (item: FixtureConnector) => ({ birthSignature: await processBirthSignature(item.pid) ?? "fixture", ...item, startedAt: new Date().toISOString(), configDigest: "0".repeat(64), hostnames: [] });
    const state = tunnelPaths(stateDir, name).state;
    await mkdir(path.dirname(state), { recursive: true });
    await writeFile(state, JSON.stringify({ version: 1, binding: name, hostnames: [], retired: await Promise.all(retired.map(record)), residue: [], ...(connector ? { connector: await record(connector) } : {}) }));
  }

  /** A Cloudflare binding registered in the run state as the journeys register it. */
  async function cloudflareBinding(stateDir: string): Promise<TunnelBinding> {
    const credentials = path.join(dir, "tunnel.json");
    await writeFile(credentials, "{}", { mode: 0o600 });
    return await registerTunnelBinding(stateDir, { name: "qabcdef12-cf", provider: "cloudflare", domain: "preview.example.test", projectId: "qualification", repositoryIdentity: dir, nonproduction: true,
      cloudflare: { accountId: approval.cloudflare.accountId, zoneId: approval.cloudflare.zoneId, tunnelId: approval.cloudflare.tunnelId, credentialsFile: credentials, apiTokenEnv: approval.cloudflare.apiTokenEnv } });
  }

  it("starts a Cloudflare connector only on a tunnel whose every connected connector is one the run started, by the ID its own cloudflared reports", async () => {
    let connected: string[] | undefined = ["operator-connector"];
    const reads: string[] = [];
    // Each run-started cloudflared answers its own connector ID on its metrics port.
    const identities = new Map<number, string>([[4101, "run-a"], [4102, "run-b"], [4103, "run-c"]]);
    const ready = { code: 0, stdout: JSON.stringify({ ok: true, state: "ready", tunnel: { hostnames: [] }, publicUrls: {} }), stderr: "" };
    const { host, calls } = await fixtureHost({ devfn: { ...stopped, "tunnel urls": { ok: true, timing: "pre-start", urls: { web: "https://web-qabcdef12-public-0123.preview.example.test/app" } },
      "tunnel register": async () => { await cloudflareBinding(host.stateDir); return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" }; },
      "up --allow-public": async () => ready } }, undefined, {},
    { connectors: async (binding) => { reads.push(binding.cloudflare.tunnelId); if (!connected) throw new Error("Cloudflare GET cfd_tunnel/connections answered HTTP 403"); return connected; },
      connectorIdentity: async (port) => identities.get(port), connectorReads: { reads: 2, intervalMs: 1 } });
    const [a, b, c] = [await survivor(), await survivor(), await survivor()];
    try {
      const scenario = NETWORKING_MATRIX.find((item) => item.id === "tunnel.cloudflare")!;
      const context: ScenarioContext = { scenario, inventory: new DisposableInventory({ runId: "abcdef123456", root: dir, domains: approvedDomains(parseApproval(approval)) }), observe: () => undefined, expect: () => undefined };
      // A connector the run did not start is on the approved tunnel: the journey stops before devfn up, after reading it again for API lag.
      await expect(liveDrivers(host, parseApproval(approval))[scenario.id](context)).rejects.toThrow(/connectors the run did not start \(operator-connector\) before the step; an approved tunnel serves one run at a time/);
      expect(calls.some((call) => call.startsWith("devfn up"))).toBe(false);
      expect(reads).toEqual([approval.cloudflare.tunnelId, approval.cloudflare.tunnelId]);
      const bound = (await readTunnelBindings(host.stateDir)).find((item) => item.name === "qabcdef12-cf")!;
      const steps: string[] = [];
      connected = [];
      await host.soleTunnelUser(bound, async () => { steps.push("start"); await recordConnectors(host.stateDir, bound.name, { pid: a.pid, metricsPort: 4101 }); connected = ["run-a"]; });
      // Withdrawing a name swaps in a successor and stops the predecessor, which the connection list still shows for a while: both are the run's.
      await host.soleTunnelUser(bound, async () => { steps.push("swap"); await recordConnectors(host.stateDir, bound.name, { pid: b.pid, metricsPort: 4102 }); await a.stop(); connected = ["run-a", "run-b"]; });
      // A successor DevFn swaps in outside any wrapped step (one worktree's down) is still the run's, by the ID it reports.
      await recordConnectors(host.stateDir, bound.name, { pid: c.pid, metricsPort: 4103 }, [{ pid: b.pid, metricsPort: 4102 }]);
      connected = ["run-b", "run-c"];
      await host.soleTunnelUser(bound, async () => { steps.push("recover"); });
      await recordConnectors(host.stateDir, bound.name, { pid: b.pid, metricsPort: 4102 });
      connected = ["run-b"];
      // A connector attaching during a step is not the run's merely because it appeared then.
      await expect(host.soleTunnelUser(bound, async () => { steps.push("foreign attaches"); connected = ["run-b", "operator-connector"]; })).rejects.toThrow(/\(operator-connector\) after the step/);
      await expect(host.soleTunnelUser(bound, async () => { steps.push("never"); })).rejects.toThrow(/\(operator-connector\) before the step/);
      // A connector the run state records but whose process no longer runs cannot vouch for an unknown ID.
      identities.set(4102, "operator-connector");
      await b.stop();
      await expect(host.soleTunnelUser(bound, async () => { steps.push("never"); })).rejects.toThrow(/\(operator-connector\)/);
      // Nor can a stale record whose PID now runs another process: a foreign connector on its old metrics port is not the run's.
      const reused = await survivor();
      try {
        identities.set(4104, "operator-connector");
        await recordConnectors(host.stateDir, bound.name, { pid: reused.pid, metricsPort: 4104, birthSignature: foreignSignature((await processBirthSignature(reused.pid))!) });
        await expect(host.soleTunnelUser(bound, async () => { steps.push("never"); })).rejects.toThrow(/\(operator-connector\) before the step/);
      } finally { await reused.stop(); }
      connected = undefined;
      await expect(host.soleTunnelUser(bound, async () => { steps.push("never"); })).rejects.toThrow(/HTTP 403/);
      expect(steps).toEqual(["start", "swap", "recover", "foreign attaches"]);
    } finally { for (const item of [a, b, c]) await item.stop().catch(() => undefined); }
    // Every connector read verifies recorded birth identities, a ps read each on macOS.
  }, 60_000);

  it("reads a cloudflared connector ID from its metrics /ready and nothing else", async () => {
    const server = http.createServer((request, response) => {
      if (request.url === "/ready") response.end(JSON.stringify({ status: 200, readyConnections: 4, connectorId: "1b0e6c5e-0000-4000-8000-000000000001" }));
      else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const silent = http.createServer((_request, response) => response.end("not json"));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      expect(await cloudflaredConnectorId((server.address() as net.AddressInfo).port)).toBe("1b0e6c5e-0000-4000-8000-000000000001");
      expect(await cloudflaredConnectorId((silent.address() as net.AddressInfo).port)).toBeUndefined();
    } finally { server.close(); silent.close(); }
  });

  it("counts a tunnel recover as a restart only when the killed connector went down and a different one runs and serves", async () => {
    const [killed, successor, reused] = [await survivor(), await survivor(), await survivor()];
    let recovered: number | undefined;
    let stoppedAs: string | undefined = "stopped";
    const { host, calls } = await fixtureHost({ devfn: {
      "tunnel status": async () => ({ code: 0, stdout: JSON.stringify({ ok: true, tunnel: recovered === undefined ? { connector: stoppedAs } : { connector: "running", pid: recovered } }), stderr: "" }),
      "tunnel recover": async () => { recovered = successor.pid; return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" }; },
    } }, undefined, {}, { connectors: async () => [], connectorReads: { reads: 1, intervalMs: 1 } });
    const cwd = path.join(dir, "qabcdef12-reload-b");
    const signature = async (pid: number) => (await processBirthSignature(pid))!;
    try {
      const bound = await cloudflareBinding(host.stateDir);
      // The remaining route answers with the worktree's marker only once a connector serves it; meanwhile Cloudflare's edge answers its own no-connector error.
      let down: () => Promise<Answer> = async () => ({ status: 530, body: "error code: 1033", headers: { server: "cloudflare", "cf-ray": "8f0c1d2e3f4a5b6c-AMS" } });
      host.request = async () => recovered === undefined ? await down() : { status: 200, body: "", headers: {}, json: { marker: "qabcdef12-reload-b" } };
      host.wait = async () => await new Promise((resolve) => setTimeout(resolve, 20));
      // A live PID whose birth identity differs from the record is another process reusing it: nothing is signalled or recovered.
      const own = await signature(reused.pid);
      await recordConnectors(host.stateDir, bound.name, { pid: reused.pid, metricsPort: 4101, birthSignature: foreignSignature(own) });
      const refused = await restartConnector(host, bound, cwd, async () => "https://web-x.preview.example.test/app/x");
      expect(refused).toEqual({ killed: reused.pid, signalled: false, downAfterKill: false, meanwhile: { outcome: "indeterminate", detail: "not probed" }, running: false, served: false });
      expect(RECOVERED.connectorRestarted(refused)).toBe(false);
      expect(process.kill(reused.pid, 0)).toBe(true);
      expect(calls).toEqual([]);
      // DevFn's unverified connector is not a stopped one.
      stoppedAs = "unverified";
      await recordConnectors(host.stateDir, bound.name, { pid: reused.pid, metricsPort: 4101, birthSignature: own });
      const unverified = await restartConnector(host, bound, cwd, async () => "https://web-x.preview.example.test/app/x");
      expect(unverified).toMatchObject({ killed: reused.pid, signalled: true, downAfterKill: false });
      expect(RECOVERED.connectorRestarted(unverified)).toBe(false);
      recovered = undefined;
      stoppedAs = "stopped";
      await recordConnectors(host.stateDir, bound.name, { pid: killed.pid, metricsPort: 4101, birthSignature: await signature(killed.pid) });
      const recovery = await restartConnector(host, bound, cwd, async () => "https://web-x.preview.example.test/app/x");
      expect(recovery).toEqual({ killed: killed.pid, signalled: true, downAfterKill: true, meanwhile: { outcome: "refused", detail: expect.stringContaining("530 error code: 1033") }, after: successor.pid, running: true, served: true });
      expect(RECOVERED.connectorRestarted(recovery)).toBe(true);
      expect(RECOVERED.connectorRestarted({ ...recovery, signalled: false })).toBe(false);
      // A recover that left the same (or no) connector, a kill that did not take the connector down, or a route served throughout is no restart.
      expect(RECOVERED.connectorRestarted({ ...recovery, after: killed.pid })).toBe(false);
      expect(RECOVERED.connectorRestarted({ ...recovery, after: undefined, running: false })).toBe(false);
      expect(RECOVERED.connectorRestarted({ ...recovery, downAfterKill: false })).toBe(false);
      for (const outcome of ["serving", "indeterminate"] as const) expect(RECOVERED.connectorRestarted({ ...recovery, meanwhile: { outcome, detail: "" } })).toBe(false);
      // A probe that fails while the connector is down (here DNS) never shows that nothing served the route; it is retried and the restart is not counted.
      recovered = undefined;
      const probes: string[] = [];
      down = async () => { probes.push("probe"); throw Object.assign(new Error("getaddrinfo EAI_AGAIN web-x.preview.example.test"), { code: "EAI_AGAIN", syscall: "getaddrinfo" }); };
      const third = await survivor();
      try {
        await recordConnectors(host.stateDir, bound.name, { pid: third.pid, metricsPort: 4103, birthSignature: await signature(third.pid) });
        const unprobed = await restartConnector(host, bound, cwd, async () => "https://web-x.preview.example.test/app/x");
        expect(unprobed).toMatchObject({ signalled: true, downAfterKill: true, meanwhile: { outcome: "indeterminate", detail: expect.stringContaining("EAI_AGAIN") }, running: true, served: true });
        expect(RECOVERED.connectorRestarted(unprobed)).toBe(false);
        expect(probes).toHaveLength(6);
      } finally { await third.stop(); }
      expect(RECOVERED.connectorRestarted({ ...recovery, served: false })).toBe(false);
      // A recover that reports the connector it was given: that pid is dead after the kill, so it is not running, though the route answers.
      recovered = undefined;
      await recordConnectors(host.stateDir, bound.name, { pid: successor.pid, metricsPort: 4102, birthSignature: await signature(successor.pid) });
      const noop = await restartConnector(host, bound, cwd, async () => "https://web-x.preview.example.test/app/x");
      expect(noop).toMatchObject({ killed: successor.pid, downAfterKill: true, after: successor.pid, running: false, served: true });
      expect(RECOVERED.connectorRestarted(noop)).toBe(false);
    } finally { for (const item of [killed, successor, reused]) await item.stop().catch(() => undefined); }
  });

  it("counts a public route as unserved or withdrawn only on a conclusive refusal, never on a failed or unrecognized probe", async () => {
    let absentInDns = true;
    const { host, inventory } = await fixtureHost({ devfn: { "tunnel status": { tunnel: { hostnames: [], outstanding: [] } } } }, async () => [], {}, { dnsAbsent: async () => absentInDns });
    const url = "https://web-qabcdef12-reload-0123.dev.example.test/";
    const lookup = (code: string) => Object.assign(new Error(`getaddrinfo ${code} web-qabcdef12-reload-0123.dev.example.test`), { code, syscall: "getaddrinfo" });
    const edge = { server: "cloudflare", "cf-ray": "8f0c1d2e3f4a5b6c-AMS" };
    const deny = { status: 403, body: "", headers: { "devfn-public-origin": "deny" } };
    const cases: Array<[string, Answer | Error, TunnelBinding["provider"], boolean, PublicOutcome["outcome"]]> = [
      ["resolver failure", lookup("EAI_AGAIN"), "cloudflare", true, "indeterminate"],
      ["deadline", new Error(`${url} passed its deadline`), "cloudflare", true, "indeterminate"],
      ["incomplete response", new Error(`${url} closed before its response was complete`), "ngrok", true, "indeterminate"],
      ["unshaped 502", { status: 502, body: "error code: 502", headers: edge }, "cloudflare", true, "indeterminate"],
      ["1033 without Cloudflare's headers", { status: 530, body: "error code: 1033", headers: {} }, "cloudflare", false, "indeterminate"],
      ["Cloudflare edge without a connector", { status: 530, body: "error code: 1033", headers: edge }, "cloudflare", false, "refused"],
      ["ngrok endpoint offline", { status: 404, body: "", headers: { "ngrok-error-code": "ERR_NGROK_3200" } }, "ngrok", false, "refused"],
      ["origin deny while the connector should be down", deny, "cloudflare", false, "indeterminate"],
      ["origin deny for a withdrawn name", deny, "cloudflare", true, "refused"],
      ["DNS has no such name, for a withdrawn name", lookup("ENOTFOUND"), "cloudflare", true, "refused"],
      ["DNS has no such name, while the connector should be down", lookup("ENOTFOUND"), "cloudflare", false, "indeterminate"],
      ["the run's own route", { status: 200, body: "", headers: {}, json: { marker: "qabcdef12-reload" } }, "cloudflare", true, "serving"],
    ];
    for (const [label, answer, provider, withdrawn, outcome] of cases) {
      host.request = async () => { if (answer instanceof Error) throw answer; return answer; };
      expect((await host.publicOutcome(url, provider, (item) => item.json?.marker === "qabcdef12-reload", { withdrawn })).outcome, label).toBe(outcome);
    }
    // A lookup failure whose own DNS query gets no not-found answer is not absence.
    absentInDns = false;
    host.request = async () => { throw lookup("ENOTFOUND"); };
    expect((await host.publicOutcome(url, "cloudflare", () => false, { withdrawn: true })).outcome).toBe("indeterminate");
    const resolver = (four: string | undefined, six: string | undefined) => ({ resolve4: async () => { if (four) throw Object.assign(new Error(four), { code: four }); return ["192.0.2.1"]; },
      resolve6: async () => { if (six) throw Object.assign(new Error(six), { code: six }); return ["2001:db8::1"]; } }) as never;
    expect(await dnsAbsent("x.example.test", resolver("ENOTFOUND", "ENODATA"))).toBe(true);
    expect(await dnsAbsent("x.example.test", resolver("ENOTFOUND", "ETIMEOUT"))).toBe(false);
    expect(await dnsAbsent("x.example.test", resolver(undefined, "ENOTFOUND"))).toBe(false);
    // The withdrawn-name read-back throws on an indeterminate probe, so cleanup stays unconfirmed; only a conclusive refusal reads absent.
    const bound = await cloudflareBinding(host.stateDir);
    const entry = inventory.record("public-hostname", "web-qabcdef12-reload-0123.dev.example.test", "s", { cwd: path.join(dir, "qabcdef12-reload"), binding: bound.name, url });
    host.request = async () => { throw new Error(`${url} passed its deadline`); };
    await expect(host.handlers().present(entry)).rejects.toThrow(/still serves is unknown: .*passed its deadline/);
    host.request = async () => ({ status: 530, body: "error code: 1016", headers: edge });
    expect(await host.handlers().present(entry)).toBe(false);
    host.request = async () => ({ status: 200, body: "", headers: {}, json: { marker: "qabcdef12-reload-b" } });
    expect(await host.handlers().present(entry)).toBe("still serves the run");
  });

  it("counts a killed start as crash evidence only when it was killed before it ended and reported no ready lifecycle", async () => {
    const seen = async (cwd: string | undefined) => await writeFile(path.join(cwd!, "seen-web.json"), JSON.stringify({ pid: 2 ** 22 + 7, env: {} }));
    const held: string[] = [];
    const fast = await fixtureHost({ devfn: { status: { ok: true, state: "ready", instanceId: "i1" },
      // The start becomes ready before the run sees its process: there is nothing to kill.
      up: async (_signal, cwd) => { await seen(cwd); return { code: 0, stdout: JSON.stringify({ ok: true, state: "ready" }), stderr: "" }; } } });
    const scenario = NETWORKING_MATRIX.find((item) => item.id === "recovery.crash")!;
    const context = (inventory: DisposableInventory): ScenarioContext => ({ scenario, inventory, observe: () => undefined, expect: () => undefined });
    const quick = await interruptStart(context(fast.inventory), fast.host, await fast.host.repository(scenario.id, "interrupted", hostFixture()));
    expect(quick.result.json.state).toBe("ready");
    expect(INTERRUPTED.killedBeforeReady(quick)).toBe(false);
    await rm(dir, { recursive: true, force: true });
    let status: unknown = { ok: true, state: "starting", instanceId: "i1" };
    const slow = await fixtureHost({ devfn: { status: async () => ({ code: 0, stdout: typeof status === "string" ? status : JSON.stringify(status), stderr: "" }),
      // The held node recorded itself and does not listen, so the start runs until it is killed.
      up: async (signal, cwd) => {
        held.push(...readdirSync(cwd!).filter((file) => file.startsWith("hold-")));
        await seen(cwd);
        await new Promise((resolve) => { if (signal!.aborted) resolve(undefined); else signal!.addEventListener("abort", resolve); });
        return { code: -1, stdout: "", stderr: "" };
      } } });
    const cwd = await slow.host.repository(scenario.id, "interrupted", hostFixture());
    const killed = await interruptStart(context(slow.inventory), slow.host, cwd);
    expect(held).toEqual([`hold-${failureInjection(hostFixture()).failing}`]);
    expect(killed).toMatchObject({ killed: true, orphan: 2 ** 22 + 7, result: { code: -1 }, status: { state: "starting" } });
    expect(INTERRUPTED.killedBeforeReady(killed)).toBe(true);
    // The hold is lifted after the kill, so the orphan listens as a process killed mid-start would.
    await expect(access(path.join(cwd, "hold-web"))).rejects.toThrow();
    expect(INTERRUPTED.killedBeforeReady({ ...killed, status: undefined })).toBe(false);
    expect(INTERRUPTED.killedBeforeReady({ ...killed, status: { state: "ready", instanceId: "i1" } })).toBe(false);
    // A status that is unparseable, an error or another owner's answer reads no lifecycle, so it is no crash evidence.
    for (const unreadable of ["not json", { ok: false, error: { code: "DEVFN_REGISTRY_LOCK_TIMEOUT" } }, { ok: true, state: "starting", instanceId: "other" }]) {
      status = unreadable;
      const again = await interruptStart(context(slow.inventory), slow.host, cwd);
      expect(again).toMatchObject({ killed: true, result: { code: -1 } });
      expect(again.status).toBeUndefined();
      expect(INTERRUPTED.killedBeforeReady(again)).toBe(false);
    }
    expect(INTERRUPTED.killedBeforeReady({ ...killed, result: { code: 0, json: { state: "ready" } } })).toBe(false);
    // Every plan node is recorded before the kill; here api never recorded itself and web's PID has no readable identity, so neither proves anything later.
    expect(killed.launched).toEqual([{ name: "api" }, { name: "web", pid: 2 ** 22 + 7 }]);
    expect(await INTERRUPTED.orphansGone(killed)).toBe(false);
    // web is gone but the api the killed start launched before it survives: that fails, even when a later lifecycle lists its pid.
    const [web, api] = [await survivor(), await survivor()];
    try {
      const launched = await Promise.all(([["api", api.pid], ["web", web.pid]] as const).map(async ([name, pid]) => ({ name, pid, process: await slow.host.recordProcess(pid) })));
      const start = { ...killed, launched };
      await web.stop();
      expect(await INTERRUPTED.orphansGone(start)).toBe(false);
      await api.stop();
      expect(await INTERRUPTED.orphansGone(start)).toBe(true);
      expect(await INTERRUPTED.orphansGone(start, async () => "unverified")).toBe(false);
      expect(await INTERRUPTED.orphansGone({ ...start, launched: [] })).toBe(false);
    } finally { await web.stop(); await api.stop(); }
  });

  const devfnOk = (json: Record<string, unknown>) => ({ code: 0, stdout: JSON.stringify({ ok: true, ...json }), stderr: "" });
  const devfnError = (code: string) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code } }), stderr: "" });
  /** What host.devfn turns into UNPARSEABLE: a garbled answer with exit 1, or a command the run killed or timed out. */
  const garbled = { code: 1, stdout: "Error: something", stderr: "" };
  const killedCommand = { code: -1, stdout: "", stderr: "" };
  /** A PID above every platform's maximum, so never a live process. */
  const DEAD = 2 ** 22 + 7;
  type Reply = { code: number; stdout: string; stderr: string };

  /**
   * A live host whose fixture checkouts answer like DevFn: each start
   * records its web and api processes (pid, this process by default) and is
   * ready; url, status and the run's probes answer per checkout, each route
   * with the checkout's marker and its service's name. Answers per checkout
   * name override that.
   */
  async function scenarioHost(answers: { up?: (name: string, cwd: string) => Promise<Reply | undefined>; status?: (name: string) => Reply | undefined; pid?: (name: string, service: string) => number | undefined;
    request?: (url: URL) => Answer | undefined } = {}) {
    const name = (cwd?: string) => path.basename(cwd!).replace(/^qabcdef12-/, "");
    const fixture = await fixtureHost({ devfn: {
      "status --trust": { ok: true, state: "stopped", instanceId: "i1" },
      status: async (_signal?: AbortSignal, cwd?: string) => answers.status?.(name(cwd)) ?? devfnOk({ state: "ready", instanceId: "i1", processes: [{}, {}] }),
      up: async (_signal?: AbortSignal, cwd?: string) => {
        const answer = await answers.up?.(name(cwd), cwd!);
        if (answer) return answer;
        for (const service of ["web", "api"]) await writeFile(path.join(cwd!, `seen-${service}.json`), JSON.stringify({ pid: answers.pid?.(name(cwd), service) ?? process.pid, env: {} }));
        return devfnOk({ state: "ready", instanceId: "i1" });
      },
      restart: { ok: true, state: "ready", instanceId: "i1" },
      url: async (_signal?: AbortSignal, cwd?: string) => devfnOk({ urls: { web: `https://${path.basename(cwd!)}.localhost:8443/`, api: `https://svc-${path.basename(cwd!)}.localhost:8443/api` } }),
      ports: { ok: true, allocations: [] }, "ports gc": { ok: true },
    } });
    fixture.host.ca = async () => "fixture-ca";
    fixture.host.request = async (target: string) => {
      const url = new URL(target);
      return answers.request?.(url) ?? { status: 200, body: "", headers: {}, json: { marker: url.hostname.split(".")[0].replace(/^svc-/, ""), name: url.pathname.startsWith("/api") ? "api" : "web" } };
    };
    return fixture;
  }

  /** Run one live driver; the observations it made and whether a failed expectation ended it. */
  async function drive(id: string, fixture: { host: LiveHost; inventory: DisposableInventory }) {
    const scenario = NETWORKING_MATRIX.find((item) => item.id === id)!;
    const observed: Record<string, { ok: boolean; detail: string }> = {};
    const observe = (assertion: string, ok: boolean, detail: string) => { observed[assertion] = { ok, detail }; };
    const context: ScenarioContext = { scenario, inventory: fixture.inventory, observe, expect: (assertion, ok, detail) => { observe(assertion, ok, detail); if (!ok) throw new Error(`${assertion}: ${detail}`); } };
    const error = await liveDrivers(fixture.host, undefined)[id](context).then(() => undefined, (failure: unknown) => failure);
    return { observed, error };
  }

  it("counts a provoked startup failure only from DevFn's own DEVFN_START_FAILED and a readable status of the checkout's owner", async () => {
    const { failing, sibling } = failureInjection(hostFixture());
    const run = async (failed: Reply, status: Reply) => {
      const fixture = await scenarioHost({
        up: async (name, cwd) => {
          if (name !== "failing" || !readdirSync(cwd).includes(`fail-${failing}`)) return undefined;
          // The failing node reached its sibling, and neither process survived the rollback.
          await writeFile(path.join(cwd, `seen-${failing}.json`), JSON.stringify({ pid: DEAD, env: {}, sibling: { name: sibling, marker: path.basename(cwd) } }));
          await writeFile(path.join(cwd, `seen-${sibling}.json`), JSON.stringify({ pid: DEAD, env: {} }));
          return failed;
        },
        status: (name) => name === "failing" ? status : undefined,
      });
      const { observed } = await drive("recovery.startup-failure", fixture);
      await rm(dir, { recursive: true, force: true });
      return observed["failure-cleaned"];
    };
    const failedStatus = { code: 0, stdout: JSON.stringify({ ok: false, state: "failed", instanceId: "i1" }), stderr: "" };
    expect(await run(devfnError("DEVFN_START_FAILED"), failedStatus)).toMatchObject({ ok: true });
    for (const failed of [garbled, killedCommand, devfnError("DEVFN_RUNTIME_INVALID")]) expect((await run(failed, failedStatus)).ok).toBe(false);
    for (const status of [{ code: 0, stdout: "not json", stderr: "" }, killedCommand, devfnOk({ state: "stopped", instanceId: "other" })]) {
      expect(await run(devfnError("DEVFN_START_FAILED"), status)).toMatchObject({ ok: false, detail: expect.stringContaining("state unreadable") });
    }
  });

  it("keeps sentinel-preserved only while every service of the unaffected lifecycle keeps its process and answers on every probe round", async () => {
    const { failing, sibling } = failureInjection(hostFixture());
    const failedStatus = { code: 0, stdout: JSON.stringify({ ok: false, state: "failed", instanceId: "i1" }), stderr: "" };
    /** Drive the startup failure; transition runs while the failing start runs, with the sentinel checkout. */
    const run = async (options: { api?: number; transition?: (sentinel: string) => Promise<void>; request?: (url: URL) => Answer | undefined } = {}) => {
      const fixture = await scenarioHost({
        pid: (name, service) => name === "sentinel" && service === "api" ? options.api : undefined,
        up: async (name, cwd) => {
          if (name !== "failing" || !readdirSync(cwd).includes(`fail-${failing}`)) return undefined;
          await writeFile(path.join(cwd, `seen-${failing}.json`), JSON.stringify({ pid: DEAD, env: {}, sibling: { name: sibling, marker: path.basename(cwd) } }));
          await writeFile(path.join(cwd, `seen-${sibling}.json`), JSON.stringify({ pid: DEAD, env: {} }));
          await options.transition?.(path.join(path.dirname(cwd), "qabcdef12-sentinel"));
          return devfnError("DEVFN_START_FAILED");
        },
        status: (name) => name === "failing" ? failedStatus : undefined,
        ...(options.request ? { request: options.request } : {}),
      });
      const { observed } = await drive("recovery.startup-failure", fixture);
      await rm(dir, { recursive: true, force: true });
      expect(observed["failure-cleaned"]?.ok).toBe(true);
      return observed["sentinel-preserved"];
    };
    expect(await run()).toMatchObject({ ok: true, detail: expect.stringMatching(/kept processes web \d+, api \d+, its URLs and 0 routes; all \d+ probe rounds of https:\/\/qabcdef12-sentinel.localhost:8443\/ and https:\/\/svc-qabcdef12-sentinel.localhost:8443\/api\/watched answered/) });
    // The sentinel's api process stops, or another process takes its place, while web is unchanged.
    const api = await survivor();
    const other = await survivor();
    try {
      expect(await run({ api: api.pid, transition: async () => await api.stop() })).toMatchObject({ ok: false, detail: expect.stringContaining(`api process ${api.pid} -> ${api.pid}`) });
      expect(await run({ transition: async (sentinel) => await writeFile(path.join(sentinel, "seen-api.json"), JSON.stringify({ pid: other.pid, env: {} })) }))
        .toMatchObject({ ok: false, detail: expect.stringContaining(`api process ${process.pid} -> ${other.pid}`) });
    } finally { await api.stop().catch(() => undefined); await other.stop(); }
    // The api path route stops answering as api, or is withdrawn and restored before the scenario ends.
    let withdrawn = false;
    const request = (url: URL): Answer | undefined => withdrawn && url.hostname.startsWith("svc-qabcdef12-sentinel.") ? { status: 404, body: "", headers: {} } : undefined;
    expect(await run({ request, transition: async () => { withdrawn = true; } })).toMatchObject({ ok: false, detail: expect.stringContaining("unanswered after the scenario: https://svc-qabcdef12-sentinel.localhost:8443/api/watched") });
    withdrawn = false;
    const restored = await run({ request, transition: async () => { withdrawn = true; await new Promise((resolve) => setTimeout(resolve, 500)); withdrawn = false; } });
    expect(restored).toMatchObject({ ok: false, detail: expect.stringMatching(/\d+ probes unanswered: https:\/\/svc-qabcdef12-sentinel.localhost:8443\/api\/watched in round \d+/) });
    expect(restored.detail).not.toContain("unanswered after the scenario");
  }, 30_000);

  it("counts a concurrent start as single-owner only when the loser is DevFn's own lock or already-running refusal", async () => {
    const run = async (loser: Reply, status?: Reply) => {
      let starts = 0;
      const fixture = await scenarioHost({ up: async (name) => name === "concurrent" && ++starts === 2 ? loser : undefined, status: (name) => name === "concurrent" ? status : undefined });
      const { observed } = await drive("recovery.concurrent-change", fixture);
      await rm(dir, { recursive: true, force: true });
      return observed["single-owner"].ok;
    };
    expect(await run(devfnError("DEVFN_ALREADY_RUNNING"))).toBe(true);
    expect(await run(devfnError("DEVFN_REGISTRY_LOCK_TIMEOUT"))).toBe(true);
    for (const loser of [garbled, killedCommand, devfnError("DEVFN_START_FAILED")]) expect(await run(loser)).toBe(false);
    expect(await run(devfnError("DEVFN_ALREADY_RUNNING"), devfnOk({ state: "ready", instanceId: "other", processes: [{}, {}] }))).toBe(false);
  });

  it("detects a crash only from a readable degraded status after signalling the web process it recorded, never a reused PID", async () => {
    const run = async (status: Reply, forge = false) => {
      const target = await survivor();
      const fixture = await scenarioHost({ pid: (name) => name === "crash" ? target.pid : undefined,
        up: async (name, cwd) => {
          if (name !== "interrupted" || !readdirSync(cwd).some((file) => file.startsWith("hold-"))) return undefined;
          // Every process of the killed start records itself, then dies with it.
          const launched = [await survivor(), await survivor()];
          for (const [index, service] of ["api", "web"].entries()) await writeFile(path.join(cwd, `seen-${service}.json`), JSON.stringify({ pid: launched[index].pid, env: {} }));
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          for (const item of launched) await item.stop();
          return killedCommand;
        },
        status: (name) => name === "crash" ? status : name === "interrupted" ? { code: 0, stdout: JSON.stringify({ ok: false, state: "failed", instanceId: "i1" }), stderr: "" } : undefined });
      const recordProcess = fixture.host.recordProcess.bind(fixture.host);
      // A record whose birth identity is not the live process's stands for a PID another process reuses.
      if (forge) fixture.host.recordProcess = async (pid) => { const own = await recordProcess(pid); return own && { ...own, birthSignature: foreignSignature(own.birthSignature) }; };
      try {
        const { observed } = await drive("recovery.crash", fixture);
        return { observed, alive: (() => { try { process.kill(target.pid, 0); return true; } catch { return false; } })() };
      } finally { await target.stop().catch(() => undefined); await rm(dir, { recursive: true, force: true }); }
    };
    const degraded = { code: 0, stdout: JSON.stringify({ ok: false, state: "degraded", instanceId: "i1" }), stderr: "" };
    const passed = await run(degraded);
    expect(passed.alive).toBe(false);
    expect(passed.observed["crash-detected"]).toMatchObject({ ok: true, detail: expect.stringContaining("status after kill: degraded") });
    expect(passed.observed["restart-recovers"]?.ok).toBe(true);
    expect(passed.observed["sentinel-preserved"]).toMatchObject({ ok: true, detail: expect.stringContaining("qabcdef12-sentinel kept processes web") });
    for (const unreadable of [{ code: 0, stdout: "not json", stderr: "" }, killedCommand, devfnOk({ state: "degraded", instanceId: "other" }), devfnOk({ state: "stopped", instanceId: "i1" })]) {
      expect((await run(unreadable)).observed["crash-detected"].ok).toBe(false);
    }
    const reused = await run(degraded, true);
    expect(reused.alive).toBe(true);
    expect(reused.observed["crash-detected"]).toMatchObject({ ok: false, detail: expect.stringContaining("not signalled") });
  }, 60_000);

  it("signals a recorded process only while it matches its recorded birth identity", async () => {
    const { host } = await fixtureHost({ devfn: {} });
    const target = await survivor();
    try {
      const recorded = (await host.recordProcess(target.pid))!;
      expect(recorded).toMatchObject({ pid: target.pid, birthSignature: expect.stringMatching(/^(linux|darwin-utc):/) });
      expect(await host.killRecorded({ ...recorded, birthSignature: foreignSignature(recorded.birthSignature) }, false)).toBe(false);
      expect(await host.killRecorded(undefined, false)).toBe(false);
      expect(process.kill(target.pid, 0)).toBe(true);
      expect(await host.killRecorded(recorded, false)).toBe(true);
      await target.stop();
      expect(await host.killRecorded(recorded, false)).toBe(false);
    } finally { await target.stop().catch(() => undefined); }
  });

  it("lets proxy reload settle when interrupted during a pending down, then cleans up, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    const events: string[] = [];
    const interrupt = new AbortController();
    const ready = async (_signal?: AbortSignal, cwd?: string) => {
      for (const service of ["web", "api"]) await writeFile(path.join(cwd!, `seen-${service}.json`), JSON.stringify({ pid: process.pid, env: {} }));
      return { code: 0, stdout: JSON.stringify({ ok: true, state: "ready" }), stderr: "" };
    };
    const fixture = await fixtureHost({ devfn: { status: { ok: true, state: "ready", instanceId: "i1" }, url: { urls: { web: "https://app-x.localhost:8443/", api: "https://svc-x.localhost:8443/api" } }, up: ready,
      // The interrupt arrives while the reload's down runs; down is cleanup, so it finishes, while the sentinel probe's wait rejects.
      down: async () => {
        events.push("down started");
        interrupt.abort();
        fixture.host.abort();
        await new Promise((resolve) => setTimeout(resolve, 200));
        events.push("down ended");
        return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      } } });
    const { host, inventory } = fixture;
    host.ca = async () => "fixture-ca";
    host.request = async () => ({ status: 200, body: "", headers: {}, json: { marker: "qabcdef12-sentinel" } });
    try {
      const scenario = NETWORKING_MATRIX.find((item) => item.id === "recovery.proxy-reload")!;
      const drivers = liveDrivers(host, undefined);
      const [result] = await runScenarios({ scenarios: [scenario], platform: "linux", prerequisites: allPrerequisites, inventory, signal: interrupt.signal, snapshot: async () => ({}),
        drivers: { [scenario.id]: async (context) => { try { await drivers[scenario.id](context); } finally { events.push("driver settled"); } } },
        resources: { remove: async () => { events.push("remove"); }, present: async () => false } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
      expect(events.slice(0, 4)).toEqual(["down started", "down ended", "driver settled", "remove"]);
      expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("the run was interrupted") });
    } finally { process.off("unhandledRejection", onUnhandled); }
  });

  it("joins a detached promise's rejection only when asked, never leaving it unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const join = detach(Promise.reject(new Error("interrupted")));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      await expect(join()).rejects.toThrow("interrupted");
      expect(await detach(Promise.resolve(7))()).toBe(7);
    } finally { process.off("unhandledRejection", onUnhandled); }
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
    await expect(handlers.present(entry)).rejects.toThrow(/still serves is unknown: .*ECONNREFUSED/);
    // ngrok's own offline answer for the name is a conclusive refusal.
    host.request = async () => ({ status: 404, body: "", headers: { "ngrok-error-code": "ERR_NGROK_3200" } });
    expect(await handlers.present(entry)).toBe(false);
  });

  it("reads a withdrawn ngrok name back by its own endpoints in both endpoint modes, while the binding read-back still holds every marked endpoint", async () => {
    let endpoints: unknown[] = [];
    const fetcher = (async (url: string | URL | Request) => new Response(JSON.stringify({ ...(String(url).includes("/endpoints") ? { endpoints } : { tunnels: [] }), next_page_uri: null }))) as typeof fetch;
    const env = { QUAL_NGROK_API_KEY: "key" };
    const status = { tunnel: { hostnames: [] as string[], outstanding: [] } };
    const { host, inventory } = await fixtureHost({ devfn: { "tunnel status": status } }, providerReadBack(env, fetcher), env);
    // ngrok's own offline answer: the withdrawn name is refused at the edge.
    host.request = async () => ({ status: 404, body: "", headers: { "ngrok-error-code": "ERR_NGROK_3200" } });
    const handlers = host.handlers();
    for (const mode of ["reserved", "ephemeral"] as const) {
      const name = `qabcdef12-ng${mode[0]}`;
      const binding = await registerTunnelBinding(host.stateDir, { name, provider: "ngrok", domain: mode === "reserved" ? "dev.example.test" : ephemeralOriginDomain(name), projectId: "qualification",
        repositoryIdentity: dir, nonproduction: true, ngrok: { endpoints: mode, authtokenEnv: "QUAL_NGROK_AUTHTOKEN", apiKeyEnv: "QUAL_NGROK_API_KEY" } });
      const [a, b] = mode === "reserved"
        ? [{ id: "web-qabcdef12-a.dev.example.test", url: "https://web-qabcdef12-a.dev.example.test/" }, { id: "web-qabcdef12-b.dev.example.test", url: "https://web-qabcdef12-b.dev.example.test/" }]
        : [{ id: `web-qabcdef12-a-0123.${binding.domain}`, url: "https://a1b2.ngrok-free.app/" }, { id: `web-qabcdef12-b-4567.${binding.domain}`, url: "https://c3d4.ngrok-free.app/" }];
      const entry = inventory.record("public-hostname", a.id, mode, { cwd: dir, binding: name, url: a.url });
      // After A's down, DevFn routes only B and the provider holds only B's endpoint, carrying the shared marker: A is withdrawn, so withdraw-one can pass and recovery runs.
      status.tunnel.hostnames = [b.id];
      const sibling = { url: b.url, metadata: ngrokMarker(binding) };
      endpoints = [sibling];
      expect(await handlers.present(entry), mode).toBe(false);
      // A leftover endpoint at A's own URL, marked or not, still holds A.
      for (const metadata of [ngrokMarker(binding), "foreign"]) {
        endpoints = [sibling, { url: a.url, metadata }];
        expect(await handlers.present(entry), mode).toBe(`held by ngrok: ${new URL(a.url).hostname}`);
      }
      // The binding's cleanup read-back still rejects every endpoint carrying its marker, the surviving sibling's included.
      endpoints = [sibling];
      expect(await handlers.present(inventory.record("tunnel-binding", name, mode)), mode).toContain(`held by ngrok: ${new URL(b.url).hostname}`);
    }
  });

  it("finds a run's ngrok endpoints by marker or name and fails closed on unreadable pages or a missing API key", async () => {
    const binding = { name: "qabcdef12-ngr", provider: "ngrok", domain: "ngrok.example.test", projectId: "qualification", repositoryIdentity: "/r", nonproduction: true,
      ngrok: { endpoints: "reserved", authtokenEnv: "QUAL_NGROK_AUTHTOKEN", apiKeyEnv: "QUAL_NGROK_API_KEY", registrationId: "c".repeat(32) } } as TunnelBinding;
    const pages = (endpoints: unknown[], tunnels: unknown[] = [], status = 200): typeof fetch => (async (url: string | URL | Request) => {
      const list = String(url).includes("/endpoints") ? { endpoints } : { tunnels };
      return new Response(JSON.stringify({ ...list, next_page_uri: null }), { status });
    }) as typeof fetch;
    const env = { QUAL_NGROK_API_KEY: "key" };
    // A name asks about that name only: a sibling endpoint carrying the binding's marker is not its residue, while the binding-wide read-back holds it.
    expect(await providerReadBack(env, pages([{ url: "https://other.ngrok.example.test", metadata: ngrokMarker(binding) }]))(binding, "web-q.ngrok.example.test", undefined)).toEqual([]);
    expect(await providerReadBack(env, pages([{ url: "https://other.ngrok.example.test", metadata: ngrokMarker(binding) }]))(binding, undefined, undefined)).toEqual(["other.ngrok.example.test"]);
    expect(await providerReadBack(env, pages([], [{ public_url: "https://other.ngrok.example.test", metadata: ngrokMarker(binding) }]))(binding, undefined, "https://web-q.ngrok.example.test/")).toEqual([]);
    // A marked endpoint without a readable URL cannot be told apart from the name.
    expect(await providerReadBack(env, pages([{ metadata: ngrokMarker(binding) }]))(binding, "web-q.ngrok.example.test", undefined)).toEqual(["an endpoint without a URL"]);
    // An ephemeral route is known to ngrok only by its assigned URL; without one, every marked endpoint counts for its origin name.
    const ephemeral = { ...binding, ngrok: { ...binding.ngrok, endpoints: "ephemeral" } } as TunnelBinding;
    expect(await providerReadBack(env, pages([{ url: "https://a1b2.ngrok-free.app", metadata: ngrokMarker(ephemeral) }]))(ephemeral, "web-q-0123.q.ngrok.devfn.internal", undefined)).toEqual(["a1b2.ngrok-free.app"]);
    expect(await providerReadBack(env, pages([{ url: "https://a1b2.ngrok-free.app", metadata: ngrokMarker(ephemeral) }]))(ephemeral, "web-q-0123.q.ngrok.devfn.internal", "https://c3d4.ngrok-free.app/")).toEqual([]);
    expect(await providerReadBack(env, pages([], [{ public_url: "https://web-q.ngrok.example.test", metadata: "foreign" }]))(binding, "web-q.ngrok.example.test", undefined)).toEqual(["web-q.ngrok.example.test"]);
    expect(await providerReadBack(env, pages([{ url: "https://other.ngrok.example.test", metadata: "foreign" }]))(binding, "web-q.ngrok.example.test", undefined)).toEqual([]);
    await expect(providerReadBack(env, pages([], [], 503))(binding, "web-q.ngrok.example.test", undefined)).rejects.toThrow(/HTTP 503/);
    await expect(providerReadBack({}, pages([]))(binding, "web-q.ngrok.example.test", undefined)).rejects.toThrow(/no readable API key/);
  });
});

describe("trust store inventory", () => {
  let dir = "";
  afterEach(async () => { if (dir) { await chmod(path.join(dir, "certs", "nested"), 0o755).catch(() => undefined); await rm(dir, { recursive: true, force: true }); } dir = ""; });

  it("walks nested directories and symbolic links, so a change anywhere under a location changes the inventory", async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-trust-")));
    const certs = path.join(dir, "certs");
    const shared = path.join(dir, "share");
    await mkdir(path.join(certs, "nested", "deeper"), { recursive: true });
    await mkdir(shared, { recursive: true });
    await writeFile(path.join(certs, "top.pem"), "top");
    await writeFile(path.join(certs, "nested", "deeper", "inner.pem"), "inner");
    await writeFile(path.join(shared, "a.crt"), "a");
    await writeFile(path.join(shared, "b.crt"), "b");
    await symlink(path.join(shared, "a.crt"), path.join(certs, "linked.pem"));
    await symlink(path.join(dir, "gone.crt"), path.join(certs, "dangling.pem"));
    // A link back to its own location is walked once, never forever.
    await symlink(certs, path.join(certs, "nested", "loop"));
    const locations = [certs, path.join(dir, "absent")];
    const before = await trustDirectoryAnchors(locations);
    expect(before.some((item) => item.startsWith(`${path.join(certs, "nested", "deeper", "inner.pem")}:`))).toBe(true);
    expect(before).toContain(`${path.join(certs, "dangling.pem")} -> ${path.join(dir, "gone.crt")} (unresolved)`);
    const changed = async (change: () => Promise<void>) => { await change(); return JSON.stringify(await trustDirectoryAnchors(locations)) !== JSON.stringify(before); };
    expect(await trustDirectoryAnchors(locations)).toEqual(before);
    expect(await changed(async () => await writeFile(path.join(certs, "nested", "deeper", "inner.pem"), "replaced"))).toBe(true);
    await writeFile(path.join(certs, "nested", "deeper", "inner.pem"), "inner");
    expect(await changed(async () => await writeFile(path.join(certs, "nested", "deeper", "added.pem"), "added"))).toBe(true);
    await rm(path.join(certs, "nested", "deeper", "added.pem"));
    // The certificate a link names is read: changing it, or retargeting the link, is a change.
    expect(await changed(async () => await writeFile(path.join(shared, "a.crt"), "a2"))).toBe(true);
    await writeFile(path.join(shared, "a.crt"), "a");
    expect(await changed(async () => { await rm(path.join(certs, "linked.pem")); await symlink(path.join(shared, "b.crt"), path.join(certs, "linked.pem")); })).toBe(true);
    // A location that does not exist holds nothing.
    expect(await trustDirectoryAnchors([path.join(dir, "absent")])).toEqual([]);
  });

  it("throws on an unreadable certificate or directory rather than reading it as unchanged", async (test) => {
    if (process.getuid?.() === 0) test.skip();
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-trust-")));
    const nested = path.join(dir, "certs", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "inner.pem"), "inner");
    await chmod(path.join(nested, "inner.pem"), 0o000);
    await expect(trustDirectoryAnchors([path.join(dir, "certs")])).rejects.toThrow(/EACCES/);
    await chmod(path.join(nested, "inner.pem"), 0o644);
    await chmod(nested, 0o000);
    await expect(trustDirectoryAnchors([path.join(dir, "certs")])).rejects.toThrow(/EACCES/);
    await chmod(nested, 0o755);
    await writeFile(path.join(dir, "file-location"), "x");
    await expect(trustDirectoryAnchors([path.join(dir, "file-location")])).rejects.toThrow(/not a directory/);
  });
});

describe("fixture processes", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ""; });
  const freePort = async () => await new Promise<number>((resolve) => { const server = net.createServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); });
  const answers = async (port: number) => await fetch(`http://127.0.0.1:${port}/`).then((answer) => answer.ok, () => false);
  const serve = (name: string, env: NodeJS.ProcessEnv) => spawn(process.execPath, ["server.mjs", name, `DEVFN_PORT_${name.toUpperCase()}`], { cwd: dir, env: { ...process.env, ...env }, stdio: "ignore" });
  const until = async (check: () => Promise<boolean>) => { for (let attempt = 0; attempt < 100 && !await check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50)); };

  it("fail the last node in plan order while the node DevFn started before it answers, and show that sibling stopped", async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-fixture-")));
    await writeFile(path.join(dir, "server.mjs"), FIXTURE_SERVER);
    const { failing, sibling } = failureInjection(hostFixture());
    expect(createPlan(validateDevFnConfig(hostFixture())).nodes.map((node) => node.name)).toEqual([sibling, failing]);
    const [siblingPort, failingPort] = [await freePort(), await freePort()];
    const ready = serve(sibling, { [`DEVFN_PORT_${sibling.toUpperCase()}`]: String(siblingPort) });
    try {
      await until(async () => await answers(siblingPort));
      await writeFile(path.join(dir, `fail-${failing}`), `DEVFN_URL_${sibling.toUpperCase()}`);
      const failed = serve(failing, { [`DEVFN_PORT_${failing.toUpperCase()}`]: String(failingPort), [`DEVFN_URL_${sibling.toUpperCase()}`]: `http://127.0.0.1:${siblingPort}` });
      const [code] = await once(failed, "exit");
      expect(code).toBe(3);
      const read = async (name: string) => JSON.parse(await readFile(path.join(dir, `seen-${name}.json`), "utf8")) as { pid: number; sibling?: Record<string, unknown> | null };
      const [failedSeen, siblingSeen] = [await read(failing), await read(sibling)];
      expect(failedSeen.sibling).toMatchObject({ name: sibling, marker: path.basename(dir) });
      // A sibling still running is not a rollback; once it stopped, it is.
      expect(rolledBackReadySibling(failedSeen, siblingSeen, sibling, dir)).toBe(false);
      ready.kill("SIGKILL");
      await once(ready, "exit");
      expect(rolledBackReadySibling(failedSeen, siblingSeen, sibling, dir)).toBe(true);
      // A failure before the sibling answered, or a failure with no sibling probe, shows nothing.
      expect(rolledBackReadySibling({ sibling: null }, siblingSeen, sibling, dir)).toBe(false);
      expect(rolledBackReadySibling({}, siblingSeen, sibling, dir)).toBe(false);
      expect(rolledBackReadySibling(failedSeen, undefined, sibling, dir)).toBe(false);
    } finally { ready.kill("SIGKILL"); }
  });

  it("hold a node after it recorded itself and before it listens until the hold is lifted", async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-fixture-")));
    await writeFile(path.join(dir, "server.mjs"), FIXTURE_SERVER);
    await writeFile(path.join(dir, "hold-web"), "");
    const port = await freePort();
    const child = serve("web", { DEVFN_PORT_WEB: String(port) });
    try {
      await until(async () => await access(path.join(dir, "seen-web.json")).then(() => true, () => false));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await answers(port)).toBe(false);
      await rm(path.join(dir, "hold-web"));
      await until(async () => await answers(port));
      expect(await answers(port)).toBe(true);
    } finally { child.kill("SIGKILL"); }
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
    "403 unmarked": answer(403), "404 fallback": answer(404, "", { [header]: "fallback" }), "404 proxy": answer(404), "404 text": answer(404, "Not Found\n"), "301": answer(301, "", { location: "https://app-x.localhost:8443/" }),
    "308": answer(308, "", { location: "https://app-x.localhost:8443/" }), "403 replayed": answer(403, "DEVFN_OAUTH_RELAY_REJECTED: replayed\n"), "403 unknown-state": answer(403, "DEVFN_OAUTH_RELAY_REJECTED: unknown-state\n"),
    "421 wrong-origin": answer(421, "DEVFN_OAUTH_RELAY_REJECTED: wrong-origin\n"),
  };
  const accepted = (predicate: (item?: Answer) => boolean) => Object.entries(failures).filter(([, item]) => predicate(item)).map(([name]) => name);

  it("accept only the shipped component's own answer for each claim", () => {
    expect(accepted(ANSWERS.originDenied)).toEqual(["403 deny"]);
    expect(accepted(ANSWERS.forgedHostRefused)).toEqual(["421"]);
    expect(accepted(ANSWERS.originFallback)).toEqual(["404 fallback"]);
    expect(accepted(ANSWERS.relayReplayRejected)).toEqual(["403 replayed"]);
    // Only the local proxy's empty, unmarked 404: the marked origin fallback is a public-origin answer, and a 404 with a body is not Caddy's respond 404.
    expect(accepted(ANSWERS.proxyNotFound)).toEqual(["404 proxy"]);
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

  it("read back every name the provider holds for the private route or with the binding's marker", async () => {
    const binding = { name: "qabcdef12-cf", provider: "cloudflare" } as TunnelBinding;
    const publicHost = "web-q.preview.example.test", privateName = "private-q.preview.example.test";
    // DNS for the private name is gone, but another record carries the binding's ownership marker.
    const held = await providerHeld(async (_binding, hostname) => hostname === privateName ? [] : [publicHost, "extra-q.preview.example.test"], binding, privateName);
    expect(held).toEqual(["extra-q.preview.example.test", publicHost]);
    expect(ANSWERS.providerWithheld(held, publicHost, privateName)).toBe(false);
    expect(ANSWERS.providerWithheld(await providerHeld(async (_binding, hostname) => hostname === privateName ? [] : [publicHost], binding, privateName), publicHost, privateName)).toBe(true);
    await expect(providerHeld(async () => { throw new Error("Cloudflare GET dns_records answered HTTP 403"); }, binding, privateName)).rejects.toThrow(/HTTP 403/);
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

  it("compares resolver and process DEVFN_ values in both directions", () => {
    const config = validateDevFnConfig(hostFixture());
    const resolved = resolveEndpointTemplates({ config, plan: createPlan(config), ownerId: "owner-1", ports: { web: 41000, api: 41001 } }).nodes.web.environment;
    const seen = Object.fromEntries(Object.entries(resolved).filter(([key]) => key.startsWith("DEVFN_")));
    expect(resolverDifferences(resolved, seen)).toEqual([]);
    // A generated key the process saw that the resolver does not produce fails, as does one the process never saw or saw with another value.
    expect(resolverDifferences(resolved, { ...seen, DEVFN_URL_EXTRA: "http://127.0.0.1:41002" })).toEqual(["DEVFN_URL_EXTRA (not produced by the resolver)"]);
    const { DEVFN_PORT_WEB: _port, ...withoutPort } = seen;
    expect(resolverDifferences(resolved, withoutPort)).toEqual(["DEVFN_PORT_WEB (not seen by the process)"]);
    expect(resolverDifferences(resolved, { ...seen, DEVFN_INSTANCE_ID: "other" })).toEqual(["DEVFN_INSTANCE_ID"]);
    // Only a key named as runtime-only is excluded; non-DEVFN_ values are outside the claim.
    expect([...RUNTIME_ONLY_KEYS]).toEqual(["DEVFN_STATE_DIR"]);
    expect(resolverDifferences(resolved, { ...seen, DEVFN_STATE_DIR: "/tmp/x", QUAL_REVISION: "2" })).toEqual([]);
    expect(resolverDifferences(resolved, { ...seen, DEVFN_STATE_DIR: "/tmp/x" }, new Set())).toEqual(["DEVFN_STATE_DIR (not produced by the resolver)"]);
  });
});
