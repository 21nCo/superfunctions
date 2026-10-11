import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FilePortRegistry, withFileLock } from "@devfn/ports";
import { matchesProcessIdentity, processBirthSignature, processIdentityStatus } from "@devfn/processes";

import { CaddyProxyController, DomainError, proxyListenerPorts, proxyListenerPortsFor, readRegisteredDomains, type ProxyRoute } from "../index.js";
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

type ProcessIdentity = { pid: number; birthSignature?: string; recordedAt?: string };
const identityStatus = async (identity: ProcessIdentity) => await processIdentityStatus(identity.pid, identity.birthSignature, identity.recordedAt);
const mayRun = (status: string) => status === "running" || status === "unverified";

const registryOf = (stateDir: string) => new FilePortRegistry(path.join(stateDir, "registry.json"));

/**
 * Every relay process identity recorded outside service.json: on the relay's
 * committed and pending routes and on its registry claims that have not
 * stopped. A committed relay always has its registry owner recorded.
 */
async function recordedIdentities(stateDir: string, proxy: Pick<OAuthRelayProxy, "instanceRouteState">): Promise<ProcessIdentity[]> {
  const routes = await proxy.instanceRouteState(OAUTH_RELAY_OWNER_ID);
  const fromRoutes = [...routes.committed, ...(routes.pending ?? [])].flatMap((route) => route.serviceProcess ? [route.serviceProcess] : []);
  const fromRegistry = (await registryOf(stateDir).read()).invocations
    .filter((item) => item.instanceId === OAUTH_RELAY_OWNER_ID && item.state !== "stopped")
    .flatMap((item) => (item.owners ?? []).flatMap((owner) => owner.process ? [owner.process] : []));
  return [...new Map([...fromRoutes, ...fromRegistry].map((item) => [`${item.pid}:${item.birthSignature}`, item])).values()];
}

/**
 * The relay process's status, decided from every recorded identity: the
 * service record, the relay routes and the relay's registry claims. It is
 * "stopped" only when every one is verifiably gone; an unreadable record, an
 * unverifiable identity, or a live identity the record does not name is
 * "unverified", so callers keep its route and refuse to replace it.
 */
async function serviceStatus(stateDir: string, proxy: Pick<OAuthRelayProxy, "instanceRouteState">): Promise<{ service?: OAuthRelayService; status: "running" | "stopped" | "unverified" }> {
  let service: OAuthRelayService | undefined;
  let unreadable = false;
  try { service = await readRelayService(stateDir); }
  catch (error) { if (!(error instanceof OAuthRelayError)) throw error; unreadable = true; }
  for (const identity of await recordedIdentities(stateDir, proxy)) {
    if (service && identity.pid === service.pid && identity.birthSignature === service.birthSignature) continue;
    if (mayRun(await identityStatus(identity))) return { service, status: "unverified" };
  }
  if (unreadable) return { status: "unverified" };
  if (!service) return { status: "stopped" };
  const status = await identityStatus(service);
  return { service, status: status === "running" ? "running" : status === "unverified" ? "unverified" : "stopped" };
}

/** Stop a relay process by its verified identity; false when it may still run. */
async function stopRelayProcess(identity: ProcessIdentity): Promise<boolean> {
  for (const [signal, waitMs] of [["SIGTERM", 5_000], ["SIGKILL", 2_000]] as const) {
    const status = await identityStatus(identity);
    if (status === "exited" || status === "identity-mismatch") return true;
    if (status === "unverified" || !await matchesProcessIdentity(identity.pid, identity.birthSignature, identity.recordedAt)) return false;
    try { process.kill(process.platform === "win32" ? identity.pid : -identity.pid, signal); } catch { /* already exited */ }
    for (const deadline = Date.now() + waitMs; Date.now() < deadline; await delay(50)) {
      const after = await identityStatus(identity);
      if (after === "exited" || after === "identity-mismatch") return true;
    }
  }
  return false;
}

interface LaunchedRelay { pid: number; birthSignature: string; port: number; commit: () => void; abandon: () => void }

/**
 * Launch a relay process and wait for its listener. The relay keeps running
 * only after commit(), which the starter sends once the relay is durably
 * recorded; a starter that dies first closes the relay's stdin, and the
 * relay exits.
 */
async function launch(command: readonly string[], config: { stateDir: string; origin: string }): Promise<LaunchedRelay> {
  const nonce = randomBytes(16).toString("hex");
  const child = spawn(command[0], command.slice(1), { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  child.stdin.once("error", () => undefined);
  child.stdin.write(`${JSON.stringify({ ...config, nonce })}\n`);
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
    child.stdin.destroy();
    if (child.pid && child.exitCode === null) {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* exited */ }
    }
    throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", "The DevFn OAuth relay process did not start.");
  }
  child.unref();
  return { pid: child.pid, birthSignature, port: ready.port, commit: () => child.stdin.end("commit\n"), abandon: () => child.stdin.destroy() };
}

