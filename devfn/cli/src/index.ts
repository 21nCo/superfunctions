#!/usr/bin/env node
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createOutput, createScaffold, redactValue } from "@clifn/core";
import {
  DevFnConfigError,
  discoverProject,
  loadTrustedDevFnConfig,
  renderDevFnConfig,
  resolveContainedPath,
  resolveDevFnManifestPath,
  trustProject,
} from "@devfn/config";
import {
  DevFnError, DevFnOrchestrator, lifecycleOwnerMayRun, oauthRelayStatus, planPublicUrls, readRegisteredDomains, readTunnelBindings, recoverOrphanedProxyRoutes, recoverTunnel, registerDomain, registerTunnelBinding,
  ephemeralOriginDomain, resolveInstanceIdentity, resolveTunnelBinding, startOAuthRelay, stopOAuthRelay, tunnelStatus, unregisterDomain, unregisterTunnelBinding, type TunnelBindingInput,
} from "@devfn/core";
import { FilePortRegistry, renderPortInventory } from "@devfn/ports";
import { defaultStateDir } from "@devfn/config";

interface ParsedArgs {
  command: string;
  positionals: string[];
  json: boolean;
  yes: boolean;
  trust: boolean;
  configPath?: string;
  profile?: string;
  stateDir?: string;
  output?: string;
  tail?: number;
  allowPublic: boolean;
  tls?: string;
  certificateFile?: string;
  keyFile?: string;
  host?: string;
  tunnel: Partial<Record<"provider" | "domain" | "accountId" | "zoneId" | "tunnelId" | "credentialsFile" | "apiTokenEnv" | "authtokenEnv" | "apiKeyEnv", string>>;
  nonproduction: boolean;
  ephemeral: boolean;
  rerunTasks: string[];
}

export interface CliOptions { cwd?: string; env?: NodeJS.ProcessEnv; stdout?: (text: string) => void; stderr?: (text: string) => void }

const HELP = `DevFn — portable local development environments

Usage: devfn <command> [options]

Commands:
  init                 Inspect a repository and preview or write devfn.config.ts
  up                   Reserve ports and start the selected profile
  down                 Stop only this worktree instance
  restart              Restart this worktree instance
  status               Show processes, services, ports, and health
  logs [name]          Show process or Compose logs
  doctor               Diagnose runtimes, Docker, ports, leases, and proxy
  ports [gc|report]    Inspect, reconcile, collect (incl. orphaned routes), or report port state
  url [name]           Print resolved local URLs
  domains [list|register|unregister]  Manage machine-owned development domains
  oauth-relay [status|start <domain>|stop]  Manage the machine's OAuth callback relay
  tunnel [list|register <name>|unregister <name>|urls|status <name>|recover <name>]
                       Manage machine public tunnel bindings and preview public URLs

Options:
  --profile <name>     Select a named profile
  --config <path>      Use an explicit manifest
  --json               Emit one machine-readable JSON value
  --trust              Trust the current manifest digest before loading it
  --allow-public       Confirm processes, ports or tunnel routes declared as public exposure
  --rerun-task <name>  Run a task on this start although its record would skip or block it (repeatable)
  --yes                Confirm devfn init writes
  --state-dir <path>   Override machine state (primarily for testing)
  --output <path>      Write a ports report
  --tail <count>       Limit log lines
  --tls <mode>         Domain TLS: internal or certificate
  --cert <path>        Certificate PEM for certificate TLS
  --key <path>         Private key PEM for certificate TLS
  --host <label>       OAuth relay host label under its domain (default auth)
  --provider <name>    Tunnel binding provider: cloudflare (default) or ngrok
  --domain, --account-id, --zone-id, --tunnel-id, --credentials-file, --api-token-env
                       Cloudflare binding fields; the token is read from the named variable, never stored
  --authtoken-env, --api-key-env
                       ngrok binding credential variable names; values are never stored
  --ephemeral          Register an ngrok binding whose URLs are assigned only after start
  --nonproduction      Confirm a tunnel binding uses a nonproduction account and domain
`;

