import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

import { withFileLock } from "@devfn/ports";
import { ProcessError, processBirthSignature, processGroupStatus, stopProcessGroup } from "@devfn/processes";

import { PUBLIC_ORIGIN_PORT } from "../index.js";
import { CloudflareTunnelProvider } from "./cloudflare.js";
import {
  TunnelError, isPublicHostname, readTunnelState, tunnelDirectory, tunnelPaths, writeTunnelState,
  type ConnectorRecord, type TunnelBinding, type TunnelHostname, type TunnelProvider, type TunnelState,
} from "./state.js";

const LOCK_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;

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
async function originRequest(port: number, servername: string, host: string, ca: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, servername, ca, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
    socket.setTimeout(5_000, () => socket.destroy(new Error("timed out")));
    let response = "";
    socket.once("secureConnect", () => socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
      const status = /^HTTP\/1\.1 (\d{3})/.exec(response);
      if (status) { socket.destroy(); resolve(Number(status[1])); }
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed without a response")));
  });
}

/**
 * Validate the public origin for one hostname, independently of any local
 * loopback-domain check: its certificate verifies against the origin root
 * for exactly that server name, the allowlisted Host is accepted, and a
 * Host header that differs from the TLS server name is refused (421).
 */
export async function probePublicOrigin(hostname: string, port: number, ca: string): Promise<void> {
  let allowed: number, forged: number;
  try {
    allowed = await originRequest(port, hostname, hostname, ca);
    forged = await originRequest(port, hostname, "devfn-forged-host.invalid", ca);
  } catch (error) {
    throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `The public origin for ${hostname} failed TLS verification: ${message(error)}.`);
  }
  if (allowed === 421 || allowed === 403) throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `The public origin does not serve ${hostname}.`);
  if (forged !== 421) throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `The public origin accepted a Host header that differs from ${hostname}.`);
}

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 0;
}

async function connectorReady(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/ready", timeout: 1_000 }, (response) => { response.resume(); resolve(response.statusCode === 200); });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });
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

/**
 * Run a connector for exactly these hostnames. The configuration is
 * validated before it runs; the connector leads its own process group and is
 * recorded through onLaunched before readiness is awaited, so an interrupted
 * start leaves a recorded process for recovery to stop.
 */
/** The connector configuration for hostnames and its digest, which also covers the origin root it trusts. */
async function connectorConfig(ctx: Context, hostnames: readonly string[]): Promise<{ config: string; digest: string }> {
  const root = await originRoot(ctx);
  const config = ctx.provider.renderConnectorConfig(ctx.binding, hostnames, { port: ctx.port, caFile: tunnelPaths(ctx.stateDir, ctx.binding.name).originCa });
  return { config, digest: createHash("sha256").update(config).update("\0").update(root).digest("hex") };
}

async function launchConnector(ctx: Context, hostnames: readonly string[], onLaunched: (record: ConnectorRecord) => Promise<void>): Promise<ConnectorRecord> {
  const paths = tunnelPaths(ctx.stateDir, ctx.binding.name);
  const { config, digest: configDigest } = await connectorConfig(ctx, hostnames);
  const configFile = paths.config(configDigest);
  await writeFile(configFile, config, { mode: 0o600 });
  await ctx.provider.validateConnectorConfig(ctx.binding, configFile, hostnames);
  const metricsPort = await freeLoopbackPort();
  const command = await ctx.provider.connectorCommand(ctx.binding, configFile, metricsPort);
  const log = await open(paths.log, "a", 0o600);
  let child;
  try { child = spawn(command[0], command.slice(1), { detached: process.platform !== "win32", stdio: ["ignore", "ignore", log.fd], windowsHide: true }); }
  finally { await log.close(); }
  child.once("error", () => undefined);
  let birthSignature: string | undefined;
  for (let attempt = 0; child.pid && attempt < 20 && !birthSignature; attempt += 1) {
    birthSignature = await processBirthSignature(child.pid);
    if (!birthSignature) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!child.pid || !birthSignature) {
    if (child.pid) child.kill("SIGKILL");
    throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", "The tunnel connector did not start.");
  }
  child.unref();
  const record: ConnectorRecord = { pid: child.pid, birthSignature, startedAt: new Date().toISOString(), configDigest, metricsPort };
  try { await onLaunched(record); }
  catch (error) { await stopConnector(record); throw error; }
  const deadline = Date.now() + ctx.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (await connectorStatus(record) !== "running") break;
    if (await connectorReady(metricsPort)) return record;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const running = await stopConnector(record);
  throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `The tunnel connector did not become ready${running ? ` and did not stop (${running})` : ""}; see ${paths.log}.`, { pid: record.pid });
}

/**
 * Make before break: the connector for `hostnames` is ready before the one it
 * replaces is stopped, so other owners' public routes keep being served. A
 * replaced connector that does not stop stays recorded as retired. No
 * hostnames stops the connector. Mutates and persists state.
 */
