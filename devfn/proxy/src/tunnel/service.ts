import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

import { withFileLock } from "@devfn/ports";
import { ProcessError, ProcessSupervisor, processGroupStatus, stopProcessGroup } from "@devfn/processes";

import { PUBLIC_ORIGIN_HEADER, PUBLIC_ORIGIN_PORT } from "../index.js";
import { CloudflareTunnelProvider } from "./cloudflare.js";
import {
  TunnelError, assertBindingRegistered, compareNames, isPublicHostname, markOwnerBinding, ownerMarkerFile, readTunnelState, tunnelDirectory, tunnelPaths, writePrivateFile, writeTunnelState,
  type ConnectorRecord, type TunnelBinding, type TunnelHostname, type TunnelProvider, type TunnelResidue, type TunnelState,
} from "./state.js";

const LOCK_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const LOG_LIMIT_BYTES = 1024 * 1024;
const CERTIFICATE_WAIT_MS = 5_000;

export interface TunnelServiceOptions {
  stateDir: string;
  binding: TunnelBinding;
  provider?: TunnelProvider;
  /** PEM root that verifies the public origin's certificates; the DevFn Caddy's internal root by default. */
  originCa?: () => Promise<string>;
  /** Origin TLS and Host/SNI check of one public hostname; a real loopback TLS probe by default. */
  probeOrigin?: (hostname: string, port: number, ca: string) => Promise<void>;
  originPort?: number;
  readyTimeoutMs?: number;
  /** Whether another owner's lifecycle may still run, so a new connector may route its committed names again; none may by default. */
  ownerMayRun?: (ownerId: string) => Promise<boolean>;
}

export interface TunnelStatus {
  binding: string;
  connector: "running" | "stopped" | "unverified";
  pid?: number;
  hostnames: Array<{ hostname: string; ownerId: string }>;
  pending: boolean;
  retired: number;
  /** The hostnames the running connector routes; none unless it verifiably runs. */
  routed: string[];
  /** Withdrawn names whose public reachability is not fully confirmed ended, by owner. */
  outstanding: Array<{ ownerId: string; detail: string }>;
}

interface Context {
  stateDir: string; binding: TunnelBinding; provider: TunnelProvider; port: number; readyTimeoutMs: number;
  originCa: () => Promise<string>; probeOrigin: (hostname: string, port: number, ca: string) => Promise<void>; ownerMayRun: (ownerId: string) => Promise<boolean>;
}

const context = (options: TunnelServiceOptions): Context => ({
  stateDir: options.stateDir, binding: options.binding, provider: options.provider ?? new CloudflareTunnelProvider(),
  port: options.originPort ?? PUBLIC_ORIGIN_PORT, readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
  originCa: options.originCa ?? caddyInternalRoot, probeOrigin: options.probeOrigin ?? probePublicOrigin,
  ownerMayRun: options.ownerMayRun ?? (() => Promise.resolve(false)),
});

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isPem = (text: string | undefined): text is string => /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(text ?? "");

/** The DevFn Caddy's internal root certificate, read from its loopback admin API. */
export async function caddyInternalRoot(): Promise<string> {
  const body = await new Promise<string | undefined>((resolve) => {
    const request = http.get({ host: "127.0.0.1", port: 2019, path: "/pki/ca/local", timeout: 2_000 }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve(response.statusCode === 200 ? text : undefined));
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(undefined));
  });
  const root = (() => { try { return (JSON.parse(body ?? "") as { root_certificate?: unknown }).root_certificate; } catch { return undefined; } })();
  if (typeof root !== "string" || !root.includes("BEGIN CERTIFICATE")) throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", "The DevFn Caddy internal root is unavailable; public routes need an active DevFn proxy.");
  return root;
}

