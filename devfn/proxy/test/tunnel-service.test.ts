import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { processGroupStatus } from "@devfn/processes";
import { registerDomain } from "../src/domains.js";
import { publishTunnelRoutes, readTunnelBindings, readTunnelState, recoverTunnel, registerTunnelBinding, tunnelPaths, tunnelStatus, unregisterTunnelBinding, withdrawTunnelRoutes, type TunnelServiceOptions } from "../src/tunnel/index.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { FakeTunnelProvider, fixtureBinding, writeConnectorScript } from "./fixtures/tunnel.js";

const A = "web-a-0123456789abcdef0123.tunnel.example.test";
const B = "web-b-0123456789abcdef0123.tunnel.example.test";
const B2 = "api-b-0123456789abcdef0123.tunnel.example.test";
const A2 = "api-a-0123456789abcdef0123.tunnel.example.test";

let dir: string;
let provider: FakeTunnelProvider;
let options: TunnelServiceOptions;
let probed: string[];

const connectorHostnames = async (): Promise<string[]> => {
  const state = await readTunnelState(dir, "preview");
  return (JSON.parse(await readFile(tunnelPaths(dir, "preview").config(state.connector!.configDigest), "utf8")) as { hostnames: string[] }).hostnames;
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "devfn-tunnel-"));
  provider = new FakeTunnelProvider(await writeConnectorScript(dir));
  probed = [];
  await writeFile(path.join(dir, "credentials.json"), "{}", { mode: 0o600 });
  options = { stateDir: dir, binding: await registerTunnelBinding(dir, fixtureBinding(dir, path.join(dir, "credentials.json"))), provider, readyTimeoutMs: 5_000,
    originCa: async () => "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n", probeOrigin: async (hostname) => { probed.push(hostname); } };
});

afterEach(async () => {
  const state = await readTunnelState(dir, "preview").catch(() => undefined);
  for (const record of [state?.connector, ...(state?.retired ?? [])]) if (record) { try { process.kill(-record.pid, "SIGKILL"); } catch { /* gone */ } }
  await rm(dir, { recursive: true, force: true });
});

