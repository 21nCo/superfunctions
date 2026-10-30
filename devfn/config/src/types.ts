export type RuntimeAdapter =
  | "command"
  | "npm"
  | "pnpm"
  | "turbo"
  | "wrangler"
  | "xcode"
  | "extfn";

export type HealthCheck =
  | { type: "http"; url?: string; port?: string; path?: string; expectedStatus?: number; timeoutMs?: number }
  | { type: "tcp"; port: string; timeoutMs?: number }
  | { type: "command"; command: string[]; timeoutMs?: number }
  | { type: "log"; pattern: string; timeoutMs?: number };

export interface PortSpec {
  protocol?: "tcp" | "udp";
  preferred?: number;
  range?: [number, number];
  exact?: boolean;
  ephemeral?: boolean;
  exposure?: "loopback" | "public";
  internal?: number;
  block?: string;
  env?: string;
}

/**
 * A finite lifecycle node: it runs to completion instead of serving, and
 * only its successful exit (code 0) lets dependents start. A task declares
 * no ports or health check and is never a resource target provider.
 */
export interface TaskSpec {
  /**
   * When a later start runs it again: "on-change" (default) when no success
   * is recorded for its current input revision, "always" on every start
   * (requires idempotent), "once" never after a success, failing before any
   * mutation when its input revision changed.
   */
  rerun?: "on-change" | "always" | "once";
  /**
   * Repeating it, also after an attempt that may have partly applied, is
   * safe. Without it a failed, timed-out, cancelled or interrupted attempt
   * blocks later starts until the task is explicitly rerun. Defaults to false.
   */
  idempotent?: boolean;
  /** Further attempts within one start after a failed or timed-out one; requires idempotent. 0-5, defaults to 0. */
  retries?: number;
  /** Per-attempt limit after which the task is stopped. Defaults to 600000. */
  timeoutMs?: number;
  /** Repository-relative files and directories whose content is part of the input revision. */
  inputs?: string[];
}

export interface ProcessSpec {
  adapter: RuntimeAdapter;
  exposure?: "local" | "public";
  command?: string[];
  script?: string;
  cwd?: string;
  env?: Record<string, string>;
  envAllowlist?: string[];
  secretEnv?: string[];
  ports?: string[];
  dependsOn?: string[];
  /** Resources this node consumes; a selected local target starts before it. */
  resources?: string[];
  health?: HealthCheck;
  shutdownTimeoutMs?: number;
  /** Run as a finite task instead of a daemon. */
  task?: TaskSpec;
}

export interface ComposeServiceSpec {
  adapter: "compose";
  file?: string;
  service: string;
  projectName?: string;
  ports?: Record<string, number>;
  dependsOn?: string[];
  /** Resources this node consumes; a selected local target starts before it. */
  resources?: string[];
  health?: HealthCheck;
  persistent?: boolean;
  env?: Record<string, string>;
  envAllowlist?: string[];
  secretEnv?: string[];
  /** Run the service's command once in a one-off container (docker compose run) as a finite task. */
  task?: TaskSpec;
}

/**
 * Routes a profile publishes through a machine-registered public tunnel
 * binding. Selecting it never authorizes exposure: every start still needs
 * --allow-public.
 */
export interface ProfileTunnelSpec {
  /** Name of a machine tunnel binding registered to this repository and project. */
  binding: string;
  /** Keys of `hostnames` entries selected by this profile; only these are public. */
  routes: string[];
  /**
   * Explicitly select a binding whose provider assigns public URLs only after
   * its connector starts (ngrok ephemeral endpoints). Those URLs reach the
   * receipt and tunnel status, never a pre-start template reference.
   */
  ephemeral?: boolean;
}

export interface ProfileSpec {
  processes?: string[];
  services?: string[];
  environment?: Record<string, string>;
  proxy?: boolean;
  tunnel?: ProfileTunnelSpec;
  /** Selected target name by resource; overrides the resource's defaultTarget. */
  resources?: Record<string, string>;
}

