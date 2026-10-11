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
    const route = (id: string, instanceId: string, hostname: string, targetPort: number) => ({ id, instanceId, hostname, targetHost: "127.0.0.1", targetPort, tls: "off", updatedAt: new Date().toISOString() });
    await writeFile(path.join(stateDir, "proxy-routes.json"), JSON.stringify({ version: 1, routes: [route(OAUTH_RELAY_ROUTE_ID, OAUTH_RELAY_OWNER_ID, "auth.localhost", 41001), route("dead:app", "dead", "dead.localhost", 41002)] }));
    const service = (owner: { pid: number; birthSignature: string }) => JSON.stringify({ version: 1, ...owner, startedAt: new Date().toISOString(), port: 41001,
      origin: "https://auth.dev.example.test", hostname: "auth.dev.example.test", domain: "dev.example.test", projectId: "fixture", repositoryIdentity: root });
    const routedOwners = async () => (JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8")) as { routes: Array<{ instanceId: string }> }).routes.map((item) => item.instanceId);
    await writeFile(path.join(stateDir, "oauth-relay", "service.json"), service(self));
    // The relay is not a registry lifecycle, but its live process keeps its route.
    expect(await recoverOrphanedProxyRoutes(stateDir)).toEqual(["dead"]);
    expect(await routedOwners()).toEqual([OAUTH_RELAY_OWNER_ID]);
    await writeFile(path.join(stateDir, "oauth-relay", "service.json"), service(await exitedProcess()));
    expect(await recoverOrphanedProxyRoutes(stateDir)).toEqual([OAUTH_RELAY_OWNER_ID]);
    expect(await routedOwners()).toEqual([]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
