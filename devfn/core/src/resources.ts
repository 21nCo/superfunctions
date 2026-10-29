import { createHash } from "node:crypto";

import { resourceEnvironmentKeys, resourceToken, validateDevFnConfig, type DevFnConfig, type ResourceKind, type ResourceSpec, type ResourceTargetSpec } from "@devfn/config";
import { composeProjectName } from "@devfn/compose";

import { DevFnError, type LifecyclePlan } from "./types.js";

/** Where a planned value came from; values never include credentials. */
export type ResourceValueSource = "manifest" | "lease" | "compose" | "host-gateway" | "namespace";

export interface ResourceValue { value: string; source: ResourceValueSource; field: string }
export interface UnreachableResourceValue { unreachable: string }

export interface PlannedResource {
  kind: ResourceKind;
  target?: { name: string; location: "local" | "remote"; selectedBy: "profile" | "defaultTarget"; field: string };
  provider?: { node: string; kind: "process" | "service"; port: string };
  /** Credential-free remote URL; validation rejects userinfo, queries and fragments. */
  remote?: { url: string };
  consumers: string[];
  namespace?: { sharing: "isolated" | "shared"; prefix: string; field: string };
  /** Host environment variable names consumers receive through their secret channel. Values are never read. */
  secrets: Array<{ name: string; env: string; field: string; present?: boolean }>;
  /** Values for host-side consumers: native processes, readiness commands and environment outputs. */
  values: Record<string, ResourceValue>;
  /** Container-side overrides by selected Compose service. */
  services: Record<string, Record<string, ResourceValue | UnreachableResourceValue>>;
}

/** A redacted, side-effect-free resource topology for one profile and runtime owner. */
export interface ResourcePlan {
  profile: string;
  /** Opaque digest of the runtime owner that isolates namespaces. */
  ownerToken: string;
  containerHostGateway?: { host: string; field: string };
  resources: Record<string, PlannedResource>;
}

export interface ResourcePlanInput {
  config: DevFnConfig;
  plan: LifecyclePlan;
  /** Opaque lifecycle owner, as passed to the endpoint resolver. */
  ownerId: string;
  /** Leased ports by name; preflight callers pass placeholders and set provisionalPorts. */
  ports: Readonly<Record<string, number>>;
  /**
   * The ports are preflight placeholders, not leases: an exact port is its
   * declared number, and any other port names no loopback listener yet.
   */
  provisionalPorts?: boolean;
  /** Effective Compose networks by selected service, as passed to the endpoint resolver. */
  composeNetworks?: Readonly<Record<string, readonly string[]>>;
  /**
   * Host name containers use to reach host loopback listeners. Defaults to
   * host.docker.internal on macOS and Windows (Docker Desktop) and to none on
   * Linux, where Compose consumers of host listeners fail instead.
   */
  containerHostGateway?: string | null;
  platform?: NodeJS.Platform;
  /** Host environment, read only for secret presence; values are never copied. */
  environment?: Readonly<Record<string, string | undefined>>;
}

function invalid(message: string): never {
  throw new DevFnError("DEVFN_RESOURCE_INVALID", message);
}

/** An own entry of a manifest map: names such as constructor never reach Object.prototype. */
function own<T>(map: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  return map && Object.hasOwn(map, name) ? map[name] : undefined;
}

/** The target a profile selects for a resource, or undefined when it selects none. */
export function selectedResourceTarget(config: DevFnConfig, profile: string, resource: string): { name: string; selectedBy: "profile" | "defaultTarget" } | undefined {
  const selected = own(own(config.profiles, profile)?.resources, resource);
  if (selected !== undefined) return { name: selected, selectedBy: "profile" };
  const fallback = own(config.resources, resource)?.defaultTarget;
  return fallback === undefined ? undefined : { name: fallback, selectedBy: "defaultTarget" };
}

