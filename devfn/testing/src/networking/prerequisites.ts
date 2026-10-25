import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import net from "node:net";

import { PUBLIC_ORIGIN_PORT } from "@devfn/proxy";

import type { QualificationApproval } from "./approval.js";
import type { PrerequisiteId } from "./matrix.js";
import type { PrerequisiteResult } from "./runner.js";

/** What prerequisite probes may read. Every probe is read-only: nothing is installed, registered or started. */
export interface ProbeEnvironment {
  platform: NodeJS.Platform;
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  /** Built DevFn CLI entry, run with this Node.js. */
  devfnCli: string;
  approval?: QualificationApproval;
  /** Why the supplied approval was refused, when it was. */
  approvalError?: string;
  /** The operator confirmed a person or browser agent completes provider logins during the run. */
  browserOperator: boolean;
  run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string }>;
  resolve(hostname: string): Promise<string[]>;
  /** Whether something accepts TCP connections on a loopback port. */
  listening(port: number): Promise<boolean>;
  exists(file: string): Promise<boolean>;
}

/** The DevFn proxy listener ports on a platform; on this host they equal @devfn/proxy proxyListenerPorts(). */
export const listenerPorts = (platform: NodeJS.Platform): { httpPort: number; httpsPort: number } => platform === "darwin" ? { httpPort: 8080, httpsPort: 8443 } : { httpPort: 80, httpsPort: 443 };

const ok = (id: PrerequisiteId, detail: string): PrerequisiteResult => ({ id, status: "satisfied", detail });
const missing = (id: PrerequisiteId, detail: string): PrerequisiteResult => ({ id, status: "missing", detail });
const isLoopback = (address: string) => net.isIPv4(address) ? address.startsWith("127.") : address === "::1";

async function tool(environment: ProbeEnvironment, id: PrerequisiteId, command: string, args: readonly string[]): Promise<PrerequisiteResult> {
  const result = await environment.run(command, args).catch(() => ({ code: -1, stdout: "" }));
  return result.code === 0 ? ok(id, `${command} ${args.join(" ")}: ${result.stdout.trim().split("\n")[0] ?? ""}`.trim()) : missing(id, `${command} is unavailable; install it explicitly before the run.`);
}

function envSet(environment: ProbeEnvironment, id: PrerequisiteId, names: ReadonlyArray<string | undefined>): PrerequisiteResult | undefined {
  const unset = names.filter((name): name is string => name !== undefined && !environment.env[name]);
  return unset.length ? missing(id, `credential variables unset: ${unset.join(", ")}`) : undefined;
}

async function loopbackOnly(environment: ProbeEnvironment, hostname: string): Promise<string | undefined> {
  const addresses = await environment.resolve(hostname).catch(() => []);
  return addresses.length && addresses.every(isLoopback) ? undefined : `${hostname} resolves to ${addresses.join(", ") || "nothing"}, not only loopback`;
}