/** One HTTP/1.1 request over TLS to the loopback origin, verifying the chain against ca and the certificate against servername. */
async function originRequest(port: number, servername: string, host: string, ca: string): Promise<{ status: number; marker?: string }> {
  return await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, servername, ca, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
    socket.setTimeout(5_000, () => socket.destroy(new Error("timed out")));
    let response = "";
    socket.once("secureConnect", () => socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
      const end = response.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [statusLine, ...headers] = response.slice(0, end).split("\r\n");
      socket.destroy();
      const marker = headers.find((line) => line.toLowerCase().startsWith(`${PUBLIC_ORIGIN_HEADER.toLowerCase()}:`));
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1] ?? 0), ...(marker ? { marker: marker.slice(marker.indexOf(":") + 1).trim() } : {}) });
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed without a response")));
  });
}

/**
 * originRequest once Caddy holds a certificate for servername: Caddy issues
 * a new route's internal certificate asynchronously and refuses the
 * handshake with an internal-error alert until then. A certificate that
 * does not verify fails at once.
 */
async function issuedOriginRequest(port: number, servername: string, host: string, ca: string): Promise<Awaited<ReturnType<typeof originRequest>>> {
  const deadline = Date.now() + CERTIFICATE_WAIT_MS;
  for (;;) {
    try { return await originRequest(port, servername, host, ca); }
    catch (error) {
      if ((error as { code?: unknown }).code !== "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Validate the public origin for one hostname, independently of any local
 * loopback-domain check and of the application's own status codes: its
 * certificate verifies against the origin root for exactly that server
 * name, the request reaches that host's allowlisted site (an application
 * response or the site's own fallback, never the origin's deny response),
 * and a Host header that differs from the TLS server name is refused (421).
 */
export async function probePublicOrigin(hostname: string, port: number, ca: string): Promise<void> {
  let allowed: Awaited<ReturnType<typeof originRequest>>, forged: Awaited<ReturnType<typeof originRequest>>;
  try {
    allowed = await issuedOriginRequest(port, hostname, hostname, ca);
    forged = await originRequest(port, hostname, "devfn-forged-host.invalid", ca);
  } catch (error) {
    throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `The public origin for ${hostname} failed TLS verification: ${message(error)}.`);
  }
  if (allowed.marker === "deny") throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `The public origin does not serve ${hostname}.`);
  if (forged.status !== 421) throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `The public origin accepted a Host header that differs from ${hostname}.`);
}

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 0;
}

const connectorStatus = async (record: ConnectorRecord) => await processGroupStatus(record.pid, record.birthSignature, record.startedAt);

/** Stop a connector's process group through its verified leader; returns why it may still run. */
async function stopConnector(record: ConnectorRecord): Promise<string | undefined> {
  try { await stopProcessGroup({ pid: record.pid, birthSignature: record.birthSignature, startedAt: record.startedAt }, "The DevFn tunnel connector", STOP_TIMEOUT_MS); return undefined; }
  catch (error) { if (error instanceof ProcessError) return error.message; throw error; }
}

/**
 * The origin root for a new connector configuration; the last written root
 * while the proxy is briefly unavailable. It is replaced atomically, so an
 * interrupted write keeps the previous root, and a saved root that is not a
 * complete certificate is never used.
 */
async function originRoot(ctx: Context): Promise<string> {
  const file = tunnelPaths(ctx.stateDir, ctx.binding.name).originCa;
  try {
    const root = await ctx.originCa();
    if (await readFile(file, "utf8").catch(() => undefined) !== root) await writePrivateFile(file, root);
    return root;
  } catch (error) {
    const saved = await readFile(file, "utf8").catch(() => undefined);
    if (isPem(saved)) return saved;
    throw error;
  }
}

/** The connector configuration for hostnames and its digest, which also covers the origin root it trusts. */
async function connectorConfig(ctx: Context, hostnames: readonly string[]): Promise<{ config: string; digest: string }> {
  const root = await originRoot(ctx);
  const config = ctx.provider.renderConnectorConfig(ctx.binding, hostnames, { port: ctx.port, caFile: tunnelPaths(ctx.stateDir, ctx.binding.name).originCa });
  return { config, digest: createHash("sha256").update(config).update("\0").update(root).digest("hex") };
}