function localProvider(config: DevFnConfig, profile: string, resource: string, consumer?: string): string | undefined {
  const spec = own(config.resources, resource);
  if (!spec || spec.kind === "browser") return undefined;
  const selection = selectedResourceTarget(config, profile, resource);
  if (!selection) {
    invalid(`${consumer ? `${consumer} consumes resource ${resource}, but profile` : "Profile"} ${profile} selects no target for it and it declares no defaultTarget.`);
  }
  const target = own(spec.targets, selection.name)!;
  return "node" in target ? target.node : undefined;
}

/** Lifecycle nodes that provide the local targets a node's consumed resources select. */
export function resourceProviders(config: DevFnConfig, profile: string, node: string): string[] {
  const consumed = own(config.processes, node)?.resources ?? own(config.services, node)?.resources ?? [];
  return consumed.flatMap((resource) => localProvider(config, profile, resource, node) ?? []);
}

/** Lifecycle nodes that provide the local targets a profile selects explicitly. */
export function profileResourceProviders(config: DevFnConfig, profile: string): string[] {
  return Object.keys(own(config.profiles, profile)?.resources ?? {}).flatMap((resource) => localProvider(config, profile, resource) ?? []);
}

interface Endpoint { scheme?: string; host: string; port: string; path: string }

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443", "ws:": "80", "wss:": "443" };

/**
 * A host as the host resolver sees it, whatever the URL scheme: IPv4
 * shorthand, IPv6 and case are normalized by WHATWG host parsing, which
 * non-special schemes (postgres:, redis:) otherwise skip, and a trailing
 * root dot is dropped.
 */
function canonicalHost(host: string): string {
  let canonical = host.toLowerCase();
  try { canonical = new URL(`http://${host}/`).hostname; } catch { /* an opaque host is compared as written */ }
  return canonical.replace(/\.+$/, "");
}

/**
 * How a host reaches this machine's loopback: "address" for loopback and
 * unspecified addresses (127/8, 0/8, [::1], [::] and their IPv4-mapped or
 * -compatible forms) and plain localhost; "name" for *.localhost names, whose
 * listeners (such as the DevFn proxy) may route by that name.
 */
