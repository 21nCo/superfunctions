import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { processGroupStatus } from "@devfn/processes";
import { registerDomain } from "../src/domains.js";
import { publishTunnelRoutes, readOwnerBindings, readTunnelBindings, readTunnelState, recoverTunnel, registerTunnelBinding, tunnelPaths, tunnelStatus, unregisterTunnelBinding, withdrawTunnelRoutes, type TunnelServiceOptions } from "../src/tunnel/index.js";
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

// Connector stand-ins are stopped and crashed through their POSIX process groups.
const posixIt = it.skipIf(process.platform === "win32");

/** Rewrite the state as if owner-b's publish of names had been interrupted after its connector, routing them, was recorded and before the commit. */
const interruptPublish = async (names: string[], createdDns: string[]) => {
  const state = await readTunnelState(dir, "preview");
  state.pending = { kind: "publish", ownerId: "owner-b", hostnames: [...names].sort(), next: state.hostnames, createdDns };
  state.hostnames = state.hostnames.filter((item) => item.ownerId !== "owner-b");
  await writeTunnelState(dir, state);
  return state.connector!;
};

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

    expect(await readOwnerBindings(dir, "owner-a")).toEqual(["preview"]);
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [A], outstanding: [] });
    expect(await readOwnerBindings(dir, "owner-a")).toEqual([]);
    expect([...provider.records.keys()].sort()).toEqual([B2, B].sort());
    expect(await connectorHostnames()).toEqual([B2, B].sort());
    expect((await tunnelStatus(options)).hostnames).toEqual([{ hostname: B2, ownerId: "owner-b" }, { hostname: B, ownerId: "owner-b" }]);

    expect(await withdrawTunnelRoutes(options, "owner-b")).toEqual({ withdrawn: [B2, B].sort(), outstanding: [] });
    const last = await readTunnelState(dir, "preview");
    expect(last).toMatchObject({ hostnames: [], retired: [], residue: [] });
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

  posixIt("restarts an exited connector for a live owner's routes once the tunnel is verified and rolls back an interrupted publish", async () => {
    options.ownerMayRun = async (ownerId) => ownerId === "owner-a";
    await publishTunnelRoutes(options, "owner-a", [A]);
    const crashed = (await readTunnelState(dir, "preview")).connector!;
    process.kill(-crashed.pid, "SIGKILL");
    // An interrupted publish recorded a create for B before the process died.
    const state = await readTunnelState(dir, "preview");
    provider.records.set(B, "devfn");
    provider.records.set(B2, "foreign");
    state.pending = { kind: "publish", ownerId: "owner-b", hostnames: [B, B2], next: [], createdDns: [B, B2] };
    await writeTunnelState(dir, state);

    probed.length = 0;
    provider.calls.length = 0;
    const status = await recoverTunnel(options);
    expect(status).toMatchObject({ connector: "running", pending: false, hostnames: [{ hostname: A, ownerId: "owner-a" }] });
    expect(probed).toEqual([A]);
    expect(provider.calls.filter((call) => call === "tunnel preview" || call === "launch")).toEqual(["tunnel preview", "launch"]);
    expect(status.pid).not.toBe(crashed.pid);
    expect(await connectorHostnames()).toEqual([A]);
    // Only the DevFn-owned record the interrupted publish created is gone.
    expect(Object.fromEntries(provider.records)).toEqual({ [A]: "devfn", [B2]: "foreign" });
  });

  it("withdraws without reducing another owner's service when the connector replacement fails", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    await publishTunnelRoutes(options, "owner-b", [B]);
    const before = (await readTunnelState(dir, "preview")).connector!;
    provider.connector = "exit";
    // DNS removal ended the owner's exposure; the running connector keeps serving the other owner.
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [A], outstanding: [`${A}: a connector that may route them has not stopped`, expect.stringContaining("kept for the other public routes")] });
    expect([...provider.records.keys()]).toEqual([B]);
    expect((await readTunnelState(dir, "preview")).connector).toEqual(before);
    expect(await processGroupStatus(before.pid, before.birthSignature)).toBe("running");
    expect((await tunnelStatus(options)).outstanding).toEqual([{ ownerId: "owner-a", detail: `${A}: a connector that may route them has not stopped` }]);
    // The stale connector is replaced by the next transition with public consent.
    provider.connector = "ready";
    expect(await recoverTunnel(options)).toMatchObject({ connector: "running", hostnames: [{ hostname: B, ownerId: "owner-b" }], outstanding: [] });
    expect(await connectorHostnames()).toEqual([B]);
    expect(await processGroupStatus(before.pid, before.birthSignature)).toBe("exited");
  });

  posixIt("launches nothing for committed routes whose tunnel or origin does not verify", async () => {
    options.ownerMayRun = async () => true;
    await publishTunnelRoutes(options, "owner-a", [A]);
    const crashed = (await readTunnelState(dir, "preview")).connector!;
    process.kill(-crashed.pid, "SIGKILL");
    provider.tunnel = "remote";
    provider.calls.length = 0;
    probed.length = 0;
    // The binding is verified before any launch, after the origins are probed.
    await expect(publishTunnelRoutes(options, "owner-b", [B])).rejects.toThrow("remotely managed");
    expect(probed).toEqual([B, A]);
    await expect(recoverTunnel(options)).rejects.toThrow("remotely managed");
    expect(provider.calls).not.toContain("launch");
    expect((await readTunnelState(dir, "preview")).connector).toEqual(crashed);
    // An origin that no longer verifies is withdrawn, not made public again.
    provider.tunnel = "local";
    options.probeOrigin = async () => { throw new Error("origin certificate does not verify"); };
    expect(await recoverTunnel(options)).toMatchObject({ connector: "stopped", hostnames: [], outstanding: [] });
    expect(provider.calls).not.toContain("launch");
    expect(provider.records.size).toBe(0);
  });

  posixIt("withdraws a dead owner's routes instead of relaunching them for another owner's publish", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    await publishTunnelRoutes(options, "owner-b", [B]);
    process.kill(-(await readTunnelState(dir, "preview")).connector!.pid, "SIGKILL");
    await publishTunnelRoutes(options, "owner-a", [A]);
    expect(await connectorHostnames()).toEqual([A]);
    expect([...provider.records.keys()]).toEqual([A]);
    expect(await tunnelStatus(options)).toMatchObject({ connector: "running", hostnames: [{ hostname: A, ownerId: "owner-a" }], outstanding: [] });
    // The dead owner's own withdrawal then finds nothing outstanding and clears its marker.
    expect(await readOwnerBindings(dir, "owner-b")).toEqual(["preview"]);
    expect(await withdrawTunnelRoutes(options, "owner-b")).toEqual({ withdrawn: [], outstanding: [] });
    expect(await readOwnerBindings(dir, "owner-b")).toEqual([]);
  });

  it("keeps another owner's routes that the running connector serves when it is replaced", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    await publishTunnelRoutes(options, "owner-b", [B]);
    const before = (await readTunnelState(dir, "preview")).connector!;
    await publishTunnelRoutes(options, "owner-a", [A, A2]);
    expect(await connectorHostnames()).toEqual([A2, A, B].sort());
    expect(await processGroupStatus(before.pid, before.birthSignature)).toBe("exited");
    expect([...provider.records.keys()].sort()).toEqual([A2, A, B].sort());
  });

  posixIt("starts no connector during a withdrawal when the recorded one exited", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    await publishTunnelRoutes(options, "owner-b", [B]);
    process.kill(-(await readTunnelState(dir, "preview")).connector!.pid, "SIGKILL");
    provider.calls.length = 0;
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [A], outstanding: [] });
    expect(provider.calls).toEqual([`remove ${A}`]);
    expect((await readTunnelState(dir, "preview")).connector).toBeUndefined();
    expect([...provider.records.keys()]).toEqual([B]);
  });

  it("fails a withdrawal while both DNS removal and the connector change fail, keeping it journaled for retry", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    await publishTunnelRoutes(options, "owner-b", [B]);
    provider.failRemove.add(A);
    provider.connector = "exit";
    await expect(withdrawTunnelRoutes(options, "owner-a")).rejects.toThrow("public DNS removal is not confirmed and a connector that may route them has not stopped");
    expect((await readTunnelState(dir, "preview")).residue).toEqual([{ ownerId: "owner-a", hostnames: [A], dnsRemoved: false }]);
    expect(await readOwnerBindings(dir, "owner-a")).toEqual(["preview"]);
    provider.failRemove.clear();
    provider.connector = "ready";
    // The owner publishes nothing any more, but its journaled withdrawal is found and finished.
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [], outstanding: [] });
    expect([...provider.records.keys()]).toEqual([B]);
    expect(await connectorHostnames()).toEqual([B]);
    expect(await readOwnerBindings(dir, "owner-a")).toEqual([]);
  });

  it("ends exposure once the connector stopped although DNS removal keeps failing, reporting it until it is removed", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    const connector = (await readTunnelState(dir, "preview")).connector!;
    provider.failRemove.add(A);
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [A], outstanding: [`${A}: public DNS removal is not confirmed`, `provider failure removing ${A}`] });
    expect(await processGroupStatus(connector.pid, connector.birthSignature)).toBe("exited");
    expect((await withdrawTunnelRoutes(options, "owner-a")).outstanding).toHaveLength(2);
    await expect(unregisterTunnelBinding(dir, "preview", "fixture", dir)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_IN_USE" });
    provider.failRemove.clear();
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [], outstanding: [] });
    expect(provider.records.size).toBe(0);
    expect(await readOwnerBindings(dir, "owner-a")).toEqual([]);
  });

  posixIt("reports and retries a withdrawn owner's connector that cannot be verified stopped", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    const connector = (await readTunnelState(dir, "preview")).connector!;
    // The wrapper that leads the group is gone; its connector child remains, so the group is unverifiable.
    process.kill(connector.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [A], outstanding: [`${A}: a connector that may route them has not stopped`] });
    expect(provider.records.size).toBe(0);
    expect((await withdrawTunnelRoutes(options, "owner-a")).outstanding).toHaveLength(1);
    expect(await readOwnerBindings(dir, "owner-a")).toEqual(["preview"]);
    process.kill(-connector.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [], outstanding: [] });
    expect(await readOwnerBindings(dir, "owner-a")).toEqual([]);
  });

  it("keeps an interrupted publish's routed name journaled until no connector routes it, keeping the record it did not create", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    provider.records.set(B, "devfn");
    await publishTunnelRoutes(options, "owner-b", [B]);
    const routing = await interruptPublish([B], []);
    provider.connector = "exit";
    await expect(withdrawTunnelRoutes(options, "owner-b")).rejects.toThrow(`${B}: a connector that may route them has not stopped`);
    expect(await readOwnerBindings(dir, "owner-b")).toEqual(["preview"]);
    expect((await readTunnelState(dir, "preview")).connector).toEqual(routing);
    expect(await processGroupStatus(routing.pid, routing.birthSignature)).toBe("running");
    expect((await tunnelStatus(options)).outstanding).toEqual([{ ownerId: "owner-b", detail: `${B}: a connector that may route them has not stopped` }]);
    provider.connector = "ready";
    expect(await withdrawTunnelRoutes(options, "owner-b")).toEqual({ withdrawn: [], outstanding: [] });
    expect(await connectorHostnames()).toEqual([A]);
    expect(await processGroupStatus(routing.pid, routing.birthSignature)).toBe("exited");
    expect(await readOwnerBindings(dir, "owner-b")).toEqual([]);
    // The record the publish found is kept, and owner A keeps its record and service.
    expect(Object.fromEntries(provider.records)).toEqual({ [A]: "devfn", [B]: "devfn" });
    expect(await tunnelStatus(options)).toMatchObject({ connector: "running", hostnames: [{ hostname: A, ownerId: "owner-a" }], outstanding: [] });
  });

  it("journals an interrupted publish's created and routed names alike, removing only the record it created", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    provider.records.set(B, "devfn");
    await publishTunnelRoutes(options, "owner-b", [B, B2]);
    const routing = await interruptPublish([B, B2], [B2]);
    provider.connector = "exit";
    // B2's DNS removal is confirmed, but B stays routable through the running connector.
    await expect(withdrawTunnelRoutes(options, "owner-b")).rejects.toThrow(`${B}: a connector that may route them has not stopped`);
    expect(Object.fromEntries(provider.records)).toEqual({ [A]: "devfn", [B]: "devfn" });
    expect(await processGroupStatus(routing.pid, routing.birthSignature)).toBe("running");
    expect(await readOwnerBindings(dir, "owner-b")).toEqual(["preview"]);
    provider.connector = "ready";
    expect(await withdrawTunnelRoutes(options, "owner-b")).toEqual({ withdrawn: [], outstanding: [] });
    expect(await connectorHostnames()).toEqual([A]);
    expect(await readOwnerBindings(dir, "owner-b")).toEqual([]);
  });

  it("rolls back an interrupted publish whose connector was ready by evicting its names, journaling them while that fails", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    provider.records.set(B, "devfn");
    await publishTunnelRoutes(options, "owner-b", [B]);
    const routing = await interruptPublish([B], []);
    provider.connector = "exit";
    await expect(recoverTunnel(options)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
    expect((await tunnelStatus(options)).outstanding).toEqual([{ ownerId: "owner-b", detail: `${B}: a connector that may route them has not stopped` }]);
    expect(await processGroupStatus(routing.pid, routing.birthSignature)).toBe("running");
    provider.connector = "ready";
    expect(await recoverTunnel(options)).toMatchObject({ connector: "running", hostnames: [{ hostname: A, ownerId: "owner-a" }], outstanding: [] });
    expect(await connectorHostnames()).toEqual([A]);
    expect(await processGroupStatus(routing.pid, routing.birthSignature)).toBe("exited");
    expect(await withdrawTunnelRoutes(options, "owner-b")).toEqual({ withdrawn: [], outstanding: [] });
    expect(await readOwnerBindings(dir, "owner-b")).toEqual([]);
  });

  it("keeps a healthy retired connector serving committed names when an interrupted swap's new connector exited", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    await publishTunnelRoutes(options, "owner-b", [B]);
    const interrupted = (await readTunnelState(dir, "preview")).connector!;
    await withdrawTunnelRoutes(options, "owner-b");
    // owner-b republished B: the swap recorded its new connector and retired A's before stopping it, then the new one exited.
    const state = await readTunnelState(dir, "preview");
    const fallback = state.connector!;
    expect(await processGroupStatus(interrupted.pid, interrupted.birthSignature)).not.toBe("running");
    state.pending = { kind: "publish", ownerId: "owner-b", hostnames: [B], next: [...state.hostnames, { hostname: B, ownerId: "owner-b", publishedAt: "now" }], createdDns: [B] };
    state.connector = interrupted;
    state.retired = [fallback];
    await writeTunnelState(dir, state);
    provider.records.set(B, "devfn");
    expect(await withdrawTunnelRoutes(options, "owner-b")).toEqual({ withdrawn: [], outstanding: [] });
    expect(await processGroupStatus(fallback.pid, fallback.birthSignature)).toBe("running");
    expect(await readTunnelState(dir, "preview")).toMatchObject({ connector: fallback, retired: [], residue: [] });
    expect(Object.fromEntries(provider.records)).toEqual({ [A]: "devfn" });
  });

  it("never journals, and so never rolls back, a DevFn-owned record that existed before the publish", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    // A failed read aborts before anything is journaled.
    provider.records.set(B, "devfn");
    provider.failRead.add(B);
    await expect(publishTunnelRoutes(options, "owner-b", [B])).rejects.toThrow("provider failure reading");
    provider.failRead.clear();
    // A record that appears between the read and the create is reported "existing" and not journaled.
    provider.unseen.add(B);
    provider.connector = "exit";
    await expect(publishTunnelRoutes(options, "owner-b", [B])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
    // An owned record that does not verify fails the publish without being journaled.
    provider.connector = "ready";
    provider.records.set(B2, "unproxied");
    await expect(publishTunnelRoutes(options, "owner-b", [B2])).rejects.toThrow(`no DevFn record for ${B2}`);
    expect(Object.fromEntries(provider.records)).toEqual({ [A]: "devfn", [B]: "devfn", [B2]: "unproxied" });
    expect(provider.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect((await readTunnelState(dir, "preview")).residue).toEqual([]);
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
    expect(await tunnelStatus(options)).toMatchObject({ outstanding: [{ ownerId: "owner-a", detail: `${A2}: public DNS removal is not confirmed` }], hostnames: [{ hostname: A, ownerId: "owner-a" }] });
    provider.failRemove.clear();
    expect(await recoverTunnel(options)).toMatchObject({ outstanding: [], connector: "running" });
    expect([...provider.records.keys()]).toEqual([A]);
  });

  posixIt("withdraws without restarting the connector for the names it removes", async () => {
    await publishTunnelRoutes(options, "owner-a", [A]);
    process.kill(-(await readTunnelState(dir, "preview")).connector!.pid, "SIGKILL");
    provider.calls.length = 0;
    expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [A], outstanding: [] });
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
    // A connector identity in a known format that is not its canonical rendering could never be verified stopped.
    const state = JSON.parse(saved) as { connector: { birthSignature: string; pid: number } };
    const live = state.connector;
    await writeFile(file, JSON.stringify({ ...state, connector: { ...live, birthSignature: "linux:0042" } }));
    await expect(withdrawTunnelRoutes(options, "owner-a")).rejects.toMatchObject({ code: "DEVFN_TUNNEL_STATE_INVALID" });
    expect(await processGroupStatus(live.pid, live.birthSignature)).toBe("running");
    await writeFile(file, saved);
  });
});
