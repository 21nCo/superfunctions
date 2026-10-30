import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ComposeController, composeProjectName, createComposeEnvironment, createComposeReadinessEnvironment, effectiveComposeServiceNetworks, fingerprintComposeSource, selectedComposeEndpointReferences, type ComposeServiceDnsNames, type ManagedComposeService } from "@devfn/compose";
import { defaultStateDir, isCredentialKey, loadDevFnPolicy, validateDevFnConfig, type DevFnConfig, type HealthCheck } from "@devfn/config";
import { FilePortRegistry, inspectContainerRunning, isPortAvailable, resolvePolicy, scanListenerState, withFileLock, withRoutingLock, type ListenerInfo, type ListenerScanResult, type PortAllocation, type RegistryInvocation } from "@devfn/ports";
import { checkReadinessNow, createProcessEnvironment, resolveAdapterCommand, ProcessSupervisor, processExists, type ManagedProcess } from "@devfn/processes";
import { CaddyProxyController, PUBLIC_ORIGIN_PORT, proxyListenerPorts, readRegisteredDomains, renderCaddyfile, verifyCertificate, verifyLocalDns, type ProxyRoute, type ProxyRouteSnapshot } from "@devfn/proxy";
import { OAUTH_RELAY_OWNER_ID, recoverOAuthRelayRoute, relayPaths, STATE_DIR_ENV } from "@devfn/proxy/oauth-relay";
import { compareNames, tunnelOwners } from "@devfn/proxy/tunnel";

import { domainAliases, resolveInstanceIdentity } from "./identity.js";
import { resolveEndpointTemplates, resolveLocalHostname, type EndpointResolution, type EndpointResolutionInput } from "./endpoints.js";
import { createPlan } from "./planner.js";
import { planResources, resourcePlanFingerprint, resourcesNeedComposeNetworks } from "./resources.js";
import { livePublicUrls, profileTunnel, publicTemplateInputs, publishLifecycleTunnel, selectedPublicRoutes, selectionTemplateInputs, withdrawLifecycleTunnel, type PublicSelection, type TunnelOverrides } from "./tunnel.js";
import { newRuntimeId, readReceipt, readRuntimeId, recordRuntimeId, secureRuntimeDirectory, writeEnvironmentOutputs, writeReceipt } from "./runtime.js";
import { preflightTasks, runTask, taskInputRevision, type TaskReceipt } from "./tasks.js";
import { DevFnError, type CleanupResult, type InstanceIdentity, type RoutingIdentity, type LifecyclePlan, type LifecycleReceipt, type UpOptions } from "./types.js";

const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

async function isProcessTreeMember(pid: number, ownerPid: number): Promise<boolean> {
  if (pid === ownerPid) return true;
  try {
    if (process.platform === "win32") {
      const script = `$current=${pid}; while ($current -gt 0) { if ($current -eq ${ownerPid}) { exit 0 }; $entry=Get-CimInstance Win32_Process -Filter \"ProcessId = $current\"; if (-not $entry) { break }; $current=$entry.ParentProcessId }; exit 1`;
      await execFileAsync("powershell", ["-NoProfile", "-Command", script], { timeout: 5000 });
      return true;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)], { timeout: 5000 });
    return Number(stdout.trim()) === ownerPid;
  } catch { return false; }
}

function assertReceiptStateDir(receipt: LifecycleReceipt, stateDir: string): void {
  if (receipt.stateDir && path.resolve(receipt.stateDir) !== path.resolve(stateDir)) {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `This invocation was started with state directory ${receipt.stateDir}; rerun cleanup with that same --state-dir.`);
  }
}

// The one lifecycle environment a process sees: generated endpoint values plus the
// lifecycle's state directory, so in-process DevFn clients read the same machine
// state as this command. Start, readiness and status all build it here.
function lifecycleGeneratedEnvironment(receipt: Pick<LifecycleReceipt, "stateDir">, generated: Readonly<Record<string, string>>): Record<string, string> {
  return { ...generated, ...(receipt.stateDir ? { [STATE_DIR_ENV]: receipt.stateDir } : {}) };
}

function resolvedHealth(health: HealthCheck | undefined, command: string[] | undefined, url?: string): HealthCheck | undefined {
  if (health?.type === "command" && command) return { ...health, command };
  if (health?.type === "http" && url) return { type: "http", url, ...(health.expectedStatus ? { expectedStatus: health.expectedStatus } : {}), ...(health.timeoutMs ? { timeoutMs: health.timeoutMs } : {}) };
  return health;
}

function provisionalComposeNetworks(config: DevFnConfig, plan: LifecyclePlan, ownerId: string): Record<string, string[]> {
  return Object.fromEntries(plan.nodes.filter((node) => node.kind === "service").map((node) =>
    [node.name, [`${composeProjectName(config.services![node.name].projectName ?? "devfn", ownerId)}_default`]]));
}

/** Which inputs of an endpoint pass are preflight placeholders rather than leases or effective networks. */
interface ProvisionalInputs { ports?: boolean; networks?: boolean }

/**
 * Resource targets and namespaces are selected first, from the same ports and
 * Compose networks, then handed to the endpoint resolver, whose templates and
 * precedence stay unchanged. Manifests without resources resolve as before.
 * With placeholder ports only manifest-fixed exact ports identify loopback
 * listeners; with provisional networks Compose service-name listeners are
 * unknown, and their collisions wait for a pass with effective networks.
 */
function resolveEndpoints({ composeNames, ...input }: Omit<EndpointResolutionInput, "resources"> & { composeNames?: Record<string, ComposeServiceDnsNames> },
  provisional: ProvisionalInputs = {}): EndpointResolution {
  if (!input.config.resources) return resolveEndpointTemplates(input);
  const runtimeId = input.routingIdentity?.runtimeId;
  // Only resource planning reads the other Docker DNS names; the endpoint resolver's network input is unchanged.
  const resources = planResources({ config: input.config, plan: input.plan, ownerId: input.ownerId, ports: input.ports, ...(runtimeId ? { runtimeId } : {}),
    provisionalPorts: provisional.ports === true, provisionalNetworks: provisional.networks === true,
    ...(input.composeNetworks ? { composeNetworks: input.composeNetworks } : {}), ...(composeNames ? { composeNames } : {}), environment: process.env });
  return resolveEndpointTemplates({ ...input, resources });
}

/** Public tunnel URL inputs of the endpoint resolver (publicTemplateInputs). */
type PublicTemplate = Awaited<ReturnType<typeof publicTemplateInputs>>;

/**
 * The Compose interpolation references of each selected service, read from
 * its Compose source without Docker; post-start public URL references among
 * them fail here, before anything else is read or started.
 */
async function composeTemplateReferences(config: DevFnConfig, plan: LifecyclePlan, root: string, identity: RoutingIdentity, ports: Record<string, number>, hostnameSuffix: string | undefined,
  publicTemplate: PublicTemplate, composeNetworks: Record<string, string[]>, provisional: ReturnType<typeof resolveEndpointTemplates>, deadline: number, provisionalPorts: boolean): Promise<Set<string>> {
  const all = new Set<string>();
  // Public and resource references are checked against permissive provisional
  // networks: whatever fails here fails on the effective networks too.
  const checkedReferences: Record<string, Set<string>> = {};
  for (const node of plan.nodes) {
    if (node.kind !== "service") continue;
    const spec = config.services![node.name];
    const selected = provisional.nodes[node.name].environment;
    const environment = createComposeEnvironment({ ...spec, env: selected }, selected);
    const references = await selectedComposeEndpointReferences({ ...spec, env: selected }, root, environment, deadline);
    checkedReferences[node.name] = new Set([...references].filter((name) => name.startsWith("DEVFN_PUBLIC_URL_") || name.startsWith("DEVFN_RESOURCE_")));
    for (const name of references) all.add(name);
  }
  resolveEndpoints({ config, plan, ownerId: identity.instanceId, ports, hostnameSuffix, routingIdentity: identity,
    composeNetworks, composeReferences: checkedReferences, ...publicTemplate }, { ports: provisionalPorts, networks: true });
  return all;
}

async function needsNetworkPreflight(config: DevFnConfig, plan: LifecyclePlan, root: string, identity: RoutingIdentity,
  ports: Record<string, number>, hostnameSuffix: string | undefined, publicTemplate: PublicTemplate): Promise<boolean> {
  // A selected sibling URL reference must fail before creating lifecycle state.
  // Without one, pure template validation is enough here; the locked pass
  // below still reads effective Compose networks before startup or publication.
  // Compose interpolation of a post-start public URL is rejected first, without Docker.
  const siblingTemplates = JSON.stringify(config).includes("{{env.DEVFN_URL_") || resourcesNeedComposeNetworks(config, plan);
  if (siblingTemplates && !publicTemplate.postStartPublicRoutes?.length) return true;
  const composeNetworks = provisionalComposeNetworks(config, plan, identity.instanceId);
  const provisional = resolveEndpoints({ config, plan, ownerId: identity.instanceId, ports, hostnameSuffix, routingIdentity: identity,
    composeNetworks, ...publicTemplate }, { ports: true, networks: true });
  const references = await composeTemplateReferences(config, plan, root, identity, ports, hostnameSuffix, publicTemplate, composeNetworks, provisional, Date.now() + 20_000, true);
  return siblingTemplates || [...references].some((name) => name.startsWith("DEVFN_URL_") || name.startsWith("DEVFN_RESOURCE_"));
}

/**
 * Every caller passes the profile's public template inputs: without them a
 * deterministic DEVFN_PUBLIC_URL_<ROUTE> reference is missing and a post-start
 * one is not rejected.
 */