async function swapConnector(ctx: Context, state: TunnelState, hostnames: readonly string[]): Promise<void> {
  const previous = state.connector;
  if (hostnames.length) {
    if (state.pending) delete state.pending.launched;
    const launched = await launchConnector(ctx, hostnames, async (record) => {
      if (state.pending) state.pending.launched = record;
      else state.retired.push(record); // recovery start: stopped unless committed below
      await writeTunnelState(ctx.stateDir, state);
    });
    state.retired = state.retired.filter((item) => item.pid !== launched.pid || item.birthSignature !== launched.birthSignature);
    state.connector = launched;
    if (state.pending) delete state.pending.launched;
  } else delete state.connector;
  if (previous) state.retired.push(previous);
  await writeTunnelState(ctx.stateDir, state);
  await stopRetired(ctx, state);
}

/** Stop every retired connector; one that does not stop stays recorded and is reported. */
async function stopRetired(ctx: Context, state: TunnelState): Promise<string[]> {
  const failures: string[] = [];
  const kept: ConnectorRecord[] = [];
  for (const record of state.retired) {
    const running = await stopConnector(record);
    if (running) { kept.push(record); failures.push(`PID ${record.pid}: ${running}`); }
  }
  if (kept.length !== state.retired.length) { state.retired = kept; await writeTunnelState(ctx.stateDir, state); }
  return failures;
}

/** Whether the recorded connector runs exactly the allowlist for hostnames; none runs for no hostnames. */
async function connectorServes(ctx: Context, state: TunnelState, hostnames: readonly string[]): Promise<boolean> {
  if (!state.connector) return !hostnames.length;
  const status = await connectorStatus(state.connector);
  if (status === "unverified") throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `The recorded tunnel connector (PID ${state.connector.pid}) cannot be verified.`);
  return status === "running" && hostnames.length > 0 && state.connector.configDigest === (await connectorConfig(ctx, hostnames)).digest;
}

/**
 * Bring a binding back to its committed hostnames before any transition:
 * an interrupted publish is rolled back (only DNS records it created are
 * removed), an interrupted withdraw is completed, retired connectors are
 * stopped, and a connector that exited while hostnames are committed is
 * restarted with the committed allowlist.
 */
async function settle(ctx: Context, state: TunnelState): Promise<TunnelState> {
  const pending = state.pending;
  if (pending?.kind === "publish") {
    if (pending.launched) state.retired.push(pending.launched);
    for (const hostname of pending.createdDns) await ctx.provider.removeDns(ctx.binding, hostname);
    delete state.pending;
    await writeTunnelState(ctx.stateDir, state);
  } else if (pending?.kind === "withdraw") {
    if (pending.launched) state.retired.push(pending.launched);
    delete pending.launched;
    const dnsFailures: string[] = [];
    for (const hostname of pending.hostnames) await ctx.provider.removeDns(ctx.binding, hostname).catch((error: unknown) => { dnsFailures.push(message(error)); });
    if (dnsFailures.length) throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `An interrupted withdrawal could not remove public DNS: ${dnsFailures.join(" ")}`);
    state.hostnames = pending.next;
    delete state.pending;
    if (state.connector) { state.retired.push(state.connector); delete state.connector; }
    await writeTunnelState(ctx.stateDir, state);
  }
  await stopRetired(ctx, state);
  const committed = state.hostnames.map((item) => item.hostname);
  if (!await connectorServes(ctx, state, committed)) {
    // A connector that exited is replaced; one running another allowlist is
    // stopped only once the committed allowlist is served again.
    if (state.connector && await connectorStatus(state.connector) !== "running") { state.retired.push(state.connector); delete state.connector; }
    await swapConnector(ctx, state, committed);
  }
  return state;
}

async function locked<T>(ctx: Context, action: (state: TunnelState) => Promise<T>): Promise<T> {
  await tunnelDirectory(ctx.stateDir, ctx.binding.name);
  return await withFileLock(tunnelPaths(ctx.stateDir, ctx.binding.name).lock, async () => await action(await readTunnelState(ctx.stateDir, ctx.binding.name)), { timeoutMs: LOCK_TIMEOUT_MS });
}

/**
 * Publish exactly these public hostnames for one lifecycle owner, replacing
 * the owner's previous set. The origin is checked first; then DNS records are
 * created (or confirmed) and read back, and a connector for the full
 * allowlist replaces the running one. Any failure removes only the records
 * this call created and keeps the previous connector and other owners'
 * hostnames serving. Callers must have the user's explicit public consent.
 */
