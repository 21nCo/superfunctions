import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import { defaultStateDir } from "@devfn/config";
import { parseProxyOwner, proxyOwnerStatus } from "@devfn/ports";
import { proxyListenerPorts, readRegisteredDomains } from "@devfn/proxy";
import { caddyInternalRoot, CloudflareTunnelProvider, readTunnelBindings } from "@devfn/proxy/tunnel";

import { loopbackListening } from "./prerequisites.js";
import type { DisposableInventory, InventoryEntry, ProtectedSnapshot, ResourceHandlers } from "./inventory.js";

export interface CliResult { code: number; json: Record<string, any> }
export interface Answer { status: number; body: string; headers: http.IncomingHttpHeaders; json?: Record<string, any> }

/**
 * A generic fixture process: it records the DevFn values it sees at its
 * first instruction, before listening, then answers every request with its
 * worktree marker, the path and Host it received, and its owner.
 */
export const FIXTURE_SERVER = `import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
const [name, portKey] = process.argv.slice(2);
writeFileSync(\`seen-\${name}.json\`, JSON.stringify({ pid: process.pid, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("DEVFN_"))) }));
if (existsSync(\`fail-\${name}\`)) process.exit(3);
const marker = path.basename(process.cwd());
createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ marker, name, path: request.url, host: request.headers.host, owner: process.env.DEVFN_INSTANCE_ID }));
}).listen(Number(process.env[portKey]), "127.0.0.1");
`;