/**
 * Run a connector for exactly these hostnames once its configuration is
 * validated. It runs through the DevFn process wrapper, which leads its own
 * process group and starts the connector only after onLaunched has durably
 * recorded the wrapper's identity: an interrupted start leaves nothing
 * running or a recorded process for recovery to stop. Its environment is
 * explicit, as in validation: a private empty HOME and no ambient
 * credentials or TUNNEL_* settings that could select another tunnel.
 */
async function launchConnector(ctx: Context, hostnames: readonly string[], onLaunched: (record: ConnectorRecord) => Promise<void>): Promise<ConnectorRecord> {
  const paths = tunnelPaths(ctx.stateDir, ctx.binding.name);
  const { config, digest: configDigest } = await connectorConfig(ctx, hostnames);
  const configFile = paths.config(configDigest);
  await writeFile(configFile, config, { mode: 0o600 });
  await ctx.provider.validateConnectorConfig(ctx.binding, configFile, hostnames);
  const metricsPort = await freeLoopbackPort();
  const command = await ctx.provider.connectorCommand(ctx.binding, configFile, metricsPort);
  const home = path.join(paths.dir, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (((await stat(paths.log).catch(() => undefined))?.size ?? 0) > LOG_LIMIT_BYTES) await rename(paths.log, `${paths.log}.1`);
  let record: ConnectorRecord | undefined;
  try {
    await new ProcessSupervisor().start({ name: "connector", root: paths.dir, runtimeDir: paths.dir,
      spec: { adapter: "command", command, env: { HOME: home }, health: { type: "http", url: `http://127.0.0.1:${metricsPort}/ready`, timeoutMs: ctx.readyTimeoutMs } },
      onStarted: async (managed) => {
        record = { pid: managed.pid, birthSignature: managed.birthSignature!, startedAt: managed.startedAt, configDigest, metricsPort, hostnames: [...hostnames] };
        await onLaunched(record);
      } });
  } catch (error) {
    throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `The tunnel connector did not become ready (${message(error)}); see ${paths.log}.`, record ? { pid: record.pid } : undefined);
  }
  return record!;
}

const sameConnector = (a: ConnectorRecord, b: ConnectorRecord): boolean => a.pid === b.pid && a.birthSignature === b.birthSignature;

/**
 * Commit a transition built on candidate, a copy of state: state becomes the
 * candidate only once it is durable, so after a failed write it is still the
 * last durable state, which rollback and recovery read.
 */
async function commitState(ctx: Context, state: TunnelState, candidate: TunnelState): Promise<void> {
  await writeTunnelState(ctx.stateDir, candidate);
  for (const key of Object.keys(state) as Array<keyof TunnelState>) delete state[key];
  Object.assign(state, candidate);
}

/**
 * Make before break: the connector for `hostnames` is ready before the one it
 * replaces is stopped, so other owners' public routes keep being served. A
 * launched connector is journaled as retired until it is promoted, so one
 * that fails readiness and does not stop stays recorded. It is promoted, and
 * its predecessor retired, in the same write that applies commit, the
 * transition's committed hostnames (commitState): until that write succeeds
 * the predecessor serves the previous committed set and the transition has
 * failed. After it, the transition stands; a replaced connector that does
 * not stop, or whose stop is not recorded, stays retired for the next
 * transition. No hostnames stops the connector. Mutates and persists state.
 */
async function swapConnector(ctx: Context, state: TunnelState, hostnames: readonly string[], commit?: (draft: TunnelState) => void): Promise<void> {
  let launched: ConnectorRecord | undefined;
  if (hostnames.length) {
    await assertSoleConnector(state);
    launched = await launchConnector(ctx, hostnames, async (record) => {
      state.retired.push(record);
      await writeTunnelState(ctx.stateDir, state);
    });
  }
  const candidate = structuredClone(state);
  candidate.retired = [...candidate.retired.filter((item) => !launched || !sameConnector(item, launched)), ...(candidate.connector ? [candidate.connector] : [])];
  if (launched) candidate.connector = launched; else delete candidate.connector;
  commit?.(candidate);
  await commitState(ctx, state, candidate);
  await stopRetired(ctx, state).catch(() => undefined);
}