const TUNNEL_OPTIONS = { "--provider": "provider", "--domain": "domain", "--account-id": "accountId", "--zone-id": "zoneId", "--tunnel-id": "tunnelId", "--credentials-file": "credentialsFile",
  "--api-token-env": "apiTokenEnv", "--authtoken-env": "authtokenEnv", "--api-key-env": "apiKeyEnv" } as const;

function parse(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values: Record<string, string | boolean> = {};
  const rerunTasks: string[] = [];
  const takesValue = new Set(["--profile", "--config", "--state-dir", "--output", "--tail", "--tls", "--cert", "--key", "--host", ...Object.keys(TUNNEL_OPTIONS)]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    if (token === "--rerun-task") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new DevFnError("DEVFN_RUNTIME_INVALID", `${token} requires a value.`);
      if (!rerunTasks.includes(value)) rerunTasks.push(value);
      index += 1;
      continue;
    }
    if (takesValue.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new DevFnError("DEVFN_RUNTIME_INVALID", `${token} requires a value.`);
      values[token] = value; index += 1;
    } else if (["--json", "--yes", "--trust", "--allow-public", "--nonproduction", "--ephemeral", "--help"].includes(token)) values[token] = true;
    else throw new DevFnError("DEVFN_RUNTIME_INVALID", `Unknown option ${token}.`);
  }
  const tailValue = values["--tail"];
  const tail = typeof tailValue === "string" && /^\d+$/.test(tailValue) ? Number(tailValue) : undefined;
  if (tailValue !== undefined && (tail === undefined || !Number.isSafeInteger(tail))) throw new DevFnError("DEVFN_RUNTIME_INVALID", "--tail must be a non-negative integer.");
  return {
    command: values["--help"] ? "help" : positionals.shift() ?? "help",
    positionals,
    json: values["--json"] === true,
    yes: values["--yes"] === true,
    trust: values["--trust"] === true,
    allowPublic: values["--allow-public"] === true,
    ...(typeof values["--profile"] === "string" ? { profile: values["--profile"] } : {}),
    ...(typeof values["--config"] === "string" ? { configPath: values["--config"] } : {}),
    ...(typeof values["--state-dir"] === "string" ? { stateDir: values["--state-dir"] } : {}),
    ...(typeof values["--output"] === "string" ? { output: values["--output"] } : {}),
    ...(tail === undefined ? {} : { tail }),
    ...(typeof values["--tls"] === "string" ? { tls: values["--tls"] } : {}),
    ...(typeof values["--cert"] === "string" ? { certificateFile: values["--cert"] } : {}),
    ...(typeof values["--key"] === "string" ? { keyFile: values["--key"] } : {}),
    ...(typeof values["--host"] === "string" ? { host: values["--host"] } : {}),
    tunnel: Object.fromEntries(Object.entries(TUNNEL_OPTIONS).flatMap(([flag, key]) => typeof values[flag] === "string" ? [[key, values[flag]]] : [])),
    nonproduction: values["--nonproduction"] === true,
    ephemeral: values["--ephemeral"] === true,
    rerunTasks,
  };
}

function errorPayload(error: unknown): { code: string; message: string; details?: unknown } {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
    return { code: typeof candidate.code === "string" && candidate.code.startsWith("DEVFN_") ? candidate.code : "DEVFN_FAILED", message: typeof candidate.message === "string" ? candidate.message : String(error), ...(candidate.details === undefined ? {} : { details: redactValue(candidate.details) }) };
  }
  return { code: "DEVFN_FAILED", message: String(error) };
}

async function trustedConfig(args: ParsedArgs, cwd: string, stateDir: string) {
  const manifest = await resolveDevFnManifestPath({ cwd, configPath: args.configPath });
  if (args.trust) await trustProject(manifest.root, manifest.path, stateDir);
  try { return await loadTrustedDevFnConfig({ cwd, configPath: manifest.path, stateDir }); }
  catch (error) {
    if (error instanceof DevFnConfigError) throw error;
    if (error instanceof Error && error.message.startsWith("DevFn manifest is not trusted:")) {
      throw new DevFnError("DEVFN_MANIFEST_UNTRUSTED", `Manifest ${manifest.path} can define lifecycle commands and is not trusted. Review it, then rerun with --trust.`);
    }
    throw error;
  }
}