function relayRoute(service: OAuthRelayService, tls: ProxyRoute["tls"], certificate: { certificateFile?: string; keyFile?: string }): Omit<ProxyRoute, "updatedAt"> {
  return { id: OAUTH_RELAY_ROUTE_ID, instanceId: OAUTH_RELAY_OWNER_ID, hostname: service.hostname, targetHost: "127.0.0.1", targetPort: service.port, tls,
    registeredDomain: service.domain, projectId: service.projectId, repositoryIdentity: service.repositoryIdentity, ...certificate,
    // Any later route transition drops this route once the relay is verified gone.
    serviceProcess: { pid: service.pid, birthSignature: service.birthSignature } };
}

/**
 * Claim the proxy listener ports for the relay route as a registry lifecycle
 * of the relay owner, as every routed lifecycle does: a sibling's planned or
 * active lease on either port refuses the claim and names its owner.
 */
async function claimListeners(stateDir: string, projectId: string, tls: ProxyRoute["tls"]): Promise<string> {
  const invocationId = randomUUID();
  await registryOf(stateDir).reserve({ projectId, instanceId: OAUTH_RELAY_OWNER_ID, invocationId, profile: "oauth-relay", requests: [],
    proxyListenerPorts: proxyListenerPortsFor([{ tls }]) });
  return invocationId;
}

/**
 * End the relay's listener claims other than keep, once the processes they
 * record are stopped or covered by keep; the shared evidence rule decides
 * whether one is retained.
 */
async function releaseClaims(stateDir: string, keep?: string): Promise<void> {
  const registry = registryOf(stateDir);
  for (const invocation of (await registry.read()).invocations) {
    if (invocation.instanceId !== OAUTH_RELAY_OWNER_ID || invocation.id === keep || ["failed", "stopped"].includes(invocation.state)) continue;
    await registry.release({ invocationId: invocation.id });
  }
}

/** Record the relay process on its claim, then mark the claim ready. */
async function activateClaim(stateDir: string, service: OAuthRelayService): Promise<void> {
  const registry = registryOf(stateDir);
  await registry.recordOwners(service.invocationId, "oauth-relay", [{ process: { pid: service.pid, birthSignature: service.birthSignature, recordedAt: service.startedAt } }]);
  await registry.markActive(service.invocationId);
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
    const current = await serviceStatus(input.stateDir, proxy);
    if (current.status === "unverified") throw new OAuthRelayError("DEVFN_OAUTH_RELAY_STATE_INVALID", "The recorded relay process cannot be verified; run devfn oauth-relay stop first.");
    if (current.status === "running") {
      const service = current.service!;
      if (service.hostname !== hostname || service.domain !== registration.domain || service.projectId !== registration.projectId || service.repositoryIdentity !== registration.repositoryIdentity) {
        throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", `A relay already serves ${service.origin}; stop it before serving another origin.`);
      }
      // A start interrupted after its record was written may lack its claim or route.
      const claimed = (await registryOf(input.stateDir).read()).invocations.some((item) => item.id === service.invocationId && item.state === "ready");
      let reused = service;
      if (!claimed) {
        reused = { ...service, invocationId: await claimListeners(input.stateDir, registration.projectId, registration.tls) };
        await activateClaim(input.stateDir, reused);
        await writePrivateJson(relayPaths(input.stateDir).service, reused);
      }
      await proxy.upsert([relayRoute(reused, registration.tls, certificate)], OAUTH_RELAY_OWNER_ID);
      await releaseClaims(input.stateDir, reused.invocationId);
      return await relayStatus(input.stateDir, proxy);
    }
    // The listener claim comes first: a conflicting sibling lease refuses the
    // start before any relay process or route exists.
    const invocationId = await claimListeners(input.stateDir, registration.projectId, registration.tls);
    let service: OAuthRelayService | undefined;
    let started: LaunchedRelay | undefined;
    try {
      started = await launch(input.command ?? defaultCommand(), { stateDir: input.stateDir, origin });
      service = { version: 1, pid: started.pid, birthSignature: started.birthSignature, port: started.port, startedAt: new Date().toISOString(), origin, hostname,
        domain: registration.domain, projectId: registration.projectId, repositoryIdentity: registration.repositoryIdentity, invocationId };
      // Recorded on the service record and the claim before the relay is
      // committed, so a relay that outlives an interrupted start is one the
      // next command can find; an uncommitted relay exits with its starter.
      await writePrivateJson(relayPaths(input.stateDir).service, service);
      await activateClaim(input.stateDir, service);
      started.commit();
      await proxy.upsert([relayRoute(service, registration.tls, certificate)], OAUTH_RELAY_OWNER_ID);
    } catch (error) {
      // The route was not activated, so the new process, record and claim go;
      // a prior route, if any, still names the previous (dead) relay.
      started?.abandon();
      if (!service || await stopRelayProcess(service)) {
        if (service) await rm(relayPaths(input.stateDir).service, { force: true });
        await registryOf(input.stateDir).release({ invocationId, errorCode: "DEVFN_START_FAILED" });
      }
      throw error;
    }
    // A crashed relay's claim is covered by this one, so it ends without being retained.
    await releaseClaims(input.stateDir, invocationId);
    return await relayStatus(input.stateDir, proxy);
  }, { timeoutMs: SERVICE_LOCK_TIMEOUT_MS });
}

