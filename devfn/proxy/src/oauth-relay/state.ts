import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { FilePortRegistry, parsePersistedProxyRoutes, withFileLock, type PersistedProxyRoute } from "@devfn/ports";
import { processIdentityStatus } from "@devfn/processes";

import { proxyListenerPorts } from "../index.js";

/** Reserved route owner of the relay service; never a worktree or runtime owner. */
export const OAUTH_RELAY_OWNER_ID = "devfn-oauth-relay";
export const OAUTH_RELAY_ROUTE_ID = "devfn-oauth-relay:callback";

const DEFAULT_TTL_SECONDS = 600;
const MAX_TTL_SECONDS = 900;
const MAX_LIVE_TICKETS_PER_OWNER = 256;
const LOCK_TIMEOUT_MS = 30_000;
// Unreserved URL characters only, so the value is forwarded byte-exact. A
// short value cannot be an unguessable OAuth state.
const STATE_PATTERN = /^[A-Za-z0-9._~-]{22,512}$/;
const PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()+,;=:@/-]*$/;
const QUERY_PATTERN = /^[\x21-\x22\x24-\x7e]*$/;

export type OAuthRelayRejection =
  | "malformed" | "unknown-state" | "replayed" | "expired" | "wrong-origin"
  | "stale-owner" | "route-stopped" | "target-mutated" | "target-invalid" | "capacity";

export class OAuthRelayError extends Error {
  public constructor(
    public readonly code: "DEVFN_OAUTH_RELAY_REJECTED" | "DEVFN_OAUTH_RELAY_UNAVAILABLE" | "DEVFN_OAUTH_RELAY_STATE_INVALID",
    message: string,
    public readonly reason?: OAuthRelayRejection,
  ) {
    super(message); this.name = "OAuthRelayError";
  }
}

const reject = (reason: OAuthRelayRejection, message: string) => new OAuthRelayError("DEVFN_OAUTH_RELAY_REJECTED", message, reason);
const invalid = (message: string) => new OAuthRelayError("DEVFN_OAUTH_RELAY_STATE_INVALID", message);

/** The running relay process and the one public origin it answers for. */
export interface OAuthRelayService {
  version: 1;
  pid: number; birthSignature: string; startedAt: string; port: number;
  origin: string; hostname: string; domain: string; projectId: string; repositoryIdentity: string;
}

/** The owner route a ticket was bound to when it was registered. */
interface RouteBinding { id: string; hostname: string; path: string; match: "exact" | "prefix"; targetPort: number; updatedAt: string }

/**
 * A single-use binding of one OAuth state to one owner's live route. Only a
 * digest of the state is stored; a consumed ticket stays as a tombstone until
 * it expires so that a replay, or a second registration of the same state,
 * is refused.
 */
interface Ticket {
  id: string; ownerId: string; redirectUri: string; callbackUrl: string; route: RouteBinding;
  createdAt: string; expiresAt: string; consumedAt?: string;
}
interface TicketState { version: 1; tickets: Ticket[] }

/** Owner liveness evidence; by default the machine registry's lifecycle journal. */
export type OwnerLiveness = (ownerId: string) => Promise<boolean>;
export interface RelayStateOptions { now?: () => Date; ownerLive?: OwnerLiveness }

export function relayPaths(stateDir: string) {
  const dir = path.join(stateDir, "oauth-relay");
  return { dir, tickets: path.join(dir, "tickets.json"), service: path.join(dir, "service.json"), lock: path.join(dir, "state.lock"), serviceLock: path.join(dir, "service.lock") };
}

export const stateDigest = (state: string): string => createHash("sha256").update(state, "utf8").digest("hex");

const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown, max = 2048): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\0-\x1f\x7f]/.test(value);

/** Private relay directory; a symlink or non-directory fails closed. */
export async function relayDirectory(stateDir: string): Promise<string> {
  const { dir } = relayPaths(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const entry = await lstat(dir);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalid("The OAuth relay state directory is not a private directory.");
  await chmod(dir, 0o700);
  return dir;
}

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}

async function readJson(file: string): Promise<unknown> {
  let raw: string;
  try {
    const entry = await lstat(file);
    if (!entry.isFile()) throw invalid(`${path.basename(file)} is not a regular file.`);
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof OAuthRelayError) throw error;
    throw invalid(`Unable to read ${path.basename(file)}.`);
  }
  try { return JSON.parse(raw); } catch { throw invalid(`${path.basename(file)} is not valid JSON.`); }
}

