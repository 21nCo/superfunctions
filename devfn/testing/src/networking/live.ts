import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { access, lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { defaultStateDir, matchesProcessIdentity, processBirthSignature } from "@devfn/config";
import { resolveInstanceIdentity } from "@devfn/core";
import { parsePersistedProxyRoutes, parseProxyOwner, proxyOwnerStatus } from "@devfn/ports";
import { proxyListenerPorts, PUBLIC_ORIGIN_HEADER, readRegisteredDomains } from "@devfn/proxy";
import { readRelayService } from "@devfn/proxy/oauth-relay";
import { caddyInternalRoot, CloudflareTunnelProvider, ngrokMarker, ownershipMarker, readTunnelBindings, readTunnelState, tunnelCapabilities, type TunnelBinding } from "@devfn/proxy/tunnel";

import { byCodeUnit, ownerLabel } from "./matrix.js";
import { cloudflareConnectors, loopbackListening } from "./prerequisites.js";
import type { DisposableInventory, ProtectedSnapshot, ResourceHandlers } from "./inventory.js";

export interface CliResult { code: number; json: Record<string, any> }

/** The project ID of every generic fixture manifest. */
export const QUALIFICATION_PROJECT_ID = "qualification";

const LIFECYCLE_STATES: ReadonlySet<unknown> = new Set(["planning", "starting", "ready", "degraded", "failed", "stopped"]);

/** A devfn status that answered for the owner it was asked about. */
export type OwnedStatus = Record<string, any> & { state: "planning" | "starting" | "ready" | "degraded" | "failed" | "stopped"; instanceId: string };

/**
 * The status result when it is a readable answer for owner: exit 0 with a
 * lifecycle state and that owner's instance ID. DevFn answers every state so,
 * degraded and failed ones with ok false too. An unparseable, timed-out or
 * killed command, or another owner's answer, reads nothing: no negative or
 * not-ready claim rests on it.
 */
export function ownedStatus(result: CliResult, owner: string): OwnedStatus | undefined {
  return result.code === 0 && LIFECYCLE_STATES.has(result.json.state) && result.json.instanceId === owner ? result.json as OwnedStatus : undefined;
}

/**
 * The error codes shipped DevFn answers for a failure a driver provokes. An
 * error is evidence only when DevFn reported it: exit 1, ok false and one of
 * these codes, never UNPARSEABLE or a command the run timed out or killed.
 */
export const SHIPPED_ERRORS = {
  /** A start whose node exits before it is healthy. */
  startupFailure: ["DEVFN_START_FAILED"],
  /** The losing one of two concurrent starts: it found the winner's ready lifecycle, or timed out waiting for its lock. */
  concurrentStart: ["DEVFN_ALREADY_RUNNING", "DEVFN_REGISTRY_LOCK_TIMEOUT"],
} as const satisfies Record<string, readonly string[]>;

/** Whether result is DevFn's own report of one of codes. */
export function failedWith(result: CliResult | undefined, codes: readonly string[]): boolean {
  return result?.code === 1 && result.json.ok === false && codes.includes(result.json.error?.code);
}

/** A process the run observed as its own, with the birth identity read while it was known to be that process. */
export interface RecordedProcess { pid: number; birthSignature: string; startedAt: string }
export interface Answer { status: number; body: string; headers: http.IncomingHttpHeaders; json?: Record<string, any> }

/**
 * A generic fixture process: it records the DevFn values, and the fixture's
 * own QUAL_ profile values, it sees at its first instruction, before
 * listening, then answers every request with its
 * worktree marker, the path and Host it received, and its owner. With a
 * fail-<name> file it exits before listening; a variable named in that file
 * holds a sibling's URL, which it requests first and records, so the failure
 * is known to happen while that sibling answers. With a hold-<name> file it
 * waits to listen until the file is removed, so a start can be killed before
 * it is ready.
 */
export const FIXTURE_SERVER = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const [name, portKey] = process.argv.slice(2);
const seen = { pid: process.pid, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("DEVFN_") || key.startsWith("QUAL_"))) };
writeFileSync(\`seen-\${name}.json\`, JSON.stringify(seen));
if (existsSync(\`fail-\${name}\`)) {
  const sibling = readFileSync(\`fail-\${name}\`, "utf8").trim();
  if (sibling) {
    seen.sibling = await fetch(process.env[sibling] ?? "", { signal: AbortSignal.timeout(5000) }).then((answer) => answer.json()).catch(() => null);
    writeFileSync(\`seen-\${name}.json\`, JSON.stringify(seen));
  }
  process.exit(3);
}
while (existsSync(\`hold-\${name}\`)) await delay(100);
const marker = path.basename(process.cwd());
createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ marker, name, path: request.url, host: request.headers.host, owner: process.env.DEVFN_INSTANCE_ID }));
}).listen(Number(process.env[portKey]), "127.0.0.1");
`;

/**
 * The provider edge's own refusal to route a public name: a Cloudflare 1xxx
 * edge error from Cloudflare's server (plain text for a non-browser client,
 * with a 4xx or Cloudflare's own 530) or an ngrok ERR_NGROK error with a 4xx.
 * An answer carrying a fixture marker or the DevFn origin's header passed
 * the edge, so it is never one.
 */
export function edgeRefused(answer: Answer, provider: TunnelBinding["provider"]): boolean {
  if (answer.json?.marker !== undefined || answer.headers[PUBLIC_ORIGIN_HEADER.toLowerCase()] !== undefined) return false;
  const client = answer.status >= 400 && answer.status < 500;
  if (provider === "cloudflare") return answer.headers.server === "cloudflare" && typeof answer.headers["cf-ray"] === "string" && (client || answer.status === 530) && /^error code: 1\d{3}\s*$/.test(answer.body);
  return client && /^ERR_NGROK_\d+$/.test(String(answer.headers["ngrok-error-code"] ?? ""));
}

/** Whether DNS answers that hostname does not exist: its A and AAAA queries both get a not-found or no-data answer. A resolver that times out, fails or refuses answers nothing. */
export async function dnsAbsent(hostname: string, resolver: Pick<Resolver, "resolve4" | "resolve6"> = new Resolver({ timeout: 5_000, tries: 2 })): Promise<boolean> {
  const absent = async (query: Promise<unknown>) => await query.then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOTFOUND" || error.code === "ENODATA");
  return (await Promise.all([absent(resolver.resolve4(hostname)), absent(resolver.resolve6(hostname))])).every(Boolean);
}

/**
 * What one probe of a public URL showed for a negative claim: the run's own
 * route (serving), a conclusive refusal by the component that owns the
 * boundary (refused), or nothing conclusive (indeterminate).
 */
export interface PublicOutcome { outcome: "serving" | "refused" | "indeterminate"; detail: string }

/** Runs a command to completion; an aborted signal kills it with SIGKILL. */
export type CommandRunner = (command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal }) => Promise<{ code: number; stdout: string; stderr: string }>;