/** The launch predicate: no recorded connector but a verifiably running predecessor (replaced make before break) may still run, as two connectors on one tunnel split its requests. */
async function assertSoleConnector(state: TunnelState): Promise<void> {
  for (const record of [state.connector, ...state.retired]) {
    const status = record ? await connectorStatus(record) : "exited";
    if (status === "unverified" || (status === "running" && record !== state.connector)) {
      throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `A previous tunnel connector (PID ${record!.pid}) may still run; stop its process group before another connector starts.`);
    }
  }
}

/** Stop every retired connector; one that does not stop stays recorded. Configurations no recorded connector runs are removed. */
async function stopRetired(ctx: Context, state: TunnelState): Promise<void> {
  const kept: ConnectorRecord[] = [];
  for (const record of state.retired) if (await stopConnector(record)) kept.push(record);
  if (kept.length !== state.retired.length) { state.retired = kept; await writeTunnelState(ctx.stateDir, state); }
  const paths = tunnelPaths(ctx.stateDir, ctx.binding.name);
  const used = new Set([state.connector, ...state.retired].flatMap((item) => item ? [path.basename(paths.config(item.configDigest))] : []));
  for (const name of await readdir(paths.dir)) if (/^connector-[a-f0-9]{64}\.yml$/.test(name) && !used.has(name)) await rm(path.join(paths.dir, name), { force: true });
}

/** Whether the recorded connector runs exactly the allowlist for hostnames; none runs for no hostnames. */
async function connectorServes(ctx: Context, state: TunnelState, hostnames: readonly string[]): Promise<boolean> {
  if (!state.connector) return !hostnames.length;
  const status = await connectorStatus(state.connector);
  if (status === "unverified") throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `The recorded tunnel connector (PID ${state.connector.pid}) cannot be verified.`);
  return status === "running" && hostnames.length > 0 && state.connector.configDigest === (await connectorConfig(ctx, hostnames)).digest;
}

/** Run a connector for exactly hostnames, replacing one that exited or serves another allowlist (make before break), then apply and persist commit. Only publish and recovery converge, after verifying the tunnel and choosing hostnames with relaunchable. */
async function converge(ctx: Context, state: TunnelState, hostnames: readonly string[], commit?: (draft: TunnelState) => void): Promise<void> {
  if (await connectorServes(ctx, state, hostnames)) {
    const candidate = structuredClone(state);
    commit?.(candidate);
    await commitState(ctx, state, candidate);
    return;
  }
  if (state.connector && await connectorStatus(state.connector) !== "running") { state.retired.push(state.connector); delete state.connector; }
  await swapConnector(ctx, state, hostnames, commit);
}

/** Whether any recorded connector may route one of hostnames. */
const mayRoute = (state: TunnelState, hostnames: readonly string[]): boolean =>
  [state.connector, ...state.retired].some((record) => record?.hostnames.some((hostname) => hostnames.includes(hostname)));

/** A withdrawal with nothing left to do: its DNS is removed, or not DevFn's to remove, and no recorded connector may route its names. */
const residueDone = (state: TunnelState, item: TunnelResidue): boolean => (item.dnsRemoved || item.keepDns === true) && !mayRoute(state, item.hostnames);

/** Journal committed names as their owners' withdrawals. */
function withdrawNames(state: TunnelState, items: readonly TunnelHostname[]): void {
  state.hostnames = state.hostnames.filter((item) => !items.some((other) => other.hostname === item.hostname));
  for (const ownerId of new Set(items.map((item) => item.ownerId))) state.residue.push({ ownerId, hostnames: items.filter((item) => item.ownerId === ownerId).map((item) => item.hostname), dnsRemoved: false });
}

/**
 * Split committed names into those a new connector may route and stale ones
 * to withdraw. A launch never makes a name reachable without its owner: a
 * name stays only while a verifiably running connector already routes it,
 * or while its owner may still run and its origin passes the probe in this
 * transition. So a publish never makes a dead owner's names public again.
 */