async function initCommand(args: ParsedArgs, cwd: string): Promise<Record<string, unknown>> {
  const configName = args.configPath ?? "devfn.config.ts";
  if (path.extname(configName).toLowerCase() !== ".ts") throw new DevFnConfigError("DEVFN_CONFIG_INVALID", `devfn init can only generate a TypeScript manifest; ${configName} must end in .ts.`);
  if (path.isAbsolute(configName) || path.dirname(configName) !== ".") throw new DevFnConfigError("DEVFN_CONFIG_INVALID", "devfn init can only generate a manifest at the repository root.");
  try { await resolveDevFnManifestPath({ cwd, configPath: args.configPath }); throw new DevFnConfigError("DEVFN_CONFIG_INVALID", "A DevFn manifest already exists; init will not overwrite it."); }
  catch (error) { if (!(error instanceof DevFnConfigError) || error.code !== "DEVFN_CONFIG_NOT_FOUND") throw error; }
  const discovery = await discoverProject(cwd);
  const content = renderDevFnConfig(discovery.config, discovery.findings);
  if (!args.yes) return { ok: true, written: false, preview: content, findings: discovery.findings, confirmationRequired: "Review the preview, then rerun devfn init --yes." };
  const scaffold = createScaffold();
  await scaffold.apply([{ kind: "write-file", path: configName, content, ifExists: "error" }], { cwd });
  try {
    const ignorePath = await resolveContainedPath(cwd, ".gitignore", ".gitignore");
    const ignore = await readFile(ignorePath, "utf8").catch(() => "");
    if (!ignore.split(/\r?\n/).includes(".devfn/")) await writeFile(ignorePath, `${ignore}${ignore.endsWith("\n") || ignore.length === 0 ? "" : "\n"}.devfn/\n`, "utf8");
  } catch (error) {
    await rm(path.join(cwd, configName), { force: true }).catch(() => undefined);
    throw error;
  }
  return { ok: true, written: true, manifest: path.join(cwd, configName), findings: discovery.findings };
}

type LoadedConfig = Awaited<ReturnType<typeof trustedConfig>>;

async function portsCommand(args: ParsedArgs, cwd: string, stateDir: string, loaded: LoadedConfig): Promise<unknown> {
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  const action = args.positionals[0];
  if (action === "gc") {
    // Orphaned routes go first so their target ports and listener claims can
    // be collected in the same run.
    // An owner whose public withdrawal fails keeps its routes, which hold its
    // ports; every other lease is still collected before that is reported.
    const recovery: { recovered: string[]; error?: DevFnError } = await recoverOrphanedProxyRoutes(stateDir).then((recovered) => ({ recovered }), (error: unknown) => {
      if (!(error instanceof DevFnError) || !Array.isArray(error.details?.recovered)) throw error;
      return { recovered: error.details.recovered as string[], error };
    });
    await registry.reconcile();
    const removed = await registry.gc();
    if (recovery.error) throw new DevFnError(recovery.error.code, recovery.error.message, { ...recovery.error.details, removed });
    return { ok: true, removed, recoveredRoutes: recovery.recovered };
  }
  if (action !== undefined && action !== "report") throw new DevFnError("DEVFN_RUNTIME_INVALID", `Unknown ports action ${action}. Expected gc or report.`);
  const state = await registry.reconcile();
  if (action === undefined) return { ok: true, revision: state.revision, allocations: state.allocations.filter((item) => item.state !== "released") };
  const { loadDevFnPolicy } = await import("@devfn/config");
  const { renderPolicyInventory } = await import("@devfn/ports");
  const policy = await loadDevFnPolicy(loaded.root, loaded.config.policy);
  const report = `${renderPolicyInventory(policy?.policy ?? null)}\n${renderPortInventory(state)}`;
  const reportPath = args.output ? await resolveContainedPath(cwd, args.output, "--output") : undefined;
  if (reportPath) await writeFile(reportPath, report, { encoding: "utf8", mode: 0o600 });
  return { ok: true, report, ...(reportPath ? { output: reportPath } : {}) };
}