const run: CommandRunner = async (command, args, options = {}) => await new Promise((resolve) => {
  execFile(command, [...args], { cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? 180_000, maxBuffer: 16 * 1024 * 1024, signal: options.signal, killSignal: "SIGKILL" },
    (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});

/**
 * The public names the provider holds for a run's name or binding: the name
 * when Cloudflare holds a DNS record DevFn owns for it, or the hosts of every
 * ngrok endpoint or tunnel at the name or its URL, and of one carrying the
 * registration's marker without a readable URL, which cannot be told apart
 * from it. A sibling route of the same binding is not the name's. Without a
 * hostname or URL (for an ngrok ephemeral route, without its assigned URL),
 * every name carrying the binding's marker: its Cloudflare DNS records or its
 * ngrok endpoints and tunnels. Empty is absence; a failed read throws, it is
 * never absence.
 */
export type ProviderReadBack = (binding: TunnelBinding, hostname: string | undefined, url: string | undefined) => Promise<string[]>;

const NGROK_API = "https://api.ngrok.com";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Every DNS record name in the binding's zone that carries its DevFn ownership comment. */
async function cloudflareMarked(binding: TunnelBinding, env: NodeJS.ProcessEnv, fetcher: typeof fetch): Promise<string[]> {
  if (binding.provider !== "cloudflare") return [];
  const token = env[binding.cloudflare.apiTokenEnv];
  if (!token) throw new Error(`Cloudflare binding ${binding.name} has no readable API token, so its DNS records cannot be read back`);
  const names: string[] = [];
  for (let page = 1, pages = 1; page <= pages; page += 1) {
    if (page > 50) throw new Error("Cloudflare DNS record paging is unreadable");
    const response = await fetcher(`${CLOUDFLARE_API}/zones/${binding.cloudflare.zoneId}/dns_records?per_page=100&page=${page}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const payload = await response.json().catch(() => undefined) as { success?: boolean; result?: Array<{ name?: string; comment?: string | null }>; result_info?: { total_pages?: number } } | undefined;
    if (!response.ok || payload?.success !== true || !Array.isArray(payload.result) || typeof payload.result_info?.total_pages !== "number") throw new Error(`Cloudflare GET dns_records answered HTTP ${response.status}`);
    for (const record of payload.result) if (record.comment === ownershipMarker(binding)) names.push(String(record.name));
    pages = payload.result_info.total_pages;
  }
  return names.sort(byCodeUnit);
}

export function providerReadBack(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): ProviderReadBack {
  return async (binding, hostname, url) => {
    if (binding.provider === "cloudflare") {
      if (hostname === undefined) return await cloudflareMarked(binding, env, fetcher);
      return await new CloudflareTunnelProvider({ env, fetch: fetcher }).ownsDns(binding, hostname) ? [hostname] : [];
    }
    const key = binding.ngrok.apiKeyEnv ? env[binding.ngrok.apiKeyEnv] : undefined;
    if (!key) throw new Error(`ngrok binding ${binding.name} has no readable API key, so its endpoints cannot be read back`);
    const names = new Set([...(hostname ? [hostname] : []), ...(url ? [new URL(url).hostname] : [])]);
    // An ephemeral route's name is DevFn's origin name, which ngrok never holds: without its assigned URL nothing tells its endpoints apart, so all the binding's count.
    const scoped = binding.ngrok.endpoints === "ephemeral" ? url !== undefined : names.size > 0;
    const held = new Set<string>();
    for (const [route, list] of [["/endpoints", "endpoints"], ["/tunnels", "tunnels"]] as const) {
      let next: string | undefined = `${NGROK_API}${route}?limit=100`;
      for (let page = 0; next; page += 1) {
        if (page >= 50 || !next.startsWith(`${NGROK_API}/`)) throw new Error(`ngrok ${route} paging is unreadable`);
        const response = await fetcher(next, { headers: { authorization: `Bearer ${key}`, "ngrok-version": "2" }, signal: AbortSignal.timeout(15_000) });
        const payload = await response.json().catch(() => undefined) as Record<string, any> | undefined;
        if (!response.ok || !Array.isArray(payload?.[list])) throw new Error(`ngrok GET ${route} answered HTTP ${response.status}`);
        for (const item of payload![list] as Array<Record<string, unknown>>) {
          const hosts = [item.url, item.public_url].flatMap((value) => { try { return typeof value === "string" ? [new URL(value).hostname] : []; } catch { return []; } });
          const owned = item.metadata === ngrokMarker(binding);
          // Asked for a name, only its own endpoints count; binding-wide, everything carrying the marker.
          const counts = scoped ? hosts.some((name) => names.has(name)) || (owned && !hosts.length) : owned;
          if (counts) for (const name of hosts.length ? hosts : ["an endpoint without a URL"]) held.add(name);
        }
        next = typeof payload!.next_page_uri === "string" && payload!.next_page_uri ? payload!.next_page_uri : undefined;
      }
    }
    return [...held].sort(byCodeUnit);
  };
}

/**
 * A DevFn up or restart waits on each node's health budget in plan order, and
 * Compose may pull an image first. It is killed only past that budget plus
 * slack, so a slow but healthy start never dies holding its lifecycle lock.
 */
export const LIFECYCLE_COMMAND_TIMEOUT_MS = 900_000;

/** The Linux locations whose certificates the operating system trust tooling reads. */
export const LINUX_TRUST_LOCATIONS: readonly string[] = ["/etc/ssl/certs", "/usr/local/share/ca-certificates", "/etc/pki/ca-trust/source/anchors", "/etc/pki/tls/certs"];

/**
 * Every entry under the trust locations, recursively: a file by its content
 * digest, a symbolic link by its target and the digest of the file it names,
 * a directory (also one reached through a link, once by real path) by its
 * entries. An absent location is empty; any other failed read throws, so an
 * unreadable certificate is never read as unchanged.
 */
export async function trustDirectoryAnchors(locations: readonly string[]): Promise<string[]> {
  const anchors: string[] = [];
  const walked = new Set<string>();
  const digest = async (file: string): Promise<string> => `${file}:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
  const walk = async (dir: string): Promise<void> => {
    const real = await realpath(dir);
    if (walked.has(real)) return;
    walked.add(real);
    for (const name of (await readdir(dir)).sort(byCodeUnit)) {
      const entry = path.join(dir, name);
      const info = await lstat(entry);
      if (info.isSymbolicLink()) {
        // A link whose target is gone or loops trusts nothing; the link itself is still recorded.
        const target = await stat(entry).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" || error.code === "ELOOP") return undefined; throw error; });
        anchors.push(`${entry} -> ${await readlink(entry)}${target ? "" : " (unresolved)"}`);
        if (target?.isDirectory()) await walk(entry);
        else if (target?.isFile()) anchors.push(await digest(entry));
      } else if (info.isDirectory()) await walk(entry);
      else if (info.isFile()) anchors.push(await digest(entry));
      else anchors.push(`${entry}: not a file`);
    }
  };
  for (const location of locations) {
    const info = await stat(location).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) continue;
    if (!info.isDirectory()) throw new Error(`trust location ${location} is not a directory`);
    await walk(location);
  }
  return anchors.sort(byCodeUnit);
}

/** devfn commands that only read state or remove what a run created; they still run after an abort. */
const READ_OR_CLEANUP = /^(down|status|ports|url|tunnel (status|urls|unregister)|domains unregister|oauth-relay (status|stop))( |$)/;

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/** Every reason a resource is still present, or false when there is none. */
const reasons = (items: ReadonlyArray<string | undefined>): string | false => items.filter(Boolean).join("; ") || false;

/** A lifecycle lock a killed DevFn command held is recoverable only once stale (five minutes); cleanup waits that long for it. */
const LOCK_STALE_WAIT_MS = 360_000;

/** The longest an HTTP probe may take, however its socket behaves. */
export const REQUEST_DEADLINE_MS = 30_000;

/**
 * One GET that always settles. It resolves only on a complete response; a
 * connection or response error, a response cut before it was complete, an
 * idle socket, the overall deadline or stop (the run's interrupt) rejects it
 * and destroys the request. The deadline is a plain timer, held until the
 * probe settles, so it fires however long the socket keeps sending.
 */
async function boundedGet(client: typeof http | typeof https, options: https.RequestOptions, bound: { deadlineMs: number; stop?: AbortSignal }, what: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    const onAbort = () => finish(new Error(`${what} was interrupted`));
    const finish = (error: Error | undefined, answer?: { status: number; body: string; headers: http.IncomingHttpHeaders }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      bound.stop?.removeEventListener("abort", onAbort);
      if (error) { request?.destroy(); reject(error); } else resolve(answer!);
    };
    const deadline = setTimeout(() => finish(new Error(`${what} passed its deadline`)), bound.deadlineMs);
    // A request Node.js refuses to build (a bad port or header) throws here; it settles the probe and clears the deadline at once.
    try {
      request = client.request({ ...options, method: "GET", agent: false }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.once("end", () => finish(response.complete ? undefined : new Error(`${what} ended before its response was complete`), { status: response.statusCode ?? 0, body, headers: response.headers }));
        response.once("error", (error) => finish(error));
        // A response that closes without its end was cut, whatever its socket does next.
        response.once("close", () => finish(new Error(`${what} closed before its response was complete`)));
      });
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); return; }
    const built = request;
    built.once("timeout", () => built.destroy(new Error(`${what} timed out`)));
    built.once("error", (error) => finish(error));
    if (bound.stop?.aborted) onAbort(); else bound.stop?.addEventListener("abort", onAbort, { once: true });
    built.end();
  });
}

