import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NgrokTunnelProvider, createOriginBridge, ngrokMarker, parseTunnelBinding, publishTunnelRoutes, readTunnelState, recoverTunnel, registerTunnelBinding, renderNgrokAgentConfig,
  tunnelPaths, tunnelStatus, urlTiming, withdrawTunnelRoutes, type NgrokConnectorConfig, type TunnelServiceOptions,
} from "../src/tunnel/index.js";
import { ngrokFixtureBinding, writeFakeNgrok } from "./fixtures/tunnel.js";

const DOMAIN = "ngrok.example.test";
const A = `web-a-0123456789abcdef0123.${DOMAIN}`;
const B = `web-b-0123456789abcdef0123.${DOMAIN}`;
const SECRETS = { DEVFN_FIXTURE_NGROK_AUTHTOKEN: "fixture-authtoken-value", DEVFN_FIXTURE_NGROK_API_KEY: "fixture-api-key-value" };
// The connector entry runs from source through tsx; the package build runs dist/tunnel/ngrok-connector.js.
const CONNECTOR = [process.execPath, "--import", createRequire(import.meta.url).resolve("tsx"), fileURLToPath(new URL("../src/tunnel/ngrok-connector.ts", import.meta.url))];
const posixIt = it.skipIf(process.platform === "win32");