/**
 * Remove the relay route first, so no callback is served, then stop every
 * recorded relay process by verified identity and end the relay's listener
 * claims. Tickets are left to expire. An unreadable service record is left
 * for inspection and reported as DEVFN_OAUTH_RELAY_STATE_INVALID, after the
 * processes the routes and claims name are stopped.
 */
export async function stopOAuthRelay(stateDir: string, proxy: OAuthRelayProxy = new CaddyProxyController(stateDir)): Promise<{ stopped: boolean; routeRemoved: boolean }> {
  await relayDirectory(stateDir);
  return await withFileLock(relayPaths(stateDir).serviceLock, async () => {
    const routeRemoved = (await proxy.instanceRouteState(OAUTH_RELAY_OWNER_ID)).committed.length > 0;
    // Read before the route that carries one of them is removed.
    const identities = await recordedIdentities(stateDir, proxy);
    await proxy.removeInstance(OAUTH_RELAY_OWNER_ID);
    let service: OAuthRelayService | undefined;
    let unreadable = false;
    try { service = await readRelayService(stateDir); }
    catch (error) { if (!(error instanceof OAuthRelayError)) throw error; unreadable = true; }
    if (service && !identities.some((item) => item.pid === service.pid && item.birthSignature === service.birthSignature)) identities.unshift(service);
    let stopped = false;
    for (const identity of identities) {
      stopped ||= await identityStatus(identity) === "running";
      if (!await stopRelayProcess(identity)) {
        throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", `The relay process (PID ${identity.pid}) may still run but did not stop; its route is removed.`);
      }
    }
    await releaseClaims(stateDir);
    if (unreadable) {
      throw new OAuthRelayError("DEVFN_OAUTH_RELAY_STATE_INVALID", `The relay route is removed and every relay process its route and claims record is stopped, but ${relayPaths(stateDir).service} is unreadable and was left for inspection; remove it once no relay process runs.`);
    }
    await rm(relayPaths(stateDir).service, { force: true });
    return { stopped, routeRemoved };
  }, { timeoutMs: SERVICE_LOCK_TIMEOUT_MS });
}

async function relayStatus(stateDir: string, proxy: Pick<OAuthRelayProxy, "instanceRouteState">): Promise<OAuthRelayStatus> {
  const current = await serviceStatus(stateDir, proxy);
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
 * The relay's status. A route left by a relay verified gone is removed
 * first, so status never reports, or leaves, a route to a dead relay.
 */
export async function oauthRelayStatus(stateDir: string, proxy: Pick<OAuthRelayProxy, "instanceRouteState" | "removeInstance"> = new CaddyProxyController(stateDir)): Promise<OAuthRelayStatus> {
  await recoverOAuthRelayRoute(stateDir, proxy);
  return await relayStatus(stateDir, proxy);
}

/**
 * Orphaned-route recovery for the relay owner: its route, service record and
 * listener claims are removed only when every recorded relay process is
 * verifiably gone. Returns whether a route was removed. A relay command
 * holding the service lock past lockTimeoutMs fails with
 * DEVFN_REGISTRY_LOCK_TIMEOUT.
 */
export async function recoverOAuthRelayRoute(stateDir: string, proxy: Pick<OAuthRelayProxy, "instanceRouteState" | "removeInstance">, options: { lockTimeoutMs?: number } = {}): Promise<boolean> {
  await relayDirectory(stateDir);
  return await withFileLock(relayPaths(stateDir).serviceLock, async () => {
    if ((await serviceStatus(stateDir, proxy)).status !== "stopped") return false;
    const state = await proxy.instanceRouteState(OAUTH_RELAY_OWNER_ID);
    const routed = state.committed.length > 0 || Boolean(state.pending?.length);
    if (routed) await proxy.removeInstance(OAUTH_RELAY_OWNER_ID);
    await rm(relayPaths(stateDir).service, { force: true });
    await releaseClaims(stateDir);
    return routed;
  }, { timeoutMs: options.lockTimeoutMs ?? SERVICE_LOCK_TIMEOUT_MS });
}