async function resolveWithComposeNetworks(config: DevFnConfig, plan: LifecyclePlan, root: string, identity: RoutingIdentity, ports: Record<string, number>, hostnameSuffix: string | undefined,
  publicTemplate: PublicTemplate, provisionalPorts = false): Promise<ReturnType<typeof resolveEndpointTemplates>> {
  // Validate literals before calling Docker. Provisional defaults are used only
  // for that read-only validation; the result is never published or started.
  const ownerId = identity.instanceId;
  const provisionalNetworks = provisionalComposeNetworks(config, plan, ownerId);
  const provisional = resolveEndpoints({ config, plan, ownerId, ports, hostnameSuffix, routingIdentity: identity, composeNetworks: provisionalNetworks, ...publicTemplate },
    { ports: provisionalPorts, networks: true });
  const deadline = Date.now() + 20_000;
  if (publicTemplate.postStartPublicRoutes?.length) await composeTemplateReferences(config, plan, root, identity, ports, hostnameSuffix, publicTemplate, provisionalNetworks, provisional, deadline, provisionalPorts);
  const composeNetworks: Record<string, string[]> = {};
  // Keyed by manifest service names, which may spell __proto__.
  const composeNames: Record<string, ComposeServiceDnsNames> = Object.create(null);
  const composeReferences: Record<string, Set<string>> = {};
  for (const node of plan.nodes) {
    if (node.kind !== "service") continue;
    const spec = config.services![node.name];
    const environment = createComposeEnvironment({ ...spec, env: provisional.nodes[node.name].environment }, provisional.nodes[node.name].environment);
    const references = new Set<string>();
    composeNames[node.name] = { networks: {}, overrides: [] };
    composeNetworks[node.name] = await effectiveComposeServiceNetworks({ ...spec, env: provisional.nodes[node.name].environment }, root, ownerId, environment, deadline,
      references, composeNames[node.name]);
    composeReferences[node.name] = references;
  }
  return resolveEndpoints({ config, plan, ownerId, ports, hostnameSuffix, routingIdentity: identity, composeNetworks, composeNames, composeReferences, ...publicTemplate },
    { ports: provisionalPorts });
}

function compareCodepoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function startupFingerprints(config: DevFnConfig, root: string, resolved: ReturnType<typeof resolveEndpointTemplates>): Promise<Record<string, string>> {
  const fingerprints: Record<string, string> = {};
  const deadline = Date.now() + 20_000;
  // Resource values may sit under credential-like names that the environment
  // fingerprint masks; the redacted plan still records every selected value.
  // Without resources it is undefined and earlier fingerprints are unchanged.
  const resources = resourcePlanFingerprint(resolved.resources);
  for (const [name, node] of Object.entries(resolved.nodes)) {
    const processSpec = config.processes?.[name];
    const serviceSpec = config.services?.[name];
    const secretNames = new Set([...(processSpec?.secretEnv ?? []), ...(serviceSpec?.secretEnv ?? [])]);
    const declaredEnvironment = Object.entries(node.environment).sort(([a], [b]) => compareCodepoint(a, b))
      .map(([key, value]) => [key, secretNames.has(key) || isCredentialKey(key) ? "<secret-channel>" : value]);
    let startup: unknown;
    if (processSpec) {
      const spec = { ...processSpec, env: node.environment, command: node.command, script: node.script };
      startup = {
        kind: "process", command: resolveAdapterCommand(spec), cwd: processSpec.cwd ?? ".",
        exposure: processSpec.exposure ?? "local", ports: processSpec.ports ?? [],
        environment: declaredEnvironment,
        inheritedEnvironment: Object.entries(createProcessEnvironment(spec))
          .filter(([key]) => processSpec.envAllowlist?.includes(key) && !Object.hasOwn(node.environment, key))
          .sort(([a], [b]) => compareCodepoint(a, b))
          .map(([key, value]) => [key, secretNames.has(key) || isCredentialKey(key) ? "<secret-channel>" : value]),
        envAllowlist: [...(processSpec.envAllowlist ?? [])].sort(compareCodepoint), secretEnv: [...(processSpec.secretEnv ?? [])].sort(compareCodepoint),
        resources,
      };
    } else if (serviceSpec) {
      const spec = { ...serviceSpec, env: node.environment };
      const environment = createComposeEnvironment(spec, node.environment);
      startup = {
        kind: "service", file: serviceSpec.file ?? "compose.yaml", service: serviceSpec.service,
        projectName: serviceSpec.projectName ?? "devfn", ports: serviceSpec.ports ?? {},
        environment: declaredEnvironment,
        envAllowlist: [...(serviceSpec.envAllowlist ?? [])].sort(compareCodepoint), secretEnv: [...(serviceSpec.secretEnv ?? [])].sort(compareCodepoint),
        source: await fingerprintComposeSource(spec, root, resolved.ownerId, environment, deadline),
        resources,
      };
    } else continue;
    fingerprints[name] = createHash("sha256").update(JSON.stringify(startup)).digest("hex");
  }
  return fingerprints;
}

function portSpecFingerprints(config: DevFnConfig, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => {
    const spec = config.ports?.[name] ?? {};
    const canonical = { ...spec, protocol: spec.protocol ?? "tcp", exposure: spec.exposure ?? "loopback" };
    if (!canonical.exact) delete canonical.exact;
    if (!canonical.ephemeral) delete canonical.ephemeral;
    return [name, createHash("sha256")
      .update(JSON.stringify(Object.entries(canonical).sort(([a], [b]) => compareCodepoint(a, b))))
      .digest("hex")];
  }));
}

function isDockerProxyListener(processName?: string): boolean {
  return Boolean(processName && /^(?:docker-proxy|com\.docker|vpnkit)/i.test(processName));
}

export function selectOwnershipListeners(allocation: PortAllocation | undefined, matches: ListenerInfo[]): ListenerInfo[] {
  const ownedDocker = allocation?.container !== undefined && matches.some((listener) => listener.source === "docker" && listener.containerId !== undefined && (allocation.container!.id.startsWith(listener.containerId) || listener.containerId.startsWith(allocation.container!.id)));
  return ownedDocker ? matches.filter((listener) => listener.source === "docker" || !isDockerProxyListener(listener.process)) : matches;
}

export function hasRecordedProcessOwner(allocations: readonly PortAllocation[], projectId: string, instanceId: string, localProcessPorts: ReadonlyMap<string, "tcp" | "udp">, protocol: "tcp" | "udp"): boolean {
  return allocations.some((allocation) => allocation.projectId === projectId && allocation.instanceId === instanceId && allocation.state === "active" && allocation.process !== undefined && allocation.protocol === protocol && localProcessPorts.get(allocation.service) === protocol);
}

export function resolveAllocationUrls(allocations: readonly PortAllocation[], routes: readonly ProxyRoute[], httpPorts: ReadonlySet<string>, directUrls: Readonly<Record<string, string>> = {}): Record<string, string> {
  const urls: Record<string, string> = {};
  const listenerPorts = proxyListenerPorts();
  for (const allocation of allocations) {
    // A service can have several aliases and paths. Prefer a root URL, then
    // choose by stable route ID instead of the persisted route order.
    // Public tunnel origin routes are reached only through their public URLs.
    const route = allocation.protocol === "tcp" ? routes.filter((item) => item.targetPort === allocation.port && item.exposure !== "public")
      .sort((a, b) => {
        const rootA = (a.path ?? "/") === "/" ? 0 : 1;
        const rootB = (b.path ?? "/") === "/" ? 0 : 1;
        return rootA - rootB || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      })[0] : undefined;
    if (route) {
      const port = route.tls === "off" ? listenerPorts.httpPort : listenerPorts.httpsPort;
      urls[allocation.service] = `${route.tls === "off" ? "http" : "https"}://${route.hostname}${port === (route.tls === "off" ? 80 : 443) ? "" : `:${port}`}${route.path && route.path !== "/" ? route.path : ""}`;
    }
    else if (allocation.protocol === "tcp" && httpPorts.has(allocation.service)) urls[allocation.service] = directUrls[allocation.service] ?? `http://127.0.0.1:${allocation.port}`;
  }
  return urls;
}

