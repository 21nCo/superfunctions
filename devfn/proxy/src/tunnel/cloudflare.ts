import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { TunnelError, isPublicHostname, type PublicOrigin, type TunnelBinding, type TunnelProvider } from "./state.js";

const execFileAsync = promisify(execFile);
const API = "https://api.cloudflare.com/client/v4";

interface DnsRecord { id: string; type: string; name: string; content: string; proxied?: boolean; comment?: string | null }

/** The comment that marks a DNS record as created by DevFn for one binding; only marked records are ever changed. */
export const ownershipMarker = (binding: TunnelBinding): string => `devfn-tunnel:${binding.name}`;
const tunnelTarget = (binding: TunnelBinding): string => `${binding.cloudflare.tunnelId}.cfargotunnel.com`;
const owned = (binding: TunnelBinding, record: DnsRecord): boolean =>
  record.type === "CNAME" && record.content === tunnelTarget(binding) && record.comment === ownershipMarker(binding);

const zone = (binding: TunnelBinding): string => `/zones/${binding.cloudflare.zoneId}`;

/** cloudflared from an absolute PATH directory; the working directory cannot supply it. */
export async function cloudflaredCommand(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* not in this directory */ }
  }
  throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", "cloudflared was not found in an absolute PATH directory; DevFn does not install it.");
}

/** A YAML double-quoted scalar; JSON string syntax is valid YAML. */
const quoted = (value: string | number): string => JSON.stringify(String(value));

export interface CloudflareProviderOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** cloudflared resolution for validation and the connector; PATH lookup by default. */
  command?: () => Promise<string>;
}

/**
 * Cloudflare named-tunnel adapter. DNS records are proxied CNAMEs to the
 * pre-existing tunnel, marked with the binding's ownership comment and read
 * back after each change; a record DevFn does not own is never modified or
 * deleted. The connector configuration is a locally managed ingress
 * allowlist whose final rule denies every other hostname and path.
 */
export class CloudflareTunnelProvider implements TunnelProvider {
  private readonly fetcher: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly command: () => Promise<string>;

  public constructor(options: CloudflareProviderOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.command = options.command ?? (async () => await cloudflaredCommand(this.env));
  }

