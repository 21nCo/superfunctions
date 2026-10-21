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
  TunnelError, assertBindingRegistered, isPublicHostname, markOwnerBinding, ownerMarkerFile, readTunnelState, tunnelDirectory, tunnelPaths, writeTunnelState,
  type ConnectorRecord, type TunnelBinding, type TunnelHostname, type TunnelProvider, type TunnelState,
} from "./state.js";

const LOCK_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const LOG_LIMIT_BYTES = 1024 * 1024;

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
}

export interface TunnelStatus {
  binding: string;
  connector: "running" | "stopped" | "unverified";
  pid?: number;
  hostnames: Array<{ hostname: string; ownerId: string }>;
  pending: boolean;
  retired: number;
  /** Withdrawn names whose public reachability is not fully confirmed ended, by owner. */
  outstanding: Array<{ ownerId: string; detail: string }>;
}

interface Context {
  stateDir: string; binding: TunnelBinding; provider: TunnelProvider; port: number; readyTimeoutMs: number;
  originCa: () => Promise<string>; probeOrigin: (hostname: string, port: number, ca: string) => Promise<void>;
}

const context = (options: TunnelServiceOptions): Context => ({
  stateDir: options.stateDir, binding: options.binding, provider: options.provider ?? new CloudflareTunnelProvider(),
  port: options.originPort ?? PUBLIC_ORIGIN_PORT, readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
  originCa: options.originCa ?? caddyInternalRoot, probeOrigin: options.probeOrigin ?? probePublicOrigin,
});

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
    allowed = await originRequest(port, hostname, hostname, ca);
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