async function urlCommand(args: ParsedArgs, orchestrator: DevFnOrchestrator, loaded: LoadedConfig): Promise<unknown> {
  const status = await orchestrator.status({ config: loaded.config, root: loaded.root }) as { urls?: Record<string, string> };
  const name = args.positionals[0];
  if (!name) return { ok: true, urls: status.urls ?? {} };
  const url = status.urls?.[name];
  if (!url) throw new DevFnError("DEVFN_URL_NOT_FOUND", `No HTTP or proxy URL is resolved for ${name}. Inspect devfn ports for its transport allocation.`);
  return { ok: true, name, url };
}

async function domainsCommand(args: ParsedArgs, cwd: string, stateDir: string, loaded: LoadedConfig): Promise<unknown> {
  const action = args.positionals[0] ?? "list";
  const identity = await resolveInstanceIdentity(loaded.config.project.id, loaded.root);
  if (action === "list") {
    if (args.positionals.length > 1) throw new DevFnError("DEVFN_RUNTIME_INVALID", "domains list takes no arguments.");
    return { ok: true, domains: (await readRegisteredDomains(stateDir)).filter((domain) => domain.projectId === identity.projectId && domain.repositoryIdentity === identity.repositoryIdentity) };
  }
  const domain = args.positionals[1];
  if (!domain || args.positionals.length !== 2) throw new DevFnError("DEVFN_RUNTIME_INVALID", "domains register/unregister requires exactly one domain.");
  if (action === "register") {
    if (args.tls !== "internal" && args.tls !== "certificate") throw new DevFnError("DEVFN_RUNTIME_INVALID", "--tls must be internal or certificate; DNS-01 requires a validated adapter and is unavailable.");
    const registered = await registerDomain(stateDir, { domain, projectId: identity.projectId, repositoryIdentity: identity.repositoryIdentity,
      tls: args.tls, ...(args.certificateFile ? { certificateFile: path.resolve(cwd, args.certificateFile) } : {}), ...(args.keyFile ? { keyFile: path.resolve(cwd, args.keyFile) } : {}) });
    return { ok: true, domain: registered };
  }
  if (action === "unregister") { await unregisterDomain(stateDir, domain, identity.projectId, identity.repositoryIdentity); return { ok: true, domain, removed: true }; }
  throw new DevFnError("DEVFN_RUNTIME_INVALID", `Unknown domains action ${action}.`);
}

/** The relay is machine state: only start reads the trusted project, for its identity. */
async function oauthRelayCommand(args: ParsedArgs, stateDir: string, load: () => Promise<LoadedConfig>): Promise<unknown> {
  const [action = "status", domain, ...extra] = args.positionals;
  if (action === "start") {
    if (!domain || extra.length) throw new DevFnError("DEVFN_RUNTIME_INVALID", "oauth-relay start requires exactly one registered domain.");
    const loaded = await load();
    const identity = await resolveInstanceIdentity(loaded.config.project.id, loaded.root);
    return { ok: true, relay: await startOAuthRelay({ stateDir, domain, projectId: identity.projectId, repositoryIdentity: identity.repositoryIdentity, ...(args.host ? { host: args.host } : {}) }) };
  }
  if (domain !== undefined || args.host !== undefined) throw new DevFnError("DEVFN_RUNTIME_INVALID", `oauth-relay ${action} takes no domain or --host.`);
  if (action === "stop") return { ok: true, ...await stopOAuthRelay(stateDir) };
  if (action === "status") return { ok: true, relay: await oauthRelayStatus(stateDir) };
  throw new DevFnError("DEVFN_RUNTIME_INVALID", `Unknown oauth-relay action ${action}. Expected status, start or stop.`);
}

