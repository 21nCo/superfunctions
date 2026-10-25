import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateDevFnConfig } from "@devfn/config";
import {
  approvedDomains, checkPrerequisites, composeFixture, DEFERRED_ROWS, DisposableInventory, domainFixture, hostFixture, InventoryError, liveDrivers, LiveHost,
  NETWORKING_MATRIX, networkingOutcomeGate, oauthFixture, parseApproval, receiptProblems, redactSecrets, runScenarios, selectScenarios, summarize, tunnelFixture,
  type NetworkingQualificationReceipt, type PrerequisiteResult, type ProbeEnvironment, type ProtectedSnapshot, type ResourceHandlers, type ScenarioDriver, type ScenarioResult,
} from "../src/networking/index.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT = "/tmp/devfn-qualification-test";
const HEAD = "a".repeat(40);
const future = new Date(Date.now() + 86_400_000).toISOString();
const approval = {
  version: 1, nonproduction: true, approvedBy: "owner", expiresAt: future, domain: "dev.example.test",
  oauth: { provider: "google", clientIdEnv: "QUAL_GOOGLE_ID", clientSecretEnv: "QUAL_GOOGLE_SECRET", relayHost: "auth", redirectUri: "https://auth.dev.example.test:8443/oauth/callback" },
  cloudflare: { domain: "preview.example.test", accountId: "a".repeat(32), zoneId: "b".repeat(32), tunnelId: "00000000-0000-4000-8000-000000000000", credentialsFile: "/secure/tunnel.json", apiTokenEnv: "QUAL_CF_TOKEN" },
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
    expect(approvedDomains(parsed)).toEqual(["dev.example.test", "preview.example.test"]);
    expect(approvedDomains(undefined)).toEqual([]);
  });

  it.each([
    ["production", { ...approval, nonproduction: false }, /nonproduction must be true/],
    ["expired", { ...approval, expiresAt: new Date(Date.now() - 1000).toISOString() }, /expired/],
    ["a credential value", { ...approval, cloudflare: { ...approval.cloudflare, apiToken: "cf-secret-value" } }, /unsupported fields: apiToken/],
    ["a lowercase variable name", { ...approval, cloudflare: { ...approval.cloudflare, apiTokenEnv: "token value" } }, /apiTokenEnv is invalid/],
    ["a redirect off the relay host", { ...approval, oauth: { ...approval.oauth, redirectUri: "https://app.dev.example.test:8443/oauth/callback" } }, /relay host/],
    ["OAuth without a domain", { ...approval, domain: undefined }, /requires approval.domain/],
    ["a relative credentials file", { ...approval, cloudflare: { ...approval.cloudflare, credentialsFile: "tunnel.json" } }, /absolute path/],
  ])("refuses %s", (_name, value, error) => {
    expect(() => parseApproval(JSON.parse(JSON.stringify(value)))).toThrow(error);
  });
});

describe("prerequisite probes", () => {
  const environment = (overrides: Partial<ProbeEnvironment> = {}): ProbeEnvironment => ({
    platform: "linux", nodeVersion: "v22.12.0", env: { QUAL_GOOGLE_ID: "id", QUAL_GOOGLE_SECRET: "google-secret-value" }, devfnCli: "/devfn/cli.js", approval: parseApproval(approval), browserOperator: true,
    run: async () => ({ code: 0, stdout: "{\"ok\":true}" }), resolve: async () => ["127.0.0.1"], listening: async () => false, exists: async () => true, ...overrides,
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
  });

  it("names unset credential variables without reading values into results", async () => {
    const result = await status("google-oauth", { env: { QUAL_GOOGLE_ID: "id" } });
    expect(result).toMatchObject({ status: "missing", detail: "credential variables unset: QUAL_GOOGLE_SECRET" });
    const ready = await checkPrerequisites(environment(), ["google-oauth", "registered-domain", "browser-operator"]);
    expect(ready.map((item) => item.status)).toEqual(["satisfied", "satisfied", "satisfied"]);
    expect(JSON.stringify(ready)).not.toContain("google-secret-value");
    expect(await status("google-oauth", { platform: "darwin", approval: parseApproval({ ...approval, oauth: { ...approval.oauth, redirectUri: "https://auth.dev.example.test/oauth/callback" } }) }))
      .toMatchObject({ status: "missing", detail: expect.stringContaining("relay origin") });
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
  const receipt = (platform: string, scenarios = NETWORKING_MATRIX.map((item) => passed(item.id))): NetworkingQualificationReceipt => ({
    contract: "devfn.networking-qualification/v1", check: "networking-qualification-contract", target: "DEV-17", head: HEAD, runId: "abcdef123456",
    host: { platform, arch: "x64", release: "1", node: "v22.12.0" }, startedAt: "t", finishedAt: "t", prerequisites: [], scenarios,
    interface: { version: 1, resolver: "@devfn/core resolveEndpointTemplates", owner: "opaque string supplied by the caller; hostnames carry only o-<20 hex sha256 digest>", outputs: ["generated", "environment", "directUrls", "composeUrls", "nodes"] },
    limitations: [], summary: summarize(scenarios),
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
