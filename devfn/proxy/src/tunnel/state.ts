import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { withFileLock } from "@devfn/ports";

import { domainContains, normalizeDomain, readRegisteredDomains } from "../domains.js";

export type TunnelErrorCode = "DEVFN_TUNNEL_INVALID" | "DEVFN_TUNNEL_UNREGISTERED" | "DEVFN_TUNNEL_IN_USE" | "DEVFN_TUNNEL_CONFLICT" |
  "DEVFN_TUNNEL_PROVIDER_FAILED" | "DEVFN_TUNNEL_VALIDATION_FAILED" | "DEVFN_TUNNEL_UNAVAILABLE" | "DEVFN_TUNNEL_STATE_INVALID";

export class TunnelError extends Error {
  public constructor(public readonly code: TunnelErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message); this.name = "TunnelError";
  }
}

/**
 * A machine-registered public tunnel binding. It names a pre-existing
 * nonproduction provider tunnel and public domain and holds only references
 * to credentials: the connector credentials file path and the name of the
 * environment variable holding a DNS-scoped API token. DevFn never stores
 * either credential, never creates the tunnel and never provisions a zone.
 */
export interface TunnelBinding {
  name: string;
  provider: "cloudflare";
  /** Public base domain; every public hostname is one label under it. */
  domain: string;
  projectId: string;
  repositoryIdentity: string;
  /** Explicit owner assertion at registration; production bindings are refused. */
  nonproduction: true;
  cloudflare: { accountId: string; zoneId: string; tunnelId: string; credentialsFile: string; apiTokenEnv: string };
}

/** One public hostname a lifecycle owner publishes through a binding. */
export interface TunnelHostname { hostname: string; ownerId: string; publishedAt: string }

/** A connector process DevFn started; it leads its own process group. */
export interface ConnectorRecord { pid: number; birthSignature: string; startedAt: string; configDigest: string; metricsPort: number }

/**
 * An in-flight transition, written before any provider or connector
 * mutation. A publish is rolled back by recovery (only the DNS records it
 * created are removed); a withdraw is rolled forward.
 */
export interface TunnelTransition {
  kind: "publish" | "withdraw";
  ownerId: string;
  hostnames: string[];
  next: TunnelHostname[];
  createdDns: string[];
  launched?: ConnectorRecord;
}

export interface TunnelState {
  version: 1;
  binding: string;
  hostnames: TunnelHostname[];
  connector?: ConnectorRecord;
  /** Replaced connectors whose stop has not been confirmed yet. */
  retired: ConnectorRecord[];
  pending?: TunnelTransition;
}

/** The loopback origin a connector forwards to and the root that verifies its certificates. */
export interface PublicOrigin { port: number; caFile: string }

/**
 * The provider-neutral tunnel boundary. A provider manages public DNS for a
 * binding's tunnel and renders, validates and runs its connector. Every DNS
 * call acts on one hostname and never changes a record DevFn does not own.
 */
export interface TunnelProvider {
  /** Create, or confirm, the DevFn-owned record routing hostname to the tunnel; "created" only when this call created it. */
  ensureDns(binding: TunnelBinding, hostname: string): Promise<"created" | "existing">;
  /** Read back public DNS: hostname must route to this binding's tunnel through a DevFn-owned record. */
  verifyDns(binding: TunnelBinding, hostname: string): Promise<void>;
  /** Delete only the DevFn-owned record for hostname; an absent record is success. */
  removeDns(binding: TunnelBinding, hostname: string): Promise<void>;
  /** An ingress allowlist routing exactly these hostnames to the origin and denying every other request. */
  renderConnectorConfig(binding: TunnelBinding, hostnames: readonly string[], origin: PublicOrigin): string;
  /** Validate a rendered configuration locally before any connector runs it. */
  validateConnectorConfig(binding: TunnelBinding, configFile: string, hostnames: readonly string[]): Promise<void>;
  /** Connector argv for configFile; it answers GET /ready on 127.0.0.1:metricsPort once connected. */
  connectorCommand(binding: TunnelBinding, configFile: string, metricsPort: number): Promise<string[]>;
}

