import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("@devfn/proxy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devfn/proxy")>();
  return {
    ...actual,
    // The command stub stands in for a Caddy that serves what it is given.
    CaddyProxyController: class extends actual.CaddyProxyController {
      constructor(stateDir: string) { super(stateDir, undefined, undefined, async () => true, async () => true); }
    },
  };
});

import { FilePortRegistry, withFileLock } from "@devfn/ports";
import { processBirthSignature } from "@devfn/processes";
import { OAUTH_RELAY_OWNER_ID, OAUTH_RELAY_ROUTE_ID } from "@devfn/proxy/oauth-relay";
import { recoverOrphanedProxyRoutes } from "../src/index.js";

const CADDY_STUB = "#!/bin/sh\ncase \"$1\" in version|validate|reload) exit 0;; esac\nexit 1\n";

async function exitedProcess(): Promise<{ pid: number; birthSignature: string }> {
  const child = execFile(process.execPath, ["-e", "setTimeout(() => undefined, 200)"]);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const birthSignature = await processBirthSignature(child.pid!);
  await exited;
  return { pid: child.pid!, birthSignature: birthSignature ?? "gone" };
}

it("keeps the OAuth relay route while its recorded process runs and recovers it, alone, once that process is gone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devfn-relay-recovery-"));
  const stateDir = path.join(root, "state");
  const toolsDir = path.join(root, "tools");
  const originalPath = process.env.PATH;
  try {
    await Promise.all([mkdir(path.join(stateDir, "oauth-relay"), { recursive: true }), mkdir(toolsDir)]);
    await writeFile(path.join(toolsDir, "caddy"), CADDY_STUB, { mode: 0o700 });
    process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
    const self = { pid: process.pid, birthSignature: (await processBirthSignature(process.pid))! };
    await writeFile(path.join(stateDir, "proxy-owner.json"), JSON.stringify(self));
    const route = (id: string, instanceId: string, hostname: string, targetPort: number, serviceProcess?: { pid: number; birthSignature: string }) => ({
      id, instanceId, hostname, targetHost: "127.0.0.1", targetPort, tls: "off", updatedAt: new Date().toISOString(), ...(serviceProcess ? { serviceProcess } : {}) });
    const relayRoute = (owner: { pid: number; birthSignature: string }) => route(OAUTH_RELAY_ROUTE_ID, OAUTH_RELAY_OWNER_ID, "auth.localhost", 41001, owner);
    await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [relayRoute(self), route("dead:app", "dead", "dead.localhost", 41002)] }));
    const service = (owner: { pid: number; birthSignature: string }) => JSON.stringify({ version: 1, ...owner, startedAt: new Date().toISOString(), port: 41001,
      origin: "https://auth.localhost", hostname: "auth.localhost", domain: "localhost", projectId: "fixture", repositoryIdentity: root, invocationId: "relay" });
    const routedOwners = async () => (JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8")) as { routes: Array<{ instanceId: string }> }).routes.map((item) => item.instanceId);
    await writeFile(path.join(stateDir, "oauth-relay", "service.json"), service(self));
    // The relay is not a registry lifecycle, but its live process keeps the route that reaches it.
    expect(await recoverOrphanedProxyRoutes(stateDir)).toEqual(["dead"]);
    expect(await routedOwners()).toEqual([OAUTH_RELAY_OWNER_ID]);
    const dead = await exitedProcess();
    await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [relayRoute(dead)] }));
    await writeFile(path.join(stateDir, "oauth-relay", "service.json"), service(dead));
    expect(await recoverOrphanedProxyRoutes(stateDir)).toEqual([OAUTH_RELAY_OWNER_ID]);
    expect(await routedOwners()).toEqual([]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("skips a relay whose command holds its lock, and ends a dead relay's claim after its route is gone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devfn-relay-gc-"));
  const stateDir = path.join(root, "state");
  const toolsDir = path.join(root, "tools");
  const originalPath = process.env.PATH;
  try {
    await Promise.all([mkdir(path.join(stateDir, "oauth-relay"), { recursive: true }), mkdir(toolsDir)]);
    await writeFile(path.join(toolsDir, "caddy"), CADDY_STUB, { mode: 0o700 });
    process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
    const self = { pid: process.pid, birthSignature: (await processBirthSignature(process.pid))! };
    await writeFile(path.join(stateDir, "proxy-owner.json"), JSON.stringify(self));
    const dead = await exitedProcess();
    const route = (id: string, instanceId: string, hostname: string, targetPort: number) => ({ id, instanceId, hostname, targetHost: "127.0.0.1", targetPort, tls: "off", updatedAt: new Date().toISOString() });
    await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [route(OAUTH_RELAY_ROUTE_ID, OAUTH_RELAY_OWNER_ID, "auth.localhost", 41001), route("dead:app", "dead", "dead.localhost", 41002)] }));
    await writeFile(path.join(stateDir, "oauth-relay", "service.json"), JSON.stringify({ version: 1, ...dead, startedAt: new Date().toISOString(), port: 41001,
      origin: "https://auth.dev.example.test", hostname: "auth.dev.example.test", domain: "dev.example.test", projectId: "fixture", repositoryIdentity: root, invocationId: "relay" }));
    const routedOwners = async () => (JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8")) as { routes: Array<{ instanceId: string }> }).routes.map((item) => item.instanceId);
    // A relay command holds the relay's lock: gc skips the relay and still recovers other owners.
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const holder = withFileLock(path.join(stateDir, "oauth-relay", "service.lock"), async () => { held(); await new Promise<void>((resolve) => { release = resolve; }); });
    await holding;
    try {
      expect(await recoverOrphanedProxyRoutes(stateDir)).toEqual(["dead"]);
    } finally { release(); await holder; }
    expect(await routedOwners()).toEqual([OAUTH_RELAY_OWNER_ID]);
    // A route transition already dropped the dead relay's route; gc still ends its claim and record.
    await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [] }));
    const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
    await registry.reserve({ projectId: "fixture", instanceId: OAUTH_RELAY_OWNER_ID, invocationId: "relay", profile: "oauth-relay", requests: [], proxyListenerPorts: [18080, 18443] });
    await registry.recordOwners("relay", "oauth-relay", [{ process: dead }]);
    await registry.markActive("relay");
    expect(await recoverOrphanedProxyRoutes(stateDir)).toEqual([]);
    expect((await registry.read()).invocations.find((item) => item.id === "relay")).toMatchObject({ state: "stopped" });
    await expect(readFile(path.join(stateDir, "oauth-relay", "service.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