async function selectedProxyRoutes(config: DevFnConfig, plan: LifecyclePlan, identity: RoutingIdentity, ports: Readonly<Record<string, number>>, suffix: string, stateDir: string, verifyActivation = true): Promise<Array<Omit<ProxyRoute, "updatedAt">>> {
  if (!plan.proxy) return [];
  const registrations = Object.values(config.hostnames ?? {}).some((spec) => spec.domain && (!spec.profiles || spec.profiles.includes(plan.profile)))
    ? await readRegisteredDomains(stateDir) : [];
  const routes: Array<Omit<ProxyRoute, "updatedAt">> = [];
  for (const [name, spec] of Object.entries(config.hostnames ?? {}).filter(([, value]) => !value.profiles || value.profiles.includes(plan.profile))) {
    if (!plan.portNames.includes(spec.target) || !Number.isInteger(ports[spec.target])) throw new DevFnError("DEVFN_RUNTIME_INVALID", `Selected route ${name} has no selected target port.`);
    const common = { instanceId: identity.instanceId, targetHost: "127.0.0.1", targetPort: ports[spec.target],
      ...(spec.path ? { path: spec.path } : {}), ...(spec.match ? { match: spec.match } : {}), ...(spec.stripPrefix ? { stripPrefix: true } : {}) };
    if (!spec.domain) {
      routes.push({ ...common, id: `${identity.instanceId}:${name}`, hostname: resolveLocalHostname(spec.hostname, name, config.project.id, identity.instanceId, suffix), tls: spec.tls ?? "off" });
      continue;
    }
    const registration = registrations.find((item) => item.domain === spec.domain && item.projectId === config.project.id && item.repositoryIdentity === identity.repositoryIdentity);
    if (!registration) throw new DevFnError("DEVFN_RUNTIME_INVALID", `Domain ${spec.domain} is not registered to this repository and project.`);
    let aliases: string[];
    try { aliases = domainAliases(spec.host ?? name, spec.domain, identity); }
    catch (error) { throw new DevFnError("DEVFN_RUNTIME_INVALID", `Route ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    for (const [index, hostname] of aliases.entries()) {
      if (verifyActivation) {
        await verifyLocalDns(hostname);
        if (registration.tls === "certificate") await verifyCertificate(hostname, registration.certificateFile, registration.keyFile);
      }
      routes.push({ ...common, id: `${identity.instanceId}:${name}:${index}`, hostname, tls: registration.tls,
        registeredDomain: registration.domain, projectId: registration.projectId, repositoryIdentity: registration.repositoryIdentity,
        ...(registration.certificateFile ? { certificateFile: registration.certificateFile, keyFile: registration.keyFile } : {}) });
    }
  }
  // Public origin routes are validated against their tunnel binding, never by local loopback DNS.
  routes.push(...(await selectedPublicRoutes(config, plan, identity, ports, stateDir))?.routes ?? []);
  renderCaddyfile(routes.map((route) => ({ ...route, updatedAt: "preflight" })));
  return routes;
}

function receiptRoutesMatch(receipt: LifecycleReceipt, expected: readonly Omit<ProxyRoute, "updatedAt">[]): boolean {
  if (receipt.routes.length !== expected.length) return false;
  const actual = new Map(receipt.routes.map((route) => [route.id, route]));
  if (actual.size !== expected.length) return false;
  return expected.every((route) => {
    const saved = actual.get(route.id);
    if (!saved) return false;
    const current = saved as unknown as Record<string, unknown>;
    const planned = route as unknown as Record<string, unknown>;
    if (current.certificateDigest !== undefined &&
      (route.tls !== "certificate" || typeof current.certificateDigest !== "string" || !/^[a-f0-9]{64}$/.test(current.certificateDigest))) return false;
    return new Set([...Object.keys(current).filter((key) => key !== "updatedAt" && key !== "certificateDigest"), ...Object.keys(planned)]).size === Object.keys(planned).length &&
      Object.entries(planned).every(([key, value]) => current[key] === value);
  });
}

function selectedHttpPorts(config: DevFnConfig, plan: LifecyclePlan): Set<string> {
  const ports = new Set<string>();
  for (const node of plan.nodes) {
    const health = node.kind === "process" ? config.processes?.[node.name]?.health : config.services?.[node.name]?.health;
    if (health?.type === "http" && health.port) ports.add(health.port);
  }
  return ports;
}

function startupOwners(config: DevFnConfig, receipt: LifecycleReceipt): Record<string, { process?: PortAllocation["process"]; container?: PortAllocation["container"] }> {
  const owners: Record<string, { process?: PortAllocation["process"]; container?: PortAllocation["container"] }> = {};
  for (const process of receipt.processes) {
    for (const name of config.processes?.[process.name]?.ports ?? []) {
      owners[name] = { process: { pid: process.pid, ...(process.birthSignature ? { birthSignature: process.birthSignature } : {}) } };
    }
  }
  for (const service of receipt.services) {
    for (const name of Object.keys(config.services?.[service.name]?.ports ?? {})) {
      owners[name] = { container: { id: service.containerIds[0], name: service.composeService,
        ...(service.dockerEnvironment !== undefined ? { dockerEnvironment: service.dockerEnvironment } : {}) } };
    }
  }
  return owners;
}

export async function verifyOwnedLoopbackListeners(processName: string, expected: Array<{ port: number; protocol: "tcp" | "udp" }>, ownerPid: number, scan: ListenerScanResult): Promise<{ port: number; protocol: "tcp" | "udp" } | undefined> {
  const requiredProtocols = new Set<"tcp" | "udp">(expected.length ? expected.map((item) => item.protocol) : ["tcp", "udp"]);
  for (const protocol of requiredProtocols) {
    if (!scan.inspection[protocol]) throw new DevFnError("DEVFN_RUNTIME_INVALID", `Process ${processName} ${protocol.toUpperCase()} listeners could not be inspected for loopback ownership.`);
  }
  const candidates = scan.listeners.filter((listener) => listener.source === "os" && listener.pid !== undefined && (expected.length === 0 || expected.some((item) => item.port === listener.port && item.protocol === listener.protocol)));
  const ownership = await Promise.all(candidates.map(async (listener) => await isProcessTreeMember(listener.pid!, ownerPid)));
  const owned = candidates.filter((_listener, index) => ownership[index]);
  const unsafe = owned.find((listener) => !isLoopbackHost(listener.host));
  if (unsafe) throw new DevFnError("DEVFN_RUNTIME_INVALID", `Process ${processName} exposed port ${unsafe.port} beyond loopback.`);
  return expected.find((item) => !owned.some((listener) => listener.port === item.port && listener.protocol === item.protocol));
}

async function waitForOwnedLoopbackListeners(processName: string, expected: Array<{ port: number; protocol: "tcp" | "udp" }>, ownerPid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let missing: { port: number; protocol: "tcp" | "udp" } | undefined;
  do {
    if (!processExists(ownerPid)) throw new DevFnError("DEVFN_RUNTIME_INVALID", `Process ${processName} exited before listener ownership could be verified.`);
    const scan = await scanListenerState(false);
    missing = await verifyOwnedLoopbackListeners(processName, expected, ownerPid, scan);
    if (!missing) return;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new DevFnError("DEVFN_RUNTIME_INVALID", `Process ${processName} ${missing!.protocol.toUpperCase()} port ${missing!.port} has no verified loopback listener owned by its process tree after ${timeoutMs} ms.`);
}

const sameUrls = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>> | undefined): boolean =>
  Object.keys(a).length === Object.keys(b ?? {}).length && Object.entries(a).every(([name, url]) => b?.[name] === url);

/** Whether a receipt's lifecycle still serves what it recorded; live receives its current public URLs. */
async function receiptIsReady(config: DevFnConfig, root: string, receipt: LifecycleReceipt, processStates: readonly string[], serviceStates: readonly string[],
  live: { publicUrls?: Record<string, string> } = {}): Promise<boolean> {
  const ports = Object.fromEntries(receipt.allocations.map((allocation) => [allocation.service, allocation.port]));
  let resolved: ReturnType<typeof resolveEndpointTemplates>;
  try {
    const plan = createPlan(config, receipt.profile);
    if (plan.portNames.length !== receipt.allocations.length || plan.portNames.some((name) => ports[name] === undefined ||
      (config.ports?.[name]?.exact === true && config.ports[name].preferred !== ports[name])) ||
      plan.nodes.filter((node) => !node.task).length !== receipt.processes.length + receipt.services.length ||
      plan.nodes.some((node) => !node.task && !(node.kind === "process" ? receipt.processes : receipt.services).some((managed) => managed.name === node.name))) return false;
    if (receipt.portSpecFingerprints) {
      const currentPorts = portSpecFingerprints(config, plan.portNames);
      if (Object.keys(currentPorts).length !== Object.keys(receipt.portSpecFingerprints).length ||
        Object.entries(currentPorts).some(([name, fingerprint]) => receipt.portSpecFingerprints?.[name] !== fingerprint)) return false;
    }
    if (receipt.allocations.some((allocation) => allocation.protocol !== (config.ports?.[allocation.service]?.protocol ?? "tcp") ||
      allocation.host !== (config.ports?.[allocation.service]?.exposure === "public" ? "0.0.0.0" : "127.0.0.1"))) return false;
    const loadedPolicy = await loadDevFnPolicy(root, config.policy);
    // Without the runtime identity it started with, the resource plan differs and the lifecycle is not reused.
    const runtimeId = config.resources ? await readRuntimeId(receipt.stateDir ?? defaultStateDir()) : undefined;
    const identity: RoutingIdentity = { ...await resolveInstanceIdentity(config.project.id, root), ...(runtimeId ? { runtimeId } : {}) };
    resolved = await resolveWithComposeNetworks(config, plan, root, identity, ports, loadedPolicy?.policy.hostnameSuffix,
      await publicTemplateInputs(config, plan, identity, receipt.stateDir ?? defaultStateDir()));
    if (!receiptRoutesMatch(receipt, await selectedProxyRoutes(config, plan, identity, ports,
      loadedPolicy?.policy.hostnameSuffix ?? ".localhost", receipt.stateDir ?? defaultStateDir(), false))) return false;
    // The receipt is only as live as the proxy: a dead Caddy owner, a missing
    // listener or routes switched by an interrupted replacement all mean the
    // recorded URLs no longer reach this lifecycle.
    if (!await new CaddyProxyController(receipt.stateDir ?? defaultStateDir()).instanceRoutesLive(receipt.instanceId, receipt.routes)) return false;
    // Public URLs are live only while the binding's connector runs and still publishes them.
    if (receipt.tunnel) {
      const publicUrls = await livePublicUrls(receipt.stateDir ?? defaultStateDir(), receipt.instanceId, receipt.tunnel, config,
        await selectedPublicRoutes(config, plan, identity, ports, receipt.stateDir ?? defaultStateDir()));
      if (!publicUrls) return false;
      live.publicUrls = publicUrls;
    }
    const currentUrls = resolveAllocationUrls(receipt.allocations, receipt.routes, selectedHttpPorts(config, plan), resolved.directUrls);
    if (Object.keys(currentUrls).length !== Object.keys(receipt.urls).length ||
      Object.entries(currentUrls).some(([name, url]) => receipt.urls[name] !== url)) return false;
    // Receipts without startup fingerprints (v0.1) still record the resource
    // plan; a changed selection replaces the lifecycle. Absent equals absent.
    if (resourcePlanFingerprint(receipt.resources) !== resourcePlanFingerprint(resolved.resources)) return false;
    // Every task completed for its current input revision; a changed one is rerun by a replacement.
    for (const node of plan.nodes.filter((item) => item.task)) {
      const completed = receipt.tasks?.find((item) => item.name === node.name);
      if (!completed || (completed.status !== "succeeded" && completed.status !== "skipped") ||
        completed.inputRevision !== await taskInputRevision(config, root, node, plan.profile, resolved.resources)) return false;
    }
    if (receipt.startupFingerprints) {
      const current = await startupFingerprints(config, root, resolved);
      if (Object.keys(current).length !== Object.keys(receipt.startupFingerprints).length ||
        Object.entries(current).some(([name, fingerprint]) => receipt.startupFingerprints?.[name] !== fingerprint)) return false;
    }
  } catch (error) {
    // A busy proxy proves nothing about this lifecycle; never replace it on that basis.
    if (error && typeof error === "object" && "code" in error && error.code === "DEVFN_REGISTRY_LOCK_TIMEOUT") throw error;
    return false;
  }
  const compose = new ComposeController();
  const supervisor = new ProcessSupervisor();
  const processReady = await Promise.all(receipt.processes.map(async (managed, index) => {
    const spec = config.processes?.[managed.name];
    if (!spec || processStates[index] !== "running") return false;
    try {
      const ready = await checkReadinessNow({
        health: resolvedHealth(spec.health, resolved.nodes[managed.name]?.healthCommand, resolved.nodes[managed.name]?.healthUrl), ports, logPath: managed.logPath, cwd: managed.cwd, environment: createProcessEnvironment({ ...spec, env: resolved.nodes[managed.name]?.environment }, lifecycleGeneratedEnvironment(receipt, resolved.generated)),
        previouslyReady: Boolean(managed.readyAt || receipt.state === "ready"), isAlive: async () => await supervisor.status(managed) === "running",
      });
      if (!ready || spec.exposure === "public") return ready;
      const expected = (spec.ports ?? []).map((name) => ({ port: ports[name], protocol: config.ports?.[name]?.protocol ?? "tcp" }));
      return !(await verifyOwnedLoopbackListeners(managed.name, expected, managed.pid, await scanListenerState(false)));
    } catch { return false; }
  }));
  const serviceReady = await Promise.all(receipt.services.map(async (managed, index) => {
    const spec = config.services?.[managed.name];
    if (!spec || serviceStates[index] !== "running") return false;
    return await checkReadinessNow({
      health: resolvedHealth(spec.health, resolved.nodes[managed.name]?.healthCommand, resolved.nodes[managed.name]?.healthUrl), ports, logPath: "", cwd: root, environment: createComposeReadinessEnvironment(spec, resolved.nodes[managed.name]?.readinessEnvironment ?? {}),
      previouslyReady: receipt.state === "ready", isAlive: async () => await compose.status(managed) === "running",
      readLog: async () => await compose.logs({ ...managed, logsDisabled: Boolean(managed.logsDisabled || spec.secretEnv?.length) }, 1000, managed.startedAt),
    });
  }));
  return processReady.every(Boolean) && serviceReady.every(Boolean);
}

/**
 * Remove proxy routes no lifecycle can still own, for example after a
 * worktree was deleted while running. Holding an instance's lifecycle lock
 * proves no command of it runs; every process and container identity its
 * lifecycles recorded must then be verified dead. Live or ambiguous
 * instances keep their routes.
 */
export async function recoverOrphanedProxyRoutes(requestedStateDir: string, tunnelOverrides: TunnelOverrides = {}): Promise<string[]> {
  let stateDir: string;
  try { stateDir = await realpath(requestedStateDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const proxy = new CaddyProxyController(stateDir);
  const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
  const recovered: string[] = [];
  const failures: string[] = [];
  // An owner whose proxy routes are gone may still have published tunnel hostnames.
  const published = await tunnelOwners(stateDir).catch((error: unknown) => { failures.push(error instanceof Error ? error.message : String(error)); return []; });
  const routed = [...new Set([...await proxy.routedInstanceIds(), ...published])].sort(compareNames);
  // The OAuth relay has no lifecycle lock; its recorded identities show
  // whether it may still run. Recovery also ends a dead relay's claim and
  // record after a route transition already dropped its route. A relay
  // command holding its lock owns the relay, as a lifecycle command does.
  if (routed.includes(OAUTH_RELAY_OWNER_ID) || await lstat(relayPaths(stateDir).dir).then(() => true, () => false)) {
    let entered = false;
    try {
      if (await recoverOAuthRelayRoute(stateDir, proxy, { lockTimeoutMs: 1_000, onLocked: () => { entered = true; } })) recovered.push(OAUTH_RELAY_OWNER_ID);
    } catch (error) {
      // Only a relay command holding the service lock is skipped; a lock timeout inside it fails recovery.
      if (entered || !(error && typeof error === "object" && "code" in error && error.code === "DEVFN_REGISTRY_LOCK_TIMEOUT")) throw error;
    }
  }
  for (const instanceId of routed) {
    if (instanceId === OAUTH_RELAY_OWNER_ID) continue;
    let entered = false;
    try {
      await withFileLock(path.join(stateDir, `lifecycle-${instanceId}.lock`), async () => {
        entered = true;
        if (await withRoutingLock(stateDir, async () => await registry.instanceMayRun(instanceId))) return;
        // The held lifecycle lock keeps this instance from starting, so its
        // public routes are withdrawn, and only then its proxy routes removed,
        // without holding the shared routing lock across provider calls.
        // A failed withdrawal keeps this owner's routes and fails only its
        // recovery; an outstanding part stays journaled and is reported.
        try { failures.push(...(await withdrawLifecycleTunnel(stateDir, instanceId, tunnelOverrides)).outstanding.map((item) => `${instanceId}: ${item}`)); }
        catch (error) { failures.push(`${instanceId}: ${error instanceof Error ? error.message : String(error)}`); return; }
        await withRoutingLock(stateDir, async () => await proxy.removeInstance(instanceId));
        recovered.push(instanceId);
      }, { timeoutMs: 1_000 });
    } catch (error) {
      // A lifecycle command of this instance is running; it owns its routes.
      if (!entered && error && typeof error === "object" && "code" in error && error.code === "DEVFN_REGISTRY_LOCK_TIMEOUT") continue;
      throw error;
    }
  }
  if (failures.length) throw new DevFnError("DEVFN_RUNTIME_INVALID", `Public routes of some orphaned owners are not fully withdrawn; owners whose exposure may continue keep their routes: ${failures.join(" ")}`, { recovered, failures });
  return recovered;
}

/**
 * Stop a recorded process and its group only through its verified identity.
 * An exited wrapper with an empty group, or a readable different birth
 * signature, proves it gone; a live PID whose identity cannot be read, or a
 * wrapper that exited while its group lives on, may still be it, so teardown
 * cannot complete. A stop refused on identity grounds proves nothing by
 * itself: only a later status of stopped or identity-mismatch does.
 */
async function stopVerifiedProcess(managed: ManagedProcess, supervisor: ProcessSupervisor, result: CleanupResult): Promise<void> {
  const unverified = () => `Process ${managed.name} (PID ${managed.pid}) may still run but its identity cannot be verified; DevFn will not signal it.`;
  const status = await supervisor.status(managed);
  if (status === "stopped" || status === "identity-mismatch") return;
  try {
    await supervisor.stop(managed);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "DEVFN_PROCESS_OWNERSHIP_MISMATCH" && code !== "DEVFN_PROCESS_IDENTITY_UNVERIFIED") throw error;
    const after = await supervisor.status(managed);
    if (after === "running" || after === "unverified") {
      result.errors.push(`${code === "DEVFN_PROCESS_IDENTITY_UNVERIFIED" && error instanceof Error ? error.message : unverified()} Stop what remains, then rerun devfn down.`);
    }
    return;
  }
  const after = await supervisor.status(managed);
  if (after === "running" || after === "unverified") { result.errors.push(`Process ${managed.name} (PID ${managed.pid}) did not exit when stopped.`); return; }
  result.stoppedProcesses.push(managed.name);
}

/**
 * The registry journal outlives the receipt and can hold what the receipt
 * never listed: an owner of a receipt rewritten outside DevFn, or a Compose
 * launch interrupted before its identity was recorded, which resolves only
 * once its launcher is verified gone. Each is stopped by verified identity or
 * reported; none is assumed gone.
 */
async function stopJournaledOwners(receipt: LifecycleReceipt, registry: FilePortRegistry, supervisor: ProcessSupervisor, compose: ComposeController, result: CleanupResult): Promise<void> {
  let invocation: RegistryInvocation | undefined;
  try { invocation = (await registry.read()).invocations.find((item) => item.id === receipt.invocationId); }
  catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); return; }
  if (!invocation) return;
  const listedProcesses = new Set(receipt.processes.map((managed) => `${managed.pid}:${managed.birthSignature ?? ""}`));
  const listedContainers = new Set(receipt.services.flatMap((managed) => managed.containerIds));
  for (const owner of invocation.owners ?? []) {
    try {
      if (owner.process && !listedProcesses.has(`${owner.process.pid}:${owner.process.birthSignature ?? ""}`)) {
        // The receipt began before this owner started, so only the owner's
        // own record time can judge a legacy signature; without it, none.
        await stopVerifiedProcess({ name: owner.node, pid: owner.process.pid, ...(owner.process.birthSignature ? { birthSignature: owner.process.birthSignature } : {}),
          command: [], cwd: receipt.root, logPath: "", startedAt: owner.process.recordedAt ?? "" }, supervisor, result);
      } else if (owner.container && !listedContainers.has(owner.container.id) && await inspectContainerRunning(owner.container) !== false) {
        result.errors.push(`Container ${owner.container.id} of ${owner.node} is journaled for invocation ${receipt.invocationId} but not in its receipt and may still run; stop it, then rerun devfn down.`);
      }
    } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
  }
  for (const node of invocation.launching ?? []) {
    const launch = invocation.composeLaunches?.[node];
    if (!launch) {
      result.errors.push(`The launch of ${node} by invocation ${receipt.invocationId} was interrupted before its identity was recorded; DevFn cannot find what it started.`);
      continue;
    }
    try {
      await compose.stopLaunch({ name: node, ...launch });
      if (!result.stoppedServices.includes(node)) result.stoppedServices.push(node);
    } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
  }
}

export class DevFnOrchestrator {
  public constructor(private readonly tunnelOverrides: TunnelOverrides = {}) {}

  public async up(options: UpOptions): Promise<LifecycleReceipt> {
    validateDevFnConfig(options.config);
    const plan = createPlan(options.config, options.profile);
    const publicNodes = plan.nodes.filter((node) => node.kind === "process" && options.config.processes?.[node.name]?.exposure === "public").map((node) => node.name);
    const publicPorts = plan.portNames.filter((name) => options.config.ports?.[name]?.exposure === "public");
    // A selected tunnel binding is an external resource, not consent: public
    // routes need the same explicit confirmation before any state is read.
    const tunnel = profileTunnel(options.config, plan);
    if ((publicNodes.length || publicPorts.length || tunnel) && !options.allowPublic) {
      throw new DevFnError("DEVFN_PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED", "This profile declares public exposure. Review it and rerun with --allow-public.", { processes: publicNodes, ports: publicPorts, ...(tunnel ? { tunnel } : {}) });
    }
    const requestedStateDir = options.stateDir ?? defaultStateDir();
    // Resource namespaces include this runtime's identity. Preflight plans
    // with the recorded one, or a new one recorded only with the state
    // directory once preflight passed.
    const runtimeId = options.config.resources ? await readRuntimeId(requestedStateDir) ?? newRuntimeId() : undefined;
    const identity: RoutingIdentity = { ...await resolveInstanceIdentity(options.config.project.id, options.root), ...(runtimeId ? { runtimeId } : {}) };
    const loadedPolicy = await loadDevFnPolicy(options.root, options.config.policy);
    // Effective network evidence must reject unreachable sibling references
    // before state creation. Re-read it under the lifecycle lock after ports
    // are reserved because the Compose source can change between these steps.
    const preflightPorts = Object.fromEntries(plan.portNames.map((name) => [name, 1]));
    await selectedProxyRoutes(options.config, plan, identity, preflightPorts, loadedPolicy?.policy.hostnameSuffix ?? ".localhost", requestedStateDir);
    // A reference to a public URL that exists only after start fails here, before any lease, process or connector.
    const publicTemplate = await publicTemplateInputs(options.config, plan, identity, requestedStateDir);
    const preflight = await needsNetworkPreflight(options.config, plan, options.root, identity, preflightPorts, loadedPolicy?.policy.hostnameSuffix, publicTemplate)
      ? await resolveWithComposeNetworks(options.config, plan, options.root, identity, preflightPorts, loadedPolicy?.policy.hostnameSuffix, publicTemplate, true)
      : resolveEndpoints({ config: options.config, plan, ownerId: identity.instanceId, routingIdentity: identity, ports: preflightPorts,
        hostnameSuffix: loadedPolicy?.policy.hostnameSuffix, composeNetworks: provisionalComposeNetworks(options.config, plan, identity.instanceId), ...publicTemplate }, { ports: true, networks: true });
    // Unknown reruns, missing task inputs and blocked tasks fail here; the locked start decides again from the journal.
    await preflightTasks({ config: options.config, plan, root: options.root, stateDir: requestedStateDir, instanceId: identity.instanceId,
      ...(preflight.resources ? { resources: preflight.resources } : {}), ...(options.rerunTasks ? { rerunTasks: options.rerunTasks } : {}) });
    await mkdir(requestedStateDir, { recursive: true, mode: 0o700 });
    const stateDir = await realpath(requestedStateDir);
    // A concurrent first start may have recorded another; the locked pass plans with the recorded one.
    if (identity.runtimeId) identity.runtimeId = await recordRuntimeId(stateDir, identity.runtimeId);
    return await withFileLock(path.join(stateDir, `lifecycle-${identity.instanceId}.lock`), async () => {
      // Health and teardown may wait for minutes. The instance lock protects
      // this lifecycle while sibling route/lease transitions use the short
      // shared routing lock below.
      const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
      const oldReady = await this.prepareExisting(options, stateDir, identity, loadedPolicy, registry, true);
      // Unless a ready lifecycle is kept for replacement, public exposure this
      // owner still has, also without a receipt, ends before any lease or
      // node start; a public profile republishes once it is ready.
      if (!oldReady) await withdrawLifecycleTunnel(stateDir, identity.instanceId, this.tunnelOverrides).catch((error: unknown) => {
        throw new DevFnError("DEVFN_RUNTIME_INVALID", `Public routes of this lifecycle could not be withdrawn before startup: ${error instanceof Error ? error.message : String(error)}`);
      });
      const start = await this.prepareUpLocked(options, stateDir, identity, loadedPolicy, oldReady);
      return await start();
    }, { timeoutMs: 30_000 });
  }

  private async prepareUpLocked(options: UpOptions, stateDir: string, identity: RoutingIdentity, loadedPolicy: Awaited<ReturnType<typeof loadDevFnPolicy>>, oldReady?: LifecycleReceipt): Promise<() => Promise<LifecycleReceipt>> {
    const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
    const plan = createPlan(options.config, options.profile);
    const profileHostnames = Object.entries(options.config.hostnames ?? {}).filter(([, spec]) => !spec.profiles || spec.profiles.includes(plan.profile));
    const listenerPorts = plan.proxy && profileHostnames.length ? [...Object.values(proxyListenerPorts()), ...(profileTunnel(options.config, plan) ? [PUBLIC_ORIGIN_PORT] : [])] : [];
    const preflightPorts = Object.fromEntries(plan.portNames.map((name) => [name, 1]));
    const routes = await selectedProxyRoutes(options.config, plan, identity, preflightPorts,
      loadedPolicy?.policy.hostnameSuffix ?? ".localhost", stateDir);
    const publicNodes = plan.nodes.filter((node) => node.kind === "process" && options.config.processes?.[node.name]?.exposure === "public").map((node) => node.name);
    const publicPorts = plan.portNames.filter((name) => options.config.ports?.[name]?.exposure === "public");
    // A selected tunnel binding is an external resource, not consent: public
    // routes need the same explicit confirmation before any state is read.
    const tunnel = profileTunnel(options.config, plan);
    if ((publicNodes.length || publicPorts.length || tunnel) && !options.allowPublic) {
      throw new DevFnError("DEVFN_PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED", "This profile declares public exposure. Review it and rerun with --allow-public.", { processes: publicNodes, ports: publicPorts, ...(tunnel ? { tunnel } : {}) });
    }
    const invocationId = randomUUID();
    const runtimeDir = await secureRuntimeDirectory(options.config, options.root, identity.instanceId);
    const policy = resolvePolicy(loadedPolicy?.policy ?? null, options.config.project.id);
    const suffix = loadedPolicy?.policy.hostnameSuffix ?? ".localhost";
    const configuredHostnames = Object.fromEntries(profileHostnames.filter(([, spec]) => !spec.domain).map(([name, spec]) => [spec.target, resolveLocalHostname(spec.hostname, name, options.config.project.id, identity.instanceId, suffix)]));
    const allocations = await withRoutingLock(stateDir, async () => {
      const prior = await readReceipt(options.config, options.root, identity.instanceId);
      if (prior && prior.state !== "stopped") assertReceiptStateDir(prior, stateDir);
      const replacingInvocationId = prior?.state === "ready" ? prior.invocationId : undefined;
      await registry.assertReplacementAvailable(listenerPorts, identity.instanceId,
        plan.portNames.map((name) => ({ name, spec: options.config.ports?.[name] ?? {} })),
        async () => {
          if (!routes.length) return;
          const proxy = new CaddyProxyController(stateDir);
          await proxy.assertRouteOwnershipAvailable(routes, identity.instanceId);
          await proxy.assertActivationReady(routes, identity.instanceId);
        }, replacingInvocationId);
      await registry.recoverInterrupted(identity.instanceId);
      return await registry.reserve({
        projectId: options.config.project.id,
        instanceId: identity.instanceId,
        invocationId,
        profile: plan.profile,
        requests: plan.portNames.map((name) => ({ name, spec: options.config.ports?.[name] ?? {}, ...(configuredHostnames[name] ? { hostname: configuredHostnames[name] } : {}) })),
        ...policy,
        // A selected proxy route claims both listener ports across protocols.
        ...(listenerPorts.length ? { proxyListenerPorts: listenerPorts } : {}),
        ...(oldReady ? { replacingInvocationId: oldReady.invocationId } : {}),
      });
    });
    const ports = Object.fromEntries(allocations.map((item) => [item.service, item.port]));
    let resolved: ReturnType<typeof resolveEndpointTemplates>;
    // The binding is read once per start: consumers resolve their public URLs from the same selection that is published.
    let publicSelection: PublicSelection | undefined;
    try {
      publicSelection = await selectedPublicRoutes(options.config, plan, identity, ports, stateDir);
      resolved = await resolveWithComposeNetworks(options.config, plan, options.root, identity, ports, suffix, selectionTemplateInputs(publicSelection));
    } catch (error) {
      await registry.release({ invocationId, errorCode: "DEVFN_ENDPOINT_RESOLUTION_FAILED" });
      throw error;
    }
    const environment = resolved.environment;
    let fingerprints: Record<string, string>;
    try { fingerprints = await startupFingerprints(options.config, options.root, resolved); }
    catch (error) {
      await registry.release({ invocationId, errorCode: "DEVFN_STARTUP_FINGERPRINT_FAILED" });
      throw error;
    }
    const proxy = new CaddyProxyController(stateDir);
    let activatedRoutes: Awaited<ReturnType<typeof proxy.upsert>> | undefined;
    // An interrupted replacement can leave committed routes the prior receipt
    // never recorded, so the proxy's own state decides what to reconcile.
    let reconcileRoutes = false;
    let priorRoutes: ProxyRouteSnapshot | undefined;
    try {
      reconcileRoutes = oldReady !== undefined && (routes.length > 0 || oldReady.routes.length > 0 || await proxy.hasInstanceRoutes(identity.instanceId));
      // Activation prunes certificate snapshots no committed route uses, so
      // the prior routes' material is captured now for any rollback.
      if (reconcileRoutes) priorRoutes = await proxy.captureInstanceRoutes(identity.instanceId);
    } catch (error) {
      await registry.release({ invocationId, errorCode: "DEVFN_PROXY_CONFIG_INVALID" });
      throw error;
    }
    // Restore this instance's routes as they were before preactivation, and
    // only when its committed or pending route state actually changed: a
    // rejected candidate leaves both untouched and keeps its own error.
    const restorePriorRoutes = async (): Promise<void> => {
      if (!priorRoutes) return;
      const before = new Set([priorRoutes.committed, priorRoutes.pending].filter(Boolean).map((value) => JSON.stringify(value)));
      const after = await proxy.instanceRouteState(identity.instanceId).catch(() => undefined);
      if (after && [after.committed, after.pending].filter(Boolean).every((value) => before.has(JSON.stringify(value)))) return;
      await proxy.restoreInstanceRoutes(identity.instanceId, priorRoutes);
    };
    const rollbackFailure = async (): Promise<string | undefined> => activatedRoutes
      ? await restorePriorRoutes().then(() => undefined, (error: unknown) => `prior routes could not be restored: ${error instanceof Error ? error.message : String(error)}`)
      : undefined;
    if (oldReady && reconcileRoutes) {
      try {
        // Caddy run/reload can fail after validate. Activate the final routes
        // while the previous ready lifecycle and receipt are still intact.
        const finalRoutes = await selectedProxyRoutes(options.config, plan, identity, ports, suffix, stateDir);
        activatedRoutes = await proxy.upsert(finalRoutes, identity.instanceId);
      } catch (error) {
        try { await restorePriorRoutes(); }
        catch (rollbackError) {
          // The invocation's listener claim stays while its routes remain.
          await registry.release({ invocationId, errorCode: "DEVFN_PROXY_RELOAD_FAILED" }).catch(() => undefined);
          throw new DevFnError("DEVFN_RUNTIME_INVALID", `Proxy activation failed and prior routes could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
        await registry.release({ invocationId, errorCode: "DEVFN_PROXY_RELOAD_FAILED" });
        throw error;
      }
    }
    const receipt: LifecycleReceipt = {
      version: 1, projectId: options.config.project.id, instanceId: identity.instanceId, invocationId, profile: plan.profile,
      state: "starting", root: options.root, runtimeDir, stateDir: path.resolve(stateDir), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      allocations, processes: [], services: [], startedNodes: [], routes: activatedRoutes ?? [], urls: {}, environmentOutputs: [],
      startupFingerprints: fingerprints,
      portSpecFingerprints: portSpecFingerprints(options.config, plan.portNames),
      ...(resolved.resources ? { resources: resolved.resources } : {}),
    };
    try {
      await registry.updateInvocation(invocationId, { state: "starting" });
    } catch (error) {
      const rollback = await rollbackFailure();
      await registry.release({ invocationId, errorCode: "DEVFN_RECEIPT_WRITE_FAILED" }).catch(() => undefined);
      if (rollback) {
        throw new DevFnError("DEVFN_RUNTIME_INVALID", `Unable to record the replacement, and its ${rollback}`,
          { cause: error instanceof Error ? error.message : String(error), priorInvocationId: oldReady?.invocationId, priorStopped: false, routesRestored: false });
      }
      throw error;
    }
    return async () => {
      const heartbeat = setInterval(() => { void registry.updateInvocation(invocationId, {}).catch(() => undefined); }, 60_000);
      heartbeat.unref();
      const supervisor = new ProcessSupervisor();
      const compose = new ComposeController();
      if (oldReady) {
        // Replacement is stop-then-start: everything that can be checked
        // without running the new source was validated above. The old
        // processes are not relaunched after a later failure because their
        // source in the working tree may already have changed.
        const stopped = await this.cleanup(oldReady, registry, supervisor, compose, proxy, false, true, true);
        if (stopped.errors.length) {
          clearInterval(heartbeat);
          // Part of the prior lifecycle may still run, so it keeps its receipt,
          // leases and routes for an explicit down. A failed route rollback
          // is reported as such, never as routes kept.
          const rollback = await rollbackFailure();
          await registry.release({ invocationId, errorCode: "DEVFN_REPLACEMENT_STOP_FAILED" }).catch(() => undefined);
          oldReady.cleanup = rollback ? { ...stopped, errors: [...stopped.errors, rollback] } : stopped;
          oldReady.state = "degraded";
          oldReady.updatedAt = new Date().toISOString();
          await writeReceipt(oldReady).catch(() => undefined);
          throw new DevFnError("DEVFN_RUNTIME_INVALID", `Unable to stop the prior lifecycle for replacement${rollback ? `, and its ${rollback}` : ""}; run devfn down before retrying.`,
            { cleanup: oldReady.cleanup, priorInvocationId: oldReady.invocationId, priorStopped: false, ...(activatedRoutes ? { routesRestored: !rollback } : {}) });
        }
      }
      try {
        // The prior processes are gone. The replacement's planned leases
        // already cover every port it reuses, so the prior leases end here,
        // before its receipt is superseded.
        if (oldReady) await registry.release({ invocationId: oldReady.invocationId });
        await writeReceipt(receipt);
        receipt.environmentOutputs = await writeEnvironmentOutputs(options.root, runtimeDir, options.config.environmentOutputs ?? [], environment);
        for (const node of plan.nodes) {
          if (options.signal?.aborted) throw new DevFnError("DEVFN_CANCELLED", `DevFn startup was cancelled before ${node.name} started.`);
          await this.startSelectedNode(node, { options, identity, receipt, resolved, ports, allocations, supervisor, compose, registry });
          receipt.updatedAt = new Date().toISOString();
          await writeReceipt(receipt);
        }
        // A cancellation observed as the last task ended still never ends ready.
        if (options.signal?.aborted) throw new DevFnError("DEVFN_CANCELLED", "DevFn startup was cancelled.");
        if (plan.proxy && !activatedRoutes) {
          const routes = await selectedProxyRoutes(options.config, plan, identity, ports, suffix, stateDir);
          receipt.routes = await proxy.upsert(routes, identity.instanceId);
        } else if (activatedRoutes) receipt.routes = activatedRoutes;
        receipt.urls = resolveAllocationUrls(allocations, receipt.routes, selectedHttpPorts(options.config, plan), resolved.directUrls);
        // Public exposure starts last, once every node is ready and the
        // public origin routes are active; a profile without a tunnel
        // withdraws any this owner still publishes.
        if (publicSelection) {
          await writeReceipt(receipt);
          const { hostnames, urls, outstanding } = await publishLifecycleTunnel(stateDir, identity.instanceId, publicSelection, options.config, this.tunnelOverrides);
          receipt.tunnel = { binding: publicSelection.binding.name, hostnames, urlTiming: publicSelection.timing, ...(outstanding.length ? { outstanding } : {}) };
          receipt.publicUrls = urls;
        } else await withdrawLifecycleTunnel(stateDir, identity.instanceId, this.tunnelOverrides);
        if (!receipt.routes.length && await proxy.hasInstanceRoutes(identity.instanceId)) await proxy.removeInstance(identity.instanceId);
        clearInterval(heartbeat);
        await registry.markActive(invocationId, startupOwners(options.config, receipt));
        receipt.state = "ready";
        receipt.updatedAt = new Date().toISOString();
        await writeReceipt(receipt);
        return receipt;
      } catch (error) {
        const cleanup = await this.cleanup(receipt, registry, supervisor, compose, proxy, true);
        receipt.state = "failed";
        receipt.cleanup = cleanup;
        receipt.error = { code: error && typeof error === "object" && "code" in error ? String(error.code) : "DEVFN_START_FAILED", message: error instanceof Error ? error.message : String(error) };
        receipt.updatedAt = new Date().toISOString();
        await writeReceipt(receipt).catch(() => undefined);
        if (oldReady) {
          throw new DevFnError("DEVFN_START_FAILED", `DevFn replacement failed after prior invocation ${oldReady.invocationId} was stopped; it was not restarted: ${receipt.error.message}`,
            { cleanup, causeCode: receipt.error.code, priorInvocationId: oldReady.invocationId, priorStopped: true });
        }
        throw new DevFnError("DEVFN_START_FAILED", `DevFn startup failed: ${receipt.error.message}`, { cleanup, causeCode: receipt.error.code });
      } finally {
        clearInterval(heartbeat);
      }
    };
  }

  private async prepareExisting(options: UpOptions, stateDir: string, identity: RoutingIdentity, loadedPolicy: Awaited<ReturnType<typeof loadDevFnPolicy>>, registry: FilePortRegistry, deferReadyCleanup = false): Promise<LifecycleReceipt | undefined> {
    const existing = await readReceipt(options.config, options.root, identity.instanceId);
    if (existing && existing.state !== "stopped") {
      assertReceiptStateDir(existing, stateDir);
      // down holds this instance lock for its whole run, so a stopping
      // invocation seen here was interrupted; finish that stop first. A ready
      // receipt is replaceable only while its registry invocation is ready.
      const registered = (await registry.read()).invocations.find((item) => item.id === existing.invocationId)?.state;
      if (registered === "stopping") {
        await this.stopExisting(existing, stateDir, registry);
        return undefined;
      }
      const processStates = await Promise.all(existing.processes.map((item) => new ProcessSupervisor().status(item)));
      const serviceStates = await Promise.all(existing.services.map((item) => new ComposeController().status(item)));
      const managedCount = processStates.length + serviceStates.length;
      const allRunning = managedCount > 0 && processStates.every((state) => state === "running") && serviceStates.every((state) => state === "running");
      const live: { publicUrls?: Record<string, string> } = {};
      const allReady = allRunning && existing.profile === (options.profile ?? options.config.defaultProfile ?? "default") &&
        await receiptIsReady(options.config, options.root, existing, processStates, serviceStates, live);
      if (existing.state === "ready" && allReady && !options.replace) {
        // Public URLs a shared connector restart reassigned are recorded; the lifecycle and every connector are kept.
        if (live.publicUrls && !sameUrls(live.publicUrls, existing.publicUrls)) {
          existing.publicUrls = live.publicUrls;
          existing.updatedAt = new Date().toISOString();
          await writeReceipt(existing);
        }
        throw new DevFnError("DEVFN_ALREADY_RUNNING", `DevFn instance ${identity.instanceId} is already running.`);
      }
      // Validate the replacement while the old lifecycle still owns its ports
      // and containers. A malformed source must never turn a ready service off.
      const replacementPlan = createPlan(options.config, options.profile);
      const existingPorts = Object.fromEntries(existing.allocations.map((allocation) => [allocation.service, allocation.port]));
      const replacementPorts = Object.fromEntries(replacementPlan.portNames.map((name) => [name, existingPorts[name] ?? 1]));
      // Ports the old lifecycle does not lease are placeholders, so this pass is provisional.
      const replacement = await resolveWithComposeNetworks(options.config, replacementPlan, options.root, identity, replacementPorts, loadedPolicy?.policy.hostnameSuffix,
        await publicTemplateInputs(options.config, replacementPlan, identity, stateDir), true);
      await startupFingerprints(options.config, options.root, replacement);
      if (existing.state === "ready" && allRunning && deferReadyCleanup && registered === "ready") return existing;
      await this.stopExisting(existing, stateDir, registry);
    }
  }

  private async stopExisting(existing: LifecycleReceipt, stateDir: string, registry: FilePortRegistry, preserveRoutes = false): Promise<void> {
    const recovered = await this.cleanup(existing, registry, new ProcessSupervisor(), new ComposeController(), new CaddyProxyController(stateDir), existing.state !== "ready", preserveRoutes);
    if (recovered.errors.length) {
      // Part of it may still run: it keeps its receipt, leases and routes
      // for an explicit down, and is never reported stopped.
      existing.cleanup = recovered;
      existing.state = "degraded";
      existing.updatedAt = new Date().toISOString();
      await writeReceipt(existing).catch(() => undefined);
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Unable to stop prior invocation ${existing.invocationId}; it was not replaced: ${recovered.errors.join(" ")}`, { cleanup: recovered, priorStopped: false });
    }
    existing.cleanup = recovered;
    existing.state = recovered.publicOutstanding?.length ? "degraded" : "stopped";
    existing.updatedAt = new Date().toISOString();
    await writeReceipt(existing);
  }

  private async startSelectedNode(node: LifecyclePlan["nodes"][number], context: {
    options: UpOptions;
    identity: InstanceIdentity;
    receipt: LifecycleReceipt;
    resolved: ReturnType<typeof resolveEndpointTemplates>;
    ports: Record<string, number>;
    allocations: readonly PortAllocation[];
    supervisor: ProcessSupervisor;
    compose: ComposeController;
    registry: FilePortRegistry;
  }): Promise<void> {
    const { options, identity, receipt, resolved, ports, allocations, supervisor, compose, registry } = context;
    if (node.task) {
      // A task is never a running owner: it is not in startedNodes, and teardown has nothing of it to stop once it ended.
      const run = async () => await runTask({ config: options.config, root: options.root, stateDir: receipt.stateDir ?? defaultStateDir(), runtimeDir: receipt.runtimeDir,
        instanceId: identity.instanceId, invocationId: receipt.invocationId, node, profile: receipt.profile, environment: resolved.nodes[node.name].environment,
        command: resolved.nodes[node.name].command, script: resolved.nodes[node.name].script, generated: lifecycleGeneratedEnvironment(receipt, resolved.generated),
        ...(resolved.resources ? { resources: resolved.resources } : {}), rerunRequested: options.rerunTasks?.includes(node.name) ?? false,
        ...(options.signal ? { signal: options.signal } : {}), registry, supervisor, compose,
        record: async (entry: TaskReceipt) => {
          const tasks = receipt.tasks ??= [];
          const index = tasks.findIndex((item) => item.name === entry.name);
          if (index < 0) tasks.push(entry); else tasks[index] = entry;
          receipt.updatedAt = new Date().toISOString();
          await writeReceipt(receipt);
        } });
      await (options.whileTaskRuns ? options.whileTaskRuns(run) : run());
      return;
    }
    // Routes may already target this lifecycle's ports. Its owner identities
    // are journaled in the registry, which outlives the worktree, so orphan
    // recovery can tell a running interrupted start from a dead one. Each
    // identity is in the receipt before the journal, so teardown of the
    // receipt reaches every journaled owner; a Compose launch and its
    // launcher are journaled before the launcher runs, and a process command
    // runs only once both hold it.
    if (node.kind === "service") {
      const spec = options.config.services![node.name];
      await compose.start({
        name: node.name, spec: { ...spec, env: resolved.nodes[node.name].environment, health: resolvedHealth(spec.health, resolved.nodes[node.name].healthCommand, resolved.nodes[node.name].healthUrl) }, root: options.root, runtimeDir: receipt.runtimeDir, instanceId: identity.instanceId, ports,
        portHosts: Object.fromEntries(allocations.map((item) => [item.service, item.host])),
        portProtocols: Object.fromEntries(allocations.map((item) => [item.service, item.protocol])), environment: resolved.nodes[node.name].environment, readinessEnvironment: resolved.nodes[node.name].readinessEnvironment,
        onLaunch: async ({ name: _name, ...launch }) => await registry.beginLaunch(receipt.invocationId, node.name, launch),
        onStarted: async (managed) => {
          receipt.services.push(managed);
          receipt.startedNodes?.push({ name: node.name, kind: node.kind });
          receipt.updatedAt = new Date().toISOString();
          await writeReceipt(receipt);
          await registry.recordOwners(receipt.invocationId, node.name, managed.containerIds.map((id) => ({ container: { id, name: managed.composeService,
            ...(managed.dockerEnvironment !== undefined ? { dockerEnvironment: managed.dockerEnvironment } : {}) } })));
        },
      });
      return;
    }
    const spec = options.config.processes![node.name];
    const managed = await supervisor.start({
      name: node.name, spec: { ...spec, env: resolved.nodes[node.name].environment, command: resolved.nodes[node.name].command, script: resolved.nodes[node.name].script, health: resolvedHealth(spec.health, resolved.nodes[node.name].healthCommand, resolved.nodes[node.name].healthUrl) }, root: options.root, runtimeDir: receipt.runtimeDir, ports,
      environment: lifecycleGeneratedEnvironment(receipt, resolved.generated),
      onStarted: async (started) => {
        receipt.processes.push(started);
        receipt.startedNodes?.push({ name: node.name, kind: node.kind });
        receipt.updatedAt = new Date().toISOString();
        await writeReceipt(receipt);
        await registry.recordOwners(receipt.invocationId, node.name, [{ process: { pid: started.pid, ...(started.birthSignature ? { birthSignature: started.birthSignature } : {}) } }]);
      },
    });
    if (spec.exposure !== "public") {
      const expected = (spec.ports ?? []).map((name) => ({ name, port: ports[name], protocol: options.config.ports?.[name]?.protocol ?? "tcp" }));
      await waitForOwnedLoopbackListeners(node.name, expected, managed.pid, spec.health?.timeoutMs ?? 120_000);
    }
  }

  private async cleanup(receipt: LifecycleReceipt, registry: FilePortRegistry, supervisor: ProcessSupervisor, compose: ComposeController, proxy: CaddyProxyController, failed: boolean, preserveRoutes = false, preserveLeases = false): Promise<CleanupResult> {
    const result: CleanupResult = { stoppedProcesses: [], stoppedServices: [], removedProxy: false, releasedPorts: false, errors: [] };
    // Public exposure ends on every binding before any process stops, also
    // for a replacement, which republishes once it is ready. While it cannot
    // end, nothing stops and no port is freed for another process to take;
    // a part still journaled after it ended is reported, not hidden.
    try {
      const { withdrawn, outstanding } = await withdrawLifecycleTunnel(receipt.stateDir ?? defaultStateDir(), receipt.instanceId, this.tunnelOverrides);
      result.withdrawnPublicHostnames = withdrawn;
      if (outstanding.length) result.publicOutstanding = outstanding;
    } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); return result; }
    const historical = [
      ...receipt.processes.map((value) => ({ kind: "process" as const, value })),
      ...receipt.services.map((value) => ({ kind: "service" as const, value })),
    ];
    const started = receipt.startedNodes?.length
      ? [...receipt.startedNodes].reverse().flatMap((node) => {
        const found = historical.find((item) => item.kind === node.kind && item.value.name === node.name);
        return found ? [found] : [];
      })
      : historical.sort((a, b) => Date.parse(b.value.startedAt) - Date.parse(a.value.startedAt));
    for (const item of started) {
      try {
        if (item.kind === "process") await stopVerifiedProcess(item.value, supervisor, result);
        else { await compose.stop(item.value); result.stoppedServices.push(item.value.name); }
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    await stopJournaledOwners(receipt, registry, supervisor, compose, result);
    // Routes of an owner that may still run keep pointing at it until a
    // later teardown resolves it.
    if (!preserveRoutes && result.errors.length === 0) {
      try { await proxy.removeInstance(receipt.instanceId); result.removedProxy = true; } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
    }
    if (result.errors.length === 0 && !preserveLeases) {
      try { await registry.release({ invocationId: receipt.invocationId, ...(failed ? { errorCode: receipt.error?.code ?? "DEVFN_START_FAILED" } : {}) }); result.releasedPorts = true; } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
    }
    return result;
  }

  public async down(options: { config: DevFnConfig; root: string; stateDir?: string }): Promise<LifecycleReceipt> {
    const requestedStateDir = options.stateDir ?? defaultStateDir();
    const identity = await resolveInstanceIdentity(options.config.project.id, options.root);
    await mkdir(requestedStateDir, { recursive: true, mode: 0o700 });
    const stateDir = await realpath(requestedStateDir);
    return await withFileLock(path.join(stateDir, `lifecycle-${identity.instanceId}.lock`), async () => {
      // Coordinate the destructive decision with sibling route/lease changes,
      // then let long process and Compose stops run under the instance lock.
      await withRoutingLock(stateDir, async () => {
        const receipt = await readReceipt(options.config, options.root, identity.instanceId);
        if (!receipt || receipt.state === "stopped") throw new DevFnError("DEVFN_NOT_RUNNING", `DevFn instance ${identity.instanceId} is not running.`);
        assertReceiptStateDir(receipt, stateDir);
        await new FilePortRegistry(path.join(stateDir, "registry.json")).updateInvocation(receipt.invocationId, { state: "stopping" });
      });
      return await this.downLocked(options, stateDir, identity);
    }, { timeoutMs: 30_000 });
  }

  private async downLocked(options: { config: DevFnConfig; root: string; stateDir?: string }, stateDir: string, identity: InstanceIdentity): Promise<LifecycleReceipt> {
    const receipt = await readReceipt(options.config, options.root, identity.instanceId);
    if (!receipt || receipt.state === "stopped") throw new DevFnError("DEVFN_NOT_RUNNING", `DevFn instance ${identity.instanceId} is not running.`);
    assertReceiptStateDir(receipt, stateDir);
    const registry = new FilePortRegistry(path.join(stateDir, "registry.json"));
    // Siblings honour a stopping claim only while it is refreshed; an
    // interrupted down expires and the next lifecycle command completes it.
    const heartbeat = setInterval(() => { void registry.updateInvocation(receipt.invocationId, {}).catch(() => undefined); }, 60_000);
    heartbeat.unref();
    let cleanup: CleanupResult;
    try { cleanup = await this.cleanup(receipt, registry, new ProcessSupervisor(), new ComposeController(), new CaddyProxyController(stateDir), false); }
    finally { clearInterval(heartbeat); }
    // The instance lock is held, so any other planning/starting invocation of
    // this worktree belongs to an interrupted command.
    if (cleanup.errors.length === 0) await registry.recoverInterrupted(identity.instanceId);
    receipt.cleanup = cleanup;
    receipt.state = cleanup.errors.length || cleanup.publicOutstanding?.length ? "degraded" : "stopped";
    receipt.updatedAt = new Date().toISOString();
    await writeReceipt(receipt);
    return receipt;
  }

  public async status(options: { config: DevFnConfig; root: string }): Promise<Record<string, unknown>> {
    const identity = await resolveInstanceIdentity(options.config.project.id, options.root);
    const receipt = await readReceipt(options.config, options.root, identity.instanceId);
    if (!receipt) return { ok: true, state: "stopped", instanceId: identity.instanceId, processes: [], services: [], urls: {} };
    const supervisor = new ProcessSupervisor();
    const processes = await Promise.all(receipt.processes.map(async (managed) => ({ name: managed.name, pid: managed.pid, state: await supervisor.status(managed), logPath: managed.logPath })));
    const compose = new ComposeController();
    const services = await Promise.all(receipt.services.map(async (managed) => ({ ...managed, state: await compose.status(managed) })));
    const live: { publicUrls?: Record<string, string> } = {};
    const runtimeReady = receipt.state === "ready" && await receiptIsReady(options.config, options.root, receipt, processes.map((item) => item.state), services.map((item) => item.state), live);
    const degraded = receipt.state === "ready" && !runtimeReady;
    const state = degraded ? "degraded" : receipt.state;
    // Public URLs are the ones served now; publicUrlsChanged marks those reassigned since the receipt recorded them.
    const publicUrls = state === "ready" && live.publicUrls ? { publicUrls: live.publicUrls, ...(sameUrls(live.publicUrls, receipt.publicUrls) ? {} : { publicUrlsChanged: true }) } : {};
    const tasks = receipt.tasks?.map(({ name, kind, status, reason, inputRevision, attempts }) => ({ name, kind, status, reason, inputRevision, attempts: attempts.length }));
    return { ok: state !== "failed" && state !== "degraded", state, instanceId: identity.instanceId, profile: receipt.profile, processes, services, ...(tasks ? { tasks } : {}), allocations: receipt.allocations, urls: state === "ready" ? receipt.urls : {}, ...publicUrls };
  }

  public async doctor(options: { config: DevFnConfig; root: string; profile?: string; stateDir?: string }): Promise<{ ok: boolean; diagnostics: Array<{ code: string; severity: "error" | "warning" | "info"; message: string; details?: unknown }> }> {
    const diagnostics: Array<{ code: string; severity: "error" | "warning" | "info"; message: string; details?: unknown }> = [];
    const stateDir = options.stateDir ?? defaultStateDir();
    const plan = createPlan(options.config, options.profile);
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22) diagnostics.push({ code: "DEVFN_NODE_VERSION", severity: "error", message: `Node 22 or newer is required; found ${process.version}.` });
    else diagnostics.push({ code: "DEVFN_NODE_VERSION", severity: "info", message: `Node runtime ${process.version}.` });
    const equivalentRuntimeChecks = new Set<string>();
    for (const requirement of options.config.prerequisites ?? []) {
      if (requirement.profiles && !requirement.profiles.includes(plan.profile)) continue;
      try {
        const executable = requirement.command === "pnpm" ? "corepack" : requirement.command;
        const args = requirement.command === "pnpm" ? ["pnpm", "--version"] : ["--version"];
        const output = await execFileAsync(executable, args, { cwd: options.root, timeout: 5000, env: { ...process.env, ...(requirement.command === "pnpm" ? { COREPACK_ENABLE_NETWORK: "0" } : {}) } });
        const actual = (output.stdout.trim() || output.stderr.trim()).replace(/^v/, "");
        let expected = requirement.version;
        if (expected === "project-pinned") {
          try {
            const packageJson = JSON.parse(await readFile(path.join(options.root, "package.json"), "utf8")) as { packageManager?: string };
            expected = packageJson.packageManager?.startsWith(`${requirement.command}@`) ? packageJson.packageManager.slice(requirement.command.length + 1) : undefined;
          } catch { expected = undefined; }
        }
        if (expected && actual !== expected) diagnostics.push({ code: "DEVFN_PREREQUISITE_VERSION", severity: "error", message: `${requirement.command} ${expected} is required; found ${actual}.` });
        else {
          if (requirement.command === "npm" || requirement.command === "pnpm") equivalentRuntimeChecks.add(requirement.command);
          diagnostics.push({ code: "DEVFN_PREREQUISITE_OK", severity: "info", message: `${requirement.command} is available.`, details: { version: actual, ...(expected ? { expected } : {}) } });
        }
      }
      catch { diagnostics.push({ code: "DEVFN_PREREQUISITE_MISSING", severity: requirement.optional ? "warning" : "error", message: `${requirement.command} is unavailable.` }); }
    }
    const adapters = new Set(plan.nodes.filter((node) => node.kind === "process").map((node) => options.config.processes?.[node.name]?.adapter).filter(Boolean));
    const implicitTools: Array<{ adapter: string; file: string; args: string[] }> = [];
    if (adapters.has("npm")) implicitTools.push({ adapter: "npm", file: "npm", args: ["--version"] });
    if (adapters.has("pnpm")) implicitTools.push({ adapter: "pnpm", file: "corepack", args: ["pnpm", "--version"] });
    if (adapters.has("xcode")) implicitTools.push({ adapter: "xcode", file: "xcodebuild", args: ["-version"] });
    for (const adapter of ["turbo", "wrangler", "extfn"] as const) if (adapters.has(adapter)) implicitTools.push({ adapter, file: "npm", args: ["exec", "--offline", "--", adapter, "--version"] });
    for (const tool of implicitTools) {
      if (equivalentRuntimeChecks.has(tool.adapter)) continue;
      try { await execFileAsync(tool.file, tool.args, { cwd: options.root, timeout: 5000, env: { ...process.env, ...(tool.adapter === "pnpm" ? { COREPACK_ENABLE_NETWORK: "0" } : {}) } }); diagnostics.push({ code: "DEVFN_ADAPTER_AVAILABLE", severity: "info", message: `${tool.adapter} adapter runtime is available.` }); }
      catch { diagnostics.push({ code: "DEVFN_ADAPTER_UNAVAILABLE", severity: "error", message: `${tool.adapter} adapter runtime is unavailable without installation.` }); }
    }
    if (plan.nodes.some((node) => node.kind === "service") && !await new ComposeController().available()) diagnostics.push({ code: "DEVFN_DOCKER_UNAVAILABLE", severity: "error", message: "Docker Compose 2.24.4 or newer is required by this profile." });
    if (plan.proxy && !await new CaddyProxyController(stateDir).available()) diagnostics.push({ code: "DEVFN_CADDY_UNAVAILABLE", severity: "error", message: "Caddy is required by this profile but unavailable." });
    const identity = await resolveInstanceIdentity(options.config.project.id, options.root);
    const registry = await new FilePortRegistry(path.join(stateDir, "registry.json")).reconcile();
    const scan = await scanListenerState(plan.nodes.some((node) => node.kind === "service"));
    const listeners = scan.listeners;
    const unavailableWarnings = new Set<string>();
    const localProcessPorts = new Map<string, "tcp" | "udp">();
    const requiredLocalProtocols = new Set<"tcp" | "udp">();
    for (const node of plan.nodes.filter((candidate) => candidate.kind === "process" && !candidate.task)) {
      const processSpec = options.config.processes?.[node.name];
      if (!processSpec || processSpec.exposure === "public") continue;
      if (!(processSpec.ports?.length)) {
        requiredLocalProtocols.add("tcp");
        requiredLocalProtocols.add("udp");
      }
      for (const name of processSpec.ports ?? []) {
        const protocol = options.config.ports?.[name]?.protocol ?? "tcp";
        localProcessPorts.set(name, protocol);
        requiredLocalProtocols.add(protocol);
      }
    }
    for (const protocol of requiredLocalProtocols) {
      if (scan.inspection[protocol]) continue;
      const hasRecordedOwner = hasRecordedProcessOwner(registry.allocations, options.config.project.id, identity.instanceId, localProcessPorts, protocol);
      diagnostics.push({
        code: "DEVFN_LISTENER_INSPECTION_UNAVAILABLE",
        severity: hasRecordedOwner ? "warning" : "error",
        message: hasRecordedOwner
          ? `${protocol.toUpperCase()} listener ownership could not be inspected; recorded active owners were retained.`
          : `${protocol.toUpperCase()} listener ownership inspection is required before starting local processes. Install lsof on macOS/Linux or ensure netstat is available on Windows.`,
      });
      unavailableWarnings.add(`${protocol}:os`);
    }
    const exact = plan.portNames.flatMap((name) => options.config.ports?.[name]?.exact && options.config.ports[name].preferred ? [{ name, port: options.config.ports[name].preferred!, protocol: options.config.ports[name].protocol ?? "tcp" as const }] : []);
    for (const item of exact) {
      const allocation = registry.allocations.find((candidate) => candidate.instanceId === identity.instanceId && candidate.service === item.name && candidate.port === item.port && candidate.protocol === item.protocol && candidate.state === "active");
      const matches = listeners.filter((candidate) => candidate.port === item.port && candidate.protocol === item.protocol);
      const relevantListeners = selectOwnershipListeners(allocation, matches);
      const ownership = await Promise.all(relevantListeners.map(async (listener) => {
        if (allocation?.process !== undefined && listener.pid !== undefined) return await isProcessTreeMember(listener.pid, allocation.process.pid);
        return allocation?.container !== undefined && listener.containerId !== undefined && (allocation.container.id.startsWith(listener.containerId) || listener.containerId.startsWith(allocation.container.id));
      }));
      const owned = ownership.length > 0 && ownership.every(Boolean);
      if (owned) continue;
      if (relevantListeners.length === 0 && allocation?.process && !scan.inspection[item.protocol]) {
        const warningKey = `${item.protocol}:os`;
        if (!unavailableWarnings.has(warningKey)) {
          diagnostics.push({ code: "DEVFN_LISTENER_INSPECTION_UNAVAILABLE", severity: "warning", message: `${item.protocol.toUpperCase()} listener ownership could not be inspected; recorded active owners were retained.` });
          unavailableWarnings.add(warningKey);
        }
        continue;
      }
      if (allocation?.container && !scan.inspection.docker) {
        if (!unavailableWarnings.has("docker")) {
          diagnostics.push({ code: "DEVFN_LISTENER_INSPECTION_UNAVAILABLE", severity: "error", message: "Docker listener ownership could not be verified for an active container." });
          unavailableWarnings.add("docker");
        }
        continue;
      }
      if (relevantListeners.length || !await isPortAvailable(item.port, item.protocol)) diagnostics.push({ code: "DEVFN_EXACT_PORT_OCCUPIED", severity: "error", message: `Exact ${item.protocol.toUpperCase()} port ${item.port} for ${item.name} is occupied.`, ...(relevantListeners[0] ? { details: relevantListeners[0] } : {}) });
    }
    const stale = registry.allocations.filter((allocation) => allocation.state === "stale");
    if (stale.length) diagnostics.push({ code: "DEVFN_STALE_LEASES", severity: "warning", message: `${stale.length} stale lease(s) need garbage collection.` });
    return { ok: diagnostics.every((item) => item.severity !== "error"), diagnostics };
  }

  public async logs(options: { config: DevFnConfig; root: string; name?: string; tail?: number }): Promise<Record<string, string>> {
    const identity = await resolveInstanceIdentity(options.config.project.id, options.root);
    const receipt = await readReceipt(options.config, options.root, identity.instanceId);
    if (!receipt) throw new DevFnError("DEVFN_NOT_RUNNING", "No runtime receipt exists for this worktree.");
    const output: Record<string, string> = {};
    const redact = (value: string, keys: readonly string[] = []) => keys.reduce((result, key) => process.env[key] ? result.split(process.env[key]!).join("[REDACTED]") : result, value);
    for (const managed of receipt.processes.filter((item) => !options.name || item.name === options.name)) {
      const lines = (await readFile(managed.logPath, "utf8").catch(() => "")).split("\n");
      const tail = options.tail ?? 200;
      output[managed.name] = redact(tail === 0 ? "" : lines.slice(-tail).join("\n"), options.config.processes?.[managed.name]?.secretEnv);
    }
    for (const task of receipt.tasks?.filter((item) => item.logPath && (!options.name || item.name === options.name)) ?? []) {
      const lines = (await readFile(task.logPath!, "utf8").catch(() => "")).split("\n");
      const tail = options.tail ?? 200;
      const spec = task.kind === "process" ? options.config.processes?.[task.name] : options.config.services?.[task.name];
      output[task.name] = redact(tail === 0 ? "" : lines.slice(-tail).join("\n"), spec?.secretEnv);
    }
    const compose = new ComposeController();
    for (const service of receipt.services.filter((item) => !options.name || item.name === options.name)) {
      const currentSpec = options.config.services?.[service.name];
      const effective = { ...service, logsDisabled: Boolean(service.logsDisabled || currentSpec?.secretEnv?.length) };
      output[service.name] = redact(await compose.logs(effective, options.tail), currentSpec?.secretEnv);
    }
    return output;
  }
}
