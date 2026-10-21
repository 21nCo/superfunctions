import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { describe, expect, it } from "vitest";

import { parsePersistedProxyRoutes, withFileLock } from "@devfn/ports";
import { PUBLIC_ORIGIN_PORT, proxyListenerPortsFor, renderCaddyfile, type ProxyRoute } from "../src/index.js";
import { CloudflareTunnelProvider, caddyInternalRoot, ownershipMarker, probePublicOrigin } from "../src/tunnel/index.js";
import { fixtureBinding } from "./fixtures/tunnel.js";

const PUBLIC_HOST = "web-w1-0123456789abcdef0123.tunnel.example.test";
const route = (overrides: Partial<ProxyRoute>): ProxyRoute => ({ id: "w1:web", instanceId: "w1", hostname: "web-w1.localhost", targetHost: "127.0.0.1", targetPort: 3000, tls: "internal", updatedAt: "now", ...overrides });
const publicRoute = (overrides: Partial<ProxyRoute> = {}): ProxyRoute => route({ id: "w1:public:web", hostname: PUBLIC_HOST, exposure: "public", publicDomain: "tunnel.example.test", ...overrides });

describe("public origin rendering", () => {
  it("serves public routes only on the public origin listener behind strict SNI and a deny fallback", () => {
    const config = renderCaddyfile([route({}), publicRoute()], true);
    expect(config).toContain(`  servers 127.0.0.1:${PUBLIC_ORIGIN_PORT} {\n    strict_sni_host on\n  }`);
    expect(config).toContain(`https://${PUBLIC_HOST}:${PUBLIC_ORIGIN_PORT} {\n  tls internal\n  route {`);
    expect(config).toContain(`https://:${PUBLIC_ORIGIN_PORT} {\n  tls internal\n  respond 403\n}`);
    expect(config).not.toMatch(new RegExp(`web-w1\\.localhost:${PUBLIC_ORIGIN_PORT}`));
    expect(config).not.toMatch(new RegExp(`^${PUBLIC_HOST.replaceAll(".", "\\.")} \\{`, "m"));
    // A profile without public routes renders exactly as before.
    expect(renderCaddyfile([route({})])).not.toContain(String(PUBLIC_ORIGIN_PORT));
    expect(proxyListenerPortsFor([publicRoute()])).toEqual([PUBLIC_ORIGIN_PORT]);
    expect(proxyListenerPortsFor([route({ tls: "off" }), publicRoute()])).toEqual([8080, PUBLIC_ORIGIN_PORT].map((port, index) => index === 0 ? (process.platform === "darwin" ? port : 80) : port));
  });

  it("refuses public routes that could be served as local or registered routes", () => {
    expect(() => renderCaddyfile([route({ hostname: PUBLIC_HOST, registeredDomain: "tunnel.example.test" }), publicRoute({ id: "w1:public:other" })])).toThrow("cannot be both public and local");
    for (const invalid of [{ tls: "off" as const }, { publicDomain: "other.example.test" }, { registeredDomain: "tunnel.example.test" }, { exposure: undefined }]) {
      expect(() => renderCaddyfile([publicRoute(invalid)])).toThrow();
      expect(() => parsePersistedProxyRoutes({ version: 1, routes: [publicRoute(invalid)] })).toThrow();
    }
    expect(parsePersistedProxyRoutes({ version: 1, routes: [route({}), publicRoute()] })).toHaveLength(2);
  });
});