async function relaunchable(ctx: Context, state: TunnelState, items: readonly TunnelHostname[]): Promise<{ keep: TunnelHostname[]; stale: TunnelHostname[] }> {
  const routed = state.connector && await connectorStatus(state.connector) === "running" ? state.connector.hostnames : [];
  const keep: TunnelHostname[] = [], stale: TunnelHostname[] = [];
  for (const item of items) {
    let ok = routed.includes(item.hostname);
    if (!ok && await ctx.ownerMayRun(item.ownerId)) { const root = await originRoot(ctx); ok = await ctx.probeOrigin(item.hostname, ctx.port, root).then(() => true, () => false); }
    (ok ? keep : stale).push(item);
  }
  return { keep, stale };
}

/**
 * Whether the owner's public reachability on this binding has ended: it
 * publishes nothing and no recorded connector may still route a name it
 * withdrew. Confirmed DNS removal is not enough: cached resolutions and
 * established connections keep reaching a connector that routes the name.
 */
function reachabilityEnded(state: TunnelState, ownerId: string): boolean {
  return !state.hostnames.some((item) => item.ownerId === ownerId) && state.pending?.ownerId !== ownerId &&
    state.residue.every((item) => item.ownerId !== ownerId || !mayRoute(state, item.hostnames));
}

/** What still keeps the owner's withdrawn names publicly reachable. */
const outstandingFor = (state: TunnelState, ownerId: string): string[] => state.residue.filter((item) => item.ownerId === ownerId).map((item) =>
  `${item.hostnames.join(", ")}: ${[...(item.dnsRemoved || item.keepDns ? [] : ["public DNS removal is not confirmed"]), ...(mayRoute(state, item.hostnames) ? ["a connector that may route them has not stopped"] : [])].join(" and ")}`);

/**
 * Retry what keeps withdrawn names reachable. Their DNS records are removed
 * and read back. A connector still routing them is replaced make before
 * break by one for the committed names it already routes when it verifiably
 * runs, so the replacement makes no name newly reachable; it is kept
 * running for the other owners if that replacement fails, and stopped when
 * no committed name remains or it exited; an unverifiable one stays the
 * recorded connector. No connector is started where none runs. Returns the
 * errors met.
 */
async function finishResidue(ctx: Context, state: TunnelState): Promise<string[]> {
  const errors: string[] = [];
  for (const item of state.residue.filter((entry) => !entry.dnsRemoved && !entry.keepDns)) {
    try { for (const hostname of item.hostnames) await ctx.provider.removeDns(ctx.binding, hostname); item.dnsRemoved = true; }
    catch (error) { errors.push(message(error)); }
  }
  await writeTunnelState(ctx.stateDir, state);
  const withdrawn = state.residue.flatMap((item) => item.hostnames);
  if (state.connector?.hostnames.some((hostname) => withdrawn.includes(hostname))) {
    const committed = state.hostnames.map((item) => item.hostname).filter((hostname) => state.connector!.hostnames.includes(hostname));
    const status = await connectorStatus(state.connector);
    // An unverifiable connector stays recorded, so no other connector starts beside it.
    if (committed.length && status === "running") {
      await swapConnector(ctx, state, committed).catch((error: unknown) => { errors.push(`the running connector was kept for the other public routes (${message(error)})`); });
    } else if (status !== "unverified") { state.retired.push(state.connector); delete state.connector; }
  }
  await stopRetired(ctx, state);
  state.residue = state.residue.filter((item) => !residueDone(state, item));
  await writeTunnelState(ctx.stateDir, state);
  return errors;
}

/**
 * After a swap interrupted before its old connector stopped, the new one
 * may have exited while the old one still serves committed names: a
 * retired connector that verifiably runs, routes a committed name and
 * otherwise only names journaled as withdrawn becomes the recorded
 * connector again. It keeps serving until a replacement is ready instead
 * of being stopped; finishResidue then replaces it make before break.
 */
