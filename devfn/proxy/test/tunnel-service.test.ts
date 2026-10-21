import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { processGroupStatus } from "@devfn/processes";
import { publishTunnelRoutes, readTunnelBindings, readTunnelState, recoverTunnel, registerTunnelBinding, tunnelPaths, tunnelStatus, withdrawTunnelRoutes, type TunnelServiceOptions } from "../src/tunnel/index.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { FakeTunnelProvider, fixtureBinding, writeConnectorScript } from "./fixtures/tunnel.js";

const A = "web-a-0123456789abcdef0123.tunnel.example.test";
const B = "web-b-0123456789abcdef0123.tunnel.example.test";
const B2 = "api-b-0123456789abcdef0123.tunnel.example.test";

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
  options = { stateDir: dir, binding: fixtureBinding(dir, path.join(dir, "credentials.json")), provider, readyTimeoutMs: 5_000,
    originCa: async () => "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n", probeOrigin: async (hostname) => { probed.push(hostname); } };
});

afterEach(async () => {
  const state = await readTunnelState(dir, "preview").catch(() => undefined);
  for (const record of [state?.connector, ...(state?.retired ?? [])]) if (record) { try { process.kill(-record.pid, "SIGKILL"); } catch { /* gone */ } }
  await rm(dir, { recursive: true, force: true });
});

describe("tunnel bindings", () => {
  it("registers only nonproduction bindings with owner-only credential references outside loopback domains", async () => {
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

  it("validates the origin before any provider mutation", async () => {
    options.probeOrigin = async () => { throw new Error("origin certificate does not verify"); };
    await expect(publishTunnelRoutes(options, "owner-a", [A])).rejects.toThrow("origin certificate");
    expect(provider.calls).toEqual([]);
    expect((await readTunnelState(dir, "preview")).pending).toBeUndefined();
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
    await expect(withdrawTunnelRoutes(options, "owner-a")).rejects.toThrow(`Public DNS for ${A} is removed`);
    expect([...provider.records.keys()]).toEqual([B]);
    // Nothing keeps serving the withdrawn name; the remaining owner is restored by recovery.
    expect(await processGroupStatus(before.pid, before.birthSignature)).toBe("exited");
    provider.connector = "ready";
    expect(await recoverTunnel(options)).toMatchObject({ connector: "running", hostnames: [{ hostname: B, ownerId: "owner-b" }] });
    expect(await connectorHostnames()).toEqual([B]);
  });

  it("fails closed on malformed state and leaves it for inspection", async () => {
    await writeFile(path.join(dir, "credentials.json"), "{}");
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