const BINDING_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const HEX32 = /^[a-f0-9]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const LOCK_TIMEOUT_MS = 30_000;

const invalid = (message: string): TunnelError => new TunnelError("DEVFN_TUNNEL_INVALID", message);

/** Whether hostname is exactly one DNS label under domain, as edge certificates for the domain cover. */
export function isPublicHostname(hostname: string, domain: string): boolean {
  if (!hostname.endsWith(`.${domain}`)) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname.slice(0, -domain.length - 1)) && hostname.length <= 253;
}

export function parseTunnelBinding(value: unknown): TunnelBinding {
  if (!value || typeof value !== "object") throw invalid("A tunnel binding must be an object.");
  const entry = value as Record<string, unknown>;
  const cloudflare = entry.cloudflare as Record<string, unknown> | undefined;
  if (typeof entry.name !== "string" || !BINDING_NAME.test(entry.name)) throw invalid("A tunnel binding name must be a lowercase label of at most 32 characters.");
  if (entry.provider !== "cloudflare") throw invalid("The only tunnel provider is cloudflare.");
  if (entry.nonproduction !== true) throw invalid("A tunnel binding must be registered as nonproduction; DevFn does not expose production accounts or domains.");
  if (typeof entry.domain !== "string") throw invalid("A tunnel binding needs a public domain.");
  try { normalizeDomain(entry.domain); } catch { throw invalid("A tunnel binding domain must be a lowercase, concrete DNS name outside .localhost."); }
  if (typeof entry.projectId !== "string" || !entry.projectId || typeof entry.repositoryIdentity !== "string" || !path.isAbsolute(entry.repositoryIdentity)) {
    throw invalid("A tunnel binding must be bound to a project and repository.");
  }
  if (!cloudflare || typeof cloudflare !== "object" || typeof cloudflare.accountId !== "string" || !HEX32.test(cloudflare.accountId) ||
    typeof cloudflare.zoneId !== "string" || !HEX32.test(cloudflare.zoneId) || typeof cloudflare.tunnelId !== "string" || !UUID.test(cloudflare.tunnelId) ||
    typeof cloudflare.credentialsFile !== "string" || !path.isAbsolute(cloudflare.credentialsFile) ||
    typeof cloudflare.apiTokenEnv !== "string" || !ENV_NAME.test(cloudflare.apiTokenEnv)) {
    throw invalid("A Cloudflare binding needs a 32-hex account and zone ID, a tunnel UUID, an absolute credentials file and an API token environment variable name.");
  }
  const extra = Object.keys(entry).filter((key) => !["name", "provider", "domain", "projectId", "repositoryIdentity", "nonproduction", "cloudflare"].includes(key));
  const extraProvider = Object.keys(cloudflare).filter((key) => !["accountId", "zoneId", "tunnelId", "credentialsFile", "apiTokenEnv"].includes(key));
  if (extra.length || extraProvider.length) throw invalid("A tunnel binding holds credential references only; unexpected fields are refused.");
  return entry as unknown as TunnelBinding;
}

const bindingsFile = (stateDir: string) => path.join(stateDir, "tunnels.json");
const bindingsLock = (stateDir: string) => path.join(stateDir, "tunnels.lock");