const run = async (command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
  await new Promise((resolve) => {
    execFile(command, [...args], { cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? 180_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });

/**
 * The real host a live run drives: the built DevFn CLI against a dedicated
 * state directory under the run root, generic fixture repositories, and
 * loopback or public HTTP(S) probes. Every resource it creates is recorded
 * in the run inventory first, so cleanup reaches it whatever fails later.
 */
export class LiveHost {
  public readonly stateDir: string;
  private readonly context = new Map<string, { cwd?: string; binding?: string; url?: string }>();

  public constructor(public readonly options: { root: string; devfnCli: string; env: NodeJS.ProcessEnv; inventory: DisposableInventory }) {
    this.stateDir = path.join(options.root, "state");
  }

  public get prefix(): string { return this.options.inventory.prefix; }

  /** Run one devfn command with --json against the run state directory. */
  public async devfn(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
    const result = await run(process.execPath, [this.options.devfnCli, ...args, "--json", "--state-dir", this.stateDir], { cwd, env: { ...this.options.env, ...env } });
    try { return { code: result.code, json: JSON.parse(result.stdout) as Record<string, any> }; }
    catch { return { code: result.code === 0 ? -1 : result.code, json: { ok: false, error: { code: "UNPARSEABLE", message: result.stderr.slice(-2000) } } }; }
  }

  /** devfn command that must succeed; its JSON result. */
  public async must(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<Record<string, any>> {
    const result = await this.devfn(cwd, args, env);
    if (result.code !== 0 || result.json.ok === false) throw new Error(`devfn ${args.join(" ")} failed: ${JSON.stringify(result.json.error ?? result.json).slice(0, 2000)}`);
    return result.json;
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
    this.options.inventory.record("fixture-repository", target, scenario);
    await this.git(repository, ["worktree", "add", "-q", "-b", `${this.prefix}-${label}`, target]);
    await this.trust(target);
    return target;
  }

  /** Trust the run's own fixture manifest at this checkout, in the run state directory only. */
  public async trust(cwd: string): Promise<void> { await this.must(cwd, ["status", "--trust"]); }

  private async git(cwd: string, args: readonly string[]): Promise<void> {
    const result = await run("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }

  /** Start a fixture lifecycle, recording it first so a partial start is still stopped. */
  public async up(scenario: string, cwd: string, args: readonly string[] = [], env?: NodeJS.ProcessEnv): Promise<CliResult> {
    if (!this.options.inventory.list(scenario).some((entry) => entry.kind === "runtime" && entry.id === cwd && !entry.cleanup)) this.options.inventory.record("runtime", cwd, scenario);
    return await this.devfn(cwd, ["up", ...args], env);
  }

  public remember(kind: InventoryEntry["kind"], id: string, value: { cwd?: string; binding?: string; url?: string }): void { this.context.set(`${kind}:${id}`, value); }

  public async seen(cwd: string, name: string): Promise<{ pid: number; env: Record<string, string> }> {
    return JSON.parse(await readFile(path.join(cwd, `seen-${name}.json`), "utf8")) as { pid: number; env: Record<string, string> };
  }

  /** The DevFn Caddy internal root; the run never installs it anywhere. */
  public async ca(): Promise<string> { return await caddyInternalRoot(); }

  /**
   * GET url. Local names connect to loopback at the DevFn proxy port for the
   * scheme, with the URL's Host and SNI; public URLs use real DNS. ca
   * replaces the default trust store; without it the default store applies.
   */
  public async request(target: string, options: { ca?: string; address?: string; host?: string; publicDns?: boolean } = {}): Promise<Answer> {
    const url = new URL(target);
    const ports = proxyListenerPorts();
    const port = url.port ? Number(url.port) : options.publicDns ? (url.protocol === "https:" ? 443 : 80) : url.protocol === "https:" ? ports.httpsPort : ports.httpPort;
    return await new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const request = client.request({ ...(options.publicDns ? { hostname: url.hostname } : { host: options.address ?? "127.0.0.1" }), port, path: `${url.pathname}${url.search}`, method: "GET",
        headers: { host: options.host ?? url.host, connection: "close" }, timeout: 15_000, agent: false,
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

  /** Removal and read-back for each recorded kind. Read-back failures throw. */
  public handlers(): ResourceHandlers {
    const context = (entry: InventoryEntry) => this.context.get(`${entry.kind}:${entry.id}`) ?? {};
    const exists = async (file: string) => await access(file).then(() => true, () => false);
    return {
      remove: async (entry) => {
        const { cwd } = context(entry);
        if (entry.kind === "runtime") {
          const result = await this.devfn(entry.id, ["down"]);
          // A lifecycle DevFn lost track of, such as an interrupted start, can leave processes in the checkout; the run reaps only its own.
          await this.reap(entry.id);
          if (result.code !== 0 && result.json.error?.code !== "DEVFN_NOT_RUNNING") throw new Error(JSON.stringify(result.json.error));
        }
        if (entry.kind === "fixture-repository") {
          const main = this.options.inventory.list().find((item) => item.kind === "fixture-repository" && entry.id.startsWith(`${item.id}-`));
          if (main) await run("git", ["worktree", "remove", "--force", entry.id], { cwd: main.id });
          await rm(entry.id, { recursive: true, force: true });
        }
        if (entry.kind === "proxy") await this.stopProxy();
        if (entry.kind === "registered-domain") await this.must(cwd!, ["domains", "unregister", entry.id]);
        if (entry.kind === "oauth-relay") await this.must(cwd!, ["oauth-relay", "stop"]);
        if (entry.kind === "tunnel-binding") await this.must(cwd!, ["tunnel", "unregister", entry.id]);
        // Stopping the owning lifecycle is what withdraws a public name, whichever was recorded first.
        if (entry.kind === "public-hostname") { const result = await this.devfn(cwd!, ["down"]); if (result.code !== 0 && result.json.error?.code !== "DEVFN_NOT_RUNNING") throw new Error(JSON.stringify(result.json.error)); }
      },
      present: async (entry) => {
        const { cwd, binding, url } = context(entry);
        if (entry.kind === "fixture-repository") return await exists(entry.id);
        if (entry.kind === "runtime") {
          const status = await this.must(entry.id, ["status"]);
          const ports = await this.must(entry.id, ["ports"]);
          return status.state !== "stopped" || (await this.processesIn(entry.id)).length > 0 || (ports.allocations as Array<{ instanceId: string }>).some((item) => item.instanceId === status.instanceId);
        }
        if (entry.kind === "proxy") return await this.proxyRunning() || await loopbackListening(2019);
        if (entry.kind === "registered-domain") return (await readRegisteredDomains(this.stateDir)).some((item) => item.domain === entry.id);
        if (entry.kind === "oauth-relay") { const { relay } = await this.must(cwd!, ["oauth-relay", "status"]); return relay.running === true || relay.routeActive === true; }
        if (entry.kind === "tunnel-binding") return (await readTunnelBindings(this.stateDir)).some((item) => item.name === entry.id);
        // A public name is absent when DevFn no longer routes or journals it, the provider holds no DevFn record for it, and its URL no longer serves the run.
        const bound = (await readTunnelBindings(this.stateDir)).find((item) => item.name === binding);
        if (!bound) throw new Error(`binding ${binding} is not readable for ${entry.id}`);
        const { tunnel } = await this.must(cwd!, ["tunnel", "status", bound.name]);
        if (JSON.stringify([tunnel.hostnames, tunnel.outstanding, tunnel.residue ?? []]).includes(entry.id)) return true;
        if (bound.provider === "cloudflare" && await new CloudflareTunnelProvider({ env: this.options.env }).ownsDns(bound, entry.id)) return true;
        const served = await this.request(url ?? `https://${entry.id}/`, { publicDns: true }).catch(() => undefined);
        return served?.json?.marker !== undefined && String(served.json.marker).startsWith(this.prefix);
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

  /** Processes whose working directory is inside dir: only the run's own fixture checkouts are ever passed. */
  public async processesIn(dir: string): Promise<number[]> {
    const result = await run("lsof", ["-n", "-w", "-d", "cwd", "-Fpn"], { timeoutMs: 30_000 });
    if (!result.stdout) throw new Error("lsof could not list process working directories");
    const pids = new Set<number>();
    let pid = 0;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && (line.slice(1) === dir || line.slice(1).startsWith(`${dir}${path.sep}`)) && pid !== process.pid) pids.add(pid);
    }
    return [...pids];
  }

  private async reap(dir: string): Promise<void> {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const pids = await this.processesIn(dir);
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
