import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { TunnelError, compareNames, isPublicHostname, type NgrokTunnelBinding, type PublicOrigin, type TunnelBinding, type TunnelProvider } from "./state.js";

const execFileAsync = promisify(execFile);
const API = "https://api.ngrok.com";

/** The ngrok fields of a binding; another provider's binding never reaches this adapter's account. */
function ngrok(binding: TunnelBinding): NgrokTunnelBinding["ngrok"] {
  if (binding.provider !== "ngrok") throw new TunnelError("DEVFN_TUNNEL_INVALID", `Tunnel binding ${binding.name} is not an ngrok binding.`);
  return binding.ngrok;
}

/**
 * The metadata that marks an online ngrok tunnel as run by DevFn for one
 * registration of a binding. The registration ID keeps it unique per
 * machine: another machine's binding of the same name derives the same
 * hostnames, and pooling would split public traffic between the two.
 */
export const ngrokMarker = (binding: TunnelBinding): string => `devfn-tunnel:${binding.name}:${ngrok(binding).registrationId}`;

/** ngrok from an absolute PATH directory; the working directory cannot supply it. */
export async function ngrokCommand(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const name = process.platform === "win32" ? "ngrok.exe" : "ngrok";
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* not in this directory */ }
  }
  throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", "ngrok was not found in an absolute PATH directory; DevFn does not install it.");
}

/**
 * What a DevFn ngrok connector runs: one endpoint per hostname, each
 * forwarded through its origin bridge to the public origin. This file, not
 * the agent configuration, is the connector configuration DevFn digests:
 * the agent configuration also names the bridge's runtime port.
 */
export interface NgrokConnectorConfig {
  version: 1;
  binding: string;
  endpoints: "reserved" | "ephemeral";
  marker: string;
  hostnames: string[];
  origin: PublicOrigin;
}

export function parseNgrokConnectorConfig(text: string): NgrokConnectorConfig {
  const config = (() => { try { return JSON.parse(text) as Partial<NgrokConnectorConfig>; } catch { return undefined; } })();
  if (!config || config.version !== 1 || typeof config.binding !== "string" || (config.endpoints !== "reserved" && config.endpoints !== "ephemeral") ||
    typeof config.marker !== "string" || !Array.isArray(config.hostnames) || !config.hostnames.length || !config.hostnames.every((item) => typeof item === "string" && /^[a-z0-9.-]+$/.test(item)) ||
    !config.origin || !Number.isInteger(config.origin.port) || typeof config.origin.caFile !== "string" || !path.isAbsolute(config.origin.caFile) ||
    Object.keys(config).length !== 6) {
    throw new TunnelError("DEVFN_TUNNEL_INVALID", "The ngrok connector configuration is invalid.");
  }
  return config as NgrokConnectorConfig;
}

/** A YAML double-quoted scalar; JSON string syntax is valid YAML. */
const quoted = (value: string | number): string => JSON.stringify(String(value));

/**
 * The ngrok agent configuration for a connector whose origin bridge listens
 * on bridgePort. Every endpoint is HTTPS only, keeps no traffic inspection,
 * carries the binding's marker and sends its own hostname as Host, so the
 * bridge sees an allowlisted name whatever URL the provider assigned. The
 * agent's local API is off: it could start endpoints DevFn did not select.
 * Reserved endpoints are pooled, so a replacement connector can come up
 * beside the one it replaces.
 */
export function renderNgrokAgentConfig(config: NgrokConnectorConfig, bridgePort: number): string {
  const lines = ["version: 3", "agent:", "  web_addr: false", "  update_check: false", "  console_ui: false", "  log: stdout", "  log_format: json", "  log_level: info", "tunnels:"];
  for (const hostname of [...config.hostnames].sort(compareNames)) {
    lines.push(`  ${quoted(hostname)}:`, "    proto: http", `    addr: ${quoted(`http://127.0.0.1:${bridgePort}`)}`, "    schemes:", "      - https", `    host_header: ${quoted(hostname)}`,
      "    inspect: false", `    metadata: ${quoted(config.marker)}`, ...(config.endpoints === "reserved" ? [`    domain: ${quoted(hostname)}`, "    pooling_enabled: true"] : []));
  }
  return `${lines.join("\n")}\n`;
}

export interface NgrokProviderOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** ngrok resolution for validation and the connector; PATH lookup by default. */
  command?: () => Promise<string>;
  /** argv that runs the connector entry; the built ngrok-connector.js under this Node by default. */
  connector?: string[];
}

interface OnlineTunnel { public_url?: unknown; metadata?: unknown }

/**
 * ngrok adapter. ngrok keeps no DNS record for DevFn to create or remove: a
 * hostname is reachable exactly while an agent runs an endpoint for it, so
 * public reachability is governed by the connector alone, and DNS calls
 * only read the account. Reserved endpoints need the account to reserve
 * `*.<domain>`; any online tunnel for a hostname that does not carry the
 * binding's marker is a conflict. Ephemeral endpoints have nothing to read
 * before the connector runs; their URLs are reported by the ready connector.
 */
