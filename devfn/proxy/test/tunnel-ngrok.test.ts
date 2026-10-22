import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NgrokTunnelProvider, createOriginBridge, ngrokMarker, parseTunnelBinding, publishTunnelRoutes, readTunnelState, recoverTunnel, registerTunnelBinding, renderNgrokAgentConfig,
  tunnelPaths, tunnelStatus, urlTiming, withdrawTunnelRoutes, type NgrokConnectorConfig, type TunnelServiceOptions,
} from "../src/tunnel/index.js";
import { writeTunnelState } from "../src/tunnel/state.js";
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

/** A fixture ngrok API: reserved domains and online tunnels, each listed one item per page; every request URL is logged, after beforeList ran. */
function account(state: { reserved: string[]; tunnels: Array<{ public_url: string; metadata?: string }>; fail?: number; beforeList?: (route: string) => void }) {
  const requests: string[] = [];
  const page = (items: unknown[], key: string, offset: number, route: string) => new Response(JSON.stringify({
    [key]: items.slice(offset, offset + 1), next_page_uri: offset + 1 < items.length ? `https://api.ngrok.com${route}?limit=100&offset=${offset + 1}` : null }), { status: 200 });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${url.origin}${url.pathname}${url.search} ${new Headers(init?.headers).get("authorization") ?? ""}`);
    if (state.fail) return new Response(JSON.stringify({ error_code: "ERR_NGROK_218", msg: `echo ${SECRETS.DEVFN_FIXTURE_NGROK_API_KEY}` }), { status: state.fail });
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!offset) state.beforeList?.(url.pathname);
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

/** One raw request to the bridge; resolves with everything it answered before closing. */
async function rawRequest(port: number, text: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    let answer = "";
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    socket.on("data", (chunk: Buffer) => { answer += chunk.toString(); });
    socket.once("close", () => resolve(answer));
    socket.once("error", reject);
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
    expect(() => parseTunnelBinding({ ...reserved, ngrok: { endpoints: "reserved", authtokenEnv: "TOKEN", registrationId: "c".repeat(32) } })).toThrow("API key environment variable name");
    expect(() => parseTunnelBinding({ ...reserved, ngrok: { ...reserved.ngrok, endpoints: "random" } })).toThrow("reserved or ephemeral");
    // An ephemeral binding cannot claim a public domain it does not control.
    expect(() => parseTunnelBinding({ ...ngrokFixtureBinding(repo, "ephemeral"), domain: DOMAIN })).toThrow("no public domain");
    // A credential value, or another provider's fields, never enters the registry.
    expect(() => parseTunnelBinding({ ...reserved, ngrok: { ...reserved.ngrok, authtoken: "value" } })).toThrow("credential references only");
    expect(() => parseTunnelBinding({ ...reserved, cloudflare: {} })).toThrow("credential references only");
    expect(() => parseTunnelBinding({ ...reserved, ngrok: { ...reserved.ngrok, authtokenEnv: "lower-case" } })).toThrow("environment variable names");
    expect(() => parseTunnelBinding({ ...reserved, provider: "other" })).toThrow("cloudflare or ngrok");
    expect(() => parseTunnelBinding({ ...reserved, ngrok: { ...reserved.ngrok, registrationId: "short" } })).toThrow("32-hex registration ID");
    const stateDir = path.join(dir, "state");
    // Registration assigns its own random registration ID, so a same-named binding registered on another machine never shares a marker.
    const registered = await registerTunnelBinding(stateDir, reserved);
    expect(registered).toEqual({ ...reserved, ngrok: { ...reserved.ngrok, registrationId: expect.stringMatching(/^[a-f0-9]{32}$/) } });
    const elsewhere = await registerTunnelBinding(path.join(dir, "elsewhere"), reserved);
    expect(registered.provider === "ngrok" && elsewhere.provider === "ngrok" && registered.ngrok.registrationId !== elsewhere.ngrok.registrationId).toBe(true);
    expect(ngrokMarker(registered)).not.toBe(ngrokMarker(elsewhere));
    // Repeating the same registration, such as a retry after an interrupted command, keeps the stored ID; a changed one is refused.
    await expect(registerTunnelBinding(stateDir, reserved)).resolves.toEqual(registered);
    await expect(registerTunnelBinding(stateDir, { ...reserved, ngrok: { ...reserved.ngrok, authtokenEnv: "OTHER_TOKEN" } })).rejects.toMatchObject({ code: "DEVFN_TUNNEL_IN_USE" });
    await expect(registerTunnelBinding(stateDir, ngrokFixtureBinding(repo, "ephemeral", "eph"))).resolves.toMatchObject({ domain: "eph.ngrok.devfn.internal" });
    // Public domains still never overlap.
    await expect(registerTunnelBinding(stateDir, { ...reserved, name: "again", domain: `sub.${DOMAIN}` })).rejects.toMatchObject({ code: "DEVFN_TUNNEL_IN_USE" });
    expect(await readFile(path.join(stateDir, "tunnels.json"), "utf8")).not.toMatch(/fixture-(authtoken|api-key)-value/);
  });

  it("render an agent configuration of exactly the selected endpoints, validated offline", async () => {
    const config: NgrokConnectorConfig = { version: 1, binding: "share", endpoints: "reserved", marker: `devfn-tunnel:share:${"c".repeat(32)}`, hostnames: [B, A], origin: { port: 8444, caFile: "/ca.pem" } };
    const reserved = renderNgrokAgentConfig(config, 41000);
    expect(reserved).toContain("agent:\n  web_addr: false\n  update_check: false\n  console_ui: false\n  log: stdout\n  log_format: json");
    expect([...reserved.matchAll(/^ {2}"(.+)":$/gm)].map((match) => match[1])).toEqual([A, B]);
    expect(reserved).toContain(`  "${A}":\n    proto: http\n    addr: "http://127.0.0.1:41000"\n    schemes:\n      - https\n    host_header: "${A}"\n    inspect: false\n    metadata: "devfn-tunnel:share:${"c".repeat(32)}"\n    domain: "${A}"\n    pooling_enabled: true\n`);
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
    // Another agent serving the name, pooled or not, would receive its requests: an unmarked one, or a same-named binding registered elsewhere.
    fixture.tunnels.push({ public_url: `https://${B}`, metadata: "someone else" });
    await expect(provider.ensureDns(binding, B)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_CONFLICT" });
    const C = `web-c-0123456789abcdef0123.${DOMAIN}`;
    fixture.tunnels.push({ public_url: `https://${C}`, metadata: ngrokMarker(ngrokFixtureBinding("/repo", "reserved", "share", "d".repeat(32))) });
    await expect(provider.ensureDns(binding, C)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_CONFLICT" });
    // The post-launch readback applies the same rule to every launched name in one listing.
    await provider.verifyServing(binding, [A]);
    await expect(provider.verifyServing(binding, [A, C])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_CONFLICT", message: `${C} is already served by an ngrok agent DevFn does not own; the new connector was stopped.` });
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
    await provider.verifyServing(ephemeral, [`web-a-0123456789abcdef0123.${ephemeral.domain}`]);
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
      // An absolute-form target, which would name its own host to the origin, is denied before the origin even with an allowlisted Host.
      for (const target of ["https://web-w1.localhost/", `https://${A}/`, "*"]) {
        expect(await rawRequest(bridgePort, `OPTIONS ${target} HTTP/1.1\r\nHost: ${A}\r\nConnection: close\r\n\r\n`)).toMatch(/^HTTP\/1\.1 404 Not Found\r\n[\s\S]*devfn-public-origin: deny/i);
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
      // An absolute-form upgrade target is denied before the origin as well.
      expect(await rawRequest((bridge.address() as net.AddressInfo).port, `GET https://${B}/socket HTTP/1.1\r\nHost: ${A}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`))
        .toMatch(/^HTTP\/1\.1 404 Not Found\r\nDevfn-Public-Origin: deny/);
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
    const api = { reserved: [`*.${DOMAIN}`], tunnels: [] as Array<{ public_url: string; metadata?: string }>, fail: undefined as number | undefined, beforeList: undefined as ((route: string) => void) | undefined };
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
      // The replacement started on a fresh log; the predecessor's history, which it kept writing until stopped, is intact beside it.
      const started = (text: string) => [...text.matchAll(/"msg":"started tunnel".*?"name":"([^"]+)"/g)].map((match) => match[1]);
      expect(started(await readFile(`${tunnelPaths(stateDir, "share").log}.1`, "utf8"))).toEqual([A]);
      expect(started(await readFile(tunnelPaths(stateDir, "share").log, "utf8"))).toEqual([A, B]);
      let status = await tunnelStatus(options);
      expect(status).toMatchObject({ connector: "running", routed: [A, B], urls: { [A]: `https://${A}`, [B]: `https://${B}` },
        capabilities: { provider: "ngrok", urlTiming: "pre-start", dns: "connector-only" } });
      // Prerequisites DevFn does not check are stated, not implied by readiness.
      expect(status.capabilities.gaps).toEqual(expect.arrayContaining([expect.stringContaining("neither creates nor checks the domain's DNS delegation to ngrok"),
        expect.stringContaining("needs the authtoken variable and ngrok on PATH")]));
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
      expect(second.capabilities.gaps.join(" ")).not.toContain("DNS delegation");
      expect((await readTunnelState(stateDir, "eph")).connector!.urls).toEqual(second.urls);
      // An agent that reports one URL for two endpoints never becomes ready; the previous connector keeps serving.
      await writeFile(path.join(record, "same-url"), "");
      await expect(publishTunnelRoutes({ ...options, readyTimeoutMs: 3_000 }, "owner-a", [a, `api-a-0123456789abcdef0123.${domain}`]))
        .rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
      await rm(path.join(record, "same-url"));
      expect(await tunnelStatus(options)).toMatchObject({ connector: "running", pid: second.pid, urls: second.urls });
    } finally { fixtureOrigin.server.close(); }
  });

  posixIt("starts no agent for a hostname a same-named binding registered elsewhere already serves", { timeout: 60_000 }, async () => {
    const { stateDir, options, api, agents, fixtureOrigin, binding } = await setup("reserved");
    try {
      // Same binding name and worktree path on another machine derive the same hostname; only the registration differs.
      for (const metadata of [`devfn-tunnel:${binding.name}`, `devfn-tunnel:${binding.name}:${"d".repeat(32)}`]) {
        api.tunnels = [{ public_url: `https://${A}`, metadata }];
        await expect(publishTunnelRoutes(options, "owner-a", [A])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_CONFLICT" });
      }
      expect(await agents()).toEqual([]);
      expect(await readTunnelState(stateDir, "share")).toMatchObject({ hostnames: [] });
      expect((await readTunnelState(stateDir, "share")).connector).toBeUndefined();
      // This registration's own running endpoint, as a pooled predecessor, is not a conflict.
      api.tunnels = [{ public_url: `https://${A}`, metadata: ngrokMarker(binding) }];
      await publishTunnelRoutes(options, "owner-a", [A]);
      expect(await tunnelStatus(options)).toMatchObject({ connector: "running", routed: [A] });
    } finally { fixtureOrigin.server.close(); }
  });

  posixIt("stops a launched connector whose pooled endpoint another registration joined after the pre-launch read, committing nothing", { timeout: 90_000 }, async () => {
    const { stateDir, options, api, record, agents, fixtureOrigin, binding } = await setup("reserved");
    const foreign = `devfn-tunnel:${binding.name}:${"d".repeat(32)}`;
    const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // The PID of each agent the connectors started, in start order.
    const agentPids = async () => (await Promise.all((await readdir(record)).filter((name) => name.startsWith("agent-")).map(async (name) =>
      ({ pid: Number(/^agent-(\d+)\.json$/.exec(name)![1]), startedAt: (JSON.parse(await readFile(path.join(record, name), "utf8")) as { startedAt: number }).startedAt }))))
      .sort((a, b) => a.startedAt - b.startedAt).map((item) => item.pid);
    // The same-name registration elsewhere comes online for name once this run's next agent has started: after every pre-launch read.
    const joinAfterLaunch = (name: string) => {
      const before = readdirSync(record).filter((item) => item.startsWith("agent-")).length;
      api.beforeList = (route) => {
        if (route === "/tunnels" && readdirSync(record).filter((item) => item.startsWith("agent-")).length > before) api.tunnels.push({ public_url: `https://${name}`, metadata: foreign });
      };
    };
    try {
      // Own pooled endpoints, a predecessor's included, are not a conflict: make before break still works.
      await publishTunnelRoutes(options, "owner-b", [B]);
      api.tunnels = [{ public_url: `https://${B}`, metadata: ngrokMarker(binding) }];
      const before = (await readTunnelState(stateDir, "share")).connector!;
      joinAfterLaunch(A);
      await expect(publishTunnelRoutes(options, "owner-a", [A])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_CONFLICT", message: expect.stringContaining("the new connector was stopped") });
      // The launched agent is gone, nothing was committed and the predecessor keeps serving B alone.
      const [kept, stopped] = await agentPids();
      expect(await agents()).toHaveLength(2);
      expect([running(kept), running(stopped)]).toEqual([true, false]);
      expect(await readTunnelState(stateDir, "share")).toMatchObject({ connector: before, hostnames: [{ hostname: B, ownerId: "owner-b" }], retired: [], residue: [] });
      expect(await tunnelStatus(options)).toMatchObject({ connector: "running", pid: before.pid, routed: [B] });

      // A recovery relaunch is read back the same way: B's crashed connector is not replaced by one pooled with a foreign agent.
      api.tunnels = [];
      process.kill(-before.pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));
      joinAfterLaunch(B);
      await expect(recoverTunnel(options)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_CONFLICT" });
      expect(await agents()).toHaveLength(3);
      expect(running((await agentPids())[2])).toBe(false);
      // The stopped relaunch is not left listed as a retired connector.
      expect(await tunnelStatus(options)).toMatchObject({ routed: [], retired: 0 });
    } finally { api.beforeList = undefined; fixtureOrigin.server.close(); }
  });

  posixIt("withdraws one owner's names while another registration's agent serves a sibling owner's name", { timeout: 90_000 }, async () => {
    const { stateDir, options, api, fixtureOrigin, binding } = await setup("reserved");
    try {
      await publishTunnelRoutes(options, "owner-a", [A]);
      await publishTunnelRoutes(options, "owner-b", [B]);
      // A same-name registration elsewhere joined B's pool after B was published.
      api.tunnels = [{ public_url: `https://${A}`, metadata: ngrokMarker(binding) }, { public_url: `https://${B}`, metadata: ngrokMarker(binding) },
        { public_url: `https://${B}`, metadata: `devfn-tunnel:${binding.name}:${"d".repeat(32)}` }];
      // The narrowing replacement routes no new name, so it does not depend on that agent: A's withdrawal ends.
      expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [A], outstanding: [] });
      expect(await tunnelStatus(options)).toMatchObject({ connector: "running", routed: [B], hostnames: [{ hostname: B, ownerId: "owner-b" }], outstanding: [] });
      expect((await readTunnelState(stateDir, "share")).retired).toEqual([]);
    } finally { fixtureOrigin.server.close(); }
  });

  /** The journal a transition leaves when it is interrupted once its launched connector is recorded, before its readback and commit. */
  async function interruptAfterLaunch(stateDir: string, name: string) {
    const state = await readTunnelState(stateDir, name);
    const { urls: _urls, readBack: _readBack, ...launched } = state.connector!;
    delete state.connector;
    state.retired = [launched];
    await writeTunnelState(stateDir, state);
    return launched;
  }

  posixIt("reads back an interrupted launch before it becomes the recorded connector (ephemeral)", { timeout: 90_000 }, async () => {
    const { stateDir, options, fixtureOrigin, domain } = await setup("ephemeral");
    const a = `web-a-0123456789abcdef0123.${domain}`;
    try {
      await publishTunnelRoutes(options, "owner-a", [a]);
      const { urls } = (await readTunnelState(stateDir, "eph")).connector!;
      const launched = await interruptAfterLaunch(stateDir, "eph");
      // The healthy connector is kept, with the URLs it serves read from it.
      expect(await recoverTunnel(options)).toMatchObject({ connector: "running", pid: launched.pid, routed: [a], urls, retired: 0 });
      expect((await readTunnelState(stateDir, "eph")).connector).toMatchObject({ pid: launched.pid, urls, readBack: true });
    } finally { fixtureOrigin.server.close(); }
  });

  posixIt("refuses to promote an interrupted launch whose name another registration serves (reserved)", { timeout: 90_000 }, async () => {
    const { stateDir, options, api, fixtureOrigin, binding } = await setup("reserved");
    try {
      await publishTunnelRoutes(options, "owner-a", [A]);
      const launched = await interruptAfterLaunch(stateDir, "share");
      const agent = JSON.parse(await readFile(tunnelPaths(stateDir, "share").agent(launched.launchId!), "utf8")) as { pid: number };
      api.tunnels = [{ public_url: `https://${A}`, metadata: ngrokMarker(binding) }, { public_url: `https://${A}`, metadata: `devfn-tunnel:${binding.name}:${"d".repeat(32)}` }];
      await expect(recoverTunnel(options)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_CONFLICT" });
      // It was stopped, agent included, instead of serving beside the foreign agent.
      await vi.waitFor(() => expect(() => process.kill(agent.pid, 0)).toThrow(), { timeout: 5_000 });
      expect(() => process.kill(launched.pid, 0)).toThrow();
      expect(await tunnelStatus(options)).toMatchObject({ connector: "stopped", routed: [], retired: 0 });
    } finally { fixtureOrigin.server.close(); }
  });

  posixIt("keeps serving after upgrade clients reset their connections, denied or allowed", { timeout: 60_000 }, async () => {
    const { options, agents, fixtureOrigin } = await setup("reserved");
    try {
      await publishTunnelRoutes(options, "owner-a", [A]);
      const before = await tunnelStatus(options);
      const bridgePort = Number(/addr: "http:\/\/127\.0\.0\.1:(\d+)"/.exec((await agents()).at(-1)!.config)![1]);
      const reset = async (host: string) => await new Promise<void>((resolve) => {
        const socket = net.connect(bridgePort, "127.0.0.1", () => {
          socket.write(`GET /socket HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
          socket.resetAndDestroy();
        });
        socket.once("close", () => resolve());
        socket.on("error", () => undefined);
      });
      for (let round = 0; round < 10; round += 1) await Promise.all(Array.from({ length: 20 }, async (_, index) => await reset(index % 4 ? B : A)));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await tunnelStatus(options)).toMatchObject({ connector: "running", pid: before.pid, routed: [A] });
      expect(await viaBridge(bridgePort, A)).toMatchObject({ status: 207 });
    } finally { fixtureOrigin.server.close(); }
  });

  /** SIGKILL only the connector process, which runs no code then, and wait until its wrapper exited too; returns the agent it left running. */
  async function killConnectorOnly(stateDir: string, name: string): Promise<number> {
    const record = (await readTunnelState(stateDir, name)).connector!;
    const agent = JSON.parse(await readFile(tunnelPaths(stateDir, name).agent(record.launchId!), "utf8")) as { pid: number };
    const connector = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(agent.pid)], { encoding: "utf8" }).trim());
    expect([record.pid, agent.pid]).not.toContain(connector);
    process.kill(connector, "SIGKILL");
    await vi.waitFor(() => expect(() => process.kill(record.pid, 0)).toThrow(), { timeout: 5_000 });
    expect(() => process.kill(agent.pid, 0)).not.toThrow();
    return agent.pid;
  }

  posixIt("stops the agent a killed connector left behind before relaunching or reporting its names unrouted (reserved)", { timeout: 120_000 }, async () => {
    const { stateDir, options, agents, record, fixtureOrigin } = await setup("reserved");
    try {
      await publishTunnelRoutes(options, "owner-a", [A]);
      await publishTunnelRoutes(options, "owner-b", [B]);
      const orphan = await killConnectorOnly(stateDir, "share");
      // The orphaned agent may still route both names: nothing reports them unrouted or starts beside it.
      expect(await tunnelStatus(options)).toMatchObject({ connector: "unverified", routed: [] });
      const status = await recoverTunnel(options);
      expect(status).toMatchObject({ connector: "running", routed: [A, B], retired: 0, outstanding: [] });
      expect(() => process.kill(orphan, 0)).toThrow();
      // The replacement agent started only once the orphan had been stopped.
      const stoppedAt = Number(await readFile(path.join(record, `exited-${orphan}`), "utf8"));
      expect((await agents()).at(-1)!.startedAt).toBeGreaterThan(stoppedAt);
    } finally { fixtureOrigin.server.close(); }
  });

  posixIt("stops the agent a killed connector left behind before a withdrawal ends (ephemeral)", { timeout: 120_000 }, async () => {
    const { stateDir, options, fixtureOrigin, domain } = await setup("ephemeral");
    const a = `web-a-0123456789abcdef0123.${domain}`;
    try {
      await publishTunnelRoutes(options, "owner-a", [a]);
      const orphan = await killConnectorOnly(stateDir, "eph");
      expect(await tunnelStatus(options)).toMatchObject({ connector: "unverified", urls: {} });
      expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [a], outstanding: [] });
      expect(() => process.kill(orphan, 0)).toThrow();
      expect(await tunnelStatus(options)).toMatchObject({ connector: "stopped", hostnames: [], retired: 0, outstanding: [] });
      expect((await readdir(tunnelPaths(stateDir, "eph").dir)).filter((file) => file.startsWith("agent-"))).toEqual([]);
    } finally { fixtureOrigin.server.close(); }
  });

  posixIt("keeps an unreadable agent record of a killed connector and fails closed until it can be read (reserved)", { timeout: 120_000 }, async () => {
    const { stateDir, options, fixtureOrigin } = await setup("reserved");
    try {
      await publishTunnelRoutes(options, "owner-a", [A]);
      const agentFile = tunnelPaths(stateDir, "share").agent((await readTunnelState(stateDir, "share")).connector!.launchId!);
      const orphan = await killConnectorOnly(stateDir, "share");
      await chmod(agentFile, 0o000);
      try {
        // An unreadable record is not an absent agent: nothing reports A unrouted, starts beside the agent or forgets it.
        expect(await tunnelStatus(options)).toMatchObject({ connector: "unverified" });
        await expect(recoverTunnel(options)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
        await expect(withdrawTunnelRoutes(options, "owner-a")).rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
        expect(await tunnelStatus(options)).toMatchObject({ connector: "unverified", hostnames: [], outstanding: [{ ownerId: "owner-a", detail: expect.stringContaining(A) }] });
        expect(() => process.kill(orphan, 0)).not.toThrow();
      } finally { await chmod(agentFile, 0o600); }
      // Readable again, the next withdrawal stops the agent and only then removes its record.
      expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [], outstanding: [] });
      expect(() => process.kill(orphan, 0)).toThrow();
      expect(await tunnelStatus(options)).toMatchObject({ connector: "stopped", retired: 0, outstanding: [] });
      expect((await readdir(tunnelPaths(stateDir, "share").dir)).filter((file) => file.startsWith("agent-"))).toEqual([]);
    } finally { fixtureOrigin.server.close(); }
  });

  posixIt("keeps a malformed agent record of a killed connector and fails closed until it is complete (ephemeral)", { timeout: 120_000 }, async () => {
    const { stateDir, options, fixtureOrigin, domain } = await setup("ephemeral");
    const a = `web-a-0123456789abcdef0123.${domain}`;
    try {
      await publishTunnelRoutes(options, "owner-a", [a]);
      const agentFile = tunnelPaths(stateDir, "eph").agent((await readTunnelState(stateDir, "eph")).connector!.launchId!);
      const orphan = await killConnectorOnly(stateDir, "eph");
      const original = await readFile(agentFile, "utf8");
      for (const malformed of ["{", JSON.stringify({ ...JSON.parse(original) as object, pid: "not-a-pid" })]) {
        await writeFile(agentFile, malformed);
        expect(await tunnelStatus(options)).toMatchObject({ connector: "unverified" });
        await expect(recoverTunnel(options)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
        await expect(withdrawTunnelRoutes(options, "owner-a")).rejects.toMatchObject({ code: "DEVFN_TUNNEL_UNAVAILABLE" });
        expect(await readFile(agentFile, "utf8")).toBe(malformed);
        expect(() => process.kill(orphan, 0)).not.toThrow();
      }
      await writeFile(agentFile, original);
      expect(await withdrawTunnelRoutes(options, "owner-a")).toEqual({ withdrawn: [], outstanding: [] });
      expect(() => process.kill(orphan, 0)).toThrow();
      expect((await readdir(tunnelPaths(stateDir, "eph").dir)).filter((file) => file.startsWith("agent-"))).toEqual([]);
    } finally { fixtureOrigin.server.close(); }
  });

  posixIt("never attributes a running connector's agent to a dead record at the same readiness port", { timeout: 120_000 }, async () => {
    const { stateDir, options, fixtureOrigin } = await setup("reserved");
    try {
      await publishTunnelRoutes(options, "owner-a", [A]);
      const live = (await readTunnelState(stateDir, "share")).connector!;
      const agentFile = tunnelPaths(stateDir, "share").agent(live.launchId!);
      const agent = JSON.parse(await readFile(agentFile, "utf8")) as { pid: number };
      const exited = spawn(process.execPath, ["-e", ""]);
      const deadPid = await new Promise<number>((resolve) => exited.once("exit", () => resolve(exited.pid!)));
      // A retired launch whose leader is gone, at the readiness port the live connector was given after it: with the same
      // configuration, then with another one. Neither may stop the live agent or forget its identity.
      for (const configDigest of [live.configDigest, "f".repeat(64)]) {
        const state = await readTunnelState(stateDir, "share");
        state.retired = [{ ...live, pid: deadPid, launchId: "e".repeat(32), configDigest, urls: undefined }];
        await writeTunnelState(stateDir, state);
        expect(await recoverTunnel(options)).toMatchObject({ connector: "running", pid: live.pid, routed: [A], retired: 0 });
        expect(() => process.kill(agent.pid, 0)).not.toThrow();
        expect(JSON.parse(await readFile(agentFile, "utf8"))).toMatchObject({ pid: agent.pid });
      }
      // The live connector's agent is still found once its connector is killed outright.
      const orphan = await killConnectorOnly(stateDir, "share");
      expect(orphan).toBe(agent.pid);
      expect(await tunnelStatus(options)).toMatchObject({ connector: "unverified", routed: [] });
      expect(await recoverTunnel(options)).toMatchObject({ connector: "running", routed: [A] });
      expect(() => process.kill(orphan, 0)).toThrow();
    } finally { fixtureOrigin.server.close(); }
  });

  posixIt("never starts an agent whose identity its connector did not record", { timeout: 60_000 }, async () => {
    const record = path.join(dir, "record");
    await mkdir(record);
    const caFile = path.join(dir, "ca.pem");
    await writeFile(caFile, issue([`*.${DOMAIN}`], "origin").cert);
    const configFile = path.join(dir, "connector.json");
    await writeFile(configFile, new NgrokTunnelProvider({ env: SECRETS }).renderConnectorConfig(ngrokFixtureBinding("/repo"), [A], { port: 1, caFile }));
    // The connector is killed outright right after spawning its agent, before it can record the agent's identity.
    const preload = path.join(dir, "kill-after-spawn.mjs");
    await writeFile(preload, `import { createRequire, syncBuiltinESMExports } from "node:module";\nimport { writeFileSync } from "node:fs";\n` +
      `const childProcess = createRequire(import.meta.url)("node:child_process");\nconst spawn = childProcess.spawn;\n` +
      `childProcess.spawn = (...args) => { const child = spawn(...args); writeFileSync(${JSON.stringify(path.join(dir, "gate.pid"))}, String(child.pid)); process.kill(process.pid, "SIGKILL"); return child; };\nsyncBuiltinESMExports();\n`);
    const home = path.join(dir, "home");
    await mkdir(home);
    const readyPort = await new Promise<number>((resolve) => { const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); }); });
    const [node, importFlag, tsx, entry] = CONNECTOR;
    const child = spawn(node, [importFlag, tsx, "--import", pathToFileURL(preload).href, entry, configFile, String(readyPort), await writeFakeNgrok(dir, record), path.join(dir, "agent.json")],
      { env: { PATH: process.env.PATH, HOME: home, NGROK_AUTHTOKEN: SECRETS.DEVFN_FIXTURE_NGROK_AUTHTOKEN }, stdio: "ignore" });
    expect(await new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)))).toBe("SIGKILL");
    const gate = Number(await readFile(path.join(dir, "gate.pid"), "utf8"));
    try {
      await vi.waitFor(() => expect(() => process.kill(gate, 0)).toThrow(), { timeout: 3_000 });
      expect(await readdir(record)).toEqual([]);
    } finally { try { process.kill(gate, "SIGKILL"); } catch { /* gone */ } }
  });

  // Reads of the agent's process identity (ps on darwin, /proc on Linux) fail
  // the first `failures` times; the gate's PID and each injected failure are recorded.
  async function connectorWithIdentityFaults(failures: number) {
    const record = path.join(dir, "record");
    await mkdir(record);
    const caFile = path.join(dir, "ca.pem");
    await writeFile(caFile, issue([`*.${DOMAIN}`], "origin").cert);
    const configFile = path.join(dir, "connector.json");
    await writeFile(configFile, new NgrokTunnelProvider({ env: SECRETS }).renderConnectorConfig(ngrokFixtureBinding("/repo"), [A], { port: 1, caFile }));
    const injected = path.join(dir, "injected");
    const preload = path.join(dir, "identity-faults.mjs");
    await writeFile(preload, `import { createRequire, syncBuiltinESMExports } from "node:module";\nimport { appendFileSync, writeFileSync } from "node:fs";\nimport { promisify } from "node:util";\n` +
      `const require = createRequire(import.meta.url);\nconst childProcess = require("node:child_process");\nconst fsPromises = require("node:fs/promises");\n` +
      `let remaining = ${failures};\nconst inject = (pid) => { if (pid === String(process.pid) || remaining <= 0) return false; remaining -= 1; appendFileSync(${JSON.stringify(injected)}, "x"); return true; };\n` +
      `const execFile = childProcess.execFile;\nconst patched = (...args) => execFile(...args);\n` +
      `patched[promisify.custom] = (file, args, options) => file === "ps" && args.includes("lstart=") && inject(args.at(-1)) ? Promise.reject(new Error("injected identity read failure")) : execFile[promisify.custom](file, args, options);\n` +
      `childProcess.execFile = patched;\nconst readFile = fsPromises.readFile;\n` +
      `fsPromises.readFile = (file, ...rest) => { const match = /^\\/proc\\/(\\d+)\\/stat$/.exec(String(file)); return match && inject(match[1]) ? Promise.reject(new Error("injected identity read failure")) : readFile(file, ...rest); };\n` +
      `const spawn = childProcess.spawn;\nchildProcess.spawn = (...args) => { const child = spawn(...args); writeFileSync(${JSON.stringify(path.join(dir, "gate.pid"))}, String(child.pid)); return child; };\nsyncBuiltinESMExports();\n`);
    const home = path.join(dir, "home");
    await mkdir(home);
    const readyPort = await new Promise<number>((resolve) => { const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); }); });
    const identityFile = path.join(dir, "agent.json");
    const [node, importFlag, tsx, entry] = CONNECTOR;
    const child = spawn(node, [importFlag, tsx, "--import", pathToFileURL(preload).href, entry, configFile, String(readyPort), await writeFakeNgrok(dir, record), identityFile],
      { env: { PATH: process.env.PATH, HOME: home, NGROK_AUTHTOKEN: SECRETS.DEVFN_FIXTURE_NGROK_AUTHTOKEN }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    return { child, exited, record, readyPort, identityFile, stderr: () => stderr, injected: async () => (await readFile(injected, "utf8").catch(() => "")).length, gate: async () => Number(await readFile(path.join(dir, "gate.pid"), "utf8")) };
  }

  posixIt("retries a failed read of its agent's identity before the agent may start", { timeout: 60_000 }, async () => {
    const connector = await connectorWithIdentityFaults(1);
    try {
      await vi.waitFor(async () => expect(await new Promise((resolve) => http.get({ host: "127.0.0.1", port: connector.readyPort, path: "/ready" }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", () => resolve(0)))).toBe(200), { timeout: 20_000, interval: 100 });
      expect(await connector.injected()).toBe(1);
      const agent = JSON.parse(await readFile(connector.identityFile, "utf8")) as { pid: number };
      expect(agent.pid).toBe(await connector.gate());
      expect((await readdir(connector.record)).filter((name) => name.startsWith("agent-"))).toEqual([`agent-${agent.pid}.json`]);
    } finally {
      connector.child.kill("SIGTERM");
      await connector.exited;
    }
  });

  posixIt("exits without opening its agent's gate when the agent's identity cannot be read", { timeout: 60_000 }, async () => {
    const connector = await connectorWithIdentityFaults(Number.MAX_SAFE_INTEGER);
    const gate = await vi.waitFor(async () => await connector.gate(), { timeout: 20_000 });
    try {
      expect(await connector.exited).toBe(1);
      expect(connector.stderr()).toContain("The ngrok agent's process identity could not be read.");
      expect(await connector.injected()).toBe(10);
      await vi.waitFor(() => expect(() => process.kill(gate, 0)).toThrow(), { timeout: 3_000 });
      expect(await readdir(connector.record)).toEqual([]);
      await expect(readFile(connector.identityFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { try { process.kill(gate, "SIGKILL"); } catch { /* gone */ } }
  });

  posixIt("stops its agent whenever the connector itself fails", { timeout: 60_000 }, async () => {
    const record = path.join(dir, "record");
    await mkdir(record);
    const caFile = path.join(dir, "ca.pem");
    await writeFile(caFile, issue([`*.${DOMAIN}`], "origin").cert);
    const configFile = path.join(dir, "connector.json");
    await writeFile(configFile, new NgrokTunnelProvider({ env: SECRETS }).renderConnectorConfig(ngrokFixtureBinding("/repo"), [A], { port: 1, caFile }));
    // A fault injected into the connector process once its agent runs.
    const preload = path.join(dir, "fail-after-agent.mjs");
    await writeFile(preload, `import { readdirSync } from "node:fs";\nconst timer = setInterval(() => { if (readdirSync(${JSON.stringify(record)}).some((name) => name.startsWith("agent-"))) { clearInterval(timer); throw new Error("injected connector fault"); } }, 20);\n`);
    const home = path.join(dir, "home");
    await mkdir(home);
    const readyPort = await new Promise<number>((resolve) => { const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); }); });
    const [node, importFlag, tsx, entry] = CONNECTOR;
    const child = spawn(node, [importFlag, tsx, "--import", pathToFileURL(preload).href, entry, configFile, String(readyPort), await writeFakeNgrok(dir, record), path.join(dir, "agent.json")],
      { env: { PATH: process.env.PATH, HOME: home, NGROK_AUTHTOKEN: SECRETS.DEVFN_FIXTURE_NGROK_AUTHTOKEN }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    const agentPid = Number(/^agent-(\d+)\.json$/.exec((await readdir(record)).find((name) => name.startsWith("agent-"))!)![1]);
    try {
      expect(code).toBe(1);
      await vi.waitFor(() => expect(() => process.kill(agentPid, 0)).toThrow(), { timeout: 3_000 });
      expect(stderr).toContain("DevFn ngrok connector failed: injected connector fault");
    } finally { try { process.kill(agentPid, "SIGKILL"); } catch { /* gone */ } }
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
