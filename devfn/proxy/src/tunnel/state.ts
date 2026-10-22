import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { canonicalBirthSignature, withFileLock, withRoutingLock } from "@devfn/ports";

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

/** A connector process DevFn started for exactly these hostnames; it leads its own process group. */
export interface ConnectorRecord { pid: number; birthSignature: string; startedAt: string; configDigest: string; metricsPort: number; hostnames: string[] }

/**
 * An in-flight publish, written before any provider or connector mutation.
 * Recovery rolls it back: only the DNS records it created are removed.
 */
export interface TunnelTransition {
  kind: "publish";
  ownerId: string;
  hostnames: string[];
  next: TunnelHostname[];
  createdDns: string[];
}

/**
 * Names an owner stopped publishing, or an interrupted publish left
 * routable, whose public reachability has not fully ended: their DNS
 * removal is not yet confirmed, or a recorded connector may still route
 * them. keepDns marks names whose DevFn-owned record the publish did not
 * create: it is kept, and their reachability ends once no connector routes
 * them. Retried by every later transition of the binding.
 */
export interface TunnelResidue { ownerId: string; hostnames: string[]; dnsRemoved: boolean; keepDns?: true }

export interface TunnelState {
  version: 1;
  binding: string;
  hostnames: TunnelHostname[];
  connector?: ConnectorRecord;
  /** Connectors that are not, or are no longer, committed and whose stop has not been confirmed yet. */
  retired: ConnectorRecord[];
  pending?: TunnelTransition;
  residue: TunnelResidue[];
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
  /** Confirm the binding's tunnel exists in its account, is not deleted and takes its ingress from the local connector configuration. */
  verifyTunnel(binding: TunnelBinding): Promise<void>;
  /** Read public DNS: whether a DevFn-owned record for hostname exists. A failed read throws; it never reports absence. */
  ownsDns(binding: TunnelBinding, hostname: string): Promise<boolean>;
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
  // Domain registration holds the same proxy lock and reads this registry,
  // so the two kinds of domain never overlap in either order.
  return await withFileLock(bindingsLock(stateDir), async () => await withRoutingLock(stateDir, async () => await withFileLock(path.join(stateDir, "proxy.lock"), async () => {
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
    // Two connectors with different allowlists on one tunnel would each
    // receive the other's requests.
    if (bindings.some((item) => item.cloudflare.tunnelId === binding.cloudflare.tunnelId)) {
      throw new TunnelError("DEVFN_TUNNEL_IN_USE", `Tunnel ${binding.cloudflare.tunnelId} is already bound; one tunnel has one DevFn connector.`);
    }
    await writeBindings(stateDir, [...bindings, binding]);
    return binding;
  }, { timeoutMs: LOCK_TIMEOUT_MS })), { timeoutMs: LOCK_TIMEOUT_MS });
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
    // The registry changes under the binding's lock, which every transition
    // holds while it revalidates its binding (assertBindingRegistered).
    await withFileLock(tunnelPaths(stateDir, name).lock, async () => {
      const state = await readTunnelState(stateDir, name);
      if (state.hostnames.length || state.connector || state.retired.length || state.pending || state.residue.length) throw new TunnelError("DEVFN_TUNNEL_IN_USE", `Tunnel binding ${name} still has public routes or a connector.`);
      await writeBindings(stateDir, bindings.filter((item) => item.name !== name));
    }, { timeoutMs: LOCK_TIMEOUT_MS });
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

/** Under the binding's lock: binding is still registered exactly as resolved, so nothing is published on a removed or changed binding. */
export async function assertBindingRegistered(stateDir: string, binding: TunnelBinding): Promise<void> {
  const current = (await readTunnelBindings(stateDir)).find((item) => item.name === binding.name);
  if (!current || JSON.stringify(current) !== JSON.stringify(binding)) throw new TunnelError("DEVFN_TUNNEL_UNREGISTERED", `Tunnel binding ${binding.name} is no longer registered as resolved.`);
}

export function tunnelPaths(stateDir: string, name: string): { dir: string; state: string; lock: string; originCa: string; log: string; config: (digest: string) => string } {
  if (!BINDING_NAME.test(name)) throw invalid("Invalid tunnel binding name.");
  const dir = path.join(stateDir, "tunnels", name);
  return { dir, state: path.join(dir, "state.json"), lock: path.join(dir, "tunnel.lock"), originCa: path.join(dir, "origin-ca.pem"),
    log: path.join(dir, "logs", "connector.log"), config: (digest) => path.join(dir, `connector-${digest}.yml`) };
}

export async function tunnelDirectory(stateDir: string, name: string): Promise<string> {
  const { dir } = tunnelPaths(stateDir, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const entry = await lstat(dir);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", "The tunnel state directory is not a private directory.");
  await chmod(dir, 0o700);
  return dir;
}

/** Directory sync errors of platforms that cannot open or sync a directory. */
const UNSYNCABLE_DIRECTORY = new Set(["EISDIR", "EPERM", "EINVAL"]);

/**
 * Replace file atomically and durably with owner-only content: readers see
 * the old or the complete new content. The content is synced to disk before
 * it replaces the previous file, so a crash also leaves one or the other
 * whole, and the rename is then synced where the platform can sync a
 * directory.
 */
export async function writePrivateFile(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
  let directory: FileHandle | undefined;
  try { directory = await open(path.dirname(file), "r"); await directory.sync(); }
  catch (error) { if (!UNSYNCABLE_DIRECTORY.has((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  finally { await directory?.close(); }
}

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The one order of hostnames, owner IDs and binding names: by UTF-16 code
 * unit, independent of locale. The rendered ingress and its rule-index
 * validation both depend on it.
 */
export function compareNames(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isConnector = (value: unknown): value is ConnectorRecord => {
  const item = value as Partial<ConnectorRecord> | undefined;
  return Boolean(item) && Number.isInteger(item!.pid) && item!.pid! > 0 && typeof item!.birthSignature === "string" && item!.birthSignature.length > 0 && canonicalBirthSignature(item!.birthSignature) &&
    typeof item!.startedAt === "string" && typeof item!.configDigest === "string" && /^[a-f0-9]{64}$/.test(item!.configDigest) &&
    Number.isInteger(item!.metricsPort) && item!.metricsPort! > 0 && item!.metricsPort! < 65536 && isNames(item!.hostnames);
};
const isHostnames = (value: unknown): value is TunnelHostname[] => Array.isArray(value) && value.every((item: Partial<TunnelHostname>) =>
  item && typeof item.hostname === "string" && typeof item.ownerId === "string" && item.ownerId.length > 0 && typeof item.publishedAt === "string") &&
  new Set(value.map((item: TunnelHostname) => item.hostname)).size === value.length;

/** A binding's state; absent state is empty. Malformed state fails closed and is left for inspection. */
export async function readTunnelState(stateDir: string, name: string): Promise<TunnelState> {
  let raw: string;
  try { raw = await readFile(tunnelPaths(stateDir, name).state, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, binding: name, hostnames: [], retired: [], residue: [] };
    throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", `Tunnel state for ${name} is unreadable.`);
  }
  let state: TunnelState;
  try { state = JSON.parse(raw) as TunnelState; } catch { throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", `Tunnel state for ${name} is invalid.`); }
  const pending = state?.pending;
  if (!state || state.version !== 1 || state.binding !== name || !isHostnames(state.hostnames) || !Array.isArray(state.retired) || !state.retired.every(isConnector) ||
    (state.connector !== undefined && !isConnector(state.connector)) ||
    !Array.isArray(state.residue) || !state.residue.every((item) => item && typeof item.ownerId === "string" && isNames(item.hostnames) && typeof item.dnsRemoved === "boolean" && (item.keepDns === undefined || item.keepDns === true)) ||
    (pending !== undefined && (pending.kind !== "publish" || typeof pending.ownerId !== "string" || !isNames(pending.hostnames) ||
      !isHostnames(pending.next) || !isNames(pending.createdDns)))) {
    throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", `Tunnel state for ${name} is invalid.`);
  }
  return state;
}

export async function writeTunnelState(stateDir: string, state: TunnelState): Promise<void> {
  await writePrivateJson(tunnelPaths(stateDir, state.binding).state, state);
}

const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ownersDir = (stateDir: string) => path.join(stateDir, "tunnel-owners");

export function ownerMarkerFile(stateDir: string, ownerId: string): string {
  if (!OWNER_ID.test(ownerId)) throw invalid("A tunnel owner ID must be a filename-safe identifier.");
  return path.join(ownersDir(stateDir), `${ownerId}.json`);
}

/**
 * The bindings an owner may publish on, from its publish-intent marker: it
 * is written before the owner's first provider or connector mutation on a
 * binding and cleared once its public reachability there has ended. An
 * owner without a marker never published, so no tunnel state is read for
 * it; a malformed marker fails closed.
 */
export async function readOwnerBindings(stateDir: string, ownerId: string): Promise<string[]> {
  let raw: string;
  try { raw = await readFile(ownerMarkerFile(stateDir, ownerId), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", `The tunnel publish marker of ${ownerId} is unreadable.`);
  }
  const marker = (() => { try { return JSON.parse(raw) as { version?: unknown; bindings?: unknown }; } catch { return undefined; } })();
  if (marker?.version !== 1 || !isNames(marker.bindings) || !marker.bindings.every((name) => BINDING_NAME.test(name))) {
    throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", `The tunnel publish marker of ${ownerId} is invalid.`);
  }
  return marker.bindings;
}

/** Add or remove one binding in an owner's publish-intent marker; the marker is removed once it names none. */
export async function markOwnerBinding(stateDir: string, ownerId: string, name: string, present: boolean): Promise<void> {
  const file = ownerMarkerFile(stateDir, ownerId);
  await mkdir(ownersDir(stateDir), { recursive: true, mode: 0o700 });
  await withFileLock(`${file}.lock`, async () => {
    const current = await readOwnerBindings(stateDir, ownerId);
    const bindings = [...new Set([...current.filter((item) => item !== name), ...(present ? [name] : [])])].sort(compareNames);
    if (bindings.length === current.length && bindings.every((item) => current.includes(item))) return;
    if (bindings.length) await writePrivateJson(file, { version: 1, bindings });
    else await rm(file, { force: true });
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

/** Every owner with a publish-intent marker on this machine. */
export async function tunnelOwners(stateDir: string): Promise<string[]> {
  try { return (await readdir(ownersDir(stateDir))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter((name) => OWNER_ID.test(name)).sort(compareNames); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new TunnelError("DEVFN_TUNNEL_STATE_INVALID", "The tunnel owner directory is unreadable.");
  }
}