/** The connector ID a cloudflared reports on its metrics GET /ready ({"status":200,"readyConnections":n,"connectorId":"<uuid>"}); undefined when it does not answer one. */
export async function cloudflaredConnectorId(metricsPort: number): Promise<string | undefined> {
  const answer = await boundedGet(http, { host: "127.0.0.1", port: metricsPort, path: "/ready", timeout: 5_000 }, { deadlineMs: 10_000 }, `cloudflared metrics on ${metricsPort}`).catch(() => undefined);
  try { const id = (JSON.parse(answer?.body ?? "") as { connectorId?: unknown }).connectorId; return typeof id === "string" && id ? id : undefined; } catch { return undefined; }
}

/** Times DevFn rewrites without a material change; every other field of a protected record is compared. */
const VOLATILE = new Set(["createdAt", "updatedAt", "releasedAt"]);

/** A digest of a record's material fields as sorted-key JSON. Protected records hold credential variable names and paths, never values. */
export function materialDigest(record: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).filter((key) => !VOLATILE.has(key)).sort(byCodeUnit).map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(record))).digest("hex").slice(0, 16);
}

/**
 * The real host a live run drives: the built DevFn CLI against a dedicated
 * state directory under the run root, generic fixture repositories, and
 * loopback or public HTTP(S) probes. Every resource it creates is recorded
 * in the run inventory first, so cleanup reaches it whatever fails later.
 * Every DevFn child, and the Caddy and Compose processes it starts, sees XDG
 * directories under the run root, so the run's internal CA and Caddy
 * configuration never touch the operator's, and Docker pinned to the local
 * engine the prerequisites resolved. Once aborted, the host kills its
 * in-flight DevFn commands and runs only read and cleanup commands.
 */
export class LiveHost {
  public readonly stateDir: string;
  /** Provider and host limitations noted while the run used them. */
  public readonly limitations = new Set<string>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly exec: CommandRunner;
  /** The provider read-back public-name cleanup uses; drivers use it for positive absence evidence. */
  public readonly readBack: ProviderReadBack;

  private readonly stop = new AbortController();
  /** Compose containers and networks of the run's own owners that a read-back found; reaped only after that read-back was recorded. */
  private readonly composeLeft = new Set<string>();
  /** The relay and connector processes, and the binding, a resource had when its removal began; its read-back confirms them gone. */
  private readonly removed = new Map<string, { pids: Set<number>; binding?: TunnelBinding; unreadable?: string }>();
  /** Connector IDs the run's own cloudflared processes reported on their metrics /ready; never inferred from timing. */
  private readonly ownConnectors = new Set<string>();
  private readonly connectors: (binding: Extract<TunnelBinding, { provider: "cloudflare" }>) => Promise<string[]>;
  private readonly connectorIdentity: (metricsPort: number) => Promise<string | undefined>;
  private readonly connectorReads: { reads: number; intervalMs: number };

  public constructor(public readonly options: { root: string; devfnCli: string; env: NodeJS.ProcessEnv; inventory: DisposableInventory; run?: CommandRunner; providers?: ProviderReadBack; docker?: string;
    connectors?: (binding: Extract<TunnelBinding, { provider: "cloudflare" }>) => Promise<string[]>; connectorIdentity?: (metricsPort: number) => Promise<string | undefined>;
    connectorReads?: { reads: number; intervalMs: number }; trustLocations?: readonly string[]; owner?: (cwd: string) => Promise<string>; dnsAbsent?: (hostname: string) => Promise<boolean> }) {
    this.stateDir = path.join(options.root, "state");
    const { DOCKER_CONTEXT: _context, ...env } = options.env;
    this.env = { ...env, ...(options.docker ? { DOCKER_HOST: options.docker } : {}),
      ...Object.fromEntries(["DATA", "CONFIG", "STATE"].map((kind) => [`XDG_${kind}_HOME`, path.join(options.root, "xdg", kind.toLowerCase())])) };
    this.exec = options.run ?? run;
    this.readBack = options.providers ?? providerReadBack(options.env);
    this.connectors = options.connectors ?? (async (binding) => await cloudflareConnectors(binding.cloudflare, options.env));
    this.connectorIdentity = options.connectorIdentity ?? cloudflaredConnectorId;
    this.connectorReads = options.connectorReads ?? { reads: 6, intervalMs: 5_000 };
  }

