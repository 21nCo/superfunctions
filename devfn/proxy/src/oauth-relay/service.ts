import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { withFileLock } from "@devfn/ports";
import { matchesProcessIdentity, processBirthSignature, processIdentityStatus } from "@devfn/processes";

import { CaddyProxyController, DomainError, proxyListenerPorts, readRegisteredDomains, type ProxyRoute } from "../index.js";
import {
  OAUTH_RELAY_OWNER_ID, OAUTH_RELAY_ROUTE_ID, OAuthRelayError, readRelayService, relayDirectory, relayPaths, relayTicketSummary,
  writePrivateJson, type OAuthRelayService,
} from "./state.js";

const SERVICE_LOCK_TIMEOUT_MS = 60_000;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** The proxy operations the relay service needs; a CaddyProxyController by default. */
export type OAuthRelayProxy = Pick<CaddyProxyController, "upsert" | "removeInstance" | "instanceRouteState">;

export interface StartOAuthRelayInput {
  stateDir: string;
  /** A machine-registered domain bound to this repository and project. */
  domain: string;
  /** Host label under the domain; defaults to "auth". */
  host?: string;
  projectId: string;
  repositoryIdentity: string;
  /** Relay process argv; the compiled entry under the current Node.js by default. */
  command?: readonly string[];
  proxy?: OAuthRelayProxy;
}

export interface OAuthRelayStatus {
  running: boolean;
  routeActive: boolean;
  origin?: string; hostname?: string; pid?: number;
  /** Process identity could not be read; the relay may still run. */
  unverified?: boolean;
  tickets: { valid: boolean; pending: number };
}

const defaultCommand = (): string[] => [process.execPath, fileURLToPath(new URL("./serve.js", import.meta.url))];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The relay process's status. An unreadable record is "unverified": it cannot
 * prove that no relay runs, so callers keep its route and refuse to replace it.
 */
async function serviceStatus(stateDir: string): Promise<{ service?: OAuthRelayService; status: "running" | "stopped" | "unverified" }> {
  let service: OAuthRelayService | undefined;
  try { service = await readRelayService(stateDir); }
  catch (error) { if (error instanceof OAuthRelayError) return { status: "unverified" }; throw error; }
  if (!service) return { status: "stopped" };
  const identity = await processIdentityStatus(service.pid, service.birthSignature);
  return { service, status: identity === "running" ? "running" : identity === "unverified" ? "unverified" : "stopped" };
}

/** Stop a relay process by its verified identity; false when it may still run. */
async function stopRelayProcess(service: OAuthRelayService): Promise<boolean> {
  for (const [signal, waitMs] of [["SIGTERM", 5_000], ["SIGKILL", 2_000]] as const) {
    const status = await processIdentityStatus(service.pid, service.birthSignature);
    if (status === "exited" || status === "identity-mismatch") return true;
    if (status === "unverified" || !await matchesProcessIdentity(service.pid, service.birthSignature)) return false;
    try { process.kill(process.platform === "win32" ? service.pid : -service.pid, signal); } catch { /* already exited */ }
    for (const deadline = Date.now() + waitMs; Date.now() < deadline; await delay(50)) {
      const after = await processIdentityStatus(service.pid, service.birthSignature);
      if (after === "exited" || after === "identity-mismatch") return true;
    }
  }
  return false;
}

async function launch(command: readonly string[], config: { stateDir: string; origin: string }): Promise<{ pid: number; birthSignature: string; port: number }> {
  const nonce = randomBytes(16).toString("hex");
  const child = spawn(command[0], command.slice(1), { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  child.stdin.once("error", () => undefined);
  child.stdin.end(JSON.stringify({ ...config, nonce }));
  let output = "";
  const ready = await new Promise<{ port: number } | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      try {
        const line = JSON.parse(output.slice(0, output.indexOf("\n"))) as { nonce?: unknown; port?: unknown };
        resolve(line.nonce === nonce && Number.isInteger(line.port) && (line.port as number) > 0 ? { port: line.port as number } : undefined);
      } catch { resolve(undefined); }
    });
    child.once("exit", () => { clearTimeout(timer); resolve(undefined); });
    child.once("error", () => { clearTimeout(timer); resolve(undefined); });
  });
  child.stdout.destroy();
  const birthSignature = child.pid ? await processBirthSignature(child.pid) : undefined;
  if (!ready || !child.pid || !birthSignature) {
    if (child.pid && child.exitCode === null) {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* exited */ }
    }
    throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", "The DevFn OAuth relay process did not start.");
  }
  child.unref();
  return { pid: child.pid, birthSignature, port: ready.port };
}

function relayRoute(service: OAuthRelayService, tls: ProxyRoute["tls"], certificate: { certificateFile?: string; keyFile?: string }): Omit<ProxyRoute, "updatedAt"> {
  return { id: OAUTH_RELAY_ROUTE_ID, instanceId: OAUTH_RELAY_OWNER_ID, hostname: service.hostname, targetHost: "127.0.0.1", targetPort: service.port, tls,
    registeredDomain: service.domain, projectId: service.projectId, repositoryIdentity: service.repositoryIdentity, ...certificate };
}

/**
 * Start the machine's one relay process and route `<host>.<domain>` to it.
 * The domain must be registered to the calling repository and project. A
 * relay left by a crash is replaced; a running one is reused only for the
 * same hostname. Other owners' routes and tickets are untouched.
 */
