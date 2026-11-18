/**
 * Node-side half of the workerd test harness, loaded by vitest.workerd.config.ts.
 *
 * With `isolatedStorage`, the pool pushes and pops each test's storage frame
 * with a request from workerd to Miniflare's loopback server, a `node:http`
 * server that keeps Node's default 5-second `keepAliveTimeout` (plus a 1-second
 * buffer on newer Node). workerd reuses pooled connections to it, so when a
 * test runs that long without loopback traffic (a D1-heavy test on a slow CI
 * runner), Node closes the idle
 * socket just as workerd sends the pop on it, and the pop fails with
 * `Error: Network connection lost.` (cloudflare/workers-sdk#14848). Miniflare
 * fixed this by setting the loopback server's `keepAliveTimeout` to 0
 * (cloudflare/workers-sdk#14850), but only releases that require Vitest 4 ship
 * it, so this applies the same setting to the Miniflare version in use.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

/** Miniflare's loopback request listener is the private field `#handleLoopback`. */
const LOOPBACK_LISTENER_NAME = "#handleLoopback";

/**
 * Longer than a default server keeps an idle connection: `keepAliveTimeout`
 * (5 seconds) plus, on Node versions that have it, `keepAliveTimeoutBuffer`.
 */
const defaults = new http.Server() as http.Server & { keepAliveTimeoutBuffer?: number };
const IDLE_MS = defaults.keepAliveTimeout + (defaults.keepAliveTimeoutBuffer ?? 0) + 500;

interface LoopbackState {
  installed: boolean;
  servers: Set<http.Server>;
}

// Kept on globalThis so a second evaluation of the config shares one patch and one server list.
const state: LoopbackState = ((globalThis as Record<symbol, unknown>)[Symbol.for("datafn.workerd.loopbackKeepAlive")] ??= {
  installed: false,
  servers: new Set<http.Server>(),
}) as LoopbackState;

/** Makes every Miniflare loopback server created from now on keep idle connections open. */
export function disableLoopbackKeepAliveTimeout(): void {
  if (state.installed) return;
  state.installed = true;
  const original = http.createServer as (...args: unknown[]) => http.Server;
  http.createServer = ((...args: unknown[]) => {
    const server = original(...args);
    const listener = args.find((arg): arg is (...a: unknown[]) => unknown => typeof arg === "function");
    if (listener?.name === LOOPBACK_LISTENER_NAME) {
      server.keepAliveTimeout = 0;
      state.servers.add(server);
      server.once("close", () => state.servers.delete(server));
    }
    return server;
  }) as typeof http.createServer;
}

/** Sends a request on a keep-alive agent and reports whether it reused a pooled socket. */
function send(host: string, port: number, agent: http.Agent): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: "/", agent }, (response) => {
      response.resume();
      response.once("end", () => resolve(request.reusedSocket));
      response.once("error", reject);
    });
    request.once("error", reject);
  });
}

/** Whether a loopback connection left idle past Node's default keep-alive limit is still reused. */
async function idleConnectionReused(server: http.Server): Promise<boolean> {
  const { address, port } = server.address() as AddressInfo;
  const host = address === "::" ? "::1" : address === "0.0.0.0" ? "127.0.0.1" : address;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    await send(host, port, agent);
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    return await send(host, port, agent);
  } finally {
    agent.destroy();
  }
}

/**
 * Service binding the workerd suite calls to check, from Node, that the
 * loopback server carrying storage push and pop keeps idle connections open.
 */
export async function probeLoopbackKeepAlive(): Promise<Response> {
  const servers = [...state.servers].filter((server) => server.listening);
  const results = await Promise.all(
    servers.map(async (server) => ({
      keepAliveTimeout: server.keepAliveTimeout,
      idleConnectionReused: await idleConnectionReused(server),
    })),
  );
  return Response.json({ servers: results });
}