  private async api<T>(binding: TunnelBinding, method: string, route: string, body?: unknown): Promise<T> {
    const token = this.env[binding.cloudflare.apiTokenEnv];
    if (!token) throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `The Cloudflare API token reference ${binding.cloudflare.apiTokenEnv} is unset.`);
    let response: Response;
    try {
      response = await this.fetcher(`${API}${route}`, {
        method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `Cloudflare ${method} request failed: ${error instanceof Error ? error.name : "network error"}.`);
    }
    const payload = await response.json().catch(() => undefined) as { success?: boolean; errors?: Array<{ code?: number }>; result?: T } | undefined;
    if (!response.ok || payload?.success !== true) {
      // Provider error codes only: messages can echo request content.
      throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `Cloudflare ${method} failed with HTTP ${response.status}.`,
        { status: response.status, errors: (payload?.errors ?? []).map((item) => item.code).filter((code) => typeof code === "number") });
    }
    return payload.result as T;
  }

  private async records(binding: TunnelBinding, hostname: string): Promise<DnsRecord[]> {
    if (!isPublicHostname(hostname, binding.domain)) throw new TunnelError("DEVFN_TUNNEL_INVALID", `${hostname} is not one label under ${binding.domain}.`);
    return await this.named(binding, hostname);
  }

  private async named(binding: TunnelBinding, name: string): Promise<DnsRecord[]> {
    const result = await this.api<DnsRecord[]>(binding, "GET", `${zone(binding)}/dns_records?name=${encodeURIComponent(name)}&per_page=100`);
    if (!Array.isArray(result)) throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", "Cloudflare returned an unreadable DNS record list.");
    return result.filter((record) => record.name?.toLowerCase() === name);
  }

  /** A wildcard record under the binding domain that routes to its tunnel keeps every name there routed whatever DevFn removes. */
  private async coveredByWildcard(binding: TunnelBinding): Promise<boolean> {
    return (await this.named(binding, `*.${binding.domain}`)).some((record) => record.type === "CNAME" && record.content === tunnelTarget(binding));
  }

  /**
   * The tunnel must exist in the binding's account and be locally
   * configured: a remotely managed tunnel's dashboard configuration would
   * replace the generated ingress allowlist.
   */
  public async verifyTunnel(binding: TunnelBinding): Promise<void> {
    const tunnel = await this.api<{ id?: unknown; deleted_at?: unknown; remote_config?: unknown; config_src?: unknown } | undefined>(binding, "GET",
      `/accounts/${binding.cloudflare.accountId}/cfd_tunnel/${binding.cloudflare.tunnelId}`);
    if (tunnel?.id !== binding.cloudflare.tunnelId || tunnel.deleted_at) {
      throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `Tunnel ${binding.cloudflare.tunnelId} does not exist in account ${binding.cloudflare.accountId}.`);
    }
    const local = (tunnel.remote_config === false || tunnel.config_src === "local") && tunnel.remote_config !== true && tunnel.config_src !== "cloudflare";
    if (!local) {
      throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `Tunnel ${binding.cloudflare.tunnelId} is remotely managed; DevFn runs only locally configured tunnels.`);
    }
  }

  public async ensureDns(binding: TunnelBinding, hostname: string): Promise<"created" | "existing"> {
    const records = await this.records(binding, hostname);
    if (records.length === 1 && owned(binding, records[0])) {
      await this.verifyDns(binding, hostname);
      return "existing";
    }
    if (records.length) throw new TunnelError("DEVFN_TUNNEL_CONFLICT", `${hostname} already has DNS records DevFn does not own; they were left unchanged.`);
    await this.api(binding, "POST", `${zone(binding)}/dns_records`, { type: "CNAME", name: hostname, content: tunnelTarget(binding), proxied: true, ttl: 1, comment: ownershipMarker(binding) });
    await this.verifyDns(binding, hostname);
    return "created";
  }

  public async ownsDns(binding: TunnelBinding, hostname: string): Promise<boolean> {
    return (await this.records(binding, hostname)).some((record) => owned(binding, record));
  }

  public async verifyDns(binding: TunnelBinding, hostname: string): Promise<void> {
    const records = await this.records(binding, hostname);
    if (records.length !== 1 || !owned(binding, records[0]) || records[0].proxied !== true) {
      throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `Public DNS for ${hostname} does not route only to tunnel binding ${binding.name} through a proxied DevFn-owned record.`);
    }
    // Removing the name's record could not end its reachability.
    if (await this.coveredByWildcard(binding)) {
      throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `A wildcard record *.${binding.domain} routes every name to tunnel binding ${binding.name}; DevFn publishes only names it can withdraw.`);
    }
  }

  public async removeDns(binding: TunnelBinding, hostname: string): Promise<void> {
    for (const record of (await this.records(binding, hostname)).filter((item) => owned(binding, item))) {
      await this.api(binding, "DELETE", `${zone(binding)}/dns_records/${encodeURIComponent(record.id)}`);
    }
    if ((await this.records(binding, hostname)).some((item) => owned(binding, item))) {
      throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `The DevFn-owned DNS record for ${hostname} is still present after deletion.`);
    }
    if (await this.coveredByWildcard(binding)) throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `${hostname} is still routed to the tunnel by the wildcard record *.${binding.domain}.`);
  }

  public renderConnectorConfig(binding: TunnelBinding, hostnames: readonly string[], origin: PublicOrigin): string {
    if (!hostnames.length) throw new TunnelError("DEVFN_TUNNEL_INVALID", "A connector configuration needs at least one public hostname.");
    const lines = [`tunnel: ${quoted(binding.cloudflare.tunnelId)}`, `credentials-file: ${quoted(binding.cloudflare.credentialsFile)}`, "no-autoupdate: true", "ingress:"];
    for (const hostname of [...hostnames].sort()) {
      if (!isPublicHostname(hostname, binding.domain)) throw new TunnelError("DEVFN_TUNNEL_INVALID", `${hostname} is not one label under ${binding.domain}.`);
      // The origin sees the allowlisted name as both TLS server name and Host,
      // and its certificate must verify against the DevFn origin root.
      lines.push(`  - hostname: ${quoted(hostname)}`, `    service: ${quoted(`https://127.0.0.1:${origin.port}`)}`, "    originRequest:",
        `      originServerName: ${quoted(hostname)}`, `      httpHostHeader: ${quoted(hostname)}`, `      caPool: ${quoted(origin.caFile)}`, "      noTLSVerify: false");
    }
    lines.push(`  - service: ${quoted("http_status:404")}`, "");
    return lines.join("\n");
  }

  /**
   * Validate with cloudflared itself, offline and under an empty HOME so no
   * user cloudflared configuration or account certificate is consulted: the
   * ingress must parse, each hostname must match its own rule, and any other
   * hostname under the domain must reach the final deny rule.
   */
  public async validateConnectorConfig(binding: TunnelBinding, configFile: string, hostnames: readonly string[]): Promise<void> {
    const command = await this.command();
    const home = await mkdtemp(path.join(os.tmpdir(), "devfn-cloudflared-"));
    const run = async (...args: string[]): Promise<string> => {
      try {
        const result = await execFileAsync(command, ["tunnel", "--config", configFile, "ingress", ...args], { timeout: 15_000, env: { PATH: this.env.PATH ?? "", HOME: home } });
        return `${result.stdout}\n${result.stderr}`;
      } catch (error) {
        throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `cloudflared rejected the generated ingress: ${(error as { stderr?: string }).stderr?.trim().split("\n").at(-1) ?? "validation failed"}`);
      }
    };
    try {
      await run("validate");
      const sorted = [...hostnames].sort();
      for (const [index, hostname] of sorted.entries()) {
        const output = await run("rule", `https://${hostname}/`);
        if (!output.includes(`Matched rule #${index}`) || !output.includes(`hostname: ${hostname}`)) {
          throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `cloudflared does not route ${hostname} to its own ingress rule.`);
        }
      }
      const denied = await run("rule", `https://devfn-deny-probe.${binding.domain}/`);
      if (!denied.includes(`Matched rule #${sorted.length}`) || !denied.includes("http_status:404")) {
        throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", "cloudflared does not deny hostnames outside the public allowlist.");
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  }

  public async connectorCommand(binding: TunnelBinding, configFile: string, metricsPort: number): Promise<string[]> {
    return [await this.command(), "tunnel", "--no-autoupdate", "--config", configFile, "--metrics", `127.0.0.1:${metricsPort}`, "run", binding.cloudflare.tunnelId];
  }
}
