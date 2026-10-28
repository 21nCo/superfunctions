import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("@devfn/proxy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devfn/proxy")>();
  return {
    ...actual,
    // The command stub stands in for a Caddy that holds its listeners and serves what it is given.
    CaddyProxyController: class extends actual.CaddyProxyController {
      constructor(stateDir: string) { super(stateDir, undefined, undefined, async () => true, async () => true); }
      // Physical owner and listener preflight is covered by the proxy suites.
      override async assertActivationReady(): Promise<void> {}
    },
  };
});

import { validateDevFnConfig } from "@devfn/config";
import { processBirthSignature } from "@devfn/processes";
import { consumeOAuthRelayCallback, OAuthRelayClient } from "@devfn/proxy/oauth-relay";
import { DevFnOrchestrator } from "../src/index.js";

const CADDY_STUB = "#!/bin/sh\ncase \"$1\" in version|validate|reload) exit 0;; esac\nexit 1\n";
const RELAY_ORIGIN = "https://auth.dev.example.test";
// The process records the DevFn values a default OAuthRelayClient reads, then serves its route.
const SERVER = "import { writeFileSync } from 'node:fs'; import { createServer } from 'node:http'; " +
  "const { DEVFN_STATE_DIR, DEVFN_INSTANCE_ID } = process.env; " +
  "writeFileSync(new URL('env.json', import.meta.url), JSON.stringify({ DEVFN_STATE_DIR, DEVFN_INSTANCE_ID })); " +
  "createServer((_request, response) => response.end('ready')).listen(Number(process.env.DEVFN_PORT_APP), '127.0.0.1');\n";

it("binds a state for a lifecycle devfn up started, from its own environment and registry evidence, and refuses it once the lifecycle is down", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devfn-relay-owner-"));
  const stateDir = path.join(root, "state");
  const toolsDir = path.join(root, "tools");
  const originalPath = process.env.PATH;
  const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, ports: { app: {} },
    processes: { app: { adapter: "command", command: [process.execPath, "server.mjs"], ports: ["app"], health: { type: "http", port: "app", timeoutMs: 20_000 } } },
    profiles: { default: { processes: ["app"], proxy: true } }, hostnames: { app: { target: "app" } } });
  const orchestrator = new DevFnOrchestrator();
  try {
    await Promise.all([mkdir(path.join(stateDir, "oauth-relay"), { recursive: true }), mkdir(toolsDir)]);
    await writeFile(path.join(root, "server.mjs"), SERVER);
    await writeFile(path.join(toolsDir, "caddy"), CADDY_STUB, { mode: 0o700 });
    process.env.PATH = `${toolsDir}${path.delimiter}${originalPath ?? ""}`;
    const self = { pid: process.pid, birthSignature: (await processBirthSignature(process.pid))! };
    await writeFile(path.join(stateDir, "proxy-owner.json"), JSON.stringify(self));
    // The relay is this process, recorded as `devfn oauth-relay start` records it.
    await writeFile(path.join(stateDir, "oauth-relay", "service.json"), JSON.stringify({ version: 1, ...self, startedAt: new Date().toISOString(), port: 41001,
      origin: RELAY_ORIGIN, hostname: "auth.dev.example.test", domain: "dev.example.test", projectId: "fixture", repositoryIdentity: root, invocationId: "relay" }));
    const started = await orchestrator.up({ config, root, stateDir });
    expect(started.state).toBe("ready");
    const env = JSON.parse(await readFile(path.join(root, "env.json"), "utf8")) as NodeJS.ProcessEnv;
    const { routes } = JSON.parse(await readFile(path.join(stateDir, "proxy-routes.json"), "utf8")) as { routes: Array<{ instanceId: string; hostname: string; tls: string }> };
    const route = routes.find((item) => item.instanceId === env.DEVFN_INSTANCE_ID)!;
    const callbackUrl = `${new URL(started.urls.app).origin}/oauth/callback`;
    expect(new URL(callbackUrl).hostname).toBe(route.hostname);
    // Nothing but the launched process's environment: owner, state directory and registry owner evidence are DevFn's defaults.
    const client = new OAuthRelayClient({ env });
    const callback = (state: string) => ({ origin: RELAY_ORIGIN, requestOrigin: RELAY_ORIGIN, requestPath: "/oauth/callback", rawQuery: `code=c0de&state=${state}` });
    await expect(client.authorize({ state: "st_live_xxxxxxxxxxxxxxxxxxxxxxxx", callbackUrl })).resolves.toMatchObject({ redirectUri: `${RELAY_ORIGIN}/oauth/callback` });
    await expect(consumeOAuthRelayCallback(env.DEVFN_STATE_DIR!, callback("st_live_xxxxxxxxxxxxxxxxxxxxxxxx")))
      .resolves.toEqual({ location: `${callbackUrl}?code=c0de&state=st_live_xxxxxxxxxxxxxxxxxxxxxxxx` });
    await client.authorize({ state: "st_down_xxxxxxxxxxxxxxxxxxxxxxxx", callbackUrl });
    await orchestrator.down({ config, root, stateDir });
    await expect(consumeOAuthRelayCallback(env.DEVFN_STATE_DIR!, callback("st_down_xxxxxxxxxxxxxxxxxxxxxxxx"))).rejects.toMatchObject({ reason: "route-stopped" });
    await expect(client.authorize({ state: "st_after_xxxxxxxxxxxxxxxxxxxxxxx", callbackUrl })).rejects.toMatchObject({ reason: "target-invalid" });
  } finally {
    await orchestrator.down({ config, root, stateDir }).catch(() => undefined);
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
