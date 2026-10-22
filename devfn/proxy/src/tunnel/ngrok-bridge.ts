import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";

import { PUBLIC_ORIGIN_HEADER } from "../index.js";

/** Hop-by-hop headers, which apply to one connection and are never forwarded. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

export interface OriginBridgeOptions {
  /** The only Host values forwarded; each is also the TLS server name toward the origin. */
  hostnames: readonly string[];
  originPort: number;
  /** PEM root that must verify the origin's certificate for each hostname. */
  ca: string;
}

/** The Host header's name, lowercased and without a port; undefined when it is not one plain DNS name. */
function hostName(header: string | undefined): string | undefined {
  const match = /^([a-z0-9.-]+)(?::\d{1,5})?$/i.exec(header ?? "");
  return match?.[1].toLowerCase();
}

function forwardHeaders(headers: http.IncomingHttpHeaders, hostname: string, upgrade: boolean): http.OutgoingHttpHeaders {
  const listed = new Set(String(headers.connection ?? "").toLowerCase().split(",").map((item) => item.trim()).filter(Boolean));
  const result: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || key === "host" || HOP_BY_HOP.has(key) || listed.has(key)) continue;
    result[key] = value;
  }
  result.host = hostname;
  if (upgrade) { result.connection = "upgrade"; result.upgrade = headers.upgrade; }
  return result;
}

const deny = (response: http.ServerResponse): void => {
  response.writeHead(404, { [PUBLIC_ORIGIN_HEADER]: "deny", "content-length": "0" });
  response.end();
};

/** A failed bridge stream closes; an 'error' event without a listener would end the whole connector. */
const contain = (...streams: Array<{ on(event: "error", listener: (error: Error) => void): unknown; destroy(): unknown }>): void => {
  for (const stream of streams) stream.on("error", () => stream.destroy());
};

/**
 * The loopback hop between the ngrok agent and the DevFn public origin.
 * ngrok forwards to a plain HTTP upstream and cannot pin the origin's TLS
 * server name or root, so this bridge provides the Cloudflare connector's
 * origin guarantees: a request whose Host is not an allowlisted hostname is
 * denied here (404) and never reaches the origin; an allowlisted one is
 * forwarded over TLS with that hostname as both server name and Host, and
 * only once the origin's certificate verifies against the DevFn root for
 * exactly that name. WebSocket upgrades follow the same rule. Every stream
 * it touches handles its errors for its whole lifetime, so one failed
 * connection, allowed or denied, closes only itself.
 */
export function createOriginBridge(options: OriginBridgeOptions): http.Server {
  const allowed = new Set(options.hostnames);
  const server = http.createServer((request, response) => {
    contain(request, response);
    const hostname = hostName(request.headers.host);
    if (!hostname || !allowed.has(hostname)) { request.resume(); deny(response); return; }
    const upstream = https.request({ host: "127.0.0.1", port: options.originPort, servername: hostname, ca: options.ca, rejectUnauthorized: true, agent: false,
      method: request.method, path: request.url, headers: forwardHeaders(request.headers, hostname, false) }, (reply) => {
      contain(reply);
      const headers: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(reply.headers)) if (value !== undefined && !HOP_BY_HOP.has(key)) headers[key] = value;
      response.writeHead(reply.statusCode ?? 502, headers);
      // An origin response cut short ends the public one as failed, never as complete or open.
      reply.once("close", () => { if (!reply.complete) response.destroy(); });
      reply.pipe(response);
    });
    upstream.on("error", () => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(502, { "content-length": "0" });
      response.end();
    });
    // A client that goes away before its response is complete cancels the origin request.
    response.once("close", () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });
  server.on("upgrade", (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node removes its own socket error handling for an upgrade; this one covers every branch, before any write.
    contain(socket);
    const hostname = hostName(request.headers.host);
    if (!hostname || !allowed.has(hostname)) { socket.end(`HTTP/1.1 404 Not Found\r\n${PUBLIC_ORIGIN_HEADER}: deny\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return; }
    const origin = tls.connect({ host: "127.0.0.1", port: options.originPort, servername: hostname, ca: options.ca, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
    let connected = false;
    origin.once("secureConnect", () => {
      connected = true;
      const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
      for (const [key, value] of Object.entries(forwardHeaders(request.headers, hostname, true))) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) lines.push(`${key}: ${String(item)}`);
      }
      origin.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) origin.write(head);
      socket.pipe(origin).pipe(socket);
    });
    // Before the origin handshake the client gets a 502; once bytes flow either side failing closes both.
    origin.on("error", () => {
      if (!connected && socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      else socket.destroy();
      origin.destroy();
    });
    socket.on("error", () => origin.destroy());
    origin.once("close", () => socket.destroy());
    socket.once("close", () => origin.destroy());
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  return server;
}

/**
 * The endpoint an ngrok JSON log line reports as started: its name, which
 * DevFn sets to the hostname, and the public URL. Other lines are undefined.
 */
export function startedEndpoint(line: string): { name: string; url: string } | undefined {
  const entry = (() => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } })();
  if (entry?.msg !== "started tunnel" || typeof entry.name !== "string" || typeof entry.url !== "string") return undefined;
  return { name: entry.name, url: entry.url };
}