/** The binding a tunnel register command describes; the options of one provider only. */
function tunnelBindingInput(args: ParsedArgs, cwd: string, name: string, identity: { projectId: string; repositoryIdentity: string }): TunnelBindingInput {
  const { provider = "cloudflare", domain, accountId, zoneId, tunnelId, credentialsFile, apiTokenEnv, authtokenEnv, apiKeyEnv } = args.tunnel;
  if (!args.nonproduction) throw new DevFnError("DEVFN_RUNTIME_INVALID", "tunnel register requires --nonproduction; DevFn binds only nonproduction tunnels and domains.");
  const base = { name, projectId: identity.projectId, repositoryIdentity: identity.repositoryIdentity, nonproduction: true as const };
  if (provider === "cloudflare") {
    if (!domain || !accountId || !zoneId || !tunnelId || !credentialsFile || !apiTokenEnv || authtokenEnv || apiKeyEnv || args.ephemeral) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", "tunnel register for cloudflare requires --domain, --account-id, --zone-id, --tunnel-id, --credentials-file and --api-token-env, and no ngrok options.");
    }
    return { ...base, provider, domain, cloudflare: { accountId, zoneId, tunnelId, credentialsFile: path.resolve(cwd, credentialsFile), apiTokenEnv } };
  }
  if (provider !== "ngrok") throw new DevFnError("DEVFN_RUNTIME_INVALID", `Unknown tunnel provider ${provider}. Expected cloudflare or ngrok.`);
  if (!authtokenEnv || accountId || zoneId || tunnelId || credentialsFile || apiTokenEnv) {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", "tunnel register for ngrok requires --authtoken-env and takes no Cloudflare options.");
  }
  if (args.ephemeral) {
    if (domain) throw new DevFnError("DEVFN_RUNTIME_INVALID", "An ephemeral ngrok binding takes no --domain; the provider assigns its URLs after start.");
    return { ...base, provider, domain: ephemeralOriginDomain(name), ngrok: { endpoints: "ephemeral", authtokenEnv, ...(apiKeyEnv ? { apiKeyEnv } : {}) } };
  }
  if (!domain || !apiKeyEnv) throw new DevFnError("DEVFN_RUNTIME_INVALID", "tunnel register for ngrok reserved endpoints requires --domain, whose wildcard *.<domain> the account reserves, and --api-key-env; use --ephemeral for assigned URLs.");
  return { ...base, provider, domain, ngrok: { endpoints: "reserved", authtokenEnv, apiKeyEnv } };
}

/** Machine tunnel bindings of the current repository and project, and its public URLs and their timing. */
async function tunnelCommand(args: ParsedArgs, cwd: string, stateDir: string, loaded: LoadedConfig): Promise<unknown> {
  const [action = "list", name, ...extra] = args.positionals;
  const identity = await resolveInstanceIdentity(loaded.config.project.id, loaded.root);
  if (extra.length || (["list", "urls"].includes(action) ? name !== undefined : !name)) throw new DevFnError("DEVFN_RUNTIME_INVALID", `tunnel ${action} ${["list", "urls"].includes(action) ? "takes no binding name" : "requires exactly one binding name"}.`);
  if (action !== "register" && (Object.keys(args.tunnel).length || args.nonproduction || args.ephemeral)) throw new DevFnError("DEVFN_RUNTIME_INVALID", `tunnel ${action} takes no binding fields.`);
  if (action === "list") return { ok: true, bindings: (await readTunnelBindings(stateDir)).filter((item) => item.projectId === identity.projectId && item.repositoryIdentity === identity.repositoryIdentity) };
  if (action === "urls") return { ok: true, ...await planPublicUrls({ config: loaded.config, root: loaded.root, profile: args.profile, stateDir }) };
  if (action === "register") return { ok: true, binding: await registerTunnelBinding(stateDir, tunnelBindingInput(args, cwd, name!, identity)) };
  if (action === "unregister") { await unregisterTunnelBinding(stateDir, name!, identity.projectId, identity.repositoryIdentity); return { ok: true, binding: name, removed: true }; }
  const binding = await resolveTunnelBinding(stateDir, name!, identity.projectId, identity.repositoryIdentity);
  if (action === "status") return { ok: true, tunnel: await tunnelStatus({ stateDir, binding }) };
  if (action === "recover") {
    // Recovery may restart the connector for the published routes of owners that may still run.
    if (!args.allowPublic) throw new DevFnError("DEVFN_PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED", "tunnel recover restarts public exposure. Review it and rerun with --allow-public.");
    return { ok: true, tunnel: await recoverTunnel({ stateDir, binding, ownerMayRun: lifecycleOwnerMayRun(stateDir) }) };
  }
  throw new DevFnError("DEVFN_RUNTIME_INVALID", `Unknown tunnel action ${action}. Expected list, register, unregister, urls, status or recover.`);
}

