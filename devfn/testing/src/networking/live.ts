import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import { defaultStateDir } from "@devfn/config";
import { parsePersistedProxyRoutes, parseProxyOwner, proxyOwnerStatus } from "@devfn/ports";
import { proxyListenerPorts, readRegisteredDomains } from "@devfn/proxy";
import { readRelayService } from "@devfn/proxy/oauth-relay";
import { caddyInternalRoot, CloudflareTunnelProvider, ngrokMarker, readTunnelBindings, readTunnelState, tunnelCapabilities, type TunnelBinding } from "@devfn/proxy/tunnel";

import { loopbackListening } from "./prerequisites.js";
import type { DisposableInventory, ProtectedSnapshot, ResourceHandlers } from "./inventory.js";

export interface CliResult { code: number; json: Record<string, any> }
export interface Answer { status: number; body: string; headers: http.IncomingHttpHeaders; json?: Record<string, any> }

/**
 * A generic fixture process: it records the DevFn values, and the fixture's
 * own QUAL_ profile values, it sees at its first instruction, before
 * listening, then answers every request with its
 * worktree marker, the path and Host it received, and its owner.
 */
export const FIXTURE_SERVER = `import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
const [name, portKey] = process.argv.slice(2);
writeFileSync(\`seen-\${name}.json\`, JSON.stringify({ pid: process.pid, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("DEVFN_") || key.startsWith("QUAL_"))) }));
if (existsSync(\`fail-\${name}\`)) process.exit(3);
const marker = path.basename(process.cwd());
createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ marker, name, path: request.url, host: request.headers.host, owner: process.env.DEVFN_INSTANCE_ID }));
}).listen(Number(process.env[portKey]), "127.0.0.1");
`;