describe("Cloudflare DNS adapter", () => {
  const binding = fixtureBinding("/repo", "/creds.json");
  const target = `${binding.cloudflare.tunnelId}.cfargotunnel.com`;
  /** An in-memory zone behind the Cloudflare v4 DNS records API. */
  const zone = (records: Array<Record<string, unknown>>) => {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method} ${url.pathname.replace(/^.*\/dns_records/, "")}`);
      const reply = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
      if (init?.method === "GET") return reply(records.filter((record) => record.name === url.searchParams.get("name")));
      if (init?.method === "POST") { const record = { id: `r${records.length}`, ...JSON.parse(String(init.body)) }; records.push(record); return reply(record); }
      if (init?.method === "DELETE") { records.splice(records.findIndex((record) => url.pathname.endsWith(`/${String(record.id)}`)), 1); return reply({}); }
      return new Response(JSON.stringify({ success: false, errors: [{ code: 9999, message: "echo secret-token" }] }), { status: 400 });
    }) as typeof fetch;
    return { calls, provider: new CloudflareTunnelProvider({ fetch: fetcher, env: { DEVFN_FIXTURE_TOKEN: "secret-token" } }) };
  };

  it("creates a proxied, marked record for the tunnel and reads it back", async () => {
    const records: Array<Record<string, unknown>> = [];
    const { provider } = zone(records);
    expect(await provider.ensureDns(binding, PUBLIC_HOST)).toBe("created");
    expect(records).toEqual([expect.objectContaining({ type: "CNAME", name: PUBLIC_HOST, content: target, proxied: true, comment: ownershipMarker(binding) })]);
    expect(await provider.ensureDns(binding, PUBLIC_HOST)).toBe("existing");
    records[0].proxied = false;
    await expect(provider.verifyDns(binding, PUBLIC_HOST)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_VALIDATION_FAILED" });
  });

  it("never changes or deletes a record DevFn does not own", async () => {
    const records: Array<Record<string, unknown>> = [{ id: "foreign", type: "CNAME", name: PUBLIC_HOST, content: target, proxied: true, comment: "someone else" }];
    const { calls, provider } = zone(records);
    await expect(provider.ensureDns(binding, PUBLIC_HOST)).rejects.toMatchObject({ code: "DEVFN_TUNNEL_CONFLICT" });
    await provider.removeDns(binding, PUBLIC_HOST);
    expect(records).toHaveLength(1);
    expect(calls.filter((call) => !call.startsWith("GET"))).toEqual([]);
  });

  it("keeps the API token out of every error", async () => {
    const failing = new CloudflareTunnelProvider({ env: { DEVFN_FIXTURE_TOKEN: "secret-token" },
      fetch: (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error secret-token" }] }), { status: 403 })) as typeof fetch });
    const error = await failing.ensureDns(binding, PUBLIC_HOST).catch((caught: unknown) => caught as Error & { details?: unknown });
    expect(error).toMatchObject({ code: "DEVFN_TUNNEL_PROVIDER_FAILED", details: { status: 403, errors: [10000] } });
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain("secret-token");
    await expect(new CloudflareTunnelProvider({ env: {} }).ensureDns(binding, PUBLIC_HOST)).rejects.toThrow("DEVFN_FIXTURE_TOKEN is unset");
  });
});

it.skipIf(process.env.DEVFN_REAL_TUNNEL !== "1")("validates the generated ingress allowlist with the real cloudflared, offline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devfn-cloudflared-"));
  try {
    const binding = fixtureBinding(dir, path.join(dir, "credentials.json"));
    await writeFile(binding.cloudflare.credentialsFile, "{}", { mode: 0o600 });
    const provider = new CloudflareTunnelProvider();
    const hostnames = [PUBLIC_HOST, "api-w1-0123456789abcdef0123.tunnel.example.test"];
    const config = provider.renderConnectorConfig(binding, hostnames, { port: PUBLIC_ORIGIN_PORT, caFile: path.join(dir, "origin-ca.pem") });
    expect(config).toContain(`      originServerName: "${PUBLIC_HOST}"\n      httpHostHeader: "${PUBLIC_HOST}"`);
    expect(config.match(/noTLSVerify: false/g)).toHaveLength(2);
    expect(config.trimEnd().endsWith(`- service: "http_status:404"`)).toBe(true);
    const file = path.join(dir, "connector.yml");
    await writeFile(file, config);
    await provider.validateConnectorConfig(binding, file, hostnames);
    // A catch-all that reaches the origin instead of denying is refused.
    await writeFile(file, config.replace(`"http_status:404"`, `"https://127.0.0.1:${PUBLIC_ORIGIN_PORT}"`));
    await expect(provider.validateConnectorConfig(binding, file, hostnames)).rejects.toThrow("does not deny");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 0;
}

/** Status and body for a TLS request with the given SNI and Host, without verification, or the handshake error. */
async function rawRequest(port: number, servername: string, host: string): Promise<{ status: number; body: string } | { error: string }> {
  return await new Promise((resolve) => {
    const socket = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] }, () => socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let text = "";
    socket.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    socket.once("error", (error) => resolve({ error: error.message }));
    socket.once("end", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), body: text.split("\r\n\r\n").slice(1).join("") }));
  });
}

it.skipIf(process.env.DEVFN_REAL_PROXY !== "1")("denies private routes, forged Host and unknown names on a real Caddy public origin", async () => {
  await withFileLock(path.join(os.tmpdir(), "devfn-test-caddy-admin.lock"), async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "devfn-public-origin-"));
    const upstreams = await Promise.all(["PRIVATE", "PUBLIC"].map(async (body) => {
      const server = http.createServer((_request, response) => response.end(body));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return { server, port: (server.address() as net.AddressInfo).port };
    }));
    const [httpPort, httpsPort, publicPort] = [await freePort(), await freePort(), await freePort()];
    const config = path.join(dir, "Caddyfile");
    await writeFile(config, renderCaddyfile([route({ targetPort: upstreams[0].port }), publicRoute({ targetPort: upstreams[1].port })], false, { httpPort, httpsPort }, publicPort));
    const child = spawn("caddy", ["run", "--config", config, "--adapter", "caddyfile"], { env: { ...process.env, XDG_DATA_HOME: path.join(dir, "data"), XDG_CONFIG_HOME: path.join(dir, "config") }, stdio: "ignore" });
    try {
      let root: string | undefined;
      for (let attempt = 0; attempt < 60 && !root; attempt += 1) {
        root = await caddyInternalRoot().catch(() => undefined);
        if (!root) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // Verified TLS for the allowlisted name, with a forged Host refused.
      await probePublicOrigin(PUBLIC_HOST, publicPort, root!);
      expect(await rawRequest(publicPort, PUBLIC_HOST, PUBLIC_HOST)).toEqual({ status: 200, body: "PUBLIC" });
      expect(await rawRequest(publicPort, PUBLIC_HOST, "web-w1.localhost")).toMatchObject({ status: 421 });
      // A private name Caddy holds a certificate for is denied on the public origin.
      expect(await rawRequest(publicPort, "web-w1.localhost", "web-w1.localhost")).toEqual({ status: 403, body: "" });
      expect(await rawRequest(publicPort, "unknown.tunnel.example.test", "unknown.tunnel.example.test")).toHaveProperty("error");
      // The origin certificate does not verify against another root.
      await expect(probePublicOrigin(PUBLIC_HOST, publicPort, tls.rootCertificates[0])).rejects.toMatchObject({ code: "DEVFN_TUNNEL_VALIDATION_FAILED" });
      // The private listener is unchanged.
      expect(await rawRequest(httpsPort, "web-w1.localhost", "web-w1.localhost")).toEqual({ status: 200, body: "PRIVATE" });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      for (const upstream of upstreams) upstream.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, { timeoutMs: 120_000 });
}, 60_000);