/**
 * While a task runs, the first SIGINT or SIGTERM stops it and the start,
 * which rolls back what it started; a second one ends DevFn at once. Outside
 * task runs both keep their default behavior.
 */
function taskCancellation(): { signal: AbortSignal; whileTaskRuns: <T>(run: () => Promise<T>) => Promise<T> } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  return {
    signal: controller.signal,
    whileTaskRuns: async (run) => {
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try { return await run(); }
      finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
      }
    },
  };
}

async function executeCommand(args: ParsedArgs, cwd: string, stateDir: string, loaded: LoadedConfig): Promise<unknown> {
  if (args.command === "domains") return await domainsCommand(args, cwd, stateDir, loaded);
  if (args.command === "tunnel") return await tunnelCommand(args, cwd, stateDir, loaded);
  const orchestrator = new DevFnOrchestrator();
  const lifecycle = { config: loaded.config, root: loaded.root, stateDir };
  if (args.rerunTasks.length && args.command !== "up" && args.command !== "restart") throw new DevFnError("DEVFN_RUNTIME_INVALID", "--rerun-task applies only to up and restart.");
  const start = async (replace: boolean) => await orchestrator.up({ ...lifecycle, profile: args.profile, allowPublic: args.allowPublic,
    ...(replace ? { replace } : {}), ...(args.rerunTasks.length ? { rerunTasks: args.rerunTasks } : {}), ...taskCancellation() });
  const handlers: Record<string, () => Promise<unknown>> = {
    up: async () => await start(false),
    down: async () => await orchestrator.down(lifecycle),
    restart: async () => await start(true),
    status: async () => await orchestrator.status(lifecycle),
    doctor: async () => await orchestrator.doctor({ ...lifecycle, profile: args.profile }),
    logs: async () => await orchestrator.logs({ config: loaded.config, root: loaded.root, name: args.positionals[0], tail: args.tail }),
    ports: async () => await portsCommand(args, cwd, stateDir, loaded),
    url: async () => await urlCommand(args, orchestrator, loaded),
  };
  const handler = Object.prototype.hasOwnProperty.call(handlers, args.command) ? handlers[args.command] : undefined;
  if (!handler) throw new DevFnError("DEVFN_RUNTIME_INVALID", `Unknown command ${args.command}.`);
  return await handler();
}

/** Tunnel binding fields that name the environment variable holding a credential, never the credential. */
const CREDENTIAL_REFERENCES = new Set(["apiTokenEnv", "authtokenEnv", "apiKeyEnv"]);

/** Result maps keyed by route names or hostnames, which carry worktree labels, not field names. */
const URL_MAPS = new Set(["urls", "publicUrls"]);

/** A receipt's resource plan (ResourcePlan): its keys name resources, services and variables. */
function isResourcePlan(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  return typeof plan.profile === "string" && typeof plan.owner === "string" && typeof plan.ownerToken === "string"
    && !!plan.resources && typeof plan.resources === "object" && !Array.isArray(plan.resources);
}