describe("tunnel bindings", () => {
  it("registers only nonproduction bindings with owner-only credential references outside loopback domains", async () => {
    dir = path.join(dir, "machine");
    await mkdir(dir);
    const credentials = path.join(dir, "credentials.json");
    const binding = fixtureBinding(dir, credentials);
    await writeFile(credentials, "{}", { mode: 0o644 });
    await expect(registerTunnelBinding(dir, binding)).rejects.toThrow("mode 0600");
    await chmod(credentials, 0o600);
    await expect(registerTunnelBinding(dir, { ...binding, nonproduction: false as unknown as true })).rejects.toThrow("nonproduction");
    await writeFile(path.join(dir, "domains.json"), JSON.stringify({ version: 1, domains: [{ domain: "example.test", projectId: "fixture", repositoryIdentity: dir, tls: "internal" }] }));
    await expect(registerTunnelBinding(dir, binding)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_IN_USE" });
    await rm(path.join(dir, "domains.json"));
    await registerTunnelBinding(dir, binding);
    expect(await readTunnelBindings(dir)).toEqual([{ ...binding, repositoryIdentity: await realpath(dir) }]);
    expect(await readFile(path.join(dir, "tunnels.json"), "utf8")).not.toContain("{}");
    // One tunnel has one DevFn connector and allowlist.
    await expect(registerTunnelBinding(dir, { ...binding, name: "second", domain: "second.example.test" })).rejects.toThrow("already bound");
    // A loopback domain may not later overlap a public binding domain either.
    const loopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as Parameters<typeof registerDomain>[2];
    await expect(registerDomain(dir, { domain: "local.tunnel.example.test", projectId: "fixture", repositoryIdentity: dir, tls: "internal" }, loopback))
      .rejects.toThrow("public tunnel binding");
  });

  it("publishes nothing on a binding unregistered after it was resolved", async () => {
    await unregisterTunnelBinding(dir, "preview", "fixture", dir);
    await expect(publishTunnelRoutes(options, "owner-a", [A])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNREGISTERED" });
    expect(provider.calls).toEqual([]);
  });
});

describe("tunnel lifecycle", () => {
  it("shares one connector between owners and withdraws one owner without touching another's routes", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    const first = (await readTunnelState(dir, "preview")).connector!;
    await publishTunnelRoutes(options, "owner-b", [B, B2]);
    const second = (await readTunnelState(dir, "preview")).connector!;
    // Make before break: a new connector serves the full allowlist, the old one is stopped.
    expect(second.pid).not.toBe(first.pid);
    expect(await processGroupStatus(first.pid, first.birthSignature)).toBe("exited");
    expect(await connectorHostnames()).toEqual([B2, A, B].sort());

    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual([A]);
    expect([...provider.records.keys()].sort()).toEqual([B2, B].sort());
    expect(await connectorHostnames()).toEqual([B2, B].sort());
    expect((await tunnelStatus(options)).hostnames).toEqual([{ hostname: B2, ownerId: "owner-b" }, { hostname: B, ownerId: "owner-b" }]);

    expect(await withdrawTunnelRoutes(options, "owner-b")).toEqual([B2, B].sort());
    const last = await readTunnelState(dir, "preview");
    expect(last).toMatchObject({ hostnames: [], retired: [] });
    expect(last.connector).toBeUndefined();
    expect(provider.records.size).toBe(0);
  });

  it("validates the origin and the provider tunnel before any provider mutation", async () => {
    options.probeOrigin = async () => { throw new Error("origin certificate does not verify"); };
    await expect(publishTunnelRoutes(options, "owner-a", [A])).rejects.toThrow("origin certificate");
    expect(provider.calls).toEqual([]);
    expect((await readTunnelState(dir, "preview")).pending).toBeUndefined();
    options.probeOrigin = async () => undefined;
    provider.tunnel = "remote";
    await expect(publishTunnelRoutes(options, "owner-a", [A])).rejects.toThrow("remotely managed");
    expect(provider.calls).toEqual(["tunnel preview"]);
  });

  it("refuses a foreign DNS record and a name outside the binding without changing anything", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    const before = (await readTunnelState(dir, "preview")).connector!;
    provider.records.set(B, "foreign");
    await expect(publishTunnelRoutes(options, "owner-b", [B])).rejects.toThrow("foreign record");
    expect(provider.records.get(B)).toBe("foreign");
    expect(provider.calls).not.toContain(`remove ${B}`);
    await expect(publishTunnelRoutes(options, "owner-b", ["web.other.example.test"])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_INVALID" });
    await expect(publishTunnelRoutes(options, "owner-b", [A])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_CONFLICT" });
    const after = await readTunnelState(dir, "preview");
    expect(after.connector).toEqual(before);
    expect(after.hostnames.map((item) => item.hostname)).toEqual([A]);
  });

  it("rolls back a partial provider failure to only the records it created", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    const before = (await readTunnelState(dir, "preview")).connector!;
    provider.failEnsure.add(B2);
    await expect(publishTunnelRoutes(options, "owner-b", [B, B2])).rejects.toThrow("provider failure");
    expect([...provider.records.keys()]).toEqual([A]);
    const after = await readTunnelState(dir, "preview");
    expect(after.pending).toBeUndefined();
    expect(after.connector).toEqual(before);
    expect(await processGroupStatus(before.pid, before.birthSignature)).toBe("running");
  });

  it("keeps the running connector when its replacement cannot start", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    const before = (await readTunnelState(dir, "preview")).connector!;
    provider.connector = "exit";
    await expect(publishTunnelRoutes(options, "owner-b", [B])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
    expect([...provider.records.keys()]).toEqual([A]);
    expect((await readTunnelState(dir, "preview")).connector).toEqual(before);
    expect(await processGroupStatus(before.pid, before.birthSignature)).toBe("running");
  });

  it("restarts an exited connector for the committed routes and rolls back an interrupted publish", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    const crashed = (await readTunnelState(dir, "preview")).connector!;
    process.kill(-crashed.pid, "SIGKILL");
    // An interrupted publish recorded a create for B before the process died.
    const state = await readTunnelState(dir, "preview");
    provider.records.set(B, "devfn");
    provider.records.set(B2, "foreign");
    state.pending = { kind: "publish", ownerId: "owner-b", hostnames: [B, B2], next: [], createdDns: [B, B2] };
    await writeTunnelState(dir, state);

    const status = await recoverTunnel(options);
    expect(status).toMatchObject({ connector: "running", pending: false, hostnames: [{ hostname: A, ownerId: "owner-a" }] });
    expect(status.pid).not.toBe(crashed.pid);
    expect(await connectorHostnames()).toEqual([A]);
    // Only the DevFn-owned record the interrupted publish created is gone.
    expect(Object.fromEntries(provider.records)).toEqual({ [A]: "devfn", [B2]: "foreign" });
  });

  it("removes public DNS on withdrawal even when no connector can serve the remaining routes", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    await publishTunnelRoutes(options, "owner-b", [B]);
    const before = (await readTunnelState(dir, "preview")).connector!;
    provider.connector = "exit";
    // The owner's exposure ended; the other owner's outage is not its failure.
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual([A]);
    expect([...provider.records.keys()]).toEqual([B]);
    // Nothing keeps serving the withdrawn name; the remaining owner is restored by recovery.
    expect(await processGroupStatus(before.pid, before.birthSignature)).toBe("exited");
    provider.connector = "ready";
    expect(await recoverTunnel(options)).toMatchObject({ connector: "running", hostnames: [{ hostname: B, ownerId: "owner-b" }] });
    expect(await connectorHostnames()).toEqual([B]);
  });

  it("keeps a DevFn-owned record it did not create and repairs a committed name's missing record", async () => {
    provider.records.set(B, "devfn");
    provider.connector = "exit";
    await expect(publishTunnelRoutes(options, "owner-b", [B])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
    expect(provider.records.get(B)).toBe("devfn");
    provider.connector = "ready";
    await publishTunnelRoutes(options, "owner-a", [A]);
    provider.records.delete(A);
    await publishTunnelRoutes(options, "owner-a", [A]);
    expect(provider.records.get(A)).toBe("devfn");
  });

  it("removes a dropped name's DNS only after the smaller set is committed, retrying a failed removal", async () => {
    await publishTunnelRoutes(options, "owner-a", [A, A2]);
    provider.failRemove.add(A2);
    expect(await publishTunnelRoutes(options, "owner-a", [A])).toEqual([expect.objectContaining({ hostname: A })]);
    expect(await connectorHostnames()).toEqual([A]);
    expect(await tunnelStatus(options)).toMatchObject({ pending: true, hostnames: [{ hostname: A, ownerId: "owner-a" }] });
    provider.failRemove.clear();
    expect(await recoverTunnel(options)).toMatchObject({ pending: false, connector: "running" });
    expect([...provider.records.keys()]).toEqual([A]);
  });

  it("withdraws without restarting the connector for the names it removes", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    process.kill(-(await readTunnelState(dir, "preview")).connector!.pid, "SIGKILL");
    provider.calls.length = 0;
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual([A]);
    expect(provider.calls).toEqual([`remove ${A}`]);
    expect((await readTunnelState(dir, "preview")).connector).toBeUndefined();
  });

  it("runs the connector with an explicit environment, only once its identity is journaled", async () => {
    process.env.TUNNEL_TOKEN = "ambient-tunnel-token";
    process.env.DEVFN_FIXTURE_TOKEN = "dns-api-token";
    try { await publishTunnelRoutes(options, "owner-a", [A]); }
    finally { delete process.env.TUNNEL_TOKEN; delete process.env.DEVFN_FIXTURE_TOKEN; }
    const envFile = path.join(tunnelPaths(dir, "preview").dir, "connector-env.json");
    const environment = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
    expect(environment.TUNNEL_TOKEN).toBeUndefined();
    expect(environment.DEVFN_FIXTURE_TOKEN).toBeUndefined();
    expect(environment.HOME).toBe(path.join(tunnelPaths(dir, "preview").dir, "home"));
    await rm(envFile);
    // The state write that journals the connector fails: it never runs.
    const stateFile = tunnelPaths(dir, "preview").state;
    const saved = await readFile(stateFile, "utf8");
    provider.beforeLaunch = async () => { await rm(stateFile); await mkdir(stateFile); await writeFile(path.join(stateFile, "blocker"), ""); };
    await expect(publishTunnelRoutes(options, "owner-b", [B])).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(access(envFile)).rejects.toThrow();
    await rm(stateFile, { recursive: true });
    await writeFile(stateFile, saved);
  });

  it("fails closed on malformed state and leaves it for inspection", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    const file = tunnelPaths(dir, "preview").state;
    const saved = await readFile(file, "utf8");
    await writeFile(file, saved.replace(/"ownerId": "owner-a"/, "\"ownerId\": 7"));
    await expect(publishTunnelRoutes(options, "owner-b", [B])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_STATE_INVALID" });
    expect(await readFile(file, "utf8")).not.toBe(saved);
    expect(provider.calls.filter((call) => call.includes(B))).toEqual([]);
    await writeFile(file, saved);
  });
});