export async function publishTunnelRoutes(options: TunnelServiceOptions, ownerId: string, hostnames: readonly string[]): Promise<TunnelHostname[]> {
  const ctx = context(options);
  const wanted = [...new Set(hostnames)].sort();
  if (!ownerId || !wanted.length || wanted.length !== hostnames.length || wanted.some((hostname) => !isPublicHostname(hostname, ctx.binding.domain))) {
    throw new TunnelError("DEVFN_TUNNEL_INVALID", `Public hostnames must be distinct labels directly under ${ctx.binding.domain}.`);
  }
  return await locked(ctx, async (current) => {
    const state = await settle(ctx, current);
    const taken = state.hostnames.find((item) => wanted.includes(item.hostname) && item.ownerId !== ownerId);
    if (taken) throw new TunnelError("DEVFN_TUNNEL_CONFLICT", `${taken.hostname} is published by another owner.`);
    const before = state.hostnames.filter((item) => item.ownerId === ownerId);
    const now = new Date().toISOString();
    const next = [...state.hostnames.filter((item) => item.ownerId !== ownerId),
      ...wanted.map((hostname) => before.find((item) => item.hostname === hostname) ?? { hostname, ownerId, publishedAt: now })]
      .sort((a, b) => a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0);
    const dropped = before.map((item) => item.hostname).filter((hostname) => !wanted.includes(hostname));
    const added = wanted.filter((hostname) => !before.some((item) => item.hostname === hostname));
    const root = await originRoot(ctx);
    for (const hostname of wanted) await ctx.probeOrigin(hostname, ctx.port, root);
    state.pending = { kind: "publish", ownerId, hostnames: added, next, createdDns: [] };
    await writeTunnelState(ctx.stateDir, state);
    try {
      for (const hostname of added) {
        // Recorded before the call, so an interrupted create is still removed;
        // removal touches only DevFn-owned records.
        state.pending.createdDns.push(hostname);
        await writeTunnelState(ctx.stateDir, state);
        try { await ctx.provider.ensureDns(ctx.binding, hostname); }
        catch (error) {
          // A conflict is reported before any record is created: that name is never removed.
          if ((error as { code?: unknown }).code === "DEVFN_TUNNEL_CONFLICT") { state.pending.createdDns.pop(); await writeTunnelState(ctx.stateDir, state); }
          throw error;
        }
      }
      for (const hostname of wanted) await ctx.provider.verifyDns(ctx.binding, hostname);
      if (!await connectorServes(ctx, state, next.map((item) => item.hostname))) await swapConnector(ctx, state, next.map((item) => item.hostname));
      for (const hostname of dropped) await ctx.provider.removeDns(ctx.binding, hostname);
    } catch (error) {
      try { await settle(ctx, state); }
      catch (rollbackError) {
        throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `Publishing failed (${message(error)}) and its rollback did not finish (${message(rollbackError)}); the transition is kept and retried by the next tunnel command.`);
      }
      throw error;
    }
    state.hostnames = next;
    delete state.pending;
    await writeTunnelState(ctx.stateDir, state);
    return next.filter((item) => item.ownerId === ownerId);
  });
}

/**
 * Stop publishing every hostname of one owner. The connector is first
 * replaced by one without them (other owners keep being served), then their
 * DNS records are removed; public DNS is removed even when the replacement
 * connector cannot start, and the remaining work is retried by the next
 * tunnel command. Other owners' records are never touched.
 */
export async function withdrawTunnelRoutes(options: TunnelServiceOptions, ownerId: string): Promise<string[]> {
  const ctx = context(options);
  return await locked(ctx, async (current) => {
    let state = current;
    try { state = await settle(ctx, current); }
    catch (error) {
      // Withdrawal must not wait for another owner's connector to recover.
      if (!(error instanceof TunnelError) || error.code !== "DEVFN_TUNNEL_UNAVAILABLE") throw error;
    }
    const withdrawn = state.hostnames.filter((item) => item.ownerId === ownerId).map((item) => item.hostname);
    if (!withdrawn.length) return [];
    const next = state.hostnames.filter((item) => item.ownerId !== ownerId);
    state.pending = { kind: "withdraw", ownerId, hostnames: withdrawn, next, createdDns: [] };
    await writeTunnelState(ctx.stateDir, state);
    let swapFailure: unknown;
    try { await swapConnector(ctx, state, next.map((item) => item.hostname)); }
    catch (error) {
      swapFailure = error;
      // Nothing may keep serving the withdrawn names: the old connector is
      // stopped as well when its replacement cannot start.
      if (state.connector) { state.retired.push(state.connector); delete state.connector; await writeTunnelState(ctx.stateDir, state); await stopRetired(ctx, state); }
    }
    for (const hostname of withdrawn) await ctx.provider.removeDns(ctx.binding, hostname);
    state.hostnames = next;
    delete state.pending;
    await writeTunnelState(ctx.stateDir, state);
    const unstopped = state.retired.map((item) => item.pid);
    if (swapFailure || unstopped.length) {
      throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `Public DNS for ${withdrawn.join(", ")} is removed, but ${swapFailure ? `the connector for the remaining routes did not start (${message(swapFailure)})` : `connector PID ${unstopped.join(", ")} did not stop`}; the next tunnel command retries it.`);
    }
    return withdrawn;
  });
}

/** Recover a binding (see settle) and report it; used after crashes and by status. */
export async function recoverTunnel(options: TunnelServiceOptions): Promise<TunnelStatus> {
  const ctx = context(options);
  await locked(ctx, async (state) => await settle(ctx, state));
  return await tunnelStatus(options);
}

/** Lock-free report of a binding's published hostnames and connector. */
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
  };
}