/**
 * JSON output under the shared redaction, with three exceptions. The keys of
 * a `urls` or `publicUrls` map are data: only their values go through the
 * redaction, so a route named like a secret field still shows its URL. A
 * receipt's resource plan is shown as planned: it is credential-free by
 * construction (target URLs reject userinfo and encoded data, secrets are
 * variable names and presence, never values), and its provenance is what the
 * operator reads, while the shared key pattern would hide a resource named
 * auth-token, every secret reference and every cookie variable. In tunnel
 * output a credential reference holding a variable name is shown: it tells the
 * operator which variable a binding reads, and the shared key pattern would
 * hide it.
 */
function redactResult(value: unknown, credentialReferences: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => redactResult(item, credentialReferences));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key,
    key === "resources" && isResourcePlan(nested) ? nested
      : credentialReferences && CREDENTIAL_REFERENCES.has(key) && typeof nested === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(nested) ? nested
        : (redactValue({ [key]: null }) as Record<string, unknown>)[key] !== null ? "[REDACTED]"
          : URL_MAPS.has(key) && nested && typeof nested === "object" && !Array.isArray(nested)
            ? Object.fromEntries(Object.entries(nested).map(([name, url]) => [name, redactResult(url, credentialReferences)]))
            : redactResult(nested, credentialReferences)]));
}

function renderResult(args: ParsedArgs, result: unknown, output: ReturnType<typeof createOutput>): void {
  if (args.json) { output.json(redactResult(result, args.command === "tunnel")); return; }
  if (args.command === "logs" && result && typeof result === "object") {
    for (const [name, log] of Object.entries(result)) output.info(`${name}\n${log}`);
    return;
  }
  if (args.command === "url") {
    const value = result as { url?: string | null; urls?: Record<string, string> };
    for (const url of value.url ? [value.url] : Object.values(value.urls ?? {})) output.info(url);
    return;
  }
  if (args.command === "doctor") {
    for (const diagnostic of (result as { diagnostics: Array<{ severity: string; code: string; message: string }> }).diagnostics) output[diagnostic.severity === "error" ? "error" : diagnostic.severity === "warning" ? "warn" : "info"](`${diagnostic.code}: ${diagnostic.message}`);
    return;
  }
  output.success(`${args.command} completed.`, result);
}

export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  let args: ParsedArgs;
  try { args = parse(argv); } catch (error) {
    const output = createOutput({ mode: argv.includes("--json") ? "json" : "text", stdout: options.stdout, stderr: options.stderr, color: false });
    const failure = errorPayload(error); argv.includes("--json") ? output.json({ ok: false, error: failure }) : output.error(`${failure.code}: ${failure.message}`); return 1;
  }
  const output = createOutput({ mode: args.json ? "json" : "text", stdout: options.stdout, stderr: options.stderr, color: false });
  const stateDir = path.resolve(args.stateDir ?? defaultStateDir(options.env));
  try {
    if (args.command === "help") { if (args.json) output.json({ ok: true, help: HELP }); else options.stdout ? options.stdout(HELP) : process.stdout.write(HELP); return 0; }
    if (args.command === "init") {
      const result = await initCommand(args, cwd); if (args.json) output.json(result); else { if (!result.written) output.info(String(result.preview)); output.success(result.written ? `Created ${result.manifest}` : String(result.confirmationRequired)); } return 0;
    }
    const load = () => trustedConfig(args, cwd, stateDir);
    const result = args.command === "oauth-relay" ? await oauthRelayCommand(args, stateDir, load) : await executeCommand(args, cwd, stateDir, await load());
    renderResult(args, result, output);
    return args.command === "doctor" && !(result as { ok?: boolean }).ok ? 1 : 0;
  } catch (error) {
    const failure = errorPayload(error);
    if (args.json) output.json({ ok: false, error: failure }); else output.error(`${failure.code}: ${failure.message}`);
    return 1;
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) process.exitCode = await runCli(process.argv.slice(2));