/**
 * A proxy route. Validation accepts two variants: a .localhost route
 * (optional `hostname` template and `tls`) or a registered-domain route
 * (`domain`, optional `host`, TLS from the machine registration). `domain`
 * excludes `hostname` and `tls`; `host` requires `domain`.
 */
export interface HostnameSpec {
  target: string;
  /** .localhost hostname template using {project} and {instance}; excludes domain. */
  hostname?: string;
  /** Machine-registered domain; a manifest cannot create the registration. */
  domain?: string;
  /** Registered-domain host label; defaults to the route key. Requires domain. */
  host?: string;
  /** Absolute URL path; defaults to "/". */
  path?: string;
  /** Defaults to "prefix". */
  match?: "exact" | "prefix";
  /** Strip the path prefix upstream; requires a non-root prefix path. Defaults to false. */
  stripPrefix?: boolean;
  /** .localhost routes only; defaults to "off". */
  tls?: "off" | "internal";
  profiles?: string[];
}

export interface RuntimePrerequisite {
  command: string;
  version?: string;
  optional?: boolean;
  profiles?: string[];
}

export interface EnvironmentOutput {
  path: string;
  format?: "dotenv" | "json";
  mode?: number;
}

export type ResourceKind = "service" | "database" | "broker" | "cache" | "object-store" | "browser";

/**
 * A resource target. A local target names the lifecycle node and declared
 * port that provide it; a remote target names a credential-free URL. Secret
 * fields name host environment variables, never values.
 */
export type ResourceTargetSpec =
  | { node: string; port: string; scheme?: string; path?: string; secrets?: Record<string, string> }
  | { url: string; secrets?: Record<string, string> };

/**
 * Isolated namespaces append an opaque runtime-owner token; shared namespaces
 * use `base` unchanged across runtimes. Sharing is never implied.
 */
export interface ResourceNamespaceSpec {
  /** Defaults to the resource name. */
  base?: string;
  /** Defaults to "isolated". */
  sharing?: "isolated" | "shared";
  /** Database resources: namespace the database (default) or a schema in `database`. */
  level?: "database" | "schema";
  /** Fixed database containing namespaced schemas; requires level "schema". */
  database?: string;
}

export interface ResourceSpec {
  kind: ResourceKind;
  /** Required for every kind except browser. */
  targets?: Record<string, ResourceTargetSpec>;
  defaultTarget?: string;
  namespace?: ResourceNamespaceSpec;
  /** Broker topics; each receives a namespaced name. */
  topics?: string[];
  /** Broker consumer group suffix; the group shares the topics' namespace. */
  consumerGroup?: string;
  /** Browser cookie names that receive namespaced names. */
  cookies?: string[];
  /** Browser storage keys that receive namespaced names. */
  storageKeys?: string[];
}

export interface DevFnConfig {
  version: 1;
  project: { id: string; name?: string };
  defaultProfile?: string;
  runtimeDir?: string;
  ports?: Record<string, PortSpec>;
  processes?: Record<string, ProcessSpec>;
  services?: Record<string, ComposeServiceSpec>;
  profiles: Record<string, ProfileSpec>;
  hostnames?: Record<string, HostnameSpec>;
  resources?: Record<string, ResourceSpec>;
  prerequisites?: RuntimePrerequisite[];
  environmentOutputs?: EnvironmentOutput[];
  policy?: string;
}

export interface PortPolicyEntry {
  name: string;
  port?: number;
  range?: [number, number];
  kind: "protected" | "preferred" | "excluded";
  project?: string;
  description?: string;
}

export interface DevFnPolicy {
  version: 1;
  fallbackRange?: [number, number];
  hostnameSuffix?: string;
  ports?: PortPolicyEntry[];
}

export interface DetectionFinding {
  kind: "package-manager" | "process" | "compose" | "wrangler" | "xcode" | "extension";
  confidence: "confirmed" | "proposed";
  source: string;
  detail: string;
}

export interface DiscoveryResult {
  root: string;
  findings: DetectionFinding[];
  config: DevFnConfig;
}