async function restoreFallback(state: TunnelState): Promise<boolean> {
  if (state.connector && ["running", "unverified"].includes(await connectorStatus(state.connector))) return false;
  const committed = new Set(state.hostnames.map((item) => item.hostname));
  const known = new Set([...committed, ...state.residue.flatMap((item) => item.hostnames)]);
  for (const record of [...state.retired].reverse()) {
    if (!record.hostnames.some((hostname) => committed.has(hostname)) || !record.hostnames.every((hostname) => known.has(hostname)) || await connectorStatus(record) !== "running") continue;
    state.retired = [...state.retired.filter((item) => !sameConnector(item, record)), ...(state.connector ? [state.connector] : [])];
    state.connector = record;
    return true;
  }
  return false;
}

/**
 * Bring a binding back to its committed hostnames before any transition.
 * An interrupted publish is journaled as a withdrawal of its owner, so no
 * recorded connector routes a name that is neither committed nor
 * journaled: the DNS records it created are removed (a committed name keeps
 * its repaired record), and an uncommitted name that a connector it
 * launched may already route stays journaled until no connector routes it.
 * Such a name's DevFn-owned record that existed before the publish is kept,
 * like every record the publish did not create. Retired connectors,
 * including any it launched, are stopped, except a running fallback for the
 * committed names (restoreFallback). No connector is launched here.
 * finishResidue completes the rest.
 */
async function settle(ctx: Context, state: TunnelState): Promise<TunnelState> {
  if (state.pending) {
    const { ownerId, hostnames, createdDns } = state.pending;
    const uncommitted = (hostname: string) => !state.hostnames.some((item) => item.hostname === hostname);
    const created = createdDns.filter(uncommitted);
    const routed = hostnames.filter((hostname) => uncommitted(hostname) && !created.includes(hostname) && mayRoute(state, [hostname]));
    if (created.length) state.residue.push({ ownerId, hostnames: created, dnsRemoved: false });
    if (routed.length) state.residue.push({ ownerId, hostnames: routed, dnsRemoved: false, keepDns: true });
    delete state.pending;
    await writeTunnelState(ctx.stateDir, state);
  }
  if (await restoreFallback(state)) await writeTunnelState(ctx.stateDir, state);
  await stopRetired(ctx, state);
  const residue = state.residue.filter((item) => !residueDone(state, item));
  if (residue.length !== state.residue.length) { state.residue = residue; await writeTunnelState(ctx.stateDir, state); }
  return state;
}

