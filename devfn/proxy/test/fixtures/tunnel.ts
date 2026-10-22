import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { compareNames, ephemeralOriginDomain, type CloudflareTunnelBinding, type NgrokTunnelBinding, type PublicOrigin, type TunnelBinding, type TunnelProvider } from "../../src/tunnel/index.js";

/**
 * A connector stand-in: answers GET /ready on its metrics port until stopped,
 * like cloudflared's metrics server, and records the environment it ran with.
 */
const READY_CONNECTOR = `
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const [port, config] = process.argv.slice(2);
fs.writeFileSync(path.join(path.dirname(config), "connector-env.json"), JSON.stringify(process.env));
http.createServer((request, response) => { response.writeHead(request.url === "/ready" ? 200 : 404); response.end(); }).listen(Number(port), "127.0.0.1");
`;

export async function writeConnectorScript(dir: string): Promise<string> {
  const file = path.join(dir, "fake-connector.cjs");
  await writeFile(file, READY_CONNECTOR);
  return file;
}

export function fixtureBinding(repositoryIdentity: string, credentialsFile: string, name = "preview"): CloudflareTunnelBinding {
  return { name, provider: "cloudflare", domain: "tunnel.example.test", projectId: "fixture", repositoryIdentity, nonproduction: true,
    cloudflare: { accountId: "a".repeat(32), zoneId: "b".repeat(32), tunnelId: "00000000-0000-4000-8000-000000000001", credentialsFile, apiTokenEnv: "DEVFN_FIXTURE_TOKEN" } };
}

/**
 * An application-neutral provider: public DNS is an in-memory zone where a
 * record is either DevFn-owned or foreign, and every call is logged so a
 * test can prove which mutations happened.
 */
export class FakeTunnelProvider implements TunnelProvider {
  /** A DevFn-owned record is "devfn", or "unproxied" when it does not verify. */
  public readonly records = new Map<string, "devfn" | "unproxied" | "foreign">();
  public readonly calls: string[] = [];
  public failEnsure = new Set<string>();
  public failRemove = new Set<string>();
  public failRead = new Set<string>();
  /** Records the next read misses, as if they were created right after it. */
  public unseen = new Set<string>();
  public connector: "ready" | "exit" = "ready";
  public tunnel: "local" | "remote" = "local";
  /** Runs when a connector command is requested, just before it launches. */
  public beforeLaunch?: () => Promise<void>;

  public constructor(private readonly script: string) {}

  public verifyTunnel(binding: TunnelBinding): Promise<void> {
    this.calls.push(`tunnel ${binding.name}`);
    return this.tunnel === "local" ? Promise.resolve() : Promise.reject(new Error("the tunnel is remotely managed"));
  }

  public async ensureDns(_binding: TunnelBinding, hostname: string): Promise<"created" | "existing"> {
    this.calls.push(`ensure ${hostname}`);
    if (this.failEnsure.has(hostname)) {
      this.records.set(hostname, "devfn"); // created, then the provider failed before answering
      throw new Error(`provider failure for ${hostname}`);
    }
    const record = this.records.get(hostname);
    if (record === "foreign") throw Object.assign(new Error(`${hostname} has a foreign record`), { code: "DEVFN_TUNNEL_CONFLICT" });
    if (record) { await this.verifyDns(_binding, hostname); return "existing"; }
    this.records.set(hostname, "devfn");
    return "created";
  }

  public ownsDns(_binding: TunnelBinding, hostname: string): Promise<boolean> {
    this.calls.push(`read ${hostname}`);
    if (this.failRead.has(hostname)) return Promise.reject(new Error(`provider failure reading ${hostname}`));
    if (this.unseen.delete(hostname)) return Promise.resolve(false);
    return Promise.resolve(this.records.get(hostname) === "devfn" || this.records.get(hostname) === "unproxied");
  }

  public verifyDns(_binding: TunnelBinding, hostname: string): Promise<void> {
    this.calls.push(`verify ${hostname}`);
    return this.records.get(hostname) === "devfn" ? Promise.resolve() : Promise.reject(new Error(`no DevFn record for ${hostname}`));
  }