export class NgrokTunnelProvider implements TunnelProvider {
  private readonly fetcher: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly command: () => Promise<string>;
  private readonly connector: string[];

  public constructor(options: NgrokProviderOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.command = options.command ?? (async () => await ngrokCommand(this.env));
    this.connector = options.connector ?? [process.execPath, fileURLToPath(new URL("./ngrok-connector.js", import.meta.url))];
  }

  private secret(name: string, what: string): string {
    const value = this.env[name];
    if (!value) throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `The ngrok ${what} reference ${name} is unset.`);
    return value;
  }

  /** Every item of a paginated ngrok API list. */
  private async list<T>(binding: TunnelBinding, route: string, key: string): Promise<T[]> {
    const fields = ngrok(binding);
    if (!fields.apiKeyEnv) throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", "An ngrok binding without an API key reference cannot read the account.");
    const token = this.secret(fields.apiKeyEnv, "API key");
    const items: T[] = [];
    let url: string | undefined = `${API}${route}?limit=100`;
    for (let page = 0; url && page < 50; page += 1) {
      if (!url.startsWith(`${API}/`)) throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", "ngrok returned a page outside its API.");
      let response: Response;
      try { response = await this.fetcher(url, { headers: { authorization: `Bearer ${token}`, "ngrok-version": "2" }, signal: AbortSignal.timeout(15_000) }); }
      catch (error) { throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `ngrok GET ${route} failed: ${error instanceof Error ? error.name : "network error"}.`); }
      const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      // Provider error codes only: messages can echo request content.
      if (!response.ok) throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `ngrok GET ${route} failed with HTTP ${response.status}.`, typeof payload?.error_code === "string" ? { errorCode: payload.error_code } : undefined);
      const list = payload?.[key];
      if (!Array.isArray(list)) throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `ngrok returned an unreadable ${key} list.`);
      items.push(...list as T[]);
      url = typeof payload?.next_page_uri === "string" && payload.next_page_uri ? payload.next_page_uri : undefined;
    }
    if (url) throw new TunnelError("DEVFN_TUNNEL_PROVIDER_FAILED", `ngrok returned too many ${key} pages.`);
    return items;
  }

  /**
   * The authtoken must be set; reserved endpoints also need the account to
   * reserve the wildcard domain, so every hostname under it is the account's.
   */
  public async verifyTunnel(binding: TunnelBinding): Promise<void> {
    const fields = ngrok(binding);
    this.secret(fields.authtokenEnv, "authtoken");
    if (fields.endpoints === "ephemeral") return;
    const domains = await this.list<{ domain?: unknown }>(binding, "/reserved_domains", "reserved_domains");
    if (!domains.some((item) => item.domain === `*.${binding.domain}`)) {
      throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `The ngrok account does not reserve *.${binding.domain}; reserved endpoints need that wildcard domain.`);
    }
  }

  /** Nothing to create: ngrok routes the name only while a connector runs its endpoint. */
  public async ensureDns(binding: TunnelBinding, hostname: string): Promise<"created" | "existing"> {
    await this.verifyDns(binding, hostname);
    return "existing";
  }

  /** DevFn never creates an ngrok record. */
  public async ownsDns(binding: TunnelBinding, hostname: string): Promise<boolean> {
    if (!isPublicHostname(hostname, binding.domain)) throw new TunnelError("DEVFN_TUNNEL_INVALID", `${hostname} is not one label under ${binding.domain}.`);
    return await Promise.resolve(false);
  }

  /**
   * A reserved hostname is under the reserved wildcard and served by no
   * agent other than a connector of this registration, such as the one a
   * replacement pools beside; any other marker, including one of a
   * same-named binding registered elsewhere, is a conflict.
   */
  public async verifyDns(binding: TunnelBinding, hostname: string): Promise<void> {
    if (!isPublicHostname(hostname, binding.domain)) throw new TunnelError("DEVFN_TUNNEL_INVALID", `${hostname} is not one label under ${binding.domain}.`);
    if (ngrok(binding).endpoints === "ephemeral") return;
    const tunnels = await this.list<OnlineTunnel>(binding, "/tunnels", "tunnels");
    const host = (url: unknown): string | undefined => { try { return typeof url === "string" ? new URL(url).hostname : undefined; } catch { return undefined; } };
    const foreign = tunnels.filter((item) => host(item.public_url) === hostname && item.metadata !== ngrokMarker(binding));
    if (foreign.length) {
      throw new TunnelError("DEVFN_TUNNEL_CONFLICT", `${hostname} is already served by an ngrok agent DevFn does not own; it was left unchanged.`);
    }
  }

  /** Nothing to remove; reachability ends once no connector routes the name. */
  public async removeDns(binding: TunnelBinding, hostname: string): Promise<void> {
    if (!isPublicHostname(hostname, binding.domain)) throw new TunnelError("DEVFN_TUNNEL_INVALID", `${hostname} is not one label under ${binding.domain}.`);
    await Promise.resolve();
  }

  public renderConnectorConfig(binding: TunnelBinding, hostnames: readonly string[], origin: PublicOrigin): string {
    if (!hostnames.length) throw new TunnelError("DEVFN_TUNNEL_INVALID", "A connector configuration needs at least one public hostname.");
    for (const hostname of hostnames) if (!isPublicHostname(hostname, binding.domain)) throw new TunnelError("DEVFN_TUNNEL_INVALID", `${hostname} is not one label under ${binding.domain}.`);
    const config: NgrokConnectorConfig = { version: 1, binding: binding.name, endpoints: ngrok(binding).endpoints, marker: ngrokMarker(binding),
      hostnames: [...hostnames].sort(compareNames), origin: { port: origin.port, caFile: origin.caFile } };
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  /**
   * The connector configuration must name exactly these hostnames, and the
   * agent configuration rendered from it must pass `ngrok config check`,
   * offline and under an empty HOME so no user ngrok configuration or
   * credential is consulted.
   */
  public async validateConnectorConfig(binding: TunnelBinding, configFile: string, hostnames: readonly string[]): Promise<void> {
    const config = parseNgrokConnectorConfig(await readFile(configFile, "utf8"));
    if (config.binding !== binding.name || config.endpoints !== ngrok(binding).endpoints || config.marker !== ngrokMarker(binding) ||
      JSON.stringify(config.hostnames) !== JSON.stringify([...hostnames].sort(compareNames))) {
      throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", "The ngrok connector configuration does not list exactly the published hostnames.");
    }
    const command = await this.command();
    const home = await mkdtemp(path.join(os.tmpdir(), "devfn-ngrok-"));
    try {
      const agentFile = path.join(home, "agent.yml");
      await writeFile(agentFile, renderNgrokAgentConfig(config, 1), { mode: 0o600 });
      await execFileAsync(command, ["config", "check", "--config", agentFile], { timeout: 15_000, env: { PATH: this.env.PATH ?? "", HOME: home } }).catch((error: unknown) => {
        const detail = (error as { stderr?: string }).stderr?.trim().split("\n").at(-1)?.replaceAll(home, "<home>");
        throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `ngrok rejected the generated agent configuration: ${detail ?? "validation failed"}`);
      });
    } finally { await rm(home, { recursive: true, force: true }); }
  }

  public async connectorCommand(_binding: TunnelBinding, configFile: string, metricsPort: number): Promise<string[]> {
    return [...this.connector, configFile, String(metricsPort), await this.command()];
  }

  /** The agent authtoken, under the name ngrok reads; the connector passes it to the agent only. */
  public connectorSecrets(binding: TunnelBinding): Record<string, string> {
    return { NGROK_AUTHTOKEN: this.secret(ngrok(binding).authtokenEnv, "authtoken") };
  }

  /** The URL of each hostname's started endpoint; a reserved endpoint must have exactly its own hostname. */
  public async assignedUrls(binding: TunnelBinding, metricsPort: number, hostnames: readonly string[]): Promise<Record<string, string>> {
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: metricsPort, path: "/ready", timeout: 5_000 }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { text += chunk; });
        response.on("end", () => response.statusCode === 200 ? resolve(text) : reject(new Error(`HTTP ${response.statusCode}`)));
      });
      request.once("timeout", () => request.destroy(new Error("timed out")));
      request.once("error", reject);
    }).catch((error: unknown) => { throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `The ngrok connector did not report its endpoints (${error instanceof Error ? error.message : String(error)}).`); });
    const urls = (() => { try { return (JSON.parse(body) as { urls?: Record<string, unknown> }).urls; } catch { return undefined; } })();
    const result: Record<string, string> = {};
    for (const hostname of hostnames) {
      const url = urls?.[hostname];
      const valid = typeof url === "string" && /^https:\/\/[a-z0-9.-]+$/.test(url) && (ngrok(binding).endpoints === "ephemeral" || url === `https://${hostname}`);
      if (!valid) throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `The ngrok connector did not start the expected endpoint for ${hostname}.`);
      // One public URL serving two hostnames would publish one route's URL for another.
      const shared = Object.keys(result).find((other) => result[other] === url);
      if (shared) throw new TunnelError("DEVFN_TUNNEL_VALIDATION_FAILED", `The ngrok connector reported the same public URL for ${shared} and ${hostname}; each endpoint needs its own URL.`);
      result[hostname] = url;
    }
    return result;
  }
}