export type CommandRunner = (command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

const run: CommandRunner = async (command, args, options = {}) => await new Promise((resolve) => {
  execFile(command, [...args], { cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? 180_000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});

/**
 * Whether the provider still holds a record or online endpoint for a run's
 * public name: a Cloudflare DNS record DevFn owns, or an ngrok endpoint or
 * tunnel for the name or carrying the registration's marker. A failed read
 * throws; it is never absence.
 */
export type ProviderReadBack = (binding: TunnelBinding, hostname: string, url: string | undefined) => Promise<boolean>;

const NGROK_API = "https://api.ngrok.com";

export function providerReadBack(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): ProviderReadBack {
  return async (binding, hostname, url) => {
    if (binding.provider === "cloudflare") return await new CloudflareTunnelProvider({ env, fetch: fetcher }).ownsDns(binding, hostname);
    const key = binding.ngrok.apiKeyEnv ? env[binding.ngrok.apiKeyEnv] : undefined;
    if (!key) throw new Error(`ngrok binding ${binding.name} has no readable API key, so its endpoints cannot be read back`);
    const names = new Set([hostname, ...(url ? [new URL(url).hostname] : [])]);
    for (const [route, list] of [["/endpoints", "endpoints"], ["/tunnels", "tunnels"]] as const) {
      let next: string | undefined = `${NGROK_API}${route}?limit=100`;
      for (let page = 0; next; page += 1) {
        if (page >= 50 || !next.startsWith(`${NGROK_API}/`)) throw new Error(`ngrok ${route} paging is unreadable`);
        const response = await fetcher(next, { headers: { authorization: `Bearer ${key}`, "ngrok-version": "2" }, signal: AbortSignal.timeout(15_000) });
        const payload = await response.json().catch(() => undefined) as Record<string, any> | undefined;
        if (!response.ok || !Array.isArray(payload?.[list])) throw new Error(`ngrok GET ${route} answered HTTP ${response.status}`);
        for (const item of payload![list] as Array<Record<string, unknown>>) {
          const hosts = [item.url, item.public_url].flatMap((value) => { try { return typeof value === "string" ? [new URL(value).hostname] : []; } catch { return []; } });
          if (item.metadata === ngrokMarker(binding) || hosts.some((name) => names.has(name))) return true;
        }
        next = typeof payload!.next_page_uri === "string" && payload!.next_page_uri ? payload!.next_page_uri : undefined;
      }
    }
    return false;
  };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * The real host a live run drives: the built DevFn CLI against a dedicated
 * state directory under the run root, generic fixture repositories, and
 * loopback or public HTTP(S) probes. Every resource it creates is recorded
 * in the run inventory first, so cleanup reaches it whatever fails later.
 * DevFn and the Caddy it starts see XDG directories under the run root, so
 * the run's internal CA and Caddy configuration never touch the operator's.
 */
export class LiveHost {
  public readonly stateDir: string;
  /** Provider and host limitations noted while the run used them. */
  public readonly limitations = new Set<string>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly exec: CommandRunner;
  /** The provider read-back public-name cleanup uses; drivers use it for positive absence evidence. */
  public readonly readBack: ProviderReadBack;

  public constructor(public readonly options: { root: string; devfnCli: string; env: NodeJS.ProcessEnv; inventory: DisposableInventory; run?: CommandRunner; providers?: ProviderReadBack }) {
    this.stateDir = path.join(options.root, "state");
    this.env = { ...options.env, ...Object.fromEntries(["DATA", "CONFIG", "STATE"].map((kind) => [`XDG_${kind}_HOME`, path.join(options.root, "xdg", kind.toLowerCase())])) };
    this.exec = options.run ?? run;
    this.readBack = options.providers ?? providerReadBack(options.env);
  }

  public get prefix(): string { return this.options.inventory.prefix; }

  /** Run one devfn command with --json against the run state directory. */
  public async devfn(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
    const result = await this.exec(process.execPath, [this.options.devfnCli, ...args, "--json", "--state-dir", this.stateDir], { cwd, env: { ...this.env, ...env } });
    try { return { code: result.code, json: JSON.parse(result.stdout) as Record<string, any> }; }
    catch { return { code: result.code === 0 ? -1 : result.code, json: { ok: false, error: { code: "UNPARSEABLE", message: result.stderr.slice(-2000) } } }; }
  }

  /** devfn command that must succeed; its JSON result. */
  public async must(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<Record<string, any>> {
    const result = await this.devfn(cwd, args, env);
    if (result.code !== 0 || result.json.ok === false) throw new Error(`devfn ${args.join(" ")} failed: ${JSON.stringify(result.json.error ?? result.json).slice(0, 2000)}`);
    return result.json;
  }

  /** A devfn down that an already stopped lifecycle also satisfies. */
  private async down(cwd: string): Promise<void> {
    const result = await this.devfn(cwd, ["down"]);
    if (result.code !== 0 && result.json.error?.code !== "DEVFN_NOT_RUNNING") throw new Error(`devfn down failed: ${JSON.stringify(result.json.error)}`);
  }

  /** A committed generic fixture repository named for the run. */
  public async repository(scenario: string, name: string, config: unknown, files: Record<string, string> = {}): Promise<string> {
    const root = path.join(this.options.root, `${this.prefix}-${name}`);
    this.options.inventory.record("fixture-repository", root, scenario);
    await mkdir(root, { recursive: true });
    for (const [file, text] of Object.entries({ "server.mjs": FIXTURE_SERVER, "devfn.config.json": `${JSON.stringify(config, null, 2)}\n`, ".gitignore": ".devfn/\nseen-*.json\nfail-*\n", ...files })) {
      await writeFile(path.join(root, file), text, "utf8");
    }
    for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=DevFn Qualification", "-c", "user.email=qualification@devfn.invalid", "commit", "-q", "-m", "fixture"]]) await this.git(root, args);
    await this.trust(root);
    return root;
  }

  /** A linked worktree of a fixture repository, named for the run. */
  public async worktree(scenario: string, repository: string, label: string): Promise<string> {
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
  public async up(scenario: string, cwd: string, args: readonly string[] = [], env?: NodeJS.ProcessEnv): Promise<CliResult> {
    if (!this.options.inventory.list(scenario).some((entry) => entry.kind === "runtime" && entry.id === cwd && !entry.cleanup)) this.options.inventory.record("runtime", cwd, scenario);
    return await this.devfn(cwd, ["up", ...args], env);
  }

  public async seen(cwd: string, name: string): Promise<{ pid: number; env: Record<string, string> }> {
    return JSON.parse(await readFile(path.join(cwd, `seen-${name}.json`), "utf8")) as { pid: number; env: Record<string, string> };
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
   */
  public async request(target: string, options: { ca?: string; address?: string; port?: number; host?: string; cookie?: string; publicDns?: boolean } = {}): Promise<Answer> {
    const url = new URL(target);
    const ports = proxyListenerPorts();
    const port = options.port ?? (url.port ? Number(url.port) : options.publicDns ? (url.protocol === "https:" ? 443 : 80) : url.protocol === "https:" ? ports.httpsPort : ports.httpPort);
    return await new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const request = client.request({ ...(options.publicDns ? { hostname: url.hostname } : { host: options.address ?? "127.0.0.1" }), port, path: `${url.pathname}${url.search}`, method: "GET",
        headers: { host: options.host ?? url.host, connection: "close", ...(options.cookie ? { cookie: options.cookie } : {}) }, timeout: 15_000, agent: false,
        ...(url.protocol === "https:" ? { servername: url.hostname, ...(options.ca ? { ca: options.ca } : {}) } : {}) }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => {
          let json: Record<string, any> | undefined;
          try { json = JSON.parse(body) as Record<string, any>; } catch { json = undefined; }
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers, ...(json ? { json } : {}) });
        });
      });
      request.once("timeout", () => request.destroy(new Error(`${target} timed out`)));
      request.once("error", reject);
      request.end();
    });
  }

  /** Routes of an owner in the run's DevFn proxy state. */
  public async routesOf(instanceId: string): Promise<string[]> {
    const text = await readFile(path.join(this.stateDir, "proxy-routes.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    return text === undefined ? [] : parsePersistedProxyRoutes(JSON.parse(text)).filter((route) => route.instanceId === instanceId).map((route) => route.hostname);
  }

  /** Recorded fixture process IDs of a checkout that still run. */
  public async survivingFixtures(cwd: string): Promise<number[]> {
    const pids = await Promise.all((await readdir(cwd).catch(() => [] as string[])).filter((file) => /^seen-.+\.json$/.test(file)).map(async (file) => (JSON.parse(await readFile(path.join(cwd, file), "utf8")) as { pid: number }).pid));
    return pids.filter(alive);
  }

  /**
   * Removal and read-back for each recorded kind. A runtime is read back
   * after devfn down and before anything is reaped, so a process that
   * survived its lifecycle is reported, never hidden. Read-back failures throw.
   */
  public handlers(): ResourceHandlers {
    const exists = async (file: string) => await access(file).then(() => true, () => false);
    const describe = (what: string, items: readonly unknown[]) => items.length ? `${what}: ${items.join(", ")}` : undefined;
    return {
      remove: async (entry) => {
        const { cwd } = entry.context ?? {};
        if (entry.kind === "runtime" || entry.kind === "public-hostname") await this.down(entry.kind === "runtime" ? entry.id : cwd!);
        if (entry.kind === "fixture-repository") {
          // Its runtime was read back first; whatever the checkout still runs is reaped before it is deleted.
          await this.reap(entry.id, await this.sharedLeaders());
          if (cwd) await this.exec("git", ["worktree", "remove", "--force", entry.id], { cwd });
          await rm(entry.id, { recursive: true, force: true });
        }
        // run-processes has nothing to remove: its read-back reports leftovers, which the run reaps only afterwards (reap).
        if (entry.kind === "proxy") await this.stopProxy();
        if (entry.kind === "registered-domain") await this.must(cwd!, ["domains", "unregister", entry.id]);
        if (entry.kind === "oauth-relay") await this.must(cwd!, ["oauth-relay", "stop"]);
        if (entry.kind === "tunnel-binding") await this.must(cwd!, ["tunnel", "unregister", entry.id]);
      },
      present: async (entry) => {
        const { cwd, binding, url } = entry.context ?? {};
        if (entry.kind === "fixture-repository") return await exists(entry.id) ? "checkout exists" : describe("processes", await this.processesIn(entry.id, await this.sharedLeaders())) ?? false;
        if (entry.kind === "run-processes") return describe("processes in the run root", await this.processesIn(entry.id, new Set())) ?? false;
        if (entry.kind === "runtime") {
          const status = await this.must(entry.id, ["status"]);
          const leases = ((await this.must(entry.id, ["ports"])).allocations as Array<{ instanceId: string; port: number }>).filter((item) => item.instanceId === status.instanceId).map((item) => item.port);
          return (status.state === "stopped" ? undefined : `state ${String(status.state)}`) ?? describe("processes", await this.processesIn(entry.id, await this.sharedLeaders()))
            ?? describe("fixture processes", await this.survivingFixtures(entry.id)) ?? describe("leases", leases) ?? describe("routes", await this.routesOf(String(status.instanceId))) ?? false;
        }
        if (entry.kind === "proxy") return await this.proxyRunning() || await loopbackListening(2019) ? "the run's Caddy still runs or 2019 is held" : false;
        if (entry.kind === "registered-domain") return (await readRegisteredDomains(this.stateDir)).some((item) => item.domain === entry.id);
        if (entry.kind === "oauth-relay") { const { relay } = await this.must(cwd!, ["oauth-relay", "status"]); return relay.running === true || relay.routeActive === true; }
        if (entry.kind === "tunnel-binding") return (await readTunnelBindings(this.stateDir)).some((item) => item.name === entry.id);
        // A public name is absent when DevFn no longer routes or journals it, the provider read-back holds nothing for it, and its URL no longer serves the run.
        const bound = (await readTunnelBindings(this.stateDir)).find((item) => item.name === binding);
        if (!bound) throw new Error(`binding ${binding} is not readable for ${entry.id}`);
        const { tunnel } = await this.must(cwd!, ["tunnel", "status", bound.name]);
        if (JSON.stringify([tunnel.hostnames, tunnel.outstanding, tunnel.residue ?? []]).includes(entry.id)) return "routed or journaled by DevFn";
        if (await this.readBack(bound, entry.id, url)) return `held by ${bound.provider}`;
        const served = await this.request(url ?? `https://${entry.id}/`, { publicDns: true }).catch(() => undefined);
        return served?.json?.marker !== undefined && String(served.json.marker).startsWith(this.prefix) ? "still serves the run" : false;
      },
    };
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
   * and reaping leave their groups to their own resources.
   */
  public async sharedLeaders(): Promise<Set<number>> {
    const leaders = new Set<number>();
    const owner = await readFile(path.join(this.stateDir, "proxy-owner.json"), "utf8").then(parseProxyOwner, () => undefined);
    if (owner) leaders.add(owner.pid);
    const relay = await readRelayService(this.stateDir).catch(() => undefined);
    if (relay) leaders.add(relay.pid);
    for (const binding of await readTunnelBindings(this.stateDir).catch(() => [])) {
      const state = await readTunnelState(this.stateDir, binding.name).catch(() => undefined);
      for (const connector of [state?.connector, ...(state?.retired ?? [])]) if (connector) leaders.add(connector.pid);
    }
    return leaders;
  }

  /** Processes whose working directory is inside dir, except groups led by shared leaders: only the run's own paths are ever passed. */
  public async processesIn(dir: string, shared: ReadonlySet<number>): Promise<number[]> {
    const result = await this.exec("lsof", ["-n", "-w", "-d", "cwd", "-Fpn"], { timeoutMs: 30_000 });
    if (!result.stdout) throw new Error("lsof could not list process working directories");
    const groups = new Map<number, number>();
    if (shared.size) {
      const table = await this.exec("ps", ["-A", "-o", "pid=,pgid="], { timeoutMs: 30_000 });
      if (table.code !== 0) throw new Error("ps could not list process groups");
      for (const line of table.stdout.split("\n")) { const [pid, pgid] = line.trim().split(/\s+/).map(Number); if (pid) groups.set(pid, pgid); }
    }
    const pids = new Set<number>();
    let pid = 0;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && (line.slice(1) === dir || line.slice(1).startsWith(`${dir}${path.sep}`)) && pid !== process.pid && !shared.has(pid) && !shared.has(groups.get(pid) ?? -1)) pids.add(pid);
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

  /** Certificates in the operating system trust stores, by fingerprint. A failed read throws. */
  public async trustAnchors(): Promise<string[]> {
    if (process.platform === "darwin") {
      const result = await run("security", ["find-certificate", "-a", "-Z", "/Library/Keychains/System.keychain", path.join(os.homedir(), "Library", "Keychains", "login.keychain-db")]);
      if (result.code !== 0) throw new Error("the macOS keychains are unreadable");
      return result.stdout.split("\n").filter((line) => line.startsWith("SHA-1 hash:")).map((line) => line.slice("SHA-1 hash:".length).trim()).sort();
    }
    const anchors: string[] = [];
    for (const location of ["/etc/ssl/certs", "/usr/local/share/ca-certificates", "/etc/pki/ca-trust/source/anchors", "/etc/pki/tls/certs"]) {
      const names = await readdir(location).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
      for (const name of names) anchors.push(`${location}/${name}:${createHash("sha256").update(await readFile(path.join(location, name)).catch(() => Buffer.from("unreadable"))).digest("hex")}`);
    }
    return anchors.sort();
  }

  /** The operator's own machine state, which a run must leave untouched. */
  public async snapshot(): Promise<ProtectedSnapshot> {
    const operator = defaultStateDir(this.options.env);
    const json = async (file: string): Promise<any> => {
      try { return JSON.parse(await readFile(path.join(operator, file), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    };
    const registry = await json("registry.json") as { allocations?: Array<{ projectId: string; instanceId: string; service: string; port: number; state: string }> } | undefined;
    const routes = await json("proxy-routes.json") as { routes?: Array<{ id: string; hostname: string }> } | undefined;
    return {
      allocations: (registry?.allocations ?? []).filter((item) => item.state !== "released").map((item) => `${item.projectId}/${item.instanceId}/${item.service}:${item.port}:${item.state}`),
      routes: (routes?.routes ?? []).map((item) => `${item.id}@${item.hostname}`),
      domains: (await readRegisteredDomains(operator)).map((item) => item.domain),
      tunnelBindings: (await readTunnelBindings(operator)).map((item) => item.name),
      trustStore: await this.trustAnchors(),
    };
  }
}