  /**
   * Learn the connector ID of every connector the run state records for
   * binding, from its own metrics endpoint, only while its process matches
   * the recorded birth identity: an exited, reused or unverifiable PID
   * vouches for nothing. IDs learned so are kept for delayed read-back.
   */
  private async identifyOwnConnectors(binding: TunnelBinding): Promise<void> {
    const state = await readTunnelState(this.stateDir, binding.name);
    for (const record of [state.connector, ...state.retired]) {
      if (!record || !await matchesProcessIdentity(record.pid, record.birthSignature, record.startedAt)) continue;
      const id = await this.connectorIdentity(record.metricsPort).catch(() => undefined);
      if (id) this.ownConnectors.add(id);
    }
  }

  /**
   * Every connector connected to binding's Cloudflare tunnel must be one the
   * run identified as its own. Cloudflare's connection list lags a connector
   * change, so a foreign, contradictory or unreadable answer is read again a
   * few times before the step is refused.
   */
  private async assertOwnConnectors(binding: Extract<TunnelBinding, { provider: "cloudflare" }>, when: string): Promise<void> {
    let problem = "";
    for (let read = 0; read < this.connectorReads.reads; read += 1) {
      if (read) await this.wait(this.connectorReads.intervalMs);
      await this.identifyOwnConnectors(binding);
      const connected = await this.connectors(binding).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
      if (connected instanceof Error) { problem = connected.message; continue; }
      const foreign = connected.filter((id) => !this.ownConnectors.has(id));
      if (!foreign.length) return;
      problem = `Cloudflare tunnel ${binding.cloudflare.tunnelId} has connectors the run did not start (${foreign.join(", ")}) ${when}; an approved tunnel serves one run at a time`;
    }
    throw new Error(problem);
  }

  /**
   * Run a step that may start, swap or recover a connector for binding. On a
   * Cloudflare tunnel every connected connector must be one the run started,
   * by the connector ID its own cloudflared reports, both before the step
   * and after it: Cloudflare would spread the run's traffic over another
   * runtime's connector.
   */
  public async soleTunnelUser<T>(binding: TunnelBinding, step: () => Promise<T>): Promise<T> {
    if (binding.provider !== "cloudflare") return await step();
    await this.assertOwnConnectors(binding, "before the step");
    const result = await step();
    await this.assertOwnConnectors(binding, "after the step");
    return result;
  }

  /** Kill in-flight DevFn commands and refuse anything that could create a resource from now on. */
  public abort(): void { this.stop.abort(); }

  public get aborted(): boolean { return this.stop.signal.aborted; }

  private refuseIfAborted(what: string): void { if (this.aborted) throw new Error(`the run was interrupted; ${what} is refused`); }

  /** Wait ms; an interrupt ends the wait by throwing, so no driver keeps waiting once the run is interrupted. */
  public async wait(ms: number): Promise<void> {
    this.refuseIfAborted("waiting");
    await delay(ms, undefined, { signal: this.stop.signal }).catch(() => this.refuseIfAborted("waiting"));
  }

  public get prefix(): string { return this.options.inventory.prefix; }