/** The origin root for a new connector configuration; the last written root while the proxy is briefly unavailable. */
async function originRoot(ctx: Context): Promise<string> {
  const file = tunnelPaths(ctx.stateDir, ctx.binding.name).originCa;
  try {
    const root = await ctx.originCa();
    if (await readFile(file, "utf8").catch(() => undefined) !== root) await writeFile(file, root, { mode: 0o600 });
    return root;
  } catch (error) {
    const saved = await readFile(file, "utf8").catch(() => undefined);
    if (saved) return saved;
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
 * Make before break: the connector for `hostnames` is ready before the one it
 * replaces is stopped, so other owners' public routes keep being served. A
 * launched connector is journaled as retired until it is committed, so one
 * that fails readiness and does not stop stays recorded. A replaced
 * connector that does not stop stays retired as well. No hostnames stops
 * the connector. Mutates and persists state.
 */
async function swapConnector(ctx: Context, state: TunnelState, hostnames: readonly string[]): Promise<void> {
  const previous = state.connector;
  if (hostnames.length) {
    const launched = await launchConnector(ctx, hostnames, async (record) => {
      state.retired.push(record);
      await writeTunnelState(ctx.stateDir, state);
    });
    state.retired = state.retired.filter((item) => !sameConnector(item, launched));
    state.connector = launched;
  } else delete state.connector;
  if (previous) state.retired.push(previous);
  await writeTunnelState(ctx.stateDir, state);
  await stopRetired(ctx, state);
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

/** Run a connector for exactly hostnames, replacing one that exited or serves another allowlist (make before break). Only publish and recovery, which have public consent, converge. */
async function converge(ctx: Context, state: TunnelState, hostnames: readonly string[]): Promise<void> {
  if (await connectorServes(ctx, state, hostnames)) return;
  if (state.connector && await connectorStatus(state.connector) !== "running") { state.retired.push(state.connector); delete state.connector; }
  await swapConnector(ctx, state, hostnames);
}

/** Whether any recorded connector may route one of hostnames. */
const mayRoute = (state: TunnelState, hostnames: readonly string[]): boolean =>
  [state.connector, ...state.retired].some((record) => record?.hostnames.some((hostname) => hostnames.includes(hostname)));

/**
 * Whether the owner's public reachability on this binding has ended: it
 * publishes nothing, and for every name it withdrew either DNS removal is
 * confirmed by readback or no recorded connector may still route it.
 */
function reachabilityEnded(state: TunnelState, ownerId: string): boolean {
  return !state.hostnames.some((item) => item.ownerId === ownerId) && state.pending?.ownerId !== ownerId &&
    state.residue.every((item) => item.ownerId !== ownerId || item.dnsRemoved || !mayRoute(state, item.hostnames));
}

/** What still keeps the owner's withdrawn names publicly reachable. */
const outstandingFor = (state: TunnelState, ownerId: string): string[] => state.residue.filter((item) => item.ownerId === ownerId).map((item) =>
  `${item.hostnames.join(", ")}: ${[...(item.dnsRemoved ? [] : ["public DNS removal is not confirmed"]), ...(mayRoute(state, item.hostnames) ? ["a connector that may route them has not stopped"] : [])].join(" and ")}`);

/**
 * Retry what keeps withdrawn names reachable. Their DNS records are removed
 * and read back. A connector still routing them is replaced make before
 * break by one for the committed names when it verifiably runs; it is kept
 * running for the other owners if that replacement fails, and stopped when
 * no committed name remains or it no longer verifiably runs. No connector is
 * started where none runs. Returns the errors met.
 */
async function finishResidue(ctx: Context, state: TunnelState): Promise<string[]> {
  const errors: string[] = [];
  for (const item of state.residue.filter((entry) => !entry.dnsRemoved)) {
    try { for (const hostname of item.hostnames) await ctx.provider.removeDns(ctx.binding, hostname); item.dnsRemoved = true; }
    catch (error) { errors.push(message(error)); }
  }
  await writeTunnelState(ctx.stateDir, state);
  const withdrawn = state.residue.flatMap((item) => item.hostnames);
  if (state.connector?.hostnames.some((hostname) => withdrawn.includes(hostname))) {
    const committed = state.hostnames.map((item) => item.hostname);
    if (committed.length && await connectorStatus(state.connector) === "running") {
      await swapConnector(ctx, state, committed).catch((error: unknown) => { errors.push(`the running connector was kept for the other public routes (${message(error)})`); });
    } else { state.retired.push(state.connector); delete state.connector; }
  }
  await stopRetired(ctx, state);
  state.residue = state.residue.filter((item) => !item.dnsRemoved || mayRoute(state, item.hostnames));
  await writeTunnelState(ctx.stateDir, state);
  return errors;
}

/**
 * Bring a binding back to its committed hostnames before any transition:
 * an interrupted publish is rolled back by withdrawing only the DNS records
 * it created (a committed name keeps its repaired record; see
 * finishResidue), and retired connectors, including any it launched, are
 * stopped. With repair, the connector is then converged to the committed
 * allowlist.
 */
async function settle(ctx: Context, state: TunnelState, repair = true): Promise<TunnelState> {
  if (state.pending) {
    const created = state.pending.createdDns.filter((hostname) => !state.hostnames.some((item) => item.hostname === hostname));
    if (created.length) state.residue.push({ ownerId: state.pending.ownerId, hostnames: created, dnsRemoved: false });
    delete state.pending;
    await writeTunnelState(ctx.stateDir, state);
  }
  await stopRetired(ctx, state);
  if (repair) await converge(ctx, state, state.hostnames.map((item) => item.hostname));
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
 * first, and the owner's publish-intent marker is written; then a
 * DevFn-owned DNS record is confirmed or created for every hostname and read
 * back, and a connector for the full allowlist replaces the running one.
 * Any failure removes only the records this call created and keeps the
 * previous connector and every committed hostname serving. Names the owner
 * no longer publishes are withdrawn once the new set is committed. Callers
 * must have the user's explicit public consent.
 */
export async function publishTunnelRoutes(options: TunnelServiceOptions, ownerId: string, hostnames: readonly string[]): Promise<TunnelHostname[]> {
  const ctx = context(options);
  const wanted = [...new Set(hostnames)].sort();
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
    const next = [...state.hostnames.filter((item) => item.ownerId !== ownerId),
      ...wanted.map((hostname) => before.find((item) => item.hostname === hostname) ?? { hostname, ownerId, publishedAt: now })]
      .sort((a, b) => a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0);
    const dropped = before.map((item) => item.hostname).filter((hostname) => !wanted.includes(hostname));
    const root = await originRoot(ctx);
    for (const hostname of wanted) await ctx.probeOrigin(hostname, ctx.port, root);
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
      await converge(ctx, state, next.map((item) => item.hostname));
    } catch (error) {
      const rollback = await settle(ctx, state).then(async () => await finishResidue(ctx, state), (rollbackError: unknown) => [message(rollbackError)]);
      if (rollback.length) {
        throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `Publishing failed (${message(error)}) and its rollback did not finish (${rollback.join("; ")}); it is journaled and retried by the next tunnel command.`);
      }
      throw error;
    }
    state.hostnames = next;
    delete state.pending;
    // A republished name is no longer withdrawn; dropped names, which the new
    // connector no longer serves, are withdrawn now and retried later.
    state.residue = state.residue.map((item) => ({ ...item, hostnames: item.hostnames.filter((hostname) => !wanted.includes(hostname)) })).filter((item) => item.hostnames.length);
    if (dropped.length) state.residue.push({ ownerId, hostnames: dropped, dnsRemoved: false });
    await writeTunnelState(ctx.stateDir, state);
    await finishResidue(ctx, state);
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
    const state = await settle(ctx, current, false);
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

/** Recover a binding (see settle and finishResidue) and report it; used after crashes and by status. */
export async function recoverTunnel(options: TunnelServiceOptions): Promise<TunnelStatus> {
  const ctx = context(options);
  await locked(ctx, async (state) => await finishResidue(ctx, await settle(ctx, state)));
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
    pending: state.pending !== undefined,
    retired: state.retired.length,
    outstanding: [...new Set(state.residue.map((item) => item.ownerId))].flatMap((ownerId) => outstandingFor(state, ownerId).map((detail) => ({ ownerId, detail }))),
  };
}