export async function readTunnelBindings(stateDir: string): Promise<TunnelBinding[]> {
  let raw: string;
  try { raw = await readFile(bindingsFile(stateDir), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", "The machine tunnel binding registry is unreadable.");
  }
  try {
    const state = JSON.parse(raw) as { version?: unknown; bindings?: unknown };
    if (state.version !== 1 || !Array.isArray(state.bindings)) throw new Error("invalid");
    const bindings = state.bindings.map(parseTunnelBinding);
    if (new Set(bindings.map((item) => item.name)).size !== bindings.length) throw new Error("duplicate");
    return bindings;
  } catch { throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", "The machine tunnel binding registry is invalid."); }
}

/** The binding with this name registered to this project and repository. */
export async function resolveTunnelBinding(stateDir: string, name: string, projectId: string, repositoryIdentity: string): Promise<TunnelBinding> {
  const binding = (await readTunnelBindings(stateDir)).find((item) => item.name === name);
  if (!binding || binding.projectId !== projectId || binding.repositoryIdentity !== repositoryIdentity) {
    throw new TunnelError("DEVFN_TUNNEL_UNREGISTERED", `Tunnel binding ${name} is not registered to this repository and project.`);
  }
  return binding;
}

async function writeBindings(stateDir: string, bindings: TunnelBinding[]): Promise<void> {
  await writePrivateJson(bindingsFile(stateDir), { version: 1, bindings });
}

/**
 * Register a pre-existing nonproduction tunnel and public domain for one
 * repository and project. The credentials file must be an owner-only regular
 * file; its content is never read. A public domain may not overlap a
 * loopback development domain or another binding, so local and public
 * validation never apply to the same names.
 */
export async function registerTunnelBinding(stateDir: string, input: TunnelBinding): Promise<TunnelBinding> {
  const binding = parseTunnelBinding({ ...input, repositoryIdentity: await realpath(input.repositoryIdentity).catch(() => input.repositoryIdentity) });
  let entry;
  try { entry = await lstat(binding.cloudflare.credentialsFile); }
  catch { throw invalid("The tunnel credentials file does not exist."); }
  if (!entry.isFile() || entry.isSymbolicLink() || (process.platform !== "win32" && (entry.mode & 0o077) !== 0)) {
    throw invalid("The tunnel credentials file must be a regular file readable only by its owner (mode 0600).");
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  return await withFileLock(bindingsLock(stateDir), async () => {
    if ((await readRegisteredDomains(stateDir)).some((item) => domainContains(item.domain, binding.domain) || domainContains(binding.domain, item.domain))) {
      throw new TunnelError("DEVFN_TUNNEL_IN_USE", `Public domain ${binding.domain} overlaps a loopback development domain registration.`);
    }
    const bindings = await readTunnelBindings(stateDir);
    const existing = bindings.find((item) => item.name === binding.name);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(binding)) return existing;
      throw new TunnelError("DEVFN_TUNNEL_IN_USE", `Tunnel binding ${binding.name} is already registered.`);
    }
    if (bindings.some((item) => domainContains(item.domain, binding.domain) || domainContains(binding.domain, item.domain))) {
      throw new TunnelError("DEVFN_TUNNEL_IN_USE", `Public domain ${binding.domain} overlaps another tunnel binding.`);
    }
    await writeBindings(stateDir, [...bindings, binding]);
    return binding;
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

/** Remove a binding of this repository and project; refused while it records any public hostname or connector. */
export async function unregisterTunnelBinding(stateDir: string, name: string, projectId: string, repositoryIdentity: string): Promise<void> {
  const canonical = await realpath(repositoryIdentity).catch(() => repositoryIdentity);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await withFileLock(bindingsLock(stateDir), async () => {
    const bindings = await readTunnelBindings(stateDir);
    const binding = bindings.find((item) => item.name === name);
    if (!binding || binding.projectId !== projectId || binding.repositoryIdentity !== canonical) throw new TunnelError("DEVFN_TUNNEL_UNREGISTERED", `Tunnel binding ${name} is not registered to this repository.`);
    await tunnelDirectory(stateDir, name);
    await withFileLock(tunnelPaths(stateDir, name).lock, async () => {
      const state = await readTunnelState(stateDir, name);
      if (state.hostnames.length || state.connector || state.retired.length || state.pending) throw new TunnelError("DEVFN_TUNNEL_IN_USE", `Tunnel binding ${name} still has public routes or a connector.`);
    }, { timeoutMs: LOCK_TIMEOUT_MS });
    await writeBindings(stateDir, bindings.filter((item) => item.name !== name));
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

export function tunnelPaths(stateDir: string, name: string): { dir: string; state: string; lock: string; originCa: string; log: string; config: (digest: string) => string } {
  if (!BINDING_NAME.test(name)) throw invalid("Invalid tunnel binding name.");
  const dir = path.join(stateDir, "tunnels", name);
  return { dir, state: path.join(dir, "state.json"), lock: path.join(dir, "tunnel.lock"), originCa: path.join(dir, "origin-ca.pem"),
    log: path.join(dir, "connector.log"), config: (digest) => path.join(dir, `connector-${digest}.yml`) };
}

export async function tunnelDirectory(stateDir: string, name: string): Promise<string> {
  const { dir } = tunnelPaths(stateDir, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const entry = await lstat(dir);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", "The tunnel state directory is not a private directory.");
  await chmod(dir, 0o700);
  return dir;
}

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}

const isConnector = (value: unknown): value is ConnectorRecord => {
  const item = value as Partial<ConnectorRecord> | undefined;
  return Boolean(item) && Number.isInteger(item!.pid) && item!.pid! > 0 && typeof item!.birthSignature === "string" && item!.birthSignature.length > 0 &&
    typeof item!.startedAt === "string" && typeof item!.configDigest === "string" && /^[a-f0-9]{64}$/.test(item!.configDigest) &&
    Number.isInteger(item!.metricsPort) && item!.metricsPort! > 0 && item!.metricsPort! < 65536;
};
const isHostnames = (value: unknown): value is TunnelHostname[] => Array.isArray(value) && value.every((item: Partial<TunnelHostname>) =>
  item && typeof item.hostname === "string" && typeof item.ownerId === "string" && item.ownerId.length > 0 && typeof item.publishedAt === "string") &&
  new Set(value.map((item: TunnelHostname) => item.hostname)).size === value.length;

/** A binding's state; absent state is empty. Malformed state fails closed and is left for inspection. */
export async function readTunnelState(stateDir: string, name: string): Promise<TunnelState> {
  let raw: string;
  try { raw = await readFile(tunnelPaths(stateDir, name).state, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, binding: name, hostnames: [], retired: [] };
    throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", `Tunnel state for ${name} is unreadable.`);
  }
  let state: TunnelState;
  try { state = JSON.parse(raw) as TunnelState; } catch { throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", `Tunnel state for ${name} is invalid.`); }
  const pending = state?.pending;
  if (!state || state.version !== 1 || state.binding !== name || !isHostnames(state.hostnames) || !Array.isArray(state.retired) || !state.retired.every(isConnector) ||
    (state.connector !== undefined && !isConnector(state.connector)) ||
    (pending !== undefined && (!["publish", "withdraw"].includes(pending.kind) || typeof pending.ownerId !== "string" || !Array.isArray(pending.hostnames) ||
      !pending.hostnames.every((item) => typeof item === "string") || !isHostnames(pending.next) || !Array.isArray(pending.createdDns) ||
      !pending.createdDns.every((item) => typeof item === "string") || (pending.launched !== undefined && !isConnector(pending.launched))))) {
    throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", `Tunnel state for ${name} is invalid.`);
  }
  return state;
}

export async function writeTunnelState(stateDir: string, state: TunnelState): Promise<void> {
  await writePrivateJson(tunnelPaths(stateDir, state.binding).state, state);
}

/** Lock-free: binding names whose state records a public hostname of this owner, or an in-flight transition for it. */
export async function tunnelOwnerBindings(stateDir: string, ownerId: string): Promise<string[]> {
  const names: string[] = [];
  for (const binding of await readTunnelBindings(stateDir)) {
    const state = await readTunnelState(stateDir, binding.name);
    if (state.hostnames.some((item) => item.ownerId === ownerId) || state.pending?.ownerId === ownerId) names.push(binding.name);
  }
  return names;
}