const PROBES: Record<PrerequisiteId, (environment: ProbeEnvironment) => Promise<PrerequisiteResult>> = {
  "supported-host": async ({ platform, nodeVersion }) => {
    const major = Number(/^v?(\d+)/.exec(nodeVersion)?.[1] ?? 0);
    if (platform !== "darwin" && platform !== "linux") return missing("supported-host", `${platform} is not a qualified DevFn host`);
    return major >= 22 ? ok("supported-host", `${platform}, Node.js ${nodeVersion}`) : missing("supported-host", `Node.js ${nodeVersion} is older than 22`);
  },
  "devfn-cli": async (environment) => {
    if (!await environment.exists(environment.devfnCli)) return missing("devfn-cli", `${environment.devfnCli} is not built`);
    const result = await environment.run(process.execPath, [environment.devfnCli, "help", "--json"]).catch(() => ({ code: -1, stdout: "" }));
    return result.code === 0 && result.stdout.includes("\"ok\":true") ? ok("devfn-cli", environment.devfnCli) : missing("devfn-cli", `${environment.devfnCli} does not answer help --json`);
  },
  git: async (environment) => await tool(environment, "git", "git", ["--version"]),
  caddy: async (environment) => {
    const caddy = await tool(environment, "caddy", "caddy", ["version"]);
    if (caddy.status !== "satisfied" || environment.platform !== "linux") return caddy;
    // Linux listeners are 80 and 443: Caddy must already be allowed to bind them; the harness never grants it.
    const output = async (command: string, args: readonly string[]) => (await environment.run(command, args).catch(() => ({ code: -1, stdout: "" }))).stdout.trim();
    const unprivileged = Number.parseInt(await output("cat", ["/proc/sys/net/ipv4/ip_unprivileged_port_start"]), 10);
    if (await output("id", ["-u"]) === "0" || unprivileged <= 80) return caddy;
    const binary = await output("sh", ["-c", "command -v caddy"]);
    if (binary && (await output("getcap", [binary])).includes("cap_net_bind_service")) return caddy;
    return missing("caddy", "Caddy may not bind ports 80 and 443 here (not root, ip_unprivileged_port_start above 80, no cap_net_bind_service); permit it explicitly before the run.");
  },
  "process-tools": async (environment) => {
    // Cleanup read-back finds a run's leftover processes by working directory and process group.
    const cwd = await environment.run("lsof", ["-n", "-w", "-a", "-p", String(process.pid), "-d", "cwd", "-Fn"]).catch(() => ({ code: -1, stdout: "" }));
    const groups = await environment.run("ps", ["-A", "-o", "pid=,pgid="]).catch(() => ({ code: -1, stdout: "" }));
    return cwd.code === 0 && /^n\//m.test(cwd.stdout) && groups.code === 0 && /^\s*\d+\s+\d+\s*$/m.test(groups.stdout) ? ok("process-tools", "lsof and ps list working directories and process groups")
      : missing("process-tools", "lsof or ps cannot list process working directories and groups; cleanup could not read processes back.");
  },
  "proxy-ports": async (environment) => {
    // The DevFn Caddy is a machine singleton; an occupied port means an unrelated runtime the run must not touch.
    const ports = [2019, ...Object.values(listenerPorts(environment.platform)), PUBLIC_ORIGIN_PORT];
    const busy: number[] = [];
    for (const port of ports) if (await environment.listening(port)) busy.push(port);
    return busy.length ? missing("proxy-ports", `loopback ports in use by another runtime: ${busy.join(", ")}`) : ok("proxy-ports", `free: ${ports.join(", ")}`);
  },
  "docker-compose": async (environment) => {
    const compose = await tool(environment, "docker-compose", "docker", ["compose", "version"]);
    if (compose.status !== "satisfied") return compose;
    const daemon = await environment.run("docker", ["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ code: -1, stdout: "" }));
    return daemon.code === 0 ? ok("docker-compose", `${compose.detail}; engine ${daemon.stdout.trim()}`) : missing("docker-compose", "the Docker engine is not running");
  },
  approval: async ({ approval, approvalError }) => approval ? ok("approval", `approved by ${approval.approvedBy} until ${approval.expiresAt}`) :
    missing("approval", approvalError ?? "no nonproduction approval file was supplied"),
  "registered-domain": async (environment) => {
    const domain = environment.approval?.domain;
    if (!domain) return missing("registered-domain", "the approval names no development domain");
    // A random name proves wildcard resolution as well as the base name.
    for (const hostname of [domain, `q${randomBytes(6).toString("hex")}.${domain}`]) {
      const problem = await loopbackOnly(environment, hostname);
      if (problem) return missing("registered-domain", `${problem}; DevFn never edits DNS or resolvers`);
    }
    return ok("registered-domain", `${domain} and its names resolve only to loopback`);
  },
  "google-oauth": async (environment) => {
    const oauth = environment.approval?.oauth;
    if (!oauth) return missing("google-oauth", "the approval names no Google OAuth client");
    const { httpsPort } = listenerPorts(environment.platform);
    const origin = `https://${oauth.relayHost}.${environment.approval!.domain}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
    if (new URL(oauth.redirectUri).origin !== origin) return missing("google-oauth", `the approved redirect URI must use the relay origin ${origin} on this host`);
    return envSet(environment, "google-oauth", [oauth.clientIdEnv, oauth.clientSecretEnv]) ?? ok("google-oauth", `client ${oauth.clientIdEnv}, redirect ${oauth.redirectUri}`);
  },
  "browser-operator": async ({ browserOperator }) => browserOperator ? ok("browser-operator", "an operator completes provider logins") : missing("browser-operator", "no browser operator was confirmed with --browser-operator"),
  cloudflare: async (environment) => {
    const cf = environment.approval?.cloudflare;
    if (!cf) return missing("cloudflare", "the approval names no Cloudflare tunnel");
    if (!await environment.exists(cf.credentialsFile)) return missing("cloudflare", "the approved tunnel credentials file does not exist");
    return envSet(environment, "cloudflare", [cf.apiTokenEnv]) ?? (await tool(environment, "cloudflare", "cloudflared", ["--version"]));
  },
  "ngrok-reserved": async (environment) => {
    const reserved = environment.approval?.ngrokReserved;
    if (!reserved) return missing("ngrok-reserved", "the approval names no reserved ngrok domain");
    return envSet(environment, "ngrok-reserved", [reserved.authtokenEnv, reserved.apiKeyEnv]) ?? (await tool(environment, "ngrok-reserved", "ngrok", ["version"]));
  },
  "ngrok-ephemeral": async (environment) => {
    const ephemeral = environment.approval?.ngrokEphemeral;
    if (!ephemeral) return missing("ngrok-ephemeral", "the approval names no ephemeral ngrok account");
    return envSet(environment, "ngrok-ephemeral", [ephemeral.authtokenEnv, ephemeral.apiKeyEnv]) ?? (await tool(environment, "ngrok-ephemeral", "ngrok", ["version"]));
  },
};

/** Probe each prerequisite once. A probe that throws is invalid, never satisfied. */
export async function checkPrerequisites(environment: ProbeEnvironment, ids: Iterable<PrerequisiteId>): Promise<PrerequisiteResult[]> {
  const results: PrerequisiteResult[] = [];
  for (const id of [...new Set(ids)]) {
    results.push(await PROBES[id](environment).catch((error: unknown) => ({ id, status: "invalid" as const, detail: `probe failed: ${error instanceof Error ? error.message : String(error)}` })));
  }
  return results;
}

const execute = async (command: string, args: readonly string[]): Promise<{ code: number; stdout: string }> => await new Promise((resolve) => {
  execFile(command, [...args], { timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout) }));
});

/** Whether something accepts TCP connections on a loopback port; an unanswered probe counts as in use. */
export const loopbackListening = async (port: number): Promise<boolean> => await new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setTimeout(1_000, () => { socket.destroy(); resolve(true); });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code !== "ECONNREFUSED"));
});

/** Probes against the real host. */
export function hostProbeEnvironment(input: Pick<ProbeEnvironment, "devfnCli" | "approval" | "approvalError" | "browserOperator">): ProbeEnvironment {
  return { ...input, platform: process.platform, nodeVersion: process.version, env: process.env, run: execute, listening: loopbackListening,
    resolve: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address),
    exists: async (file) => await access(file).then(() => true, () => false) };
}