export function parseRelayService(value: unknown): OAuthRelayService {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || record.version !== 1 || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 ||
    !text(record.birthSignature) || !iso(record.startedAt) || !Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535 ||
    !text(record.origin) || !text(record.hostname, 253) || !text(record.domain, 253) || !text(record.projectId) || !text(record.repositoryIdentity, 4096)) {
    throw invalid("The OAuth relay service record is invalid.");
  }
  const origin = canonicalHttpUrl(record.origin as string, true);
  if (!origin || origin.protocol !== "https:" || origin.hostname !== record.hostname || origin.origin !== record.origin) throw invalid("The OAuth relay service origin is invalid.");
  return record as unknown as OAuthRelayService;
}

export async function readRelayService(stateDir: string): Promise<OAuthRelayService | undefined> {
  const value = await readJson(relayPaths(stateDir).service);
  return value === undefined ? undefined : parseRelayService(value);
}

function parseTickets(value: unknown): TicketState {
  if (value === undefined) return { version: 1, tickets: [] };
  const state = value as { version?: unknown; tickets?: unknown };
  if (!state || typeof state !== "object" || state.version !== 1 || !Array.isArray(state.tickets)) throw invalid("OAuth relay ticket state is invalid.");
  const ids = new Set<string>();
  for (const item of state.tickets as unknown[]) {
    const ticket = item as Record<string, unknown> | null;
    const route = ticket?.route as Record<string, unknown> | undefined;
    if (!ticket || typeof ticket !== "object" || typeof ticket.id !== "string" || !/^[a-f0-9]{64}$/.test(ticket.id) || ids.has(ticket.id) ||
      !text(ticket.ownerId, 256) || !text(ticket.redirectUri) || !text(ticket.callbackUrl) || !iso(ticket.createdAt) || !iso(ticket.expiresAt) ||
      (ticket.consumedAt !== undefined && !iso(ticket.consumedAt)) || !route || typeof route !== "object" || !text(route.id, 512) ||
      !text(route.hostname, 253) || typeof route.path !== "string" || !PATH_PATTERN.test(route.path) || !["exact", "prefix"].includes(route.match as string) ||
      !Number.isInteger(route.targetPort) || !iso(route.updatedAt) ||
      !canonicalHttpUrl(ticket.redirectUri as string) || !canonicalHttpUrl(ticket.callbackUrl as string)) {
      throw invalid("OAuth relay ticket state is invalid.");
    }
    ids.add(ticket.id);
  }
  return state as TicketState;
}

async function readTickets(stateDir: string): Promise<TicketState> {
  return parseTickets(await readJson(relayPaths(stateDir).tickets));
}

/**
 * A URL in the only form the relay stores and compares: http(s), no
 * credentials, query or fragment, and no spelling the URL parser would
 * rewrite (dot segments, backslashes, percent-encoding, case or default
 * ports). Anything else is not a valid redirect or callback target.
 */
function canonicalHttpUrl(value: string, originOnly = false): URL | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) return undefined;
  if (originOnly) return url.origin === value ? url : undefined;
  if (url.href !== value || !PATH_PATTERN.test(url.pathname) || url.pathname.includes("//") || /%/.test(value)) return undefined;
  return url;
}

/** The scheme and port Caddy serves this route on. */
function routeOrigin(route: PersistedProxyRoute): string {
  const ports = proxyListenerPorts();
  const secure = route.tls !== "off";
  const port = secure ? ports.httpsPort : ports.httpPort;
  const host = route.hostname.toLowerCase();
  return `${secure ? "https" : "http"}://${host}${port === (secure ? 443 : 80) ? "" : `:${port}`}`;
}

/** Caddy's own precedence: exact before prefix, then the longest path. */
function routeFor(routes: readonly PersistedProxyRoute[], url: URL): PersistedProxyRoute | undefined {
  const matches = routes.filter((route) => {
    if (routeOrigin(route) !== url.origin) return false;
    const routePath = (route.path ?? "/").toLowerCase();
    const requestPath = url.pathname.toLowerCase();
    if ((route.match ?? "prefix") === "exact") return requestPath === routePath;
    const prefix = routePath.replace(/\/$/, "");
    return prefix === "" || requestPath === prefix || requestPath.startsWith(`${prefix}/`);
  });
  const rank = (route: PersistedProxyRoute) => ((route.match ?? "prefix") === "exact" ? 1_000_000 : 0) + (route.path ?? "/").length;
  return matches.sort((a, b) => rank(b) - rank(a))[0];
}