export async function startOAuthRelay(input: StartOAuthRelayInput): Promise<OAuthRelayStatus> {
  const host = input.host ?? "auth";
  if (!HOST_LABEL.test(host)) throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", "The relay host must be one lowercase DNS label of at most 40 characters.");
  // Registrations hold the canonical repository path, as domain unregistration compares.
  const repositoryIdentity = await realpath(input.repositoryIdentity).catch(() => input.repositoryIdentity);
  const registration = (await readRegisteredDomains(input.stateDir)).find((item) => item.domain === input.domain &&
    item.projectId === input.projectId && item.repositoryIdentity === repositoryIdentity);
  if (!registration) throw new DomainError("DEVFN_DOMAIN_UNREGISTERED", `Domain ${input.domain} is not registered to this repository and project.`);
  const hostname = `${host}.${registration.domain}`;
  const httpsPort = proxyListenerPorts().httpsPort;
  const origin = `https://${hostname}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
  const proxy = input.proxy ?? new CaddyProxyController(input.stateDir);
  const certificate = registration.certificateFile ? { certificateFile: registration.certificateFile, keyFile: registration.keyFile } : {};
  await relayDirectory(input.stateDir);
  return await withFileLock(relayPaths(input.stateDir).serviceLock, async () => {
    const current = await serviceStatus(input.stateDir);
    if (current.status === "unverified") throw new OAuthRelayError("DEVFN_OAUTH_RELAY_STATE_INVALID", "The recorded relay process cannot be verified; run devfn oauth-relay stop first.");
    if (current.status === "running") {
      const service = current.service!;
      if (service.hostname !== hostname || service.domain !== registration.domain || service.projectId !== registration.projectId || service.repositoryIdentity !== registration.repositoryIdentity) {
        throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", `A relay already serves ${service.origin}; stop it before serving another origin.`);
      }
      // A start interrupted after its record was written may lack its route.
      await proxy.upsert([relayRoute(service, registration.tls, certificate)], OAUTH_RELAY_OWNER_ID);
      return await oauthRelayStatus(input.stateDir, proxy);
    }
    const started = await launch(input.command ?? defaultCommand(), { stateDir: input.stateDir, origin });
    const service: OAuthRelayService = { version: 1, ...started, startedAt: new Date().toISOString(), origin, hostname,
      domain: registration.domain, projectId: registration.projectId, repositoryIdentity: registration.repositoryIdentity };
    try {
      await writePrivateJson(relayPaths(input.stateDir).service, service);
      await proxy.upsert([relayRoute(service, registration.tls, certificate)], OAUTH_RELAY_OWNER_ID);
    } catch (error) {
      // The route was not activated, so the new process and record go; a
      // prior route, if any, still names the previous (dead) relay port.
      if (await stopRelayProcess(service)) await rm(relayPaths(input.stateDir).service, { force: true });
      throw error;
    }
    return await oauthRelayStatus(input.stateDir, proxy);
  }, { timeoutMs: SERVICE_LOCK_TIMEOUT_MS });
}

/**
 * Remove the relay route first, so no callback is served, then stop the
 * relay process by verified identity. Tickets are left to expire.
 */
export async function stopOAuthRelay(stateDir: string, proxy: OAuthRelayProxy = new CaddyProxyController(stateDir)): Promise<{ stopped: boolean; routeRemoved: boolean }> {
  await relayDirectory(stateDir);
  return await withFileLock(relayPaths(stateDir).serviceLock, async () => {
    const routeRemoved = (await proxy.instanceRouteState(OAUTH_RELAY_OWNER_ID)).committed.length > 0;
    await proxy.removeInstance(OAUTH_RELAY_OWNER_ID);
    const current = await serviceStatus(stateDir);
    if (current.service && !await stopRelayProcess(current.service)) {
      throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", `The relay process (PID ${current.service.pid}) may still run but did not stop; its route is removed.`);
    }
    // An unreadable record cannot identify a process to signal; with the
    // route gone no callback reaches whatever it named.
    await rm(relayPaths(stateDir).service, { force: true });
    return { stopped: current.status === "running", routeRemoved };
  }, { timeoutMs: SERVICE_LOCK_TIMEOUT_MS });
}

export async function oauthRelayStatus(stateDir: string, proxy: Pick<OAuthRelayProxy, "instanceRouteState"> = new CaddyProxyController(stateDir)): Promise<OAuthRelayStatus> {
  const current = await serviceStatus(stateDir);
  const routes = (await proxy.instanceRouteState(OAUTH_RELAY_OWNER_ID)).committed;
  const service = current.service;
  return {
    running: current.status === "running",
    routeActive: service !== undefined && routes.some((route) => route.id === OAUTH_RELAY_ROUTE_ID && route.targetPort === service.port && route.hostname === service.hostname),
    ...(service ? { origin: service.origin, hostname: service.hostname, pid: service.pid } : {}),
    ...(current.status === "unverified" ? { unverified: true } : {}),
    tickets: await relayTicketSummary(stateDir),
  };
}

/**
 * Orphaned-route recovery for the relay owner: its route is removed only when
 * its recorded process is verifiably gone. Returns whether it was removed.
 */
export async function recoverOAuthRelayRoute(stateDir: string, proxy: Pick<OAuthRelayProxy, "removeInstance">): Promise<boolean> {
  await relayDirectory(stateDir);
  return await withFileLock(relayPaths(stateDir).serviceLock, async () => {
    if ((await serviceStatus(stateDir)).status !== "stopped") return false;
    await proxy.removeInstance(OAUTH_RELAY_OWNER_ID);
    await rm(relayPaths(stateDir).service, { force: true });
    return true;
  }, { timeoutMs: SERVICE_LOCK_TIMEOUT_MS });
}