let dir: string;
beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-ngrok-"))); });
afterEach(async () => {
  for (const name of ["share", "eph"]) {
    const state = await readTunnelState(path.join(dir, "state"), name).catch(() => undefined);
    for (const record of [state?.connector, ...(state?.retired ?? [])]) if (record) { try { process.kill(-record.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  await rm(dir, { recursive: true, force: true });
});

/** A fixture ngrok API: reserved domains and online tunnels, each listed one item per page; every request URL is logged. */
function account(state: { reserved: string[]; tunnels: Array<{ public_url: string; metadata?: string }>; fail?: number }) {
  const requests: string[] = [];
  const page = (items: unknown[], key: string, offset: number, route: string) => new Response(JSON.stringify({
    [key]: items.slice(offset, offset + 1), next_page_uri: offset + 1 < items.length ? `https://api.ngrok.com${route}?limit=100&offset=${offset + 1}` : null }), { status: 200 });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${url.origin}${url.pathname}${url.search} ${new Headers(init?.headers).get("authorization") ?? ""}`);
    if (state.fail) return new Response(JSON.stringify({ error_code: "ERR_NGROK_218", msg: `echo ${SECRETS.DEVFN_FIXTURE_NGROK_API_KEY}` }), { status: state.fail });
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (url.pathname === "/reserved_domains") return page(state.reserved.map((domain) => ({ domain })), "reserved_domains", offset, url.pathname);
    if (url.pathname === "/tunnels") return page(state.tunnels, "tunnels", offset, url.pathname);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { requests, fetcher };
}

/** A self-signed certificate for names, which is also its own verifying root. */
function issue(names: string[], name: string): { cert: string; key: string } {
  const cert = path.join(dir, `${name}.pem`), key = path.join(dir, `${name}.key`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${name}`,
    "-addext", `subjectAltName=${names.map((item) => `DNS:${item}`).join(",")}`], { stdio: "ignore" });
  return { cert: execFileSync("cat", [cert], { encoding: "utf8" }), key: execFileSync("cat", [key], { encoding: "utf8" }) };
}

/** A TLS origin standing in for the DevFn public origin: it reports the Host and TLS server name each request arrived with. */
async function origin(credentials: { cert: string; key: string }) {
  const seen: Array<{ host?: string; servername?: string; connection?: string }> = [];
  const server = https.createServer(credentials, (request, response) => {
    seen.push({ host: request.headers.host, servername: (request.socket as unknown as { servername?: string }).servername, connection: request.headers["x-hop"] as string | undefined });
    response.writeHead(207, { "x-origin": "fixture" });
    response.end(`origin saw ${request.headers.host}`);
  });
  server.on("upgrade", (request, socket) => {
    seen.push({ host: request.headers.host, servername: (socket as unknown as { servername?: string }).servername });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, server, port: (server.address() as net.AddressInfo).port };
}

/** One plain HTTP request to the bridge, as the ngrok agent sends it. */
async function viaBridge(port: number, host: string | undefined): Promise<{ status: number; marker?: string; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/path?q=1", headers: host === undefined ? {} : { host, connection: "x-hop", "x-hop": "dropped" }, setHost: host !== undefined }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, marker: response.headers["devfn-public-origin"] as string | undefined, body }));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("ngrok bindings", () => {
  it("keep only credential references and require an explicit endpoint kind", async () => {
    const repo = path.join(dir, "repo");
    await mkdir(repo);
    const reserved = ngrokFixtureBinding(repo);
    expect(parseTunnelBinding(reserved)).toEqual(reserved);
    expect(urlTiming(reserved)).toBe("pre-start");
    expect(urlTiming(ngrokFixtureBinding(repo, "ephemeral"))).toBe("post-start");
    // Reserved URLs are read back through the API, so a key reference is required.
    expect(() => parseTunnelBinding({ ...reserved, ngrok: { endpoints: "reserved", authtokenEnv: "TOKEN" } })).toThrow("API key environment variable name");
    expect(() => parseTunnelBinding({ ...reserved, ngrok: { ...reserved.ngrok, endpoints: "random" } })).toThrow("reserved or ephemeral");
    // An ephemeral binding cannot claim a public domain it does not control.
    expect(() => parseTunnelBinding({ ...ngrokFixtureBinding(repo, "ephemeral"), domain: DOMAIN })).toThrow("no public domain");
    // A credential value, or another provider's fields, never enters the registry.
    expect(() => parseTunnelBinding({ ...reserved, ngrok: { ...reserved.ngrok, authtoken: "value" } })).toThrow("credential references only");
    expect(() => parseTunnelBinding({ ...reserved, cloudflare: {} })).toThrow("credential references only");
    expect(() => parseTunnelBinding({ ...reserved, ngrok: { ...reserved.ngrok, authtokenEnv: "lower-case" } })).toThrow("environment variable names");
    expect(() => parseTunnelBinding({ ...reserved, provider: "other" })).toThrow("cloudflare or ngrok");
    const stateDir = path.join(dir, "state");
    await expect(registerTunnelBinding(stateDir, reserved)).resolves.toEqual(reserved);
    await expect(registerTunnelBinding(stateDir, ngrokFixtureBinding(repo, "ephemeral", "eph"))).resolves.toMatchObject({ domain: "eph.ngrok.devfn.internal" });
    // Public domains still never overlap.
    await expect(registerTunnelBinding(stateDir, { ...reserved, name: "again", domain: `sub.${DOMAIN}` })).rejects.toMatchObject({ code: "DEVFN_TUNNEL_IN_USE" });
    expect(await readFile(path.join(stateDir, "tunnels.json"), "utf8")).not.toMatch(/fixture-(authtoken|api-key)-value/);
  });

  it("render an agent configuration of exactly the selected endpoints, validated offline", async () => {
    const config: NgrokConnectorConfig = { version: 1, binding: "share", endpoints: "reserved", marker: "devfn-tunnel:share", hostnames: [B, A], origin: { port: 8444, caFile: "/ca.pem" } };
    const reserved = renderNgrokAgentConfig(config, 41000);
    expect(reserved).toContain("agent:\n  web_addr: false\n  update_check: false\n  console_ui: false\n  log: stdout\n  log_format: json");
    expect([...reserved.matchAll(/^ {2}"(.+)":$/gm)].map((match) => match[1])).toEqual([A, B]);
    expect(reserved).toContain(`  "${A}":\n    proto: http\n    addr: "http://127.0.0.1:41000"\n    schemes:\n      - https\n    host_header: "${A}"\n    inspect: false\n    metadata: "devfn-tunnel:share"\n    domain: "${A}"\n    pooling_enabled: true\n`);
    const ephemeral = renderNgrokAgentConfig({ ...config, endpoints: "ephemeral" }, 41000);
    expect(ephemeral).not.toMatch(/domain:|pooling_enabled/);
    expect(ephemeral).toContain(`host_header: "${A}"`);

    const record = path.join(dir, "record");
    await mkdir(record);
    const binding = ngrokFixtureBinding("/repo");
    const provider = new NgrokTunnelProvider({ env: SECRETS, command: async () => await writeFakeNgrok(dir, record) });
    const configFile = path.join(dir, "connector.yml");
    await writeFile(configFile, provider.renderConnectorConfig(binding, [B, A], { port: 8444, caFile: "/ca.pem" }));
    await provider.validateConnectorConfig(binding, configFile, [A, B]);
    expect(await readFile(path.join(record, "checked.yml"), "utf8")).toBe(renderNgrokAgentConfig({ ...config, hostnames: [A, B] }, 1));
    await expect(provider.validateConnectorConfig(binding, configFile, [A])).rejects.toThrow("exactly the published hostnames");
    expect(() => provider.renderConnectorConfig(binding, [`web.other.example.test`], { port: 8444, caFile: "/ca.pem" })).toThrow("one label under");
    // An agent that rejects the configuration fails validation; the reported line hides the private home path.
    const rejecting = new NgrokTunnelProvider({ env: SECRETS, command: async () => {
      const file = await writeFakeNgrok(dir, record);
      await writeFile(file, (await readFile(file, "utf8")).replace('config.includes("REJECT")', "true"));
      return file;
    } });
    const error = await rejecting.validateConnectorConfig(binding, configFile, [A, B]).catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: "DEVFN_TUNNEL_VALIDATION_FAILED" });
    expect((error as Error).message).toContain("<home>");
    expect((error as Error).message).not.toContain(os.tmpdir());
  });

  it("read a reserved account through the API before any connector routes a name, and never send the key elsewhere", async () => {
    const binding = ngrokFixtureBinding("/repo");
    const fixture = { reserved: ["other.example.test", `*.${DOMAIN}`], tunnels: [{ public_url: `https://${A}`, metadata: ngrokMarker(binding) }, { public_url: "https://unrelated.example.test" }] };
    const { requests, fetcher } = account(fixture);
    const provider = new NgrokTunnelProvider({ env: SECRETS, fetch: fetcher });
    await provider.verifyTunnel(binding);
    expect(requests).toEqual([`https://api.ngrok.com/reserved_domains?limit=100 Bearer ${SECRETS.DEVFN_FIXTURE_NGROK_API_KEY}`,
      `https://api.ngrok.com/reserved_domains?limit=100&offset=1 Bearer ${SECRETS.DEVFN_FIXTURE_NGROK_API_KEY}`]);
    // DevFn's own running endpoint does not conflict; nothing is created or deleted.
    expect(await provider.ensureDns(binding, A)).toBe("existing");
    expect(await provider.ownsDns(binding, A)).toBe(false);
    requests.length = 0;
    await provider.removeDns(binding, A);
    expect(requests).toEqual([]);
    // Another agent serving the name, pooled or not, would receive its requests.
    fixture.tunnels.push({ public_url: `https://${B}`, metadata: "someone else" });
    await expect(provider.ensureDns(binding, B)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_CONFLICT" });
    await expect(provider.verifyDns(binding, `web.other.example.test`)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_INVALID" });
    fixture.reserved = [DOMAIN];
    await expect(provider.verifyTunnel(binding)).rejects.toThrow(`does not reserve *.${DOMAIN}`);

    // A next page outside the API never receives the key.
    requests.length = 0;
    const redirecting = new NgrokTunnelProvider({ env: SECRETS, fetch: (async (input: string | URL, init?: RequestInit) => {
      requests.push(`${String(input)} ${new Headers(init?.headers).get("authorization") ?? ""}`);
      return new Response(JSON.stringify({ reserved_domains: [], next_page_uri: "https://collector.example.test/steal" }), { status: 200 });
    }) as typeof fetch });
    await expect(redirecting.verifyTunnel(binding)).rejects.toThrow("outside its API");
    expect(requests.every((item) => item.startsWith("https://api.ngrok.com/"))).toBe(true);

    // Errors carry the status and error code only, never a credential.
    const failing = new NgrokTunnelProvider({ env: SECRETS, fetch: account({ ...fixture, fail: 401 }).fetcher });
    const error = await failing.verifyTunnel(binding).catch((caught: unknown) => caught as Error & { details?: unknown });
    expect(error).toMatchObject({ code: "DEVFN_TUNNEL_PROVIDER_FAILED", details: { errorCode: "ERR_NGROK_218" } });
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toMatch(/fixture-(authtoken|api-key)-value/);
    await expect(new NgrokTunnelProvider({ env: {} }).verifyTunnel(binding)).rejects.toThrow("DEVFN_FIXTURE_NGROK_AUTHTOKEN is unset");
    expect(() => new NgrokTunnelProvider({ env: {} }).connectorSecrets(binding)).toThrow("DEVFN_FIXTURE_NGROK_AUTHTOKEN is unset");
    expect(new NgrokTunnelProvider({ env: SECRETS }).connectorSecrets(binding)).toEqual({ NGROK_AUTHTOKEN: SECRETS.DEVFN_FIXTURE_NGROK_AUTHTOKEN });

    // Ephemeral endpoints have nothing to read before the connector runs.
    requests.length = 0;
    const ephemeral = ngrokFixtureBinding("/repo", "ephemeral");
    await provider.verifyTunnel(ephemeral);
    await provider.verifyDns(ephemeral, `web-a-0123456789abcdef0123.${ephemeral.domain}`);
    expect(requests).toEqual([]);
  });

  it("refuses one assigned URL for two hostnames, which would publish one route's URL for another", async () => {
    const a = "web-a-0123456789abcdef0123.eph.ngrok.devfn.internal", b = "web-b-0123456789abcdef0123.eph.ngrok.devfn.internal";
    let urls: Record<string, string> = { [a]: "https://shared.ngrok-free.app", [b]: "https://shared.ngrok-free.app" };
    const readiness = http.createServer((_request, response) => response.end(JSON.stringify({ urls })));
    await new Promise<void>((resolve) => readiness.listen(0, "127.0.0.1", resolve));
    const port = (readiness.address() as net.AddressInfo).port;
    const provider = new NgrokTunnelProvider({ env: SECRETS });
    const ephemeral = ngrokFixtureBinding("/repo", "ephemeral");
    try {
      await expect(provider.assignedUrls(ephemeral, port, [a, b])).rejects.toThrow(`reported the same public URL for ${a} and ${b}`);
      urls = { [a]: "https://one.ngrok-free.app", [b]: "https://two.ngrok-free.app" };
      expect(await provider.assignedUrls(ephemeral, port, [a, b])).toEqual(urls);
    } finally { readiness.close(); }
  });
});

describe("ngrok origin bridge", () => {
  it("forwards only allowlisted hostnames, over TLS verified for exactly that name, with it as server name and Host", async () => {
    const credentials = issue([`*.${DOMAIN}`, "web-w1.localhost"], "origin");
    const { seen, server, port } = await origin(credentials);
    const bridge = createOriginBridge({ hostnames: [A, `web.other.example.test`], originPort: port, ca: credentials.cert });
    await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const bridgePort = (bridge.address() as net.AddressInfo).port;
    try {
      // The application response passes through unchanged; hop-by-hop headers stay on their connection.
      expect(await viaBridge(bridgePort, A)).toEqual({ status: 207, body: `origin saw ${A}` });
      expect(await viaBridge(bridgePort, `${A.toUpperCase()}:443`)).toMatchObject({ status: 207 });
      expect(seen).toEqual([{ host: A, servername: A }, { host: A, servername: A }]);
      // Any other Host, including a private route the origin holds a certificate for, is denied before the origin.
      for (const host of [B, "web-w1.localhost", "127.0.0.1", `${A}.evil.test`, `evil@${A}`]) {
        expect(await viaBridge(bridgePort, host)).toMatchObject({ status: 404, marker: "deny" });
      }
      // An HTTP/1.1 request without Host is refused by the parser itself.
      expect(await viaBridge(bridgePort, undefined)).toMatchObject({ status: 400 });
      expect(seen).toHaveLength(2);
      // An allowlisted name the origin certificate does not cover is never forwarded unverified.
      expect(await viaBridge(bridgePort, "web.other.example.test")).toMatchObject({ status: 502 });
      expect(seen).toHaveLength(2);
    } finally { bridge.close(); server.close(); }

    // A root other than the origin's fails closed too.
    const other = issue([`*.${DOMAIN}`], "other");
    const second = await origin(credentials);
    const untrusted = createOriginBridge({ hostnames: [A], originPort: second.port, ca: other.cert });
    await new Promise<void>((resolve) => untrusted.listen(0, "127.0.0.1", resolve));
    try {
      expect(await viaBridge((untrusted.address() as net.AddressInfo).port, A)).toMatchObject({ status: 502 });
      expect(second.seen).toEqual([]);
    } finally { untrusted.close(); second.server.close(); }
  });

  it("fails a response the origin cuts short and cancels the origin request when the client goes away", async () => {
    const credentials = issue([`*.${DOMAIN}`], "origin");
    const closed: string[] = [];
    const server = https.createServer(credentials, (request, response) => {
      response.once("close", () => { if (!response.writableFinished) closed.push(request.url ?? ""); });
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      // Cut the connection mid-body; /hold keeps it open until the client leaves.
      if (request.url === "/cut") setTimeout(() => request.socket.destroy(), 50);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const bridge = createOriginBridge({ hostnames: [A], originPort: (server.address() as net.AddressInfo).port, ca: credentials.cert });
    await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const bridgePort = (bridge.address() as net.AddressInfo).port;
    /** How the client sees one request end: complete, failed, or still open after three seconds. */
    const outcome = async (requestPath: string, method: string, act?: (request: http.ClientRequest, response?: http.IncomingMessage) => void) =>
      await new Promise<string>((resolve) => {
        const timer = setTimeout(() => { request.destroy(); resolve("hung"); }, 3_000);
        const done = (result: string) => { clearTimeout(timer); resolve(result); };
        const request = http.request({ host: "127.0.0.1", port: bridgePort, path: requestPath, method, headers: { host: A } }, (response) => {
          response.once("data", () => act?.(request, response));
          response.once("end", () => done("complete"));
          response.once("error", () => done("failed"));
          response.once("close", () => { if (!response.complete) done("failed"); });
        });
        request.once("error", () => done("failed"));
        if (method === "POST") { request.write("upload"); act?.(request); } else request.end();
      });
    try {
      expect(await outcome("/cut", "GET")).toBe("failed");
      // A download the client abandons, and an upload it abandons before the origin answers, end at the origin too.
      expect(await outcome("/hold", "GET", (request) => request.destroy())).toBe("failed");
      await vi.waitFor(() => expect(closed).toContain("/hold"), { timeout: 3_000 });
      await outcome("/upload", "POST", (request) => setTimeout(() => request.destroy(), 100));
      await vi.waitFor(() => expect(closed).toContain("/upload"), { timeout: 3_000 });
      // The bridge still serves after each failure.
      expect(await outcome("/hold", "GET", (request) => request.destroy())).toBe("failed");
    } finally { bridge.close(); bridge.closeAllConnections(); server.close(); server.closeAllConnections(); }
  });

  it("applies the same allowlist and origin verification to WebSocket upgrades", async () => {
    const credentials = issue([`*.${DOMAIN}`], "origin");
    const { seen, server, port } = await origin(credentials);
    const bridge = createOriginBridge({ hostnames: [A], originPort: port, ca: credentials.cert });
    await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const upgrade = async (host: string) => await new Promise<string>((resolve, reject) => {
      const socket = net.connect((bridge.address() as net.AddressInfo).port, "127.0.0.1", () => {
        socket.write(`GET /socket HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        if (text.startsWith("HTTP/1.1 101") && text.includes("\r\n\r\n") && !text.endsWith("ping")) socket.write("ping");
        if (text.endsWith("ping") || text.startsWith("HTTP/1.1 404")) { socket.destroy(); resolve(text); }
      });
      socket.once("error", reject);
    });
    try {
      expect(await upgrade(A)).toMatch(/^HTTP\/1\.1 101[\s\S]*ping$/);
      expect(seen).toEqual([{ host: A, servername: A }]);
      expect(await upgrade(B)).toMatch(/^HTTP\/1\.1 404 Not Found\r\nDevfn-Public-Origin: deny/);
      expect(seen).toHaveLength(1);
    } finally { bridge.close(); server.close(); }
  });
});

describe("ngrok connector lifecycle", () => {
  /** Two owners on one binding, served by the real connector entry and a stand-in agent. */
  async function setup(endpoints: "reserved" | "ephemeral") {
    const stateDir = path.join(dir, "state");
    const record = path.join(dir, "record");
    await mkdir(record, { recursive: true });
    const credentials = issue([`*.${DOMAIN}`, "*.eph.ngrok.devfn.internal"], "origin");
    const fixtureOrigin = await origin(credentials);
    const binding = await registerTunnelBinding(stateDir, ngrokFixtureBinding(path.join(dir), endpoints, endpoints === "reserved" ? "share" : "eph"));
    const api = { reserved: [`*.${DOMAIN}`], tunnels: [] as Array<{ public_url: string; metadata?: string }>, fail: undefined as number | undefined };
    const provider = new NgrokTunnelProvider({ env: SECRETS, fetch: account(api).fetcher, command: async () => await writeFakeNgrok(dir, record), connector: CONNECTOR });
    const live = new Set(["owner-a", "owner-b"]);
    const options: TunnelServiceOptions = { stateDir, binding, provider, originPort: fixtureOrigin.port, readyTimeoutMs: 20_000, originCa: async () => credentials.cert,
      probeOrigin: async () => undefined, ownerMayRun: async (ownerId) => await Promise.resolve(live.has(ownerId)) };
    // Every agent the connectors started, in start order.
    const agents = async () => (await Promise.all((await readdir(record)).filter((name) => name.startsWith("agent-")).map(async (name) =>
      JSON.parse(await readFile(path.join(record, name), "utf8")) as { startedAt: number; args: string[]; env: Record<string, string>; config: string })))
      .sort((a, b) => a.startedAt - b.startedAt);
    return { stateDir, binding, options, api, record, live, agents, fixtureOrigin, name: binding.name, domain: binding.domain };
  }

  posixIt("keeps each owner's endpoints independent across start, stop, provider failure, crash and restart", { timeout: 120_000 }, async () => {
    const { stateDir, options, api, record, live, agents, fixtureOrigin } = await setup("reserved");
    try {
      await publishTunnelRoutes(options, "owner-a", [A]);
      await publishTunnelRoutes(options, "owner-b", [B]);
      let status = await tunnelStatus(options);
      expect(status).toMatchObject({ connector: "running", routed: [A, B], urls: { [A]: `https://${A}`, [B]: `https://${B}` },
        capabilities: { provider: "ngrok", urlTiming: "pre-start", dns: "connector-only" } });
      // The agent got only PATH, its private HOME and the authtoken, and a configuration of exactly the published endpoints.
      const agent = (await agents()).at(-1)!;
      expect(Object.keys(agent.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["HOME", "NGROK_AUTHTOKEN", "PATH"]);
      expect(agent.env.HOME).toBe(path.join(tunnelPaths(stateDir, "share").dir, "home"));
      expect([...agent.config.matchAll(/^ {2}"(.+)":$/gm)].map((match) => match[1])).toEqual([A, B]);
      // End to end through the connector's bridge: the selected name reaches the origin with verified TLS, another is denied.
      const bridgePort = Number(/addr: "http:\/\/127\.0\.0\.1:(\d+)"/.exec(agent.config)![1]);
      expect(await viaBridge(bridgePort, B)).toMatchObject({ status: 207, body: `origin saw ${B}` });
      expect(await viaBridge(bridgePort, `web-c-0123456789abcdef0123.${DOMAIN}`)).toMatchObject({ status: 404, marker: "deny" });
      expect(fixtureOrigin.seen).toEqual([{ host: B, servername: B }]);
      // The authtoken never reaches the log, the journal or the connector configuration.
      const log = await readFile(tunnelPaths(stateDir, "share").log, "utf8");
      expect(log).toContain("authtoken in use: ");
      for (const file of [tunnelPaths(stateDir, "share").log, tunnelPaths(stateDir, "share").state, ...(await readdir(tunnelPaths(stateDir, "share").dir)).filter((name) => name.endsWith(".yml")).map((name) => path.join(tunnelPaths(stateDir, "share").dir, name))]) {
        expect(await readFile(file, "utf8")).not.toMatch(/fixture-(authtoken|api-key)-value/);
      }

      // A provider failure on A's republish rolls back to B's running connector untouched.
      const before = (await readTunnelState(stateDir, "share")).connector!;
      api.fail = 500;
      await expect(publishTunnelRoutes(options, "owner-a", [A, `api-a-0123456789abcdef0123.${DOMAIN}`])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_PROVIDER_FAILED" });
      api.fail = undefined;
      expect((await readTunnelState(stateDir, "share")).connector).toEqual(before);
      // An agent that fails to start leaves the previous connector serving both owners.
      await writeFile(path.join(record, "fail"), "");
      await expect(publishTunnelRoutes(options, "owner-a", [A, `api-a-0123456789abcdef0123.${DOMAIN}`])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
      await rm(path.join(record, "fail"));
      status = await tunnelStatus(options);
      expect(status).toMatchObject({ connector: "running", pid: before.pid, routed: [A, B], pending: false, retired: 0 });

      // Stopping A leaves B published by a replacement connector.
      expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [A], outstanding: [] });
      status = await tunnelStatus(options);
      expect(status).toMatchObject({ connector: "running", routed: [B], hostnames: [{ hostname: B, ownerId: "owner-b" }], urls: { [B]: `https://${B}` } });
      expect(status.pid).not.toBe(before.pid);

      // A crashed connector is restarted only for owners that may still run.
      await publishTunnelRoutes(options, "owner-a", [A]);
      process.kill(-(await readTunnelState(stateDir, "share")).connector!.pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await tunnelStatus(options)).connector).toBe("stopped");
      live.delete("owner-a");
      status = await recoverTunnel(options);
      expect(status).toMatchObject({ connector: "running", routed: [B], hostnames: [{ hostname: B, ownerId: "owner-b" }] });
    } finally { fixtureOrigin.server.close(); }
  });

  posixIt("publishes ephemeral URLs only once the connector reports them", { timeout: 120_000 }, async () => {
    const { stateDir, options, agents, record, fixtureOrigin, domain } = await setup("ephemeral");
    const a = `web-a-0123456789abcdef0123.${domain}`, b = `web-b-0123456789abcdef0123.${domain}`;
    try {
      await publishTunnelRoutes(options, "owner-a", [a]);
      const first = await tunnelStatus(options);
      expect(first).toMatchObject({ routed: [a], capabilities: { urlTiming: "post-start" } });
      expect(first.urls[a]).toMatch(/^https:\/\/[0-9a-f]+\.ngrok-free\.app$/);
      expect((await agents()).at(-1)!.config).not.toContain("domain:");
      // The shared connector restarts for another owner's publish, and the provider assigns new URLs: status reports the current ones.
      await publishTunnelRoutes(options, "owner-b", [b]);
      const second = await tunnelStatus(options);
      expect(Object.keys(second.urls)).toEqual([a, b]);
      expect(second.urls[a]).not.toBe(first.urls[a]);
      expect(second.capabilities.gaps.join(" ")).toContain("assigns new ephemeral URLs");
      expect((await readTunnelState(stateDir, "eph")).connector!.urls).toEqual(second.urls);
      // An agent that reports one URL for two endpoints never becomes ready; the previous connector keeps serving.
      await writeFile(path.join(record, "same-url"), "");
      await expect(publishTunnelRoutes({ ...options, readyTimeoutMs: 3_000 }, "owner-a", [a, `api-a-0123456789abcdef0123.${domain}`]))
        .rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
      await rm(path.join(record, "same-url"));
      expect(await tunnelStatus(options)).toMatchObject({ connector: "running", pid: second.pid, urls: second.urls });
    } finally { fixtureOrigin.server.close(); }
  });
});

it.skipIf(process.env.DEVFN_REAL_TUNNEL !== "1")("validates the generated agent configuration with the real ngrok, offline", async () => {
  const binding = ngrokFixtureBinding("/repo");
  const provider = new NgrokTunnelProvider({ env: { PATH: process.env.PATH, ...SECRETS } });
  for (const endpoints of ["reserved", "ephemeral"] as const) {
    const target = endpoints === "reserved" ? binding : ngrokFixtureBinding("/repo", "ephemeral");
    const caFile = path.join(dir, "ca.pem");
    await writeFile(caFile, "unused");
    const configFile = path.join(dir, `connector-${endpoints}.yml`);
    const names = [`web-a-0123456789abcdef0123.${target.domain}`, `web-b-0123456789abcdef0123.${target.domain}`];
    await writeFile(configFile, provider.renderConnectorConfig(target, names, { port: 8444, caFile }));
    await provider.validateConnectorConfig(target, configFile, names);
  }
});