async function readRoutes(stateDir: string): Promise<{ committed: PersistedProxyRoute[]; pending?: PersistedProxyRoute[] }> {
  const read = async (name: string) => {
    let raw: string;
    try { raw = await readFile(path.join(stateDir, name), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw invalid("Proxy route state is unreadable, so route ownership cannot be established.");
    }
    try { return parsePersistedProxyRoutes(JSON.parse(raw)); }
    catch { throw invalid("Proxy route state is invalid, so route ownership cannot be established."); }
  };
  const [committed, pending] = await Promise.all([read("proxy-routes.json"), read("proxy-routes.pending.json")]);
  return { committed: committed ?? [], ...(pending ? { pending } : {}) };
}

const binding = (route: PersistedProxyRoute): RouteBinding => ({
  id: route.id, hostname: route.hostname.toLowerCase(), path: route.path ?? "/", match: route.match ?? "prefix", targetPort: route.targetPort, updatedAt: route.updatedAt,
});
const sameBinding = (a: RouteBinding, b: RouteBinding) => a.id === b.id && a.hostname === b.hostname && a.path === b.path && a.match === b.match && a.targetPort === b.targetPort && a.updatedAt === b.updatedAt;

function defaultOwnerLive(stateDir: string): OwnerLiveness {
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  return async (ownerId) => await registry.instanceMayRun(ownerId);
}

/**
 * The owner route that serves url right now. It must be committed, not in a
 * pending route transition, owned by ownerId and, when bound, unchanged
 * since registration; and the owner's lifecycle must still be running.
 */
async function liveOwnerRoute(stateDir: string, ownerId: string, url: URL, ownerLive: OwnerLiveness, bound?: RouteBinding): Promise<RouteBinding> {
  const { committed, pending } = await readRoutes(stateDir);
  const route = routeFor(committed, url);
  if (bound) {
    const current = committed.find((item) => item.id === bound.id);
    if (!current) throw reject("route-stopped", "The target route is no longer served.");
    if (current.instanceId !== ownerId || current.updatedAt !== bound.updatedAt) throw reject("stale-owner", "The target route belongs to a different or restarted owner.");
    if (!sameBinding(binding(current), bound) || route?.id !== current.id) throw reject("target-mutated", "The target route changed after registration.");
  }
  if (!route) throw reject("target-invalid", "The callback URL is not served by a DevFn route.");
  if (route.instanceId !== ownerId) throw reject(bound ? "stale-owner" : "target-invalid", "The callback URL is served by another owner.");
  const pendingRoute = pending?.find((item) => item.id === route.id);
  if (pending && (!pendingRoute || !sameBinding(binding(pendingRoute), binding(route)) || pendingRoute.instanceId !== ownerId)) {
    throw reject(bound ? "route-stopped" : "target-invalid", "The target route is changing; retry after the route transition completes.");
  }
  if (!await ownerLive(ownerId)) throw reject("stale-owner", "The target route's owner is not running.");
  return binding(route);
}

/** The relay service, when its recorded process is verifiably this record's process. */
async function runningService(stateDir: string): Promise<OAuthRelayService> {
  const service = await readRelayService(stateDir);
  if (!service) throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", "The DevFn OAuth relay is not running; run devfn oauth-relay start.");
  if (await processIdentityStatus(service.pid, service.birthSignature) !== "running") throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", "The recorded DevFn OAuth relay is not running.");
  return service;
}

/** Drop tickets and tombstones after expiry; nothing else is rewritten. */
const prune = (state: TicketState, now: number): Ticket[] => state.tickets.filter((ticket) => Date.parse(ticket.expiresAt) > now);

export interface RegisterOAuthRelayStateInput {
  /** Opaque lifecycle owner, normally the process's DEVFN_INSTANCE_ID. */
  ownerId: string;
  /** The OAuth state value the client sends to the provider unchanged. */
  state: string;
  /** The registered redirect URI on the relay origin, used for authorization and token exchange. */
  redirectUri: string;
  /** The owner's own callback URL on one of its live DevFn routes. */
  callbackUrl: string;
  expiresInSeconds?: number;
}

/**
 * Bind one OAuth state to the registering owner's live route. The state is
 * single-use and expiring, and a state can be bound only once: a second
 * registration, even with the same target, is refused.
 */
export async function registerOAuthRelayState(stateDir: string, input: RegisterOAuthRelayStateInput, options: RelayStateOptions = {}): Promise<{ expiresAt: string }> {
  const now = options.now ?? (() => new Date());
  if (!text(input.ownerId, 256) || input.ownerId === OAUTH_RELAY_OWNER_ID) throw reject("malformed", "A relay owner must be a non-empty lifecycle owner identity.");
  if (typeof input.state !== "string" || !STATE_PATTERN.test(input.state)) throw reject("malformed", "The OAuth state must be 22-512 unreserved URL characters.");
  const ttl = input.expiresInSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) throw reject("malformed", `Relay state lifetime must be 1-${MAX_TTL_SECONDS} seconds.`);
  const redirect = typeof input.redirectUri === "string" ? canonicalHttpUrl(input.redirectUri) : undefined;
  const callback = typeof input.callbackUrl === "string" ? canonicalHttpUrl(input.callbackUrl) : undefined;
  if (!redirect || !callback) throw reject("malformed", "Redirect and callback URLs must be canonical http(s) URLs without credentials, query or fragment.");
  await relayDirectory(stateDir);
  return await withFileLock(relayPaths(stateDir).lock, async () => {
    const service = await runningService(stateDir);
    if (redirect.origin !== service.origin) throw reject("wrong-origin", "The redirect URI is not on the relay origin.");
    if (callback.origin === service.origin) throw reject("target-invalid", "The callback URL cannot be the relay itself.");
    const route = await liveOwnerRoute(stateDir, input.ownerId, callback, options.ownerLive ?? defaultOwnerLive(stateDir));
    const state = await readTickets(stateDir);
    const at = now();
    const tickets = prune(state, at.getTime());
    const id = stateDigest(input.state);
    if (state.tickets.some((ticket) => ticket.id === id)) throw reject("target-mutated", "This OAuth state is already bound; a state cannot be rebound.");
    if (tickets.filter((ticket) => ticket.ownerId === input.ownerId && !ticket.consumedAt).length >= MAX_LIVE_TICKETS_PER_OWNER) {
      throw reject("capacity", "This owner has too many pending OAuth relay states.");
    }
    const expiresAt = new Date(at.getTime() + ttl * 1000).toISOString();
    tickets.push({ id, ownerId: input.ownerId, redirectUri: redirect.href, callbackUrl: callback.href, route, createdAt: at.toISOString(), expiresAt });
    await writePrivateJson(relayPaths(stateDir).tickets, { version: 1, tickets });
    return { expiresAt };
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

export interface OAuthRelayCallback {
  /** The relay origin this process serves, from its service record. */
  origin: string;
  /** Scheme from the relay origin with the request's Host. */
  requestOrigin: string;
  requestPath: string;
  /** The raw query string, without "?"; forwarded byte-exact. */
  rawQuery: string;
}

/**
 * Consume the ticket for a provider callback and return the owner's callback
 * URL with the provider's query unchanged. The ticket is consumed before any
 * route check, so every attempt that reaches it is its only attempt.
 */
export async function consumeOAuthRelayCallback(stateDir: string, input: OAuthRelayCallback, options: RelayStateOptions = {}): Promise<{ location: string }> {
  const now = options.now ?? (() => new Date());
  if (!QUERY_PATTERN.test(input.rawQuery) || !PATH_PATTERN.test(input.requestPath)) throw reject("malformed", "The callback request is malformed.");
  const query = new URLSearchParams(input.rawQuery);
  const states = query.getAll("state");
  const codes = query.getAll("code");
  const errors = query.getAll("error");
  if (states.length !== 1 || !STATE_PATTERN.test(states[0]) || codes.length > 1 || errors.length > 1 || codes.length + errors.length !== 1) {
    throw reject("malformed", "A callback needs exactly one state and exactly one code or error.");
  }
  if (input.requestOrigin !== input.origin) throw reject("wrong-origin", "The callback did not arrive on the relay origin.");
  await relayDirectory(stateDir);
  return await withFileLock(relayPaths(stateDir).lock, async () => {
    const state = await readTickets(stateDir);
    const id = stateDigest(states[0]);
    const ticket = state.tickets.find((item) => item.id === id);
    if (!ticket) throw reject("unknown-state", "No relay registration exists for this state.");
    if (ticket.consumedAt) throw reject("replayed", "This OAuth state was already used.");
    const at = now();
    ticket.consumedAt = at.toISOString();
    // An expired ticket is pruned here; a later attempt finds no ticket.
    await writePrivateJson(relayPaths(stateDir).tickets, { version: 1, tickets: prune(state, at.getTime()) });
    if (Date.parse(ticket.expiresAt) <= at.getTime()) throw reject("expired", "This OAuth state expired.");
    if (`${input.origin}${input.requestPath}` !== ticket.redirectUri) throw reject("wrong-origin", "The callback did not arrive at the registered redirect URI.");
    await liveOwnerRoute(stateDir, ticket.ownerId, new URL(ticket.callbackUrl), options.ownerLive ?? defaultOwnerLive(stateDir), ticket.route);
    return { location: `${ticket.callbackUrl}?${input.rawQuery}` };
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

/** Ticket store integrity and pending counts, without any state material. */
export async function relayTicketSummary(stateDir: string, now = new Date()): Promise<{ valid: boolean; pending: number }> {
  try {
    const state = await readTickets(stateDir);
    return { valid: true, pending: state.tickets.filter((ticket) => !ticket.consumedAt && Date.parse(ticket.expiresAt) > now.getTime()).length };
  } catch (error) {
    if (error instanceof OAuthRelayError) return { valid: false, pending: 0 };
    throw error;
  }
}