  public removeDns(_binding: TunnelBinding, hostname: string): Promise<void> {
    this.calls.push(`remove ${hostname}`);
    if (this.failRemove.has(hostname)) return Promise.reject(new Error(`provider failure removing ${hostname}`));
    if (this.records.get(hostname) !== "foreign") this.records.delete(hostname);
    return Promise.resolve();
  }

  public renderConnectorConfig(_binding: TunnelBinding, hostnames: readonly string[], origin: PublicOrigin): string {
    return `${JSON.stringify({ hostnames: [...hostnames].sort(compareNames), origin })}\n`;
  }

  public async validateConnectorConfig(_binding: TunnelBinding, configFile: string, hostnames: readonly string[]): Promise<void> {
    const config = JSON.parse(await readFile(configFile, "utf8")) as { hostnames: string[] };
    if (JSON.stringify(config.hostnames) !== JSON.stringify([...hostnames].sort(compareNames))) throw new Error("connector configuration mismatch");
  }

  public async connectorCommand(_binding: TunnelBinding, configFile: string, metricsPort: number): Promise<string[]> {
    this.calls.push("launch");
    await this.beforeLaunch?.();
    return this.connector === "ready" ? [process.execPath, this.script, String(metricsPort), configFile] : [process.execPath, "-e", "process.exit(3)"];
  }
}

/** A registered-shape ngrok binding; registering it assigns a fresh registration ID. */
export function ngrokFixtureBinding(repositoryIdentity: string, endpoints: "reserved" | "ephemeral" = "reserved", name = "share", registrationId = "c".repeat(32)): NgrokTunnelBinding {
  return { name, provider: "ngrok", domain: endpoints === "reserved" ? "ngrok.example.test" : ephemeralOriginDomain(name), projectId: "fixture", repositoryIdentity, nonproduction: true,
    ngrok: { endpoints, authtokenEnv: "DEVFN_FIXTURE_NGROK_AUTHTOKEN", ...(endpoints === "reserved" ? { apiKeyEnv: "DEVFN_FIXTURE_NGROK_API_KEY" } : {}), registrationId } };
}

/**
 * An ngrok agent stand-in. `config check` accepts a configuration unless it
 * contains REJECT. `start --all --config <file>` records its argv,
 * environment and configuration under the record directory, prints its
 * authtoken (so a test can prove it is redacted) and reports every tunnel
 * started the way the agent's JSON log does: at its reserved domain, or at a
 * fresh ephemeral URL. It exits at once while <record>/fail exists, and
 * records when it was asked to stop in <record>/exited-<pid>.
 */
export async function writeFakeNgrok(dir: string, record: string): Promise<string> {
  const file = path.join(dir, "fake-ngrok");
  await writeFile(file, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const record = ${JSON.stringify(record)};
const args = process.argv.slice(2);
const config = fs.readFileSync(args[args.indexOf("--config") + 1], "utf8");
if (args[0] === "config") {
  fs.writeFileSync(path.join(record, "checked.yml"), config);
  if (config.includes("REJECT")) { process.stderr.write("ERROR: invalid configuration in " + args[3] + "\\n"); process.exit(1); }
  process.exit(0);
}
if (fs.existsSync(path.join(record, "fail"))) process.exit(1);
fs.writeFileSync(path.join(record, "agent-" + process.pid + ".json"), JSON.stringify({ startedAt: performance.timeOrigin + performance.now(), args, env: process.env, config }));
process.stdout.write("authtoken in use: " + process.env.NGROK_AUTHTOKEN + "\\n");
const tunnels = [...config.matchAll(/^  ("[^"]+"):\\n((?:    .*\\n)+)/gm)];
for (const [, name, body] of tunnels) {
  const domain = /^    domain: (".*")$/m.exec(body);
  const assigned = fs.existsSync(path.join(record, "same-url")) ? "shared" : Math.random().toString(16).slice(2, 10);
  const url = domain ? "https://" + JSON.parse(domain[1]) : "https://" + assigned + ".ngrok-free.app";
  process.stdout.write(JSON.stringify({ lvl: "info", msg: "started tunnel", obj: "tunnels", name: JSON.parse(name), url }) + "\\n");
}
process.on("SIGTERM", () => { fs.writeFileSync(path.join(record, "exited-" + process.pid), String(performance.timeOrigin + performance.now())); process.exit(0); });
setInterval(() => undefined, 1000);
`, { mode: 0o755 });
  return file;
}
