import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PublicOrigin, TunnelBinding, TunnelProvider } from "../../src/tunnel/index.js";

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

export function fixtureBinding(repositoryIdentity: string, credentialsFile: string, name = "preview"): TunnelBinding {
  return { name, provider: "cloudflare", domain: "tunnel.example.test", projectId: "fixture", repositoryIdentity, nonproduction: true,
    cloudflare: { accountId: "a".repeat(32), zoneId: "b".repeat(32), tunnelId: "00000000-0000-4000-8000-000000000001", credentialsFile, apiTokenEnv: "DEVFN_FIXTURE_TOKEN" } };
}

/**
 * An application-neutral provider: public DNS is an in-memory zone where a
 * record is either DevFn-owned or foreign, and every call is logged so a
 * test can prove which mutations happened.
 */
export class FakeTunnelProvider implements TunnelProvider {
  public readonly records = new Map<string, "devfn" | "foreign">();
  public readonly calls: string[] = [];
  public failEnsure = new Set<string>();
  public failRemove = new Set<string>();
  public connector: "ready" | "exit" = "ready";
  public tunnel: "local" | "remote" = "local";
  /** Runs when a connector command is requested, just before it launches. */
  public beforeLaunch?: () => Promise<void>;

  public constructor(private readonly script: string) {}

  public async verifyTunnel(binding: TunnelBinding): Promise<void> {
    this.calls.push(`tunnel ${binding.name}`);
    if (this.tunnel !== "local") throw new Error("the tunnel is remotely managed");
  }

  public async ensureDns(_binding: TunnelBinding, hostname: string): Promise<"created" | "existing"> {
    this.calls.push(`ensure ${hostname}`);
    if (this.failEnsure.has(hostname)) {
      this.records.set(hostname, "devfn"); // created, then the provider failed before answering
      throw new Error(`provider failure for ${hostname}`);
    }
    const record = this.records.get(hostname);
    if (record === "foreign") throw Object.assign(new Error(`${hostname} has a foreign record`), { code: "DEVFN_TUNNEL_CONFLICT" });
    if (record === "devfn") return "existing";
    this.records.set(hostname, "devfn");
    return "created";
  }

  public async verifyDns(_binding: TunnelBinding, hostname: string): Promise<void> {
    this.calls.push(`verify ${hostname}`);
    if (this.records.get(hostname) !== "devfn") throw new Error(`no DevFn record for ${hostname}`);
  }

  public async removeDns(_binding: TunnelBinding, hostname: string): Promise<void> {
    this.calls.push(`remove ${hostname}`);
    if (this.failRemove.has(hostname)) throw new Error(`provider failure removing ${hostname}`);
    if (this.records.get(hostname) === "devfn") this.records.delete(hostname);
  }

  public renderConnectorConfig(_binding: TunnelBinding, hostnames: readonly string[], origin: PublicOrigin): string {
    return `${JSON.stringify({ hostnames: [...hostnames].sort(), origin })}\n`;
  }

  public async validateConnectorConfig(_binding: TunnelBinding, configFile: string, hostnames: readonly string[]): Promise<void> {
    const config = JSON.parse(await readFile(configFile, "utf8")) as { hostnames: string[] };
    if (JSON.stringify(config.hostnames) !== JSON.stringify([...hostnames].sort())) throw new Error("connector configuration mismatch");
  }

  public async connectorCommand(_binding: TunnelBinding, configFile: string, metricsPort: number): Promise<string[]> {
    this.calls.push("launch");
    await this.beforeLaunch?.();
    return this.connector === "ready" ? [process.execPath, this.script, String(metricsPort), configFile] : [process.execPath, "-e", "process.exit(3)"];
  }
}