function loopbackHost(host: string): "address" | "name" | undefined {
  const canonical = canonicalHost(host);
  if (canonical === "localhost") return "address";
  if (canonical.endsWith(".localhost")) return "name";
  if (/^(?:127|0)\.\d+\.\d+\.\d+$/.test(canonical)) return "address";
  const ipv6 = /^\[([0-9a-f:.]+)\]$/.exec(canonical)?.[1];
  if (!ipv6) return undefined;
  if (ipv6 === "::1" || ipv6 === "::") return "address";
  const embedded = /^::(?:ffff:(?:0:)?)?([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(ipv6);
  const firstOctet = embedded ? Number.parseInt(embedded[1], 16) >> 8 : -1;
  return firstOctet === 127 || firstOctet === 0 ? "address" : undefined;
}

/** A URL in the form clients and Origin headers use: a scheme's default port is omitted. */
function endpointUrl(endpoint: Endpoint): string {
  const port = DEFAULT_PORTS[`${endpoint.scheme}:`] === endpoint.port ? "" : `:${endpoint.port}`;
  return `${endpoint.scheme}://${endpoint.host}${port}${endpoint.path}`;
}

function endpointValues(prefix: string, endpoint: Endpoint, source: ResourceValueSource, field: string): Record<string, ResourceValue> {
  const value = (text: string): ResourceValue => ({ value: text, source, field });
  const authority = `${endpoint.host}:${endpoint.port}`;
  return {
    [`${prefix}HOST`]: value(endpoint.host),
    [`${prefix}PORT`]: value(endpoint.port),
    [`${prefix}ENDPOINT`]: value(authority),
    ...(endpoint.scheme ? { [`${prefix}URL`]: value(endpointUrl(endpoint)) } : {}),
  };
}

interface NamespaceValues { prefix: string; values: Record<string, string>; database?: string; schema?: string; members: string[] }

function namespaceValues(name: string, spec: ResourceSpec, token: string, prefix: string): NamespaceValues {
  const isolated = spec.namespace?.sharing !== "shared";
  const base = spec.namespace?.base ?? (spec.kind === "database" ? name.replaceAll("-", "_") : name);
  const owned = (separator: string) => isolated ? `${base}${separator}${token}` : base;
  switch (spec.kind) {
    case "database": {
      const namespace = owned("_");
      const schemaLevel = spec.namespace?.level === "schema";
      const database = schemaLevel ? spec.namespace!.database! : namespace;
      return { prefix: namespace, database, ...(schemaLevel ? { schema: namespace } : {}), members: [],
        values: { [`${prefix}NAMESPACE`]: namespace, [`${prefix}DATABASE`]: database, ...(schemaLevel ? { [`${prefix}SCHEMA`]: namespace } : {}) } };
    }
    case "cache":
    case "object-store": {
      const separator = spec.kind === "cache" ? ":" : "/";
      const namespace = `${owned(separator)}${separator}`;
      return { prefix: namespace, members: [], values: { [`${prefix}NAMESPACE`]: owned(separator), [`${prefix}PREFIX`]: namespace } };
    }
    case "broker": {
      // Topics and the consumer group share one namespace: an isolated runtime
      // never joins another runtime's group or reads its topics by accident.
      const namespace = owned(".");
      const topics = Object.fromEntries(spec.topics!.map((topic) => [`${prefix}TOPIC_${resourceToken(topic)}`, `${namespace}.${topic}`]));
      const group = spec.consumerGroup ? `${namespace}.${spec.consumerGroup}` : namespace;
      return { prefix: namespace, members: [...Object.values(topics), `group:${group}`],
        values: { [`${prefix}NAMESPACE`]: namespace, ...topics, [`${prefix}CONSUMER_GROUP`]: group } };
    }
    case "browser": {
      const namespace = owned("_");
      const cookies = Object.fromEntries((spec.cookies ?? []).map((cookie) => [`${prefix}COOKIE_${resourceToken(cookie)}`, `${namespace}_${cookie}`]));
      const storage = Object.fromEntries((spec.storageKeys ?? []).map((key) => [`${prefix}STORAGE_${resourceToken(key)}`, `${namespace}:${key}`]));
      return { prefix: namespace, members: [...Object.values(cookies).map((cookie) => `cookie:${cookie}`), ...Object.values(storage).map((key) => `storage:${key}`)],
        values: { [`${prefix}NAMESPACE`]: namespace, ...cookies, ...storage } };
    }
    default: return { prefix: "", members: [], values: {} };
  }
}

function sharesComposeNetwork(input: ResourcePlanInput, producer: string, consumer: string): boolean {
  const { config, ownerId } = input;
  const project = (name: string) => composeProjectName(config.services![name].projectName ?? "devfn", ownerId);
  if (project(producer) !== project(consumer)) return false;
  const consumerNetworks = input.composeNetworks?.[consumer] ?? [];
  return (input.composeNetworks?.[producer] ?? []).some((network) => consumerNetworks.includes(network));
}

interface TargetContext {
  input: ResourcePlanInput;
  name: string;
  spec: ResourceSpec;
  targetName: string;
  target: ResourceTargetSpec;
  database?: string;
  gateway?: { host: string; field: string };
}

/** The number a port has before reservation, when the manifest fixes it. */
function exactPort(input: ResourcePlanInput, port: string): number | undefined {
  const spec = own(input.config.ports, port);
  return spec?.exact ? spec.preferred : undefined;
}

/** A leased port's number, or undefined while it is a preflight placeholder. */
function knownPort(input: ResourcePlanInput, port: string): number | undefined {
  return input.provisionalPorts ? exactPort(input, port) : input.ports[port];
}

function localEndpoint(context: TargetContext, target: Extract<ResourceTargetSpec, { node: string }>): { host: Endpoint; provider: PlannedResource["provider"] } {
  const { input, name } = context;
  const provider = input.plan.nodes.find((node) => node.name === target.node);
  if (!provider) invalid(`Resource ${name} selects local target ${context.targetName}, but profile ${input.plan.profile} does not start ${target.node}.`);
  const leased = knownPort(input, target.port) ?? input.ports[target.port];
  if (!Number.isInteger(leased) || leased < 1 || leased > 65535) invalid(`Resource ${name} target ${context.targetName} requires a leased ${target.port} port.`);
  const path = context.database !== undefined ? `/${context.database}` : target.path ?? "";
  return { host: { ...(target.scheme ? { scheme: target.scheme } : {}), host: "127.0.0.1", port: String(leased), path },
    provider: { node: target.node, kind: provider.kind, port: target.port } };
}

function remoteEndpoint(context: TargetContext, raw: string): Endpoint {
  const url = new URL(raw);
  const path = context.database !== undefined ? `/${context.database}` : url.pathname === "/" ? "" : url.pathname;
  return { scheme: url.protocol.slice(0, -1), host: url.hostname, port: url.port || DEFAULT_PORTS[url.protocol], path };
}

/** Container-side endpoint of a selected target for one Compose service, or why it is unreachable. */
function containerEndpoint(context: TargetContext, host: Endpoint, service: string): { endpoint: Endpoint; source: ResourceValueSource; field: string } | { unreachable: string } {
  const { input, target, gateway } = context;
  if ("node" in target) {
    const producer = input.config.services?.[target.node];
    if (producer && input.plan.nodes.some((node) => node.name === target.node && node.kind === "service") && sharesComposeNetwork(input, target.node, service)) {
      return { endpoint: { ...host, host: producer.service, port: String(producer.ports![target.port]) }, source: "compose", field: `services.${target.node}.ports.${target.port}` };
    }
  } else {
    const loopback = loopbackHost(host.host);
    if (!loopback) return { endpoint: host, source: "manifest", field: `resources.${context.name}.targets.${context.targetName}.url` };
    // Rewriting a *.localhost name to the gateway would drop the name its
    // listener routes by, so it is never rewritten.
    if (loopback === "name") {
      return { unreachable: `Resource ${context.name} target ${context.targetName} uses loopback name ${host.host}, which Compose service ${service} cannot reach and DevFn cannot rewrite to a container host gateway without changing the name its listener routes by; select a target reachable from containers.` };
    }
  }
  // Host loopback inside a container is the container itself. Only a
  // platform host gateway reaches the host's loopback listeners.
  if (gateway) return { endpoint: { ...host, host: gateway.host }, source: "host-gateway", field: gateway.field };
  return { unreachable: `Resource ${context.name} target ${context.targetName} listens on host loopback, which Compose service ${service} cannot reach on this platform without a container host gateway; provide it from a Compose service on a shared network or select a remote target.` };
}

function defaultGateway(input: ResourcePlanInput): { host: string; field: string } | undefined {
  const platform = input.platform ?? process.platform;
  if (input.containerHostGateway === null) return undefined;
  if (input.containerHostGateway !== undefined) return { host: input.containerHostGateway, field: "option:containerHostGateway" };
  return platform === "darwin" || platform === "win32" ? { host: "host.docker.internal", field: `platform:${platform}` } : undefined;
}

function consumersOf(input: ResourcePlanInput, resource: string): string[] {
  const { config, plan } = input;
  return plan.nodes.filter((node) => (node.kind === "process" ? config.processes?.[node.name]?.resources : config.services?.[node.name]?.resources)?.includes(resource))
    .map((node) => node.name);
}

function plannedSecrets(input: ResourcePlanInput, name: string, context: TargetContext | undefined, consumers: readonly string[]): PlannedResource["secrets"] {
  if (!context) return [];
  const field = `resources.${name}.targets.${context.targetName}.secrets`;
  const secrets = Object.entries(context.target.secrets ?? {}).map(([secret, env]) => ({ name: secret, env, field: `${field}.${secret}`,
    ...(input.environment ? { present: input.environment[env] !== undefined } : {}) }));
  for (const consumer of consumers) {
    const spec = input.config.processes?.[consumer] ?? input.config.services?.[consumer];
    for (const secret of secrets) {
      if (!spec?.envAllowlist?.includes(secret.env) || !spec.secretEnv?.includes(secret.env)) {
        invalid(`${consumer} consumes resource ${name}, whose target ${context.targetName} needs secret ${secret.env}; add it to the consumer's envAllowlist and secretEnv.`);
      }
    }
  }
  return secrets;
}

function composeListener(input: ResourcePlanInput, node: string, port: string | number): string {
  const service = input.config.services![node];
  return `compose:${composeProjectName(service.projectName ?? "devfn", input.ownerId)}:${service.service}:${port}`;
}

/**
 * A canonical name for the listener an endpoint reaches from the host or from
 * one Compose consumer, so every spelling of one listener compares equal:
 * host loopback in any spelling, or the container host gateway, is the
 * loopback port; a Compose service name is the selected service it resolves
 * to on that consumer's networks, so one name in unrelated projects or
 * networks stays distinct; any other host is its canonical DNS name.
 */
function listenerOf(context: TargetContext, endpoint: Endpoint, consumer?: string): string {
  const { input, gateway } = context;
  const host = canonicalHost(endpoint.host);
  if (consumer === undefined ? loopbackHost(host) : gateway && host === canonicalHost(gateway.host)) return `loopback:${endpoint.port}`;
  const sibling = consumer === undefined ? undefined : input.plan.nodes.find((node) => node.kind === "service" &&
    canonicalHost(input.config.services![node.name].service) === host && sharesComposeNetwork(input, node.name, consumer));
  return sibling ? composeListener(input, sibling.name, endpoint.port) : `dns:${host}:${endpoint.port}`;
}

/**
 * The listeners a selected target reaches, from the endpoints its consumers
 * resolve rather than from how the target is written. A local provider is its
 * port, its leased loopback port and, for a Compose provider, its service
 * listener, which is also what any consumer reaches it through. A remote
 * target is what its host-side consumers and each Compose consumer resolve.
 */
function targetListeners(context: TargetContext, host: Endpoint, containers: ReadonlyMap<string, ReturnType<typeof containerEndpoint>>, consumers: readonly string[]): string[] {
  const { input, target } = context;
  if ("node" in target) {
    // Before reservation only a manifest-fixed port names a loopback listener.
    const listeners = [`port:${target.port}`, ...(knownPort(input, target.port) !== undefined ? [`loopback:${host.port}`] : [])];
    const provider = input.plan.nodes.find((node) => node.name === target.node);
    return provider?.kind === "service" ? [...listeners, composeListener(input, target.node, input.config.services![target.node].ports![target.port])] : listeners;
  }
  const containerConsumers = consumers.filter((consumer) => containers.has(consumer));
  // Host-side values also reach readiness and environment outputs.
  const hostSide = containerConsumers.length < consumers.length || consumers.length === 0;
  return [...(hostSide ? [listenerOf(context, host)] : []), ...containerConsumers.flatMap((consumer) => {
    const located = containers.get(consumer)!;
    return "unreachable" in located ? [] : [listenerOf(context, located.endpoint, consumer)];
  })];
}

function planTarget(context: TargetContext, prefix: string, consumers: readonly string[]): Pick<PlannedResource, "target" | "provider" | "remote" | "values" | "services"> & { listeners: string[] } {
  const { input, name, targetName, target } = context;
  const selection = selectedResourceTarget(input.config, input.plan.profile, name)!;
  const targetField = `resources.${name}.targets.${targetName}`;
  const local = "node" in target ? localEndpoint(context, target) : undefined;
  const host = local?.host ?? remoteEndpoint(context, (target as { url: string }).url);
  const values = endpointValues(prefix, host, local ? "lease" : "manifest", local ? `ports.${(target as { port: string }).port}` : `${targetField}.url`);
  if (local) {
    values[`${prefix}HOST_ENDPOINT`] = { value: `127.0.0.1:${host.port}`, source: "lease", field: `ports.${local.provider!.port}` };
    const producer = input.config.services?.[local.provider!.node];
    if (producer && local.provider!.kind === "service") {
      values[`${prefix}INTERNAL_ENDPOINT`] = { value: `${producer.service}:${producer.ports![local.provider!.port]}`, source: "compose", field: `services.${local.provider!.node}.ports.${local.provider!.port}` };
    }
  }
  const services: PlannedResource["services"] = {};
  const containers = new Map<string, ReturnType<typeof containerEndpoint>>();
  for (const node of input.plan.nodes) {
    if (node.kind !== "service") continue;
    const located = containerEndpoint(context, host, node.name);
    containers.set(node.name, located);
    if ("unreachable" in located) {
      if (consumers.includes(node.name)) invalid(located.unreachable);
      services[node.name] = Object.fromEntries(["HOST", "PORT", "ENDPOINT", ...(host.scheme ? ["URL"] : [])].map((suffix) => [`${prefix}${suffix}`, located]));
    } else services[node.name] = endpointValues(prefix, located.endpoint, located.source, located.field);
  }
  return {
    target: { name: targetName, location: local ? "local" : "remote", selectedBy: selection.selectedBy,
      field: selection.selectedBy === "profile" ? `profiles.${input.plan.profile}.resources.${name}` : `resources.${name}.defaultTarget` },
    ...(local ? { provider: local.provider } : { remote: { url: endpointUrl(host) } }),
    values, services, listeners: targetListeners(context, host, containers, consumers),
  };
}

function namespacesOverlap(kind: ResourceKind, left: NamespaceValues, right: NamespaceValues): boolean {
  if (kind === "database") return left.database === right.database && (left.schema === undefined || right.schema === undefined || left.schema === right.schema);
  if (kind === "broker" || kind === "browser") return left.members.some((member) => right.members.includes(member));
  return left.prefix.startsWith(right.prefix) || right.prefix.startsWith(left.prefix);
}

/**
 * Two selected resources must not mix data in one namespace of the same
 * listener. Before reservation, a collision that depends on a port DevFn has
 * not leased yet is unknown; the locked pass detects it and releases the lease.
 */
function rejectNamespaceCollisions(planned: Record<string, PlannedResource>, namespaces: ReadonlyMap<string, NamespaceValues>, listeners: ReadonlyMap<string, readonly string[]>): void {
  const names = Object.keys(planned).filter((name) => namespaces.has(name));
  for (const [index, left] of names.entries()) {
    for (const right of names.slice(index + 1)) {
      if (planned[left].kind !== planned[right].kind || !listeners.get(left)!.some((listener) => listeners.get(right)!.includes(listener))) continue;
      if (namespacesOverlap(planned[left].kind, namespaces.get(left)!, namespaces.get(right)!)) {
        invalid(`Resources ${left} and ${right} share namespace ${namespaces.get(left)!.prefix} on the same ${planned[left].kind} target; declare distinct namespace bases.`);
      }
    }
  }
}

function selectedResourceNames(input: ResourcePlanInput): string[] {
  const { config, plan } = input;
  const consumed = plan.nodes.flatMap((node) => (node.kind === "process" ? config.processes?.[node.name]?.resources : config.services?.[node.name]?.resources) ?? []);
  return [...new Set([...Object.keys(own(config.profiles, plan.profile)?.resources ?? {}), ...consumed])].sort();
}

/**
 * Select each resource target the profile uses, derive its namespaces and
 * endpoint values with provenance, and validate the topology. Pure: no lease,
 * file, process or service is touched, and no secret value is read.
 */
export function planResources(input: ResourcePlanInput): ResourcePlan {
  const config = validateDevFnConfig(input.config);
  if (!input.ownerId || input.ownerId.includes("\0")) invalid("ownerId must be a non-empty opaque value without NUL.");
  const context = { ...input, config };
  const ownerToken = `o${createHash("sha256").update(input.ownerId).digest("hex").slice(0, 12)}`;
  const gateway = defaultGateway(input);
  const resources: Record<string, PlannedResource> = Object.create(null);
  const namespaces = new Map<string, NamespaceValues>();
  const listeners = new Map<string, string[]>();
  for (const name of selectedResourceNames(context)) {
    const spec = own(config.resources, name)!;
    const prefix = `DEVFN_RESOURCE_${resourceToken(name)}_`;
    const consumers = consumersOf(context, name);
    const namespace = namespaceValues(name, spec, ownerToken, prefix);
    const namespaceField = spec.namespace ? `resources.${name}.namespace` : `resources.${name}`;
    const selection = spec.kind === "browser" ? undefined : selectedResourceTarget(config, input.plan.profile, name);
    if (spec.kind !== "browser" && !selection) invalid(`Profile ${input.plan.profile} selects no target for resource ${name} and it declares no defaultTarget.`);
    const targetContext: TargetContext | undefined = selection ? { input: context, name, spec, targetName: selection.name, target: own(spec.targets, selection.name)!,
      ...(namespace.database !== undefined ? { database: namespace.database } : {}), ...(gateway ? { gateway } : {}) } : undefined;
    const { listeners: reached, ...target } = targetContext ? planTarget(targetContext, prefix, consumers) :
      // Every browser resource names state in the same local browser profile.
      { values: {}, services: {}, listeners: ["browser"] };
    listeners.set(name, reached);
    for (const [key, value] of Object.entries(namespace.values)) {
      target.values[key] = { value, source: "namespace", field: key === `${prefix}DATABASE` && spec.namespace?.level === "schema" ? `${namespaceField}.database` : namespaceField };
    }
    const emitted = new Set(resourceEnvironmentKeys(name, spec));
    for (const key of Object.keys(target.values)) if (!emitted.has(key)) invalid(`Resource ${name} produced undeclared key ${key}.`);
    resources[name] = {
      kind: spec.kind,
      ...target,
      consumers,
      ...(spec.kind === "service" ? {} : { namespace: { sharing: spec.namespace?.sharing ?? "isolated", prefix: namespace.prefix, field: namespaceField } }),
      secrets: plannedSecrets(context, name, targetContext, consumers),
    };
    if (spec.kind !== "service") namespaces.set(name, namespace);
  }
  rejectNamespaceCollisions(resources, namespaces, listeners);
  return { profile: input.plan.profile, ownerToken, ...(gateway ? { containerHostGateway: gateway } : {}), resources };
}

/**
 * A credential-free digest of the selected targets, namespaces and values a
 * lifecycle was started with. Secret presence is excluded; secret values are
 * never part of a plan.
 */
export function resourcePlanFingerprint(plan: ResourcePlan | undefined): string | undefined {
  if (!plan) return undefined;
  return createHash("sha256").update(JSON.stringify(plan, (key, value: unknown) => key === "present" ? undefined : value)).digest("hex");
}

/** Host-side generated values of a plan, for the endpoint resolver. */
export function resourceEnvironment(plan: ResourcePlan | undefined): Record<string, string> {
  const environment: Record<string, string> = Object.create(null);
  for (const resource of Object.values(plan?.resources ?? {})) {
    for (const [key, value] of Object.entries(resource.values)) environment[key] = value.value;
  }
  return environment;
}

/** Container-side values of a plan for one Compose service, or the reason a key is unreachable there. */
export function resourceServiceEnvironment(plan: ResourcePlan | undefined, service: string): Map<string, { value: string } | { unreachable: string }> {
  const environment = new Map<string, { value: string } | { unreachable: string }>();
  for (const resource of Object.values(plan?.resources ?? {})) {
    for (const [key, value] of Object.entries(resource.services[service] ?? {})) environment.set(key, "unreachable" in value ? value : { value: value.value });
  }
  return environment;
}

/** Whether a selected Compose service's resource values depend on its effective networks. */
export function resourcesNeedComposeNetworks(config: DevFnConfig, plan: LifecyclePlan): boolean {
  if (!config.resources) return false;
  return JSON.stringify(config).includes("{{env.DEVFN_RESOURCE_") ||
    plan.nodes.some((node) => node.kind === "service" && (config.services?.[node.name]?.resources?.length ?? 0) > 0);
}