  /**
   * Run one devfn command with --json against the run state directory. After
   * abort only read and cleanup commands run; signal kills this command alone.
   */
  public async devfn(cwd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<CliResult> {
    if (!READ_OR_CLEANUP.test(args.slice(0, 2).join(" "))) this.refuseIfAborted(`devfn ${args.join(" ")}`);
    const signal = READ_OR_CLEANUP.test(args.slice(0, 2).join(" ")) ? options.signal : AbortSignal.any([this.stop.signal, ...(options.signal ? [options.signal] : [])]);
    const result = await this.exec(process.execPath, [this.options.devfnCli, ...args, "--json", "--state-dir", this.stateDir],
      { cwd, env: { ...this.env, ...options.env }, ...(signal ? { signal } : {}), ...(args[0] === "up" || args[0] === "restart" ? { timeoutMs: LIFECYCLE_COMMAND_TIMEOUT_MS } : {}) });
    try { return { code: result.code, json: JSON.parse(result.stdout) as Record<string, any> }; }
    catch { return { code: result.code === 0 ? -1 : result.code, json: { ok: false, error: { code: "UNPARSEABLE", message: result.stderr.slice(-2000) } } }; }
  }

  /** The instance ID DevFn derives for a fixture checkout. */
  public async owner(cwd: string): Promise<string> {
    return await (this.options.owner ?? (async (root: string) => (await resolveInstanceIdentity(QUALIFICATION_PROJECT_ID, root)).instanceId))(cwd);
  }

  /** devfn status (with args) for cwd when it answers for cwd's owner; undefined otherwise (see ownedStatus). */
  public async status(cwd: string, args: readonly string[] = []): Promise<OwnedStatus | undefined> {
    return ownedStatus(await this.devfn(cwd, ["status", ...args]), await this.owner(cwd));
  }

  /** Record pid with its current birth identity; undefined when that identity cannot be read. */
  public async recordProcess(pid: number): Promise<RecordedProcess | undefined> {
    const birthSignature = await processBirthSignature(pid);
    return birthSignature ? { pid, birthSignature, startedAt: new Date().toISOString() } : undefined;
  }

  /** Whether a recorded process still runs with its recorded birth identity; an exited, reused or unverifiable PID does not. */
  public async stillRecorded(recorded: RecordedProcess | undefined): Promise<boolean> {
    return recorded !== undefined && await matchesProcessIdentity(recorded.pid, recorded.birthSignature, recorded.startedAt);
  }

  /**
   * SIGKILL a recorded run-owned process, or its process group, only once
   * its current identity verifiably matches the record: an exited, reused or
   * unverifiable PID is never signalled. True when the signal was sent.
   */
  public async killRecorded(recorded: RecordedProcess | undefined, group: boolean): Promise<boolean> {
    if (!recorded || !await this.stillRecorded(recorded)) return false;
    for (const target of group ? [-recorded.pid, recorded.pid] : [recorded.pid]) {
      try { process.kill(target, "SIGKILL"); return true; } catch { /* the group is gone; try the leader */ }
    }
    return false;
  }

  /** devfn command that must succeed; its JSON result. */
  public async must(cwd: string, args: readonly string[]): Promise<Record<string, any>> {
    const result = await this.devfn(cwd, args);
    if (result.code !== 0 || result.json.ok === false) throw new Error(`devfn ${args.join(" ")} failed: ${JSON.stringify(result.json.error ?? result.json).slice(0, 2000)}`);
    return result.json;
  }

  /**
   * A devfn down that an already stopped lifecycle also satisfies. A start the
   * interrupt killed leaves its lifecycle lock until the lock is stale, so a
   * lock timeout is retried until then rather than leaving the runtime up.
   */
  private async down(cwd: string): Promise<void> {
    const deadline = Date.now() + LOCK_STALE_WAIT_MS;
    let result = await this.devfn(cwd, ["down"]);
    while (result.code !== 0 && result.json.error?.code === "DEVFN_REGISTRY_LOCK_TIMEOUT" && Date.now() < deadline) {
      await delay(15_000);
      result = await this.devfn(cwd, ["down"]);
    }
    if (result.code !== 0 && result.json.error?.code !== "DEVFN_NOT_RUNNING") throw new Error(`devfn down failed: ${JSON.stringify(result.json.error)}`);
  }

  /** A committed generic fixture repository named for the run. */
  public async repository(scenario: string, name: string, config: unknown, files: Record<string, string> = {}): Promise<string> {
    this.refuseIfAborted(`fixture repository ${name}`);
    const root = path.join(this.options.root, `${this.prefix}-${name}`);
    this.options.inventory.record("fixture-repository", root, scenario);
    await mkdir(root, { recursive: true });
    for (const [file, text] of Object.entries({ "server.mjs": FIXTURE_SERVER, "devfn.config.json": `${JSON.stringify(config, null, 2)}\n`, ".gitignore": ".devfn/\nseen-*.json\nfail-*\nhold-*\n", ...files })) {
      await writeFile(path.join(root, file), text, "utf8");
    }
    for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=DevFn Qualification", "-c", "user.email=qualification@devfn.invalid", "commit", "-q", "-m", "fixture"]]) await this.git(root, args);
    await this.trust(root);
    return root;
  }

  /** A linked worktree of a fixture repository, named for the run. */
  public async worktree(scenario: string, repository: string, label: string): Promise<string> {
    this.refuseIfAborted(`worktree ${label}`);
    const target = `${repository}-${label}`;
    this.options.inventory.record("fixture-repository", target, scenario, { cwd: repository });
    await this.git(repository, ["worktree", "add", "-q", "-b", `${this.prefix}-${label}`, target]);
    await this.trust(target);
    return target;
  }

  /** Trust the run's own fixture manifest at this checkout, in the run state directory only. */
  public async trust(cwd: string): Promise<void> { await this.must(cwd, ["status", "--trust"]); }

  private async git(cwd: string, args: readonly string[]): Promise<void> {
    const result = await this.exec("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }

  /** Start a fixture lifecycle, recording it first so a partial start is still stopped. */
  public async up(scenario: string, cwd: string, args: readonly string[] = [], signal?: AbortSignal): Promise<CliResult> {
    this.refuseIfAborted("devfn up");
    if (!this.options.inventory.list(scenario).some((entry) => entry.kind === "runtime" && entry.id === cwd && !entry.cleanup)) this.options.inventory.record("runtime", cwd, scenario);
    return await this.devfn(cwd, ["up", ...args], signal ? { signal } : {});
  }

  /** A docker command against the engine the run pinned. */
  public async docker(args: readonly string[]): Promise<{ code: number; stdout: string }> { return await this.exec("docker", args, { env: this.env, timeoutMs: 60_000 }); }

  /** Containers and networks of an owner's Compose projects (named with its o-<digest> label) that still exist on the pinned engine. */
  public async composeLeftovers(instanceId: string): Promise<string[]> {
    const owner = `-${ownerLabel(instanceId)}`;
    const left: string[] = [];
    for (const [kind, args, name] of [["container", ["ps", "-a"], "{{.Names}}"], ["network", ["network", "ls"], "{{.Name}}"]] as const) {
      const listed = await this.docker([...args, "--filter", "label=com.docker.compose.project", "--format", `${name}\t{{.Label "com.docker.compose.project"}}`]);
      if (listed.code !== 0) throw new Error(`docker could not list ${kind}s on the pinned engine`);
      for (const line of listed.stdout.split("\n")) { const [item, project = ""] = line.split("\t"); if (item && project.endsWith(owner)) left.push(`${kind} ${item}`); }
    }
    for (const item of left) this.composeLeft.add(item);
    return left;
  }

  /**
   * DevFn's Compose stop removes an owner's containers but leaves its project
   * network. Once no container of the owner remains, remove the owner's own
   * Compose networks and record that DevFn left them, so the receipt keeps the
   * leak and the read-back that follows still reports anything left. Other
   * projects' networks are never listed; an unreadable status removes nothing.
   */
  private async removeComposeNetworks(cwd: string): Promise<void> {
    const status = await this.status(cwd);
    // An unreadable engine removes nothing here; the read-back lists it again and fails closed.
    const left = status ? await this.composeLeftovers(status.instanceId).catch(() => [] as string[]) : [];
    if (left.some((item) => item.startsWith("container "))) return;
    for (const item of left) {
      const name = item.slice("network ".length);
      if ((await this.docker(["network", "rm", name])).code !== 0) continue;
      this.composeLeft.delete(item);
      this.limitations.add(`devfn down left Compose network ${name}; the run removed it during cleanup and read its owner's networks back absent (a DevFn teardown leak)`);
    }
  }

  /** Remove the run owners' Compose containers, then networks, that a recorded read-back reported. */
  public async reapCompose(): Promise<void> {
    const left = [...this.composeLeft].sort((a, b) => Number(b.startsWith("container")) - Number(a.startsWith("container")));
    for (const item of left) {
      const [kind, name] = item.split(" ");
      if ((await this.docker(kind === "container" ? ["rm", "-f", name] : ["network", "rm", name])).code === 0) this.composeLeft.delete(item);
    }
  }

  /** What a fixture process recorded before listening, and, for a failing one, its sibling's answer. */
  public async seen(cwd: string, name: string): Promise<{ pid: number; env: Record<string, string>; sibling?: Record<string, unknown> | null }> {
    return JSON.parse(await readFile(path.join(cwd, `seen-${name}.json`), "utf8")) as { pid: number; env: Record<string, string>; sibling?: Record<string, unknown> | null };
  }

  /** The DevFn Caddy internal root, read from its admin API once a lifecycle started it; the run never installs it anywhere. */
  public async ca(): Promise<string> { return await caddyInternalRoot(); }

  /** Note a binding's provider gaps when the run registers it, so they reach the receipt whatever happens next. */
  public noteBinding(binding: TunnelBinding): void {
    for (const gap of tunnelCapabilities(binding).gaps) this.limitations.add(`${binding.provider}${binding.provider === "ngrok" ? ` ${binding.ngrok.endpoints}` : ""}: ${gap}`);
  }

  /**
   * GET url. Local names connect to loopback at the DevFn proxy port for the
   * scheme, with the URL's Host and SNI; public URLs use real DNS. ca
   * replaces the default trust store; without it the default store applies.
   * It settles within deadlineMs and rejects an incomplete response. An
   * interrupt rejects a driver's probe in flight and refuses new ones; only a
   * cleanup read-back (afterAbort) still runs once the run is interrupted.
   */
  public async request(target: string, options: { ca?: string; address?: string; port?: number; host?: string; cookie?: string; publicDns?: boolean; deadlineMs?: number; afterAbort?: boolean } = {}): Promise<Answer> {
    if (!options.afterAbort) this.refuseIfAborted(`requesting ${target}`);
    const url = new URL(target);
    const ports = proxyListenerPorts();
    const port = options.port ?? (url.port ? Number(url.port) : options.publicDns ? (url.protocol === "https:" ? 443 : 80) : url.protocol === "https:" ? ports.httpsPort : ports.httpPort);
    const answer = await boundedGet(url.protocol === "https:" ? https : http, { ...(options.publicDns ? { hostname: url.hostname } : { host: options.address ?? "127.0.0.1" }), port, path: `${url.pathname}${url.search}`,
      headers: { host: options.host ?? url.host, connection: "close", ...(options.cookie ? { cookie: options.cookie } : {}) }, timeout: 15_000,
      ...(url.protocol === "https:" ? { servername: url.hostname, ...(options.ca ? { ca: options.ca } : {}) } : {}) },
      { deadlineMs: options.deadlineMs ?? REQUEST_DEADLINE_MS, ...(options.afterAbort ? {} : { stop: this.stop.signal }) }, target);
    let json: Record<string, any> | undefined;
    try { json = JSON.parse(answer.body) as Record<string, any>; } catch { json = undefined; }
    return { ...answer, ...(json ? { json } : {}) };
  }

  /**
   * Probe a public URL once for a negative claim. serving: the answer
   * satisfies serving. refused: the provider edge's own refusal (edgeRefused)
   * and, for a withdrawn name, the DevFn public origin's empty deny or DNS
   * answering that the name does not exist. A failed request, a failed or
   * unanswered DNS query, an incomplete response or any other answer is
   * indeterminate: it never shows that nothing serves.
   */
  public async publicOutcome(url: string, provider: TunnelBinding["provider"], serving: (answer: Answer) => boolean, options: { withdrawn?: boolean; afterAbort?: boolean } = {}): Promise<PublicOutcome> {
    const answer = await this.request(url, { publicDns: true, ...(options.afterAbort ? { afterAbort: true } : {}) }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    if (answer instanceof Error) {
      const hostname = new URL(url).hostname;
      if (options.withdrawn && (answer as NodeJS.ErrnoException).syscall === "getaddrinfo" && (answer as NodeJS.ErrnoException).code === "ENOTFOUND" && await (this.options.dnsAbsent ?? dnsAbsent)(hostname).catch(() => false)) return { outcome: "refused", detail: `DNS answers that ${hostname} does not exist` };
      return { outcome: "indeterminate", detail: `${url} gave no conclusive answer: ${answer.message}` };
    }
    const detail = `${url} -> ${answer.status} ${String(answer.headers[PUBLIC_ORIGIN_HEADER.toLowerCase()] ?? answer.headers["ngrok-error-code"] ?? answer.body.trim().slice(0, 40))}`.trim();
    if (serving(answer)) return { outcome: "serving", detail };
    const originDeny = answer.headers[PUBLIC_ORIGIN_HEADER.toLowerCase()] === "deny" && answer.body === "" && (answer.status === 403 || answer.status === 404);
    if (edgeRefused(answer, provider) || (options.withdrawn && originDeny)) return { outcome: "refused", detail };
    return { outcome: "indeterminate", detail: `${detail}: not a refusal this claim accepts` };
  }

  /** Routes of an owner in the run's DevFn proxy state. */
  public async routesOf(instanceId: string): Promise<string[]> {
    const text = await readFile(path.join(this.stateDir, "proxy-routes.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    return text === undefined ? [] : parsePersistedProxyRoutes(JSON.parse(text)).filter((route) => route.instanceId === instanceId).map((route) => route.hostname);
  }

  /** Recorded fixture process IDs of a checkout that still run. Only an absent checkout has none; any other failed read throws. */
  public async survivingFixtures(cwd: string): Promise<number[]> {
    const files = await readdir(cwd).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return [] as string[]; throw error; });
    const pids = await Promise.all(files.filter((file) => /^seen-.+\.json$/.test(file)).map(async (file) => (JSON.parse(await readFile(path.join(cwd, file), "utf8")) as { pid: number }).pid));
    return pids.filter(alive);
  }

  /**
   * Record the processes, and binding, a resource has before its removal
   * begins; repeated removals keep every one seen. When they could not be
   * read, unreadable says why, and the resource is never confirmed absent.
   */
  private beforeRemoval(key: string, pids: readonly number[], binding?: TunnelBinding, unreadable?: string): void {
    const seen = this.removed.get(key) ?? { pids: new Set<number>() };
    for (const pid of pids) seen.pids.add(pid);
    const why = seen.unreadable ?? unreadable;
    this.removed.set(key, { pids: seen.pids, ...(binding ?? seen.binding ? { binding: binding ?? seen.binding } : {}), ...(why ? { unreadable: why } : {}) });
  }

  /** The processes recorded for a resource before its removal that still run. */
  private stillRunning(key: string): number[] { return [...this.removed.get(key)?.pids ?? []].filter(alive).sort((a, b) => a - b); }

  /**
   * Removal and read-back for each recorded kind. Nothing is reaped before
   * the read-back that would report it: a runtime is read back after devfn
   * down; a checkout that still runs processes is kept for its read-back;
   * the relay and connector processes recorded before removal must be gone.
   * The run reaps leftovers only after every read-back. Read-back failures throw.
   */
  public handlers(): ResourceHandlers {
    // Only an absent path is absence; any other failed access throws.
    const exists = async (file: string) => await access(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    const describe = (what: string, items: readonly unknown[]) => items.length ? `${what}: ${items.join(", ")}` : undefined;
    const key = (entry: { kind: string; id: string }) => `${entry.kind} ${entry.id}`;
    return {
      remove: async (entry) => {
        const { cwd } = entry.context ?? {};
        if (entry.kind === "runtime" || entry.kind === "public-hostname") await this.down(entry.kind === "runtime" ? entry.id : cwd!);
        if (entry.kind === "runtime" && await this.usesCompose(entry.id)) await this.removeComposeNetworks(entry.id);
        if (entry.kind === "fixture-repository") {
          // Processes left in the checkout are its read-back's evidence: the checkout is kept, and the run reaps them only afterwards.
          const left = await this.processesIn(entry.id, await this.sharedLeaders());
          if (left.length) throw new Error(`processes ${left.join(", ")} still run in the checkout, so it is kept`);
          if (cwd) await this.exec("git", ["worktree", "remove", "--force", entry.id], { cwd });
          await rm(entry.id, { recursive: true, force: true });
        }
        // run-processes has nothing to remove: its read-back reports leftovers, which the run reaps only afterwards (reap).
        if (entry.kind === "proxy") await this.stopProxy();
        if (entry.kind === "registered-domain") await this.must(cwd!, ["domains", "unregister", entry.id]);
        if (entry.kind === "oauth-relay") {
          const relay = await readRelayService(this.stateDir).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
          this.beforeRemoval(key(entry), relay && !(relay instanceof Error) ? [relay.pid] : [], undefined, relay instanceof Error ? `the relay record was unreadable before stop: ${relay.message}` : undefined);
          await this.must(cwd!, ["oauth-relay", "stop"]);
        }
        if (entry.kind === "tunnel-binding") {
          const registered = (await readTunnelBindings(this.stateDir)).find((item) => item.name === entry.id);
          const state = registered ? await readTunnelState(this.stateDir, entry.id).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))) : undefined;
          const read = state instanceof Error ? undefined : state;
          this.beforeRemoval(key(entry), [read?.connector, ...(read?.retired ?? [])].flatMap((connector) => connector ? [connector.pid] : []), registered,
            state instanceof Error ? `the connector state was unreadable before unregister: ${state.message}` : undefined);
          await this.must(cwd!, ["tunnel", "unregister", entry.id]);
        }
      },
      present: async (entry) => {
        const { cwd, binding, url } = entry.context ?? {};
        if (entry.kind === "fixture-repository") return reasons([await exists(entry.id) ? "checkout exists" : undefined, describe("processes", await this.processesIn(entry.id, await this.sharedLeaders()))]);
        if (entry.kind === "run-processes") return describe("processes in the run root", await this.processesIn(entry.id, new Set())) ?? false;
        if (entry.kind === "runtime") {
          // Every check runs, so a Compose read-back lists what remains even when the lifecycle did not stop. DevFn answers a
          // degraded or failed state with ok false; that state is a reason here, and only a status naming no owner is unreadable.
          const status = await this.status(entry.id);
          if (!status) throw new Error("devfn status gave no readable answer for the runtime's owner");
          const leases = ((await this.must(entry.id, ["ports"])).allocations as Array<{ instanceId: string; port: number }>).filter((item) => item.instanceId === status.instanceId).map((item) => item.port);
          return reasons([status.state === "stopped" ? undefined : `state ${String(status.state)}`, describe("processes", await this.processesIn(entry.id, await this.sharedLeaders())),
            describe("fixture processes", await this.survivingFixtures(entry.id)), describe("leases", leases), describe("routes", await this.routesOf(String(status.instanceId))),
            await this.usesCompose(entry.id) ? describe("Compose resources", await this.composeLeftovers(String(status.instanceId))) : undefined]);
        }
        if (entry.kind === "proxy") return await this.proxyRunning() || await loopbackListening(2019) ? "the run's Caddy still runs or 2019 is held" : false;
        if (entry.kind === "registered-domain") return (await readRegisteredDomains(this.stateDir)).some((item) => item.domain === entry.id);
        if (entry.kind === "oauth-relay") {
          const { relay } = await this.must(cwd!, ["oauth-relay", "status"]);
          return reasons([relay.running === true || relay.routeActive === true ? "the relay runs or is routed" : undefined, describe("relay processes", this.stillRunning(key(entry))), this.removed.get(key(entry))?.unreadable]);
        }
        if (entry.kind === "tunnel-binding") {
          // A binding that was never registered never published; otherwise the provider must hold nothing carrying its marker.
          const registered = (await readTunnelBindings(this.stateDir)).find((item) => item.name === entry.id);
          const bound = registered ?? this.removed.get(key(entry))?.binding;
          return reasons([registered ? "still registered" : undefined, describe("connector processes", this.stillRunning(key(entry))), this.removed.get(key(entry))?.unreadable,
            bound ? describe(`held by ${bound.provider}`, await this.readBack(bound, undefined, undefined)) : undefined]);
        }
        // A public name is absent when DevFn no longer routes or journals it, the provider read-back holds nothing for it, and its URL no longer serves the run.
        const bound = (await readTunnelBindings(this.stateDir)).find((item) => item.name === binding);
        if (!bound) throw new Error(`binding ${binding} is not readable for ${entry.id}`);
        const { tunnel } = await this.must(cwd!, ["tunnel", "status", bound.name]);
        if (JSON.stringify([tunnel.hostnames, tunnel.outstanding, tunnel.residue ?? []]).includes(entry.id)) return "routed or journaled by DevFn";
        const held = await this.readBack(bound, entry.id, url);
        if (held.length) return `held by ${bound.provider}: ${held.join(", ")}`;
        // Only a conclusive refusal is absence; an indeterminate probe leaves the name unconfirmed.
        const seen = await this.publicOutcome(url ?? `https://${entry.id}/`, bound.provider, (answer) => answer.json?.marker !== undefined && String(answer.json.marker).startsWith(this.prefix), { withdrawn: true, afterAbort: true });
        if (seen.outcome === "indeterminate") throw new Error(`whether ${entry.id} still serves is unknown: ${seen.detail}`);
        return seen.outcome === "serving" ? "still serves the run" : false;
      },
    };
  }

  /** Whether a fixture checkout declares Compose services; an unreadable manifest counts as Compose, so its read-back still runs. */
  private async usesCompose(cwd: string): Promise<boolean> {
    return await readFile(path.join(cwd, "devfn.config.json"), "utf8").then((text) => (JSON.parse(text) as { services?: unknown }).services !== undefined, () => true);
  }

  /** Whether the Caddy DevFn started from the run state directory may still run. */
  public async proxyRunning(): Promise<boolean> {
    const owner = await readFile(path.join(this.stateDir, "proxy-owner.json"), "utf8").then(parseProxyOwner, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    return owner !== undefined && ["active", "unverified"].includes(await proxyOwnerStatus(owner));
  }

  /** Stop the run's own DevFn Caddy, verified by its recorded identity; DevFn keeps it running between lifecycles. */
  private async stopProxy(): Promise<void> {
    const owner = await readFile(path.join(this.stateDir, "proxy-owner.json"), "utf8").then(parseProxyOwner, () => undefined);
    if (!owner || await proxyOwnerStatus(owner) !== "active") return;
    try { process.kill(-owner.pid, "SIGTERM"); } catch { process.kill(owner.pid, "SIGTERM"); }
    for (let wait = 0; wait < 50 && await proxyOwnerStatus(owner) === "active"; wait += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /**
   * Process group leaders the run state records as shared by every lifecycle:
   * its Caddy, OAuth relay and tunnel connectors. They inherit the working
   * directory of whichever checkout started them, so per-checkout read-back
   * and reaping leave their groups to their own resources. A record counts
   * only while its process matches the recorded birth identity, so a reused
   * PID never hides a process from a read-back; an unreadable record hides
   * nothing either.
   */
  public async sharedLeaders(): Promise<Set<number>> {
    const recorded: Array<{ pid: number; birthSignature?: string; startedAt?: string }> = [];
    const owner = await readFile(path.join(this.stateDir, "proxy-owner.json"), "utf8").then(parseProxyOwner, () => undefined);
    if (owner) recorded.push(owner);
    const relay = await readRelayService(this.stateDir).catch(() => undefined);
    if (relay) recorded.push(relay);
    for (const binding of await readTunnelBindings(this.stateDir).catch(() => [])) {
      const state = await readTunnelState(this.stateDir, binding.name).catch(() => undefined);
      for (const connector of [state?.connector, ...(state?.retired ?? [])]) if (connector) recorded.push(connector);
    }
    const leaders = new Set<number>();
    for (const item of recorded) if (await matchesProcessIdentity(item.pid, item.birthSignature, item.startedAt)) leaders.add(item.pid);
    return leaders;
  }

  /**
   * Processes whose working directory is inside dir, except groups led by
   * shared leaders: only the run's own paths are ever passed. Only a listing
   * lsof completed counts: exit 0, or 1 when it could not inspect a process
   * the run does not own (-w hides that warning), ending with a full line. A
   * killed, timed-out or overflowing listing (-1), or any other status,
   * throws, so its partial output never confirms absence.
   */
  public async processesIn(dir: string, shared: ReadonlySet<number>): Promise<number[]> {
    const result = await this.exec("lsof", ["-n", "-w", "-d", "cwd", "-Fpn"], { timeoutMs: 30_000 });
    if ((result.code !== 0 && result.code !== 1) || !result.stdout.endsWith("\n")) throw new Error(`lsof could not list every process working directory (exit ${result.code})`);
    const groups = new Map<number, number>();
    if (shared.size) {
      const table = await this.exec("ps", ["-A", "-o", "pid=,pgid="], { timeoutMs: 30_000 });
      if (table.code !== 0) throw new Error("ps could not list process groups");
      for (const line of table.stdout.split("\n")) { const [pid, pgid] = line.trim().split(/\s+/).map(Number); if (pid) groups.set(pid, pgid); }
    }
    const pids = new Set<number>();
    let pid = 0;
    for (const line of result.stdout.split("\n")) {
      // Linux lsof marks a removed working directory with a " (deleted)" suffix.
      const name = line.slice(1).replace(/ \(deleted\)$/, "");
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && (name === dir || name.startsWith(`${dir}${path.sep}`)) && pid !== process.pid && !shared.has(pid) && !shared.has(groups.get(pid) ?? -1)) pids.add(pid);
    }
    return [...pids];
  }

  /** Terminate, then kill, the processes left in dir outside shared groups. */
  public async reap(dir: string, shared: ReadonlySet<number>): Promise<void> {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const pids = await this.processesIn(dir, shared);
      if (!pids.length) return;
      for (const pid of pids) { try { process.kill(pid, signal); } catch { /* already gone */ } }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  /**
   * Certificates in the operating system trust stores, by fingerprint, and on
   * macOS a digest of the user and admin trust settings, so a trust decision
   * about a certificate already in a keychain is a change too. On Linux,
   * every entry under the trust locations (trustDirectoryAnchors). A failed
   * read throws.
   */
  public async trustAnchors(): Promise<string[]> {
    if (process.platform === "darwin") {
      const result = await run("security", ["find-certificate", "-a", "-Z", "/Library/Keychains/System.keychain", path.join(os.homedir(), "Library", "Keychains", "login.keychain-db")]);
      if (result.code !== 0) throw new Error("the macOS keychains are unreadable");
      const settings: string[] = [];
      for (const [domain, args] of [["user", []], ["admin", ["-d"]]] as const) {
        const dump = await run("security", ["dump-trust-settings", ...args]);
        // Only security's own exit reporting no settings is none; a killed or timed-out read (-1) is unreadable.
        if (dump.code !== 0 && (dump.code < 1 || !dump.stderr.includes("No Trust Settings were found"))) throw new Error(`the macOS ${domain} trust settings are unreadable`);
        settings.push(`trust-settings:${domain}:${dump.code === 0 ? createHash("sha256").update(dump.stdout).digest("hex") : "none"}`);
      }
      return [...result.stdout.split("\n").filter((line) => line.startsWith("SHA-1 hash:")).map((line) => line.slice("SHA-1 hash:".length).trim()), ...settings].sort(byCodeUnit);
    }
    return await trustDirectoryAnchors(this.options.trustLocations ?? LINUX_TRUST_LOCATIONS);
  }

  /**
   * The operator's own machine state, which a run must leave untouched. Each
   * record is named and carries a digest of its material fields, so a change
   * under the same name (a route's target, a domain's TLS, a binding's
   * provider configuration) is reported, not only additions and removals.
   */
  public async snapshot(): Promise<ProtectedSnapshot> {
    const operator = defaultStateDir(this.options.env);
    const json = async (file: string): Promise<any> => {
      try { return JSON.parse(await readFile(path.join(operator, file), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    };
    const registry = await json("registry.json") as { allocations?: Array<{ projectId: string; instanceId: string; service: string; port: number; state: string }> } | undefined;
    const routes = await json("proxy-routes.json") as { routes?: Array<{ id: string; hostname: string }> } | undefined;
    return {
      allocations: (registry?.allocations ?? []).filter((item) => item.state !== "released").map((item) => `${item.projectId}/${item.instanceId}/${item.service}:${item.port}:${item.state} ${materialDigest(item)}`),
      routes: (routes?.routes ?? []).map((item) => `${item.id}@${item.hostname} ${materialDigest(item)}`),
      domains: (await readRegisteredDomains(operator)).map((item) => `${item.domain} ${materialDigest(item)}`),
      tunnelBindings: (await readTunnelBindings(operator)).map((item) => `${item.name} ${materialDigest(item)}`),
      trustStore: await this.trustAnchors(),
    };
  }
}