async function locked<T>(ctx: Context, action: (state: TunnelState) => Promise<T>): Promise<T> {
  await tunnelDirectory(ctx.stateDir, ctx.binding.name);
  return await withFileLock(tunnelPaths(ctx.stateDir, ctx.binding.name).lock, async () => {
    await assertBindingRegistered(ctx.stateDir, ctx.binding);
    return await action(await readTunnelState(ctx.stateDir, ctx.binding.name));
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

/**
 * Publish exactly these public hostnames for one lifecycle owner, replacing
 * the owner's previous set. The origin and the provider tunnel are checked
 * first, other owners' names the new connector may not route are chosen
 * (relaunchable) and withdrawn on commit, and the owner's publish-intent
 * marker is written; then a
 * DevFn-owned DNS record is confirmed or created for every hostname and read
 * back, and a connector for the full allowlist replaces the running one.
 * Any failure removes only the records this call created and keeps the
 * previous connector and every committed hostname serving. Names the owner
 * no longer publishes are withdrawn once the new set is committed. Callers
 * must have the user's explicit public consent.
 */
export async function publishTunnelRoutes(options: TunnelServiceOptions, ownerId: string, hostnames: readonly string[]): Promise<TunnelHostname[]> {
  const ctx = context(options);
  const wanted = [...new Set(hostnames)].sort(compareNames);
  ownerMarkerFile(ctx.stateDir, ownerId);
  if (!wanted.length || wanted.length !== hostnames.length || wanted.some((hostname) => !isPublicHostname(hostname, ctx.binding.domain))) {
    throw new TunnelError("DEVFN_TUNNEL_INVALID", `Public hostnames must be distinct labels directly under ${ctx.binding.domain}.`);
  }
  return await locked(ctx, async (current) => {
    const state = await settle(ctx, current);
    const taken = [...state.hostnames, ...state.residue.flatMap((item) => item.hostnames.map((hostname) => ({ hostname, ownerId: item.ownerId })))]
      .find((item) => wanted.includes(item.hostname) && item.ownerId !== ownerId);
    if (taken) throw new TunnelError("DEVFN_TUNNEL_CONFLICT", `${taken.hostname} is published by another owner.`);
    const before = state.hostnames.filter((item) => item.ownerId === ownerId);
    const now = new Date().toISOString();
    const root = await originRoot(ctx);
    for (const hostname of wanted) await ctx.probeOrigin(hostname, ctx.port, root);
    const { keep, stale } = await relaunchable(ctx, state, state.hostnames.filter((item) => item.ownerId !== ownerId));
    const next = [...keep,
      ...wanted.map((hostname) => before.find((item) => item.hostname === hostname) ?? { hostname, ownerId, publishedAt: now })]
      .sort((a, b) => compareNames(a.hostname, b.hostname));
    const dropped = before.map((item) => item.hostname).filter((hostname) => !wanted.includes(hostname));
    await ctx.provider.verifyTunnel(ctx.binding);
    await markOwnerBinding(ctx.stateDir, ownerId, ctx.binding.name, true);
    state.pending = { kind: "publish", ownerId, hostnames: wanted, next, createdDns: [] };
    await writeTunnelState(ctx.stateDir, state);
    try {
      for (const hostname of wanted) {
        // Only a create after a successful read showed no DevFn-owned record
        // is journaled, before the call, so an interrupted create is still
        // removed. A failed read aborts first; an existing record, including
        // a committed name's or one that does not verify, is never journaled.
        if (await ctx.provider.ownsDns(ctx.binding, hostname)) { await ctx.provider.ensureDns(ctx.binding, hostname); continue; }
        state.pending.createdDns.push(hostname);
        await writeTunnelState(ctx.stateDir, state);
        let result: "created" | "existing";
        try { result = await ctx.provider.ensureDns(ctx.binding, hostname); }
        catch (error) {
          // A conflict is reported before any record is created: that name is never removed.
          if ((error as { code?: unknown }).code === "DEVFN_TUNNEL_CONFLICT") { state.pending.createdDns.pop(); await writeTunnelState(ctx.stateDir, state); }
          throw error;
        }
        // A record that appeared after the read is not this call's to remove.
        if (result === "existing") { state.pending.createdDns.pop(); await writeTunnelState(ctx.stateDir, state); }
      }
      for (const hostname of wanted) await ctx.provider.verifyDns(ctx.binding, hostname);
      // The new set is committed in the write that promotes its connector;
      // the publish has failed, and is rolled back, unless that write succeeds.
      // A republished name is no longer withdrawn; dropped names, which the
      // new connector no longer serves, are withdrawn then and retried later.
      await converge(ctx, state, next.map((item) => item.hostname), (draft) => {
        withdrawNames(draft, stale);
        draft.hostnames = next;
        delete draft.pending;
        draft.residue = draft.residue.map((item) => ({ ...item, hostnames: item.hostnames.filter((hostname) => !wanted.includes(hostname)) })).filter((item) => item.hostnames.length);
        if (dropped.length) draft.residue.push({ ownerId, hostnames: dropped, dnsRemoved: false });
      });
    } catch (error) {
      const rollback = await settle(ctx, state).then(async () => await finishResidue(ctx, state), (rollbackError: unknown) => [message(rollbackError)]);
      if (rollback.length) {
        throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `Publishing failed (${message(error)}) and its rollback did not finish (${rollback.join("; ")}); it is journaled and retried by the next tunnel command.`);
      }
      throw error;
    }
    // The publish is committed; what finishResidue cannot finish stays journaled for the next tunnel command.
    await finishResidue(ctx, state).catch(() => undefined);
    return next.filter((item) => item.ownerId === ownerId);
  });
}

export interface TunnelWithdrawal { withdrawn: string[]; outstanding: string[] }

/**
 * Stop publishing every hostname of one owner. An interrupted publish is
 * rolled back without restarting any connector. The owner's names are
 * journaled as withdrawn, their DNS records removed and the connector
 * replaced without them (see finishResidue); other owners' records and
 * service are never reduced and no connector is started where none runs.
 * Succeeds once the owner's public reachability has ended (reachabilityEnded),
 * reporting in outstanding what is still journaled and retried; fails, with
 * everything journaled, while it has not. The owner's publish-intent marker
 * for the binding is cleared once nothing is outstanding.
 */
export async function withdrawTunnelRoutes(options: TunnelServiceOptions, ownerId: string): Promise<TunnelWithdrawal> {
  const ctx = context(options);
  return await locked(ctx, async (current) => {
    const state = await settle(ctx, current);
    const withdrawn = state.hostnames.filter((item) => item.ownerId === ownerId).map((item) => item.hostname);
    if (withdrawn.length) {
      state.hostnames = state.hostnames.filter((item) => item.ownerId !== ownerId);
      state.residue.push({ ownerId, hostnames: withdrawn, dnsRemoved: false });
      await writeTunnelState(ctx.stateDir, state);
    }
    const errors = await finishResidue(ctx, state);
    const outstanding = outstandingFor(state, ownerId);
    if (!reachabilityEnded(state, ownerId)) {
      throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `Public routes ${outstanding.join("; ")}${errors.length ? ` (${errors.join("; ")})` : ""}; the withdrawal is journaled and retried by the next tunnel command.`);
    }
    if (!outstanding.length) await markOwnerBinding(ctx.stateDir, ownerId, ctx.binding.name, false);
    return { withdrawn, outstanding: outstanding.length ? [...outstanding, ...errors] : [] };
  });
}

/**
 * Recover a binding (see settle and finishResidue), then run a connector for
 * the committed names that are still relaunchable; the rest are withdrawn.
 * While any name is kept, the provider tunnel is verified first, then every
 * kept name has its DevFn-owned DNS record confirmed, or recreated, and read
 * back; a name whose DNS does not verify fails the recovery before any
 * launch. Reports the binding.
 */
export async function recoverTunnel(options: TunnelServiceOptions): Promise<TunnelStatus> {
  const ctx = context(options);
  await locked(ctx, async (current) => {
    const state = await settle(ctx, current);
    const { keep, stale } = await relaunchable(ctx, state, state.hostnames);
    withdrawNames(state, stale);
    await writeTunnelState(ctx.stateDir, state);
    await finishResidue(ctx, state);
    const names = keep.map((item) => item.hostname);
    if (names.length) await ctx.provider.verifyTunnel(ctx.binding);
    for (const hostname of names) await ctx.provider.ensureDns(ctx.binding, hostname);
    if (await connectorServes(ctx, state, names)) return;
    await converge(ctx, state, names);
  });
  return await tunnelStatus(options);
}

/** Lock-free report of a binding's published hostnames, connector and withdrawals still outstanding. */
export async function tunnelStatus(options: Pick<TunnelServiceOptions, "stateDir" | "binding">): Promise<TunnelStatus> {
  const state = await readTunnelState(options.stateDir, options.binding.name);
  const status = state.connector ? await connectorStatus(state.connector) : "exited";
  return {
    binding: options.binding.name,
    connector: status === "running" ? "running" : status === "unverified" ? "unverified" : "stopped",
    ...(state.connector && status === "running" ? { pid: state.connector.pid } : {}),
    hostnames: state.hostnames.map(({ hostname, ownerId }) => ({ hostname, ownerId })),
    routed: state.connector && status === "running" ? [...state.connector.hostnames] : [],
    pending: state.pending !== undefined,
    retired: state.retired.length,
    outstanding: [...new Set(state.residue.map((item) => item.ownerId))].flatMap((ownerId) => outstandingFor(state, ownerId).map((detail) => ({ ownerId, detail }))),
  };
}
